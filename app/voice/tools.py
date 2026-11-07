"""The assistant tools. Provider-neutral: the outside world is reached only through
`push` (UI events) and `hangup`, so a pipeline or a hosted voice platform can call this class alike."""

import asyncio
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from app.agent_mcp import RateLimiter
from app.orders import (OrderError, latest_for_conversation, pay_page_url, place_order as core_place_order,
                        price_cart)
from app.sms import payment_link_text
from app.totals import cents_to_words

PHONE_RE = re.compile(r"^\+[1-9]\d{7,14}$")
MAX_TEXTS_PER_CALL = 5
MAX_TEXTS_PER_NUMBER = 10
TEXT_WINDOW_SECONDS = 5 * 3600

TOOL_SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "set_order",
        "description": (
            "Set the caller's whole order. Call it every time the caller adds, removes or changes a dish, "
            "passing the complete list of items (it replaces the cart). Returns the priced lines and the total, "
            "or unknown_items / unavailable_items. Do not call it to read the order back, and never guess a total."),
        "parameters": {"type": "object", "properties": {"items": {
            "type": "array", "items": {"type": "object", "properties": {
                "item_id": {"type": "string", "description": "Short id from the menu."},
                "qty": {"type": "integer", "minimum": 1, "maximum": 10},
                "spice": {"type": "string", "enum": ["mild", "medium", "hot"]},
                "note": {"type": "string"}}, "required": ["item_id", "qty"]}}},
            "required": ["items"]}}},
    {"type": "function", "function": {
        "name": "place_order",
        "description": (
            "Place the order and send the payment step. Call it only after the caller has said that is everything "
            "and given their name; on the phone, only after they clearly agreed to a text with the payment link. "
            "Do not call it with an empty order, and do not call it just to check the total."),
        "parameters": {"type": "object", "properties": {
            "customer_name": {"type": "string"},
            "sms_consent": {"type": "boolean",
                            "description": "Phone only: true only if the caller agreed to be texted the payment link."}},
            "required": ["customer_name"]}}},
    {"type": "function", "function": {
        "name": "end_call",
        "description": (
            "Hang up. Call it only after the payment confirmation has been spoken, or the caller said goodbye. "
            "Never call it while an order is still being taken."),
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "transfer_to_staff",
        "description": (
            "Transfer the caller to a person at the restaurant. Call it only when the caller asks to speak to a "
            "person (a human, staff, a manager, a supervisor). Never call it on your own."),
        "parameters": {"type": "object", "properties": {}}}},
]


@dataclass
class Conversation:
    conversation_id: str
    channel: str  # "phone" | "web"
    caller_phone: str | None = None
    cart: list[dict] = field(default_factory=list)
    texts_claimed: int = 0


