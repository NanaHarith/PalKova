"""MCP agent channel: three tools an outside AI agent uses to browse the menu, order and check an order.
Payment is always the human opening the pay page link; the agent never touches card or login details."""

import difflib
import threading
import time
from datetime import datetime, timedelta

from mcp.server.mcpserver import Context, MCPServer
from pydantic import BaseModel, Field

from app.config import restaurant
from app.db import connect
from app.menu import _norm, menu_for_prompt, resolve_item
from app.orders import EXPIRY_MINUTES, PAID_STATES, OrderError, get_order, pay_page_url, place_order
from app.subscription import line_is_active
from app.totals import cents_to_str

LINE_INACTIVE = {"error": "line_inactive", "message": "This restaurant isn't taking orders right now."}


# In-memory per-process limiter, swap for shared store if multi-instance
class RateLimiter:
    def __init__(self, max_events: int = 10, window_s: int = 3600):
        self.max_events, self.window_s = max_events, window_s
        self._events: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            recent = [t for t in self._events.get(key, []) if now - t < self.window_s]
            allowed = len(recent) < self.max_events
            if allowed:
                recent.append(now)
            self._events[key] = recent
            return allowed


def _item_out(i: dict) -> dict:
    return {"id": i["id"], "name": i["name"], "category": i["category"], "description": i["description"],
            "dietary": i["dietary"], "spice_default": i["spice_default"], "price_cents": i["price_cents"],
            "price": cents_to_str(i["price_cents"]), "remaining": i["remaining"]}


class AgentTools:
    def __init__(self, settings, paypal, limiter: RateLimiter):
        self.settings, self.paypal, self.limiter = settings, paypal, limiter

    def search_menu(self, query: str | None = None, dietary: str | None = None) -> dict:
        conn = connect(self.settings.database_path)
        try:
            if not line_is_active(conn):
                return LINE_INACTIVE
            tz = self.settings.restaurant_tz
            items = menu_for_prompt(conn, tz)[0]
            if dietary:
                items = [i for i in items if dietary.lower() in (d.lower() for d in i["dietary"])]
            if not (query and query.strip()):
                return {"items": [_item_out(i) for i in items]}
            q = _norm(query)
            hit = resolve_item(conn, query, tz)
            found = [i for i in items if (hit and i["id"] == hit["id"]) or any(
                q in _norm(t) for t in (i["name"], i["description"], *i["aliases"]))]
            found.sort(key=lambda i: not (hit and i["id"] == hit["id"]))
            if found:
                return {"items": [_item_out(i) for i in found]}
            names = {_norm(i["name"]): i["name"] for i in menu_for_prompt(conn, tz)[0]}
            return {"items": [], "message": f"{query!r} is not on today's menu.",
                    "closest": [names[n] for n in difflib.get_close_matches(q, list(names), n=3, cutoff=0.5)]}
        finally:
            conn.close()

    def create_order(self, items: list[dict], customer_name: str, client_ip: str = "unknown") -> dict:
        if not self.limiter.hit(client_ip):
            return {"error": "rate_limited", "message": "Too many orders from this connection; try again later."}
        conn = connect(self.settings.database_path)
        try:
            if not line_is_active(conn):
                return LINE_INACTIVE
            r = restaurant()
            try:
                placed = place_order(
                    conn, self.paypal, channel="agent", conversation_id=None, customer_name=customer_name,
                    raw_items=items, tz=self.settings.restaurant_tz, tax_rate_bps=r["tax_rate_bps"],
                    base_url=self.settings.public_base_url)
            except OrderError as e:
                if e.code == "bad_name":
                    return {"error": "bad_name", "message": "A customer name is needed for pickup."}
                cart = e.detail
                return {"error": "bad_cart", "unknown_items": cart["unknown_items"],
                        "unavailable_items": cart["unavailable_items"], "line_error": cart["error"],
                        "message": "Some items are not on today's menu or are sold out; use search_menu "
                                   "for ids and check quantities (1-10 each)."}
            o = placed["order"]
            link_at = datetime.fromisoformat(o["flags"]["link_created_at"])
            return {
                "order_id": o["id"], "order_number": o["number"], "customer_name": o["customer_name"],
                "lines": [{"name": ln["name"], "qty": ln["qty"], "spice": ln.get("spice"), "note": ln.get("note"),
                           "unit_price_cents": ln["unit_price_cents"], "unit_price": cents_to_str(ln["unit_price_cents"]),
                           "line_cents": ln["line_cents"], "line_total": cents_to_str(ln["line_cents"])}
                          for ln in o["items"]],
                "subtotal_cents": o["subtotal_cents"], "tax_cents": o["tax_cents"], "total_cents": o["total_cents"],
                "subtotal": cents_to_str(o["subtotal_cents"]), "tax": cents_to_str(o["tax_cents"]),
                "total": cents_to_str(o["total_cents"]),
                "payment_url": pay_page_url(self.settings.public_base_url, o["paypal_order_id"]),
                "expires_at": (link_at + timedelta(minutes=EXPIRY_MINUTES)).isoformat(),
                "ready_minutes": r["ready_minutes"],
                "next_step": "Give payment_url to the customer to pay with PayPal or a card (both through PayPal). "
                             "The order is confirmed "
                             "once paid; check it with get_order_status(order_id).",
            }
        finally:
            conn.close()

    def get_order_status(self, order_id: str) -> dict:
        """By the order's random id, not its 4-digit number: numbers are guessable and would show anyone's order."""
        conn = connect(self.settings.database_path)
        try:
            o = get_order(conn, order_id.strip())
            if o is None:
                return {"error": "not_found",
                        "message": "No order with that order_id. Use the order_id create_order returned."}
            ready_by = None
            if o["status"] in PAID_STATES and o["paid_at"]:
                ready_by = (datetime.fromisoformat(o["paid_at"])
                            + timedelta(minutes=restaurant()["ready_minutes"])).isoformat()
            out = {"order_number": o["number"], "status": o["status"], "total": cents_to_str(o["total_cents"]),
                   "total_cents": o["total_cents"], "ready_by": ready_by}
            if o["status"] == "pending_payment":
                out["payment_url"] = pay_page_url(self.settings.public_base_url, o["paypal_order_id"])
            return out
        finally:
            conn.close()


