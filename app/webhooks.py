"""PayPal webhook intake: verify, dedupe, dispatch."""
import json
import logging
import sqlite3
from typing import Callable, Mapping

from app.db import now_utc
from app.events import hub
from app.orders import add_alert_for_capture, capture_if_current, complete_pending_capture, revert_declined_capture
from app.paypal import _cents

log = logging.getLogger(__name__)


def handle_paypal_webhook(conn: sqlite3.Connection, paypal, headers: Mapping[str, str], body: bytes, *,
                          webhook_id: str, handlers: dict[str, Callable[[dict], None]]) -> int:
    """Returns the HTTP status. Each handler receives the event's `resource`."""
    try:
        event = json.loads(body)
        event_id, event_type = event["id"], event["event_type"]
    except (ValueError, KeyError, TypeError):
        return 400
    if not paypal.verify_webhook(headers, body, webhook_id):
        return 400
    try:
        conn.execute("INSERT INTO webhook_events (event_id, event_type, received_at) VALUES (?,?,?)",
                     (event_id, event_type, now_utc()))
    except sqlite3.IntegrityError:
        return 200
    handler = handlers.get(event_type)
    if handler is None:
        return 200
    try:
        handler(event.get("resource") or {})
    except Exception:
        log.exception("webhook %s (%s) failed", event_id, event_type)
        conn.execute("DELETE FROM webhook_events WHERE event_id = ?", (event_id,))
        return 500
    return 200


def order_handlers(conn: sqlite3.Connection, paypal, *, tz: str, on_paid, on_sold_out) -> dict:
    def related_order_id(resource: dict) -> str:
        return resource["supplementary_data"]["related_ids"]["order_id"]

    def alert(kind: str) -> Callable[[dict], None]:
        def handle(resource: dict) -> None:
            # a refund resource has no supplementary_data; its rel=up link points at the capture
            up = next((link["href"] for link in resource.get("links", []) if link.get("rel") == "up"), "")
            extra = {}
            if kind == "capture_refunded":  # cumulative for the capture; a partial refund must not read as full
                value = (resource.get("seller_payable_breakdown", {}).get("total_refunded_amount")
                         or resource.get("amount") or {}).get("value")
                if value:
                    extra["refunded_cents"] = _cents(value)
            order = add_alert_for_capture(conn, up.rstrip("/").rsplit("/", 1)[-1], kind, **extra) if up else None
            if order:
                hub.publish("order.alert", order)
        return handle

    return {
        "CHECKOUT.ORDER.APPROVED": lambda r: capture_if_current(
            conn, paypal, r["id"], tz=tz, on_paid=on_paid, on_sold_out=on_sold_out),
        "PAYMENT.CAPTURE.COMPLETED": lambda r: complete_pending_capture(
            conn, paypal, related_order_id(r), on_paid=on_paid),
        "PAYMENT.CAPTURE.DENIED": lambda r: revert_declined_capture(conn, related_order_id(r)),
        "PAYMENT.CAPTURE.REVERSED": alert("capture_reversed"),
        "PAYMENT.CAPTURE.REFUNDED": alert("capture_refunded"),
    }
