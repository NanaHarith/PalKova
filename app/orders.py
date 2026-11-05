"""Order core: prices carts and writes orders (place, supersede, lookups). Integer cents only."""

import json
import logging
import random
import re
import sqlite3
import unicodedata
import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from app.db import now_utc, tx
from app.menu import remaining_stock, resolve_item
from app.totals import LineError, compute_totals, items_hash, merge_lines, validate_lines

log = logging.getLogger(__name__)

PAID_STATES = ("paid", "ready", "picked_up")
NO_NEW_ORDER_STATES = (*PAID_STATES, "capturing", "capture_pending")


class OrderError(Exception):
    def __init__(self, code: str, detail=None):
        super().__init__(code)
        self.code = code
        self.detail = detail


def clean_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", raw)
    name = "".join(c for c in name if not unicodedata.category(c).startswith("C")).strip()[:60]
    if not name:
        raise OrderError("bad_name")
    return name


def _short_items(conn: sqlite3.Connection, lines: list[dict], tz: str) -> list[str]:
    """Names of dishes the lines need more of than is left today, counting every spice line of a dish."""
    want, names = Counter(), {}
    for ln in lines:
        want[ln["item_id"]] += ln["qty"]
        names[ln["item_id"]] = ln["name"]
    return [names[i] for i, qty in want.items() if qty > remaining_stock(conn, i, tz)]


def price_cart(conn: sqlite3.Connection, raw_items: list[dict], tz: str, tax_rate_bps: int) -> dict:
    fail = {"ok": False, "unknown_items": [], "unavailable_items": [], "error": None}
    resolved, unknown = [], []
    for raw in raw_items:
        item = resolve_item(conn, str(raw.get("item_id") or ""), tz)
        if item is None:
            unknown.append(raw.get("item_id"))
            continue
        resolved.append((item, {
            "item_id": item["id"], "qty": raw.get("qty"),
            # a dish with no default has no spice to choose (a drink, a dessert), whatever the caller's agent sends
            "spice": (raw.get("spice") or item["spice_default"]) if item["spice_default"] else None, "note": raw.get("note"),
        }))
    if unknown:
        return {**fail, "unknown_items": unknown}
    try:
        validate_lines([ln for _, ln in resolved])
    except LineError as e:
        return {**fail, "error": e.code}
    by_id = {item["id"]: item for item, _ in resolved}
    priced = [{**ln, "name": by_id[ln["item_id"]]["name"],
               "unit_price_cents": by_id[ln["item_id"]]["price_cents"]}
              for ln in merge_lines([ln for _, ln in resolved])]
    short = _short_items(conn, priced, tz)
    if short:
        return {**fail, "unavailable_items": short}
    t = compute_totals(priced, tax_rate_bps)
    return {"ok": True, **t, "items_hash": items_hash(t["lines"])}


