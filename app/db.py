"""SQLite connection, schema and transaction helper."""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    description TEXT,
    dietary TEXT,
    spice_default TEXT,
    aliases TEXT,
    par_level INTEGER,
    available INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    order_date TEXT NOT NULL,
    channel TEXT,
    conversation_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    items TEXT,
    items_hash TEXT,
    subtotal_cents INTEGER,
    tax_cents INTEGER,
    total_cents INTEGER,
    status TEXT NOT NULL,
    paypal_order_id TEXT,
    superseded_paypal_order_ids TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    capture_id TEXT,
    paid_cents INTEGER,
    sms_consent_at TEXT,
    flags TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    ready_at TEXT,
    picked_up_at TEXT,
    UNIQUE (number, order_date)
);
CREATE INDEX IF NOT EXISTS idx_orders_paypal_order_id ON orders (paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_conversation_id ON orders (conversation_id);
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    channel TEXT,
    from_number TEXT,
    started_at TEXT,
    ended_at TEXT
);
CREATE TABLE IF NOT EXISTS subscription (
    id INTEGER PRIMARY KEY,
    paypal_subscription_id TEXT,
    status TEXT,
    checked_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT,
    received_at TEXT
);
"""


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")  # above the PayPal SDK timeout (app/paypal.py)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


@contextmanager
def tx(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()