class VoiceTools:
    def __init__(self, conn_factory: Callable[[], sqlite3.Connection], paypal, sms, restaurant: dict, settings,
                 push: Callable[[str, dict], Awaitable[None]], hangup: Callable[[], Awaitable[None]],
                 transfer: Callable[[], Awaitable[bool]] | None = None, text_limiter: RateLimiter | None = None):
        self.conn_factory, self.paypal, self.sms = conn_factory, paypal, sms
        self.restaurant, self.settings, self.push, self.hangup = restaurant, settings, push, hangup
        self.transfer = transfer  # phone only: hands the live call to staff; False if it could not
        self.text_limiter = text_limiter or RateLimiter(MAX_TEXTS_PER_NUMBER, TEXT_WINDOW_SECONDS)

    def _claim_text(self, conv: Conversation) -> bool:
        """Claim one payment text. Checked before a link changes, so a refusal leaves the last link working."""
        if conv.texts_claimed >= MAX_TEXTS_PER_CALL:
            return False
        if conv.caller_phone != self.settings.call_limit_exempt_number and not self.text_limiter.hit(conv.caller_phone):
            return False
        conv.texts_claimed += 1
        return True

    def _core_place(self, conn, conv: Conversation, name: str, items: list[dict], consent: bool) -> dict:
        return core_place_order(
            conn, self.paypal, channel=conv.channel, conversation_id=conv.conversation_id, customer_name=name,
            raw_items=items, customer_phone=conv.caller_phone if conv.channel == "phone" else None,
            sms_consent=consent, tz=self.settings.restaurant_tz,
            tax_rate_bps=self.restaurant["tax_rate_bps"], base_url=self.settings.public_base_url)

    def _blocked(self, conn, conv: Conversation) -> dict | None:
        """The error for a conversation whose latest order can no longer change."""
        last = latest_for_conversation(conn, conv.conversation_id)
        if last and last["status"] in ("capturing", "capture_pending"):
            return {"error": "payment_processing"}
        if last and last["status"] in ("paid", "ready", "picked_up"):
            return {"error": "already_paid"}
        return None

    def _set_order(self, conv: Conversation, items) -> tuple[dict, dict | None]:
        if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
            return {"ok": False, "error": "bad_items"}, None
        conn = self.conn_factory()
        try:
            if (blocked := self._blocked(conn, conv)):
                return blocked, None
            result = price_cart(conn, items, self.settings.restaurant_tz, self.restaurant["tax_rate_bps"])
            if not result["ok"]:
                return result, None
            relinked = None
            last = latest_for_conversation(conn, conv.conversation_id)
            if last and last["status"] == "pending_payment" and last["items_hash"] != result["items_hash"]:
                if conv.channel == "phone" and not self._claim_text(conv):
                    return {"error": "text_limit_reached"}, None
                try:
                    placed = self._core_place(conn, conv, last["customer_name"], items, False)
                except OrderError as e:
                    return ({"error": "bad_name"} if e.code == "bad_name" else e.detail or self._blocked(conn, conv)
                            or {"error": e.code}), None
                relinked = placed
            conv.cart = items
            return {**result, "total_words": cents_to_words(result["total_cents"])}, relinked
        finally:
            conn.close()

    async def set_order(self, conv: Conversation, items: list[dict]) -> dict:
        result, relinked = await asyncio.to_thread(self._set_order, conv, items)
        if not result.get("ok"):
            return result
        if relinked:
            await self._deliver(conv, relinked)
            result["payment_link_updated"] = True
        await self.push("cart", result)
        return result

    async def _deliver(self, conv: Conversation, placed: dict) -> None:
        """Send the payment step for a new or changed PayPal link."""
        o = placed["order"]
        if conv.channel == "phone":
            if o["sms_consent_at"]:  # never text a caller who did not agree
                url = pay_page_url(self.settings.public_base_url, o["paypal_order_id"])
                body = payment_link_text(self.restaurant["name"], o["number"], o["total_cents"], url)
                await asyncio.to_thread(self.sms.send, conv.caller_phone, body)
        else:
            await self.push("payment_ready", {"order_number": o["number"], "paypal_order_id": o["paypal_order_id"],
                                              "total_cents": o["total_cents"]})

    def _place(self, conv: Conversation, name: str, consent: bool) -> dict:
        conn = self.conn_factory()
        try:
            last = latest_for_conversation(conn, conv.conversation_id)
            # A pending order already has its link: set_order re-links on any change, so this repeat sends no text.
            if conv.channel == "phone" and not (last and last["status"] == "pending_payment") and not self._claim_text(conv):
                return {"error": "text_limit_reached"}
            try:
                return self._core_place(conn, conv, name, conv.cart, consent)
            except OrderError as e:
                if e.code == "already_paid":
                    return self._blocked(conn, conv) or {"error": "already_paid"}
                return {"error": "bad_name"} if e.code == "bad_name" else e.detail
        finally:
            conn.close()

    async def place_order(self, conv: Conversation, customer_name: str, sms_consent: bool = False) -> dict:
        if not conv.cart:
            return {"error": "empty_cart"}
        if conv.channel == "phone":
            if not PHONE_RE.match(conv.caller_phone or ""):
                return {"error": "no_callback_number"}
            if not sms_consent:
                return {"error": "needs_sms_consent"}
        placed = await asyncio.to_thread(self._place, conv, customer_name, sms_consent)
        if "order" not in placed:
            return placed
        o = placed["order"]
        if placed["changed"] or conv.channel == "web":  # a repeat on the web re-pushes: the screen may have missed it
            await self._deliver(conv, placed)
        return {"order_number": o["number"], "order_number_spoken": " ".join(str(o["number"])),
                "total_cents": o["total_cents"],
                "total_words": cents_to_words(o["total_cents"]),
                "delivery": "link sent" if conv.channel == "phone" else "buttons shown"}

    async def end_call(self, conv: Conversation) -> dict:
        await self.hangup()
        return {"ok": True}

    async def transfer_to_staff(self, conv: Conversation) -> dict:
        if conv.channel != "phone" or not self.transfer:
            return {"error": "not_on_phone"}  # restaurant.json has no phone field to offer
        return {"ok": True} if await self.transfer() else {"error": "no_staff_available"}