def _decode(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    o = dict(row)
    for k, empty in (("items", []), ("superseded_paypal_order_ids", []), ("flags", {})):
        o[k] = json.loads(o[k]) if o[k] else empty
    return o


def get_order(conn: sqlite3.Connection, order_id: str) -> dict | None:
    return _decode(conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone())


def latest_for_conversation(conn: sqlite3.Connection, conversation_id: str) -> dict | None:
    return _decode(conn.execute(
        "SELECT * FROM orders WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        (conversation_id,),
    ).fetchone())


def _local_date(tz: str) -> str:
    return datetime.now(timezone.utc).astimezone(ZoneInfo(tz)).date().isoformat()


def recent_orders(conn: sqlite3.Connection, tz: str, days: int = 1) -> list[dict]:
    """Orders from the last `days` local days, today included (days=1 is today only); expired ones are left out."""
    since = (date.fromisoformat(_local_date(tz)) - timedelta(days=days - 1)).isoformat()
    rows = conn.execute("SELECT * FROM orders WHERE order_date >= ? AND status != 'expired'"
                        " ORDER BY created_at DESC, rowid DESC", (since,)).fetchall()
    return [_decode(r) for r in rows]


# action -> (from status, to status, timestamp column)
TRANSITIONS = {"ready": ("paid", "ready", "ready_at"), "picked_up": ("ready", "picked_up", "picked_up_at"),
               "cancel": ("pending_payment", "cancelled", None)}


def fully_refunded(order: dict) -> bool:
    """Refunded alert with the whole payment returned; rows refunded before amounts were kept carry none (all were full)."""
    paid = order["paid_cents"]
    return ("capture_refunded" in order["flags"].get("alerts", []) and paid is not None
            and order["flags"].get("refunded_cents", paid) >= paid)


def transition(conn: sqlite3.Connection, order_id: str, action: str) -> dict:
    """Owner moves an order along paid -> ready -> picked_up, or cancels an unpaid or fully refunded one (no money moves)."""
    order = get_order(conn, order_id)
    if order is None:
        raise OrderError("not_found")
    src, dst, col = TRANSITIONS[action]
    if action == "cancel" and order["status"] in PAID_STATES and fully_refunded(order):
        src = order["status"]
    with tx(conn):
        cur = conn.execute(f"UPDATE orders SET status=?{f', {col}=?' if col else ''} WHERE id=? AND status=?",
                           (dst, *([now_utc()] if col else []), order_id, src))
    if cur.rowcount == 0:
        raise OrderError("bad_transition")
    return get_order(conn, order_id)


def find_by_number(conn: sqlite3.Connection, number: str, tz: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM orders WHERE number = ? AND order_date = ?", (number, _local_date(tz))
    ).fetchone()
    return _decode(row)


def check_refundable(order: dict | None) -> dict:
    """A refund goes only to a paid order of ours, against its own capture, once."""
    if order is None or not order["capture_id"]:
        raise OrderError("not_found")
    if order["status"] not in PAID_STATES:
        raise OrderError("not_refundable")
    if "capture_refunded" in order["flags"].get("alerts", []):
        raise OrderError("already_refunded")
    return order


def sales_count(conn: sqlite3.Connection, tz: str, dish: str, start: str, end: str) -> dict:
    """Units and sales (cents) per dish whose name contains `dish`, over orders paid on local dates start..end
    inclusive. Refunded orders are left out and counted. With a `dish`, `paired_with` tallies the other dishes
    in those orders. Names and money only; no customer data."""
    zone = ZoneInfo(tz)
    lo = datetime.combine(date.fromisoformat(start), datetime.min.time(), tzinfo=zone).astimezone(timezone.utc)
    hi = datetime.combine(date.fromisoformat(end) + timedelta(days=1), datetime.min.time(),
                          tzinfo=zone).astimezone(timezone.utc)
    rows = conn.execute(
        f"SELECT items, flags FROM orders WHERE status IN ({','.join('?' * len(PAID_STATES))})"
        " AND paid_at >= ? AND paid_at < ?", (*PAID_STATES, lo.isoformat(), hi.isoformat())).fetchall()
    dishes: dict[str, dict] = {}
    pairs: dict[str, dict] = {}
    orders = refunded = 0
    for r in rows:
        all_lines = json.loads(r["items"])
        lines = [ln for ln in all_lines if dish.lower() in ln["name"].lower()]
        if not lines:
            continue
        if "capture_refunded" in json.loads(r["flags"]).get("alerts", []):
            refunded += 1
            continue
        for ln in lines:
            d = dishes.setdefault(ln["name"], {"name": ln["name"], "quantity": 0, "sales_cents": 0})
            d["quantity"] += ln["qty"]
            d["sales_cents"] += ln["line_cents"]
        orders += 1
        if dish:
            for ln in all_lines:
                if ln not in lines:
                    p = pairs.setdefault(ln["name"], {"name": ln["name"], "quantity": 0, "orders": 0})
                    p["quantity"] += ln["qty"]
                    p["orders"] += 1
    paired = sorted(pairs.values(), key=lambda p: (-p["orders"], -p["quantity"]))
    return {"dishes": list(dishes.values()), "orders": orders, "refunded_excluded": refunded, "paired_with": paired}


def refundable_by_number(conn: sqlite3.Connection, number: str) -> dict:
    """Numbers restart each day, so the latest captured order with this number."""
    return check_refundable(_decode(conn.execute(
        "SELECT * FROM orders WHERE number = ? AND capture_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        (number.lstrip("#"),)).fetchone()))


def find_by_paypal_id(conn: sqlite3.Connection, pid: str) -> tuple[dict | None, bool]:
    row = conn.execute("SELECT * FROM orders WHERE paypal_order_id = ?", (pid,)).fetchone()
    if row:
        return _decode(row), False
    for r in conn.execute(
        "SELECT * FROM orders WHERE superseded_paypal_order_ids LIKE ?", (f'%"{pid}"%',)
    ):
        o = _decode(r)
        if pid in o["superseded_paypal_order_ids"]:
            return o, True
    return None, False


def _new_number(conn: sqlite3.Connection, order_date: str) -> str:
    while True:
        n = str(random.randint(1000, 9999))
        if not conn.execute(
            "SELECT 1 FROM orders WHERE number = ? AND order_date = ?", (n, order_date)
        ).fetchone():
            return n


def place_order(
    conn: sqlite3.Connection,
    paypal,
    *,
    channel: str,
    conversation_id: str | None,
    customer_name: str,
    raw_items: list[dict],
    customer_phone: str | None = None,
    sms_consent: bool = False,
    tz: str,
    tax_rate_bps: int,
    base_url: str,
) -> dict:
    name = clean_name(customer_name)
    cart = price_cart(conn, raw_items, tz, tax_rate_bps)
    if not cart["ok"]:
        raise OrderError("bad_cart", cart)
    # PayPal call runs inside the write tx (SQLite lock held); fine at one-restaurant volume
    with tx(conn):
        prev = latest_for_conversation(conn, conversation_id) if conversation_id is not None else None
        if prev and prev["status"] in NO_NEW_ORDER_STATES:
            raise OrderError("already_paid")
        if prev and prev["status"] == "pending_payment":
            if prev["items_hash"] == cart["items_hash"]:
                return {"order": prev, "approve_url": prev["flags"]["approve_url"], "changed": False}
            gen = prev["generation"] + 1
            order_id = prev["id"]
            superseded = prev["superseded_paypal_order_ids"] + [prev["paypal_order_id"]]
            conn.execute(
                "UPDATE orders SET items=?, items_hash=?, subtotal_cents=?, tax_cents=?, total_cents=? WHERE id=?",
                (json.dumps(cart["lines"]), cart["items_hash"], cart["subtotal_cents"],
                 cart["tax_cents"], cart["total_cents"], order_id),
            )
        else:
            gen, superseded, order_id = 1, [], str(uuid.uuid4())
            order_date = _local_date(tz)
            conn.execute(
                "INSERT INTO orders (id, number, order_date, channel, conversation_id, customer_name,"
                " customer_phone, items, items_hash, subtotal_cents, tax_cents, total_cents, status,"
                " superseded_paypal_order_ids, generation, sms_consent_at, flags, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending_payment','[]',?,?,'{}',?)",
                (order_id, _new_number(conn, order_date), order_date, channel, conversation_id, name,
                 customer_phone, json.dumps(cart["lines"]), cart["items_hash"], cart["subtotal_cents"],
                 cart["tax_cents"], cart["total_cents"], gen, now_utc() if sms_consent else None, now_utc()),
            )
        created = paypal.create_order({**get_order(conn, order_id), "base_url": base_url}, gen)
        conn.execute(
            "UPDATE orders SET paypal_order_id=?, superseded_paypal_order_ids=?, generation=?, flags=? WHERE id=?",
            (created["id"], json.dumps(superseded), gen,
             json.dumps({"approve_url": created["approve_url"], "link_created_at": now_utc()}), order_id),
        )
    return {"order": get_order(conn, order_id), "approve_url": created["approve_url"], "changed": True}


def _update_flags(conn: sqlite3.Connection, order_id: str, pid: str, status: str | None = None, **flags) -> bool:
    """Merge flags into the order (alerts are appended); optionally set status.
    Only while the order is still pending_payment on `pid`; returns whether it applied."""
    with tx(conn):
        o = get_order(conn, order_id)
        if o["status"] != "pending_payment" or o["paypal_order_id"] != pid:
            return False
        alerts = flags.pop("alert", None)
        o["flags"].update(flags)
        if alerts and alerts not in o["flags"].get("alerts", []):
            o["flags"].setdefault("alerts", []).append(alerts)
        conn.execute("UPDATE orders SET flags=?, status=? WHERE id=?",
                     (json.dumps(o["flags"]), status or o["status"], order_id))
    return True


def _current(conn: sqlite3.Connection, order_id: str, pid: str) -> dict:
    """The order's state for a caller that lost a conditional write on `pid`."""
    order = get_order(conn, order_id)
    return {"result": "superseded" if order["paypal_order_id"] != pid else "not_pending", "order": order}


def dismiss_alert(conn: sqlite3.Connection, order_id: str, alert: str) -> dict:
    """Owner has seen this alert; the order keeps it, the board stops showing it."""
    with tx(conn):
        o = get_order(conn, order_id)
        if o is None:
            raise OrderError("not_found")
        if alert not in o["flags"].get("alerts", []):
            raise OrderError("bad_transition")
        o["flags"].setdefault("dismissed", {})[alert] = now_utc()
        conn.execute("UPDATE orders SET flags=? WHERE id=?", (json.dumps(o["flags"]), order_id))
    return o


def _alert(conn: sqlite3.Connection, order_id: str, alert: str, **extra) -> dict:
    with tx(conn):
        o = get_order(conn, order_id)
        o["flags"].update(extra)
        o["flags"].setdefault("alerts", []).append(alert)
        o["flags"].setdefault("alerts_at", {})[alert] = now_utc()
        conn.execute("UPDATE orders SET flags=? WHERE id=?", (json.dumps(o["flags"]), o["id"]))
    return o


def _claim_paid(conn, order_id: str, pid: str, capture_id: str | None, paid_cents: int, on_paid) -> dict:
    """Atomic claim on the PayPal order being captured: only the caller whose UPDATE hits a row notifies.
    A capture for the wrong amount never marks the order paid: it goes back to pending_payment with an alert, so the
    poll expires it, and the capture id is kept for a refund in PayPal."""
    open_states = ("pending_payment", "capturing", "capture_pending")
    order = get_order(conn, order_id)
    if paid_cents != order["total_cents"] and order["paypal_order_id"] == pid and order["status"] in open_states:
        log.error("capture: amount mismatch on order %s: captured %s vs ours %s (capture %s)",
                  order_id, paid_cents, order["total_cents"], capture_id)
        conn.execute("UPDATE orders SET status='pending_payment' WHERE id=? AND paypal_order_id=?"
                     " AND status IN ('capturing','capture_pending')", (order_id, pid))
        _update_flags(conn, order_id, pid, alert="amount_mismatch", mismatch_capture_id=capture_id)
        return {"result": "mismatch", "order": get_order(conn, order_id)}
    cur = conn.execute(
        "UPDATE orders SET status='paid', capture_id=?, paid_cents=?, paid_at=?"
        " WHERE id=? AND paypal_order_id=? AND status IN ('pending_payment','capturing','capture_pending')",
        (capture_id, paid_cents, now_utc(), order_id, pid),
    )
    order = get_order(conn, order_id)
    if cur.rowcount == 1:
        on_paid(order)
        return {"result": "paid", "order": order}
    if order["paypal_order_id"] == pid and order["status"] in PAID_STATES:
        return {"result": "not_pending", "order": order}
    # should never happen: money taken on pid but the order moved on without it
    log.error("capture: order %s is %s on %s but %s was captured (%s cents, capture %s)",
              order_id, order["status"], order["paypal_order_id"], pid, paid_cents, capture_id)
    _alert(conn, order_id, "capture_orphaned")
    return _current(conn, order_id, pid)


def _settle(conn, order_id: str, pid: str, cap: dict, on_paid) -> dict:
    """Apply a PayPal capture result to an order claimed as `capturing` on `pid`."""
    if cap["status"] == "COMPLETED":
        return _claim_paid(conn, order_id, pid, cap["capture_id"], cap["amount_cents"], on_paid)
    if cap["status"] == "PENDING":
        conn.execute("UPDATE orders SET status='capture_pending', capture_id=?"
                     " WHERE id=? AND paypal_order_id=? AND status IN ('pending_payment','capturing')",
                     (cap["capture_id"], order_id, pid))
        return {"result": "capture_pending", "order": get_order(conn, order_id)}
    conn.execute("UPDATE orders SET status='pending_payment' WHERE id=? AND paypal_order_id=? AND status='capturing'",
                 (order_id, pid))
    return {"result": "declined", "order": get_order(conn, order_id)}


def capture_if_current(
    conn: sqlite3.Connection,
    paypal,
    paypal_order_id: str,
    *,
    tz: str,
    on_paid: Callable[[dict], None],
    on_sold_out: Callable[[dict, list[str]], None] = lambda o, items: None,
) -> dict:
    """The only place a PayPal payment is captured. PayPal calls run outside any tx.
    The order is claimed as `capturing` on this PayPal id before money moves, so a supersede, a
    sold-out cancel or a second trigger can never act on an order whose capture is in flight."""
    order, superseded = find_by_paypal_id(conn, paypal_order_id)
    if order is None:
        log.error("capture: no order for paypal id %s", paypal_order_id)
        return {"result": "not_found", "order": None}
    if superseded:
        return {"result": "superseded", "order": order}
    if order["status"] != "pending_payment":
        return {"result": "not_pending", "order": order}

    pp = paypal.get_order(paypal_order_id)
    if pp["capture_status"] in ("COMPLETED", "PENDING"):  # PayPal already took the money; our claim never landed
        return _settle(conn, order["id"], paypal_order_id, _capture(pp), on_paid)
    if pp["status"] != "APPROVED":
        return {"result": "not_approved", "order": order}
    if pp["amount_cents"] != order["total_cents"]:
        log.error("capture: amount mismatch on order %s: paypal %s vs ours %s",
                  order["id"], pp["amount_cents"], order["total_cents"])
        _update_flags(conn, order["id"], paypal_order_id, alert="amount_mismatch")
        return {"result": "mismatch", "order": get_order(conn, order["id"])}

    short = _short_items(conn, order["items"], tz)
    if short:
        if not _update_flags(conn, order["id"], paypal_order_id, status="cancelled", cancel_reason="sold_out"):
            return _current(conn, order["id"], paypal_order_id)
        order = get_order(conn, order["id"])
        on_sold_out(order, short)
        return {"result": "sold_out", "order": order, "sold_out": short}

    cur = conn.execute("UPDATE orders SET status='capturing', flags=json_set(flags, '$.capturing_at', ?)"
                       " WHERE id=? AND paypal_order_id=? AND status='pending_payment'",
                       (now_utc(), order["id"], paypal_order_id))
    if cur.rowcount == 0:
        return _current(conn, order["id"], paypal_order_id)
    return _settle(conn, order["id"], paypal_order_id, paypal.capture_order(paypal_order_id), on_paid)


def _capture(pp: dict) -> dict:
    """The capture shown on a PayPal get_order, in capture_order's shape."""
    return {"status": pp["capture_status"], "capture_id": pp["capture_id"], "amount_cents": pp["capture_amount_cents"]}


def _revert(conn: sqlite3.Connection, order_id: str, pid: str, from_status: tuple[str, ...], alert: str | None) -> dict:
    """Put an order stuck mid-capture back to pending_payment on `pid`, alerting the owner once."""
    with tx(conn):
        o = get_order(conn, order_id)
        if o["paypal_order_id"] == pid and o["status"] in from_status:
            alerts = o["flags"].setdefault("alerts", [])
            if alert and alert not in alerts:
                alerts.append(alert)
            conn.execute("UPDATE orders SET status='pending_payment', flags=? WHERE id=?",
                         (json.dumps(o["flags"]), order_id))
    return {"result": "declined", "order": get_order(conn, order_id)}


def _is_4xx(e: Exception) -> bool:
    return 400 <= getattr(getattr(e, "response", None), "status_code", 0) < 500


def _resume_capture(conn: sqlite3.Connection, paypal, order: dict, on_paid, now: datetime) -> dict:
    """A `capturing` order whose capture call never reported back (crash, timeout, failed claim write).
    If PayPal shows no capture and the retry hits a 4xx, or the claim is over EXPIRY_MINUTES old, the order is payable again."""
    pid = order["paypal_order_id"]
    stale = (now - datetime.fromisoformat(order["flags"]["capturing_at"])).total_seconds() > EXPIRY_MINUTES * 60
    try:
        pp = paypal.get_order(pid)
        if pp["capture_status"]:
            return _settle(conn, order["id"], pid, _capture(pp), on_paid)
        if pp["status"] == "APPROVED":  # PayPal never saw the capture; same PayPal-Request-Id, so a retry is safe
            return _settle(conn, order["id"], pid, paypal.capture_order(pid), on_paid)
    except Exception as e:
        if not (stale or _is_4xx(e)):
            raise
        log.exception("capture: order %s could not be resumed", order["id"])
        return _revert(conn, order["id"], pid, ("capturing",), "capture_failed")
    if stale:
        return _revert(conn, order["id"], pid, ("capturing",), "capture_failed")
    return _settle(conn, order["id"], pid, {"status": None}, on_paid)  # nothing captured: payable again


def complete_pending_capture(conn: sqlite3.Connection, paypal, paypal_order_id: str, *, on_paid) -> dict:
    """PAYMENT.CAPTURE.COMPLETED: re-read PayPal; claim the order as paid only once the capture is COMPLETED."""
    order, superseded = find_by_paypal_id(conn, paypal_order_id)
    if order is None or superseded:
        return {"result": "not_found" if order is None else "superseded", "order": order}
    if order["status"] in PAID_STATES:
        return {"result": "not_pending", "order": order}
    pp = paypal.get_order(paypal_order_id)
    if pp["capture_status"] in ("DECLINED", "FAILED"):
        return _revert(conn, order["id"], paypal_order_id, ("capturing", "capture_pending"), "capture_declined")
    if pp["capture_status"] != "COMPLETED":
        in_flight = order["status"] in ("capturing", "capture_pending")
        return {"result": "capture_pending" if in_flight else "not_pending", "order": order}
    # a COMPLETED capture is claimed whatever our state; _claim_paid alerts if the order moved on
    return _claim_paid(conn, order["id"], paypal_order_id, pp["capture_id"], pp["capture_amount_cents"], on_paid)


def revert_declined_capture(conn: sqlite3.Connection, paypal_order_id: str) -> dict | None:
    """PAYMENT.CAPTURE.DENIED: a pending capture failed, so the order is payable again."""
    order, superseded = find_by_paypal_id(conn, paypal_order_id)
    if order is None or superseded:
        return None
    conn.execute("UPDATE orders SET status='pending_payment' WHERE id=? AND status='capture_pending'", (order["id"],))
    return get_order(conn, order["id"])


def add_alert_for_capture(conn: sqlite3.Connection, capture_id: str, alert: str, **extra) -> dict | None:
    """Flags the order holding this capture; refund/reversal webhooks only identify the capture."""
    row = conn.execute("SELECT id FROM orders WHERE capture_id = ?", (capture_id,)).fetchone()
    return _alert(conn, row["id"], alert, **extra) if row else None


EXPIRY_MINUTES = 15
# a `capturing` order older than this lost its capture call; above SDK timeout + busy_timeout (10 s + 15 s)
CAPTURE_STALE_SECONDS = 60


def expire_and_poll(conn: sqlite3.Connection, paypal, *, tz: str, on_paid, now: datetime | None = None,
                    on_sold_out: Callable[[dict, list[str]], None] = lambda o, items: None) -> None:
    """Background tick: capture approved orders, expire stale unpaid ones, finish pending
    and interrupted captures. An order whose PayPal capture is COMPLETED or PENDING is never expired."""
    now = now or datetime.now(timezone.utc)
    rows = conn.execute("SELECT * FROM orders WHERE status IN ('pending_payment','capturing','capture_pending')").fetchall()
    for r in map(_decode, rows):
        try:
            if r["status"] == "capture_pending":
                complete_pending_capture(conn, paypal, r["paypal_order_id"], on_paid=on_paid)
                continue
            if r["status"] == "capturing":
                if (now - datetime.fromisoformat(r["flags"]["capturing_at"])).total_seconds() > CAPTURE_STALE_SECONDS:
                    _resume_capture(conn, paypal, r, on_paid, now)
                continue
            # the clock runs from the current link; rows from before link_created_at fall back to the order's age
            old = (now - datetime.fromisoformat(r["flags"].get("link_created_at", r["created_at"]))).total_seconds() > EXPIRY_MINUTES * 60
            res = {"result": "declined"}  # a link whose capture already failed once is not tried again once it is old
            if not (old and "capture_failed" in r["flags"].get("alerts", [])):
                res = capture_if_current(conn, paypal, r["paypal_order_id"], tz=tz, on_paid=on_paid,
                                         on_sold_out=on_sold_out)
            if res["result"] in ("not_approved", "mismatch", "declined") and old:
                conn.execute("UPDATE orders SET status='expired' WHERE id=? AND paypal_order_id=? AND status='pending_payment'",
                             (r["id"], r["paypal_order_id"]))
        except Exception:
            log.exception("expire_and_poll: order %s failed", r["id"])