class OrderLine(BaseModel):
    item_id: str = Field(description="Dish id from search_menu.")
    qty: int = Field(description="How many, 1 to 10.")
    spice: str | None = Field(default=None, description="mild, medium or hot; omit for the dish's default.")
    note: str | None = Field(default=None, description="Short kitchen note, e.g. no onions.")


def _client_ip(ctx: Context) -> str:
    # First X-Forwarded-For hop is client-spoofable; fine for a demo limiter
    headers = ctx.headers or {}
    if fwd := headers.get("x-forwarded-for"):
        return fwd.split(",")[0].strip()
    client = getattr(ctx.request_context.request, "client", None)
    return client.host if client else "unknown"


def build_mcp(tools: AgentTools) -> MCPServer:
    ready = restaurant()["ready_minutes"]
    mcp = MCPServer("Kaveri Kitchen", instructions=(
        "Kaveri Kitchen is a demo Indian restaurant that can be ordered from only through these tools. "
        "Orders are pickup only; never ask whether the customer wants pickup or delivery. "
        "Pickup address: 123 Gay Street, Knoxville, TN 37901. Open every day, 11 AM to 10 PM (Eastern). "
        "An order is ready "
        f"in about {ready} minutes after payment. Prices are in USD; tax is included in the total shown when "
        "you create the order. The human pays by opening payment_url, the restaurant's pay page with PayPal and "
        "card buttons; no PayPal account is needed, and the card form is PayPal's own, so card details go to "
        "PayPal, never to the restaurant. You never handle card or login details. Shortest path: search_menu, confirm dishes, quantities and the customer's name with "
        "the human, create_order, give them payment_url, then get_order_status with its order_id. If a dish is "
        "not on today's menu, say so and offer the closest matches; never swap in a different dish. Read dish descriptions "
        "for the meat: mutton here means goat."))

    @mcp.tool(description=(
        "Search today's orderable menu. Pass a dish name or word as query, and/or a dietary tag (for example "
        "vegetarian) to filter; omit both to list everything. Returns item ids for create_order. If nothing "
        "matches, the dish is not served today: say so and offer the closest names returned."))
    def search_menu(query: str | None = None, dietary: str | None = None) -> dict:
        return tools.search_menu(query, dietary)

    @mcp.tool(description=(
        "Place a pickup order and get its payment_url. Only after the customer confirmed the dishes, "
        "quantities and the name for pickup. Use item_id values from search_menu. Give payment_url to the "
        "customer; the order is confirmed once they pay."))
    def create_order(items: list[OrderLine], customer_name: str, ctx: Context) -> dict:
        return tools.create_order([i.model_dump() for i in items], customer_name, _client_ip(ctx))

    @mcp.tool(description=(
        "Check an order by the order_id create_order returned (not the 4-digit order number): pending_payment, "
        "paid, ready, picked_up, cancelled or expired. While unpaid it also returns payment_url again."))
    def get_order_status(order_id: str) -> dict:
        return tools.get_order_status(order_id)

    return mcp
