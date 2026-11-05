"""Subscription gate: the restaurant pays for the AI line via a PayPal subscription."""
import logging
import sqlite3
from typing import Callable

from app.db import now_utc, tx

log = logging.getLogger(__name__)

EVENTS = (
    "BILLING.SUBSCRIPTION.ACTIVATED",
    "BILLING.SUBSCRIPTION.CANCELLED",
    "BILLING.SUBSCRIPTION.SUSPENDED",
    "BILLING.SUBSCRIPTION.EXPIRED",
    "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    "PAYMENT.SALE.COMPLETED",
)


def _row(conn) -> dict:
    r = conn.execute("SELECT paypal_subscription_id, status, checked_at FROM subscription WHERE id=1").fetchone()
    return dict(r) if r else {}


def line_is_active(conn) -> bool:
    """ACTIVE (trials included) only. DB errors fail open."""
    try:
        return _row(conn).get("status") == "ACTIVE"
    except sqlite3.Error:
        log.exception("subscription status lookup failed; failing open")
        return True


def _save(conn, sub_id: str, status: str) -> dict:
    with tx(conn):
        conn.execute(
            "INSERT INTO subscription(id, paypal_subscription_id, status, checked_at) VALUES (1, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET paypal_subscription_id=excluded.paypal_subscription_id, "
            "status=excluded.status, checked_at=excluded.checked_at",
            (sub_id, status, now_utc()),
        )
    return _row(conn)


def store_subscription(conn, paypal, sub_id: str, plan_id: str) -> dict:
    sub = paypal.get_subscription(sub_id)
    if sub["plan_id"] != plan_id:
        raise ValueError(f"subscription {sub_id} is not on the configured plan")
    return _save(conn, sub_id, sub["status"])


def sync(conn, paypal) -> dict:
    """Re-read the stored subscription from PayPal. No stored row: no-op, returns {}."""
    row = _row(conn)
    if not row:
        return {}
    return _save(conn, row["paypal_subscription_id"], paypal.get_subscription(row["paypal_subscription_id"])["status"])


def cancel(conn, paypal) -> dict:
    row = _row(conn)
    if row:
        paypal.cancel_subscription(row["paypal_subscription_id"])
    return sync(conn, paypal)


def subscription_handlers(conn, paypal) -> dict[str, Callable]:
    return {e: (lambda _resource: sync(conn, paypal)) for e in EVENTS}
