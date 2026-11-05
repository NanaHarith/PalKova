"""Menu seed, listing, today's stock and the spoken-name resolver."""

import difflib
import json
import re
import sqlite3
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from app.config import ROOT
from app.db import tx


def seed_menu(conn: sqlite3.Connection, path: str | Path = ROOT / "config" / "menu.json") -> int:
    """Insert the menu file into an empty menu_items table; return rows inserted."""
    if conn.execute("SELECT 1 FROM menu_items LIMIT 1").fetchone():
        return 0
    items = json.loads(Path(path).read_text(encoding="utf-8"))
    with tx(conn):
        for n, i in enumerate(items):
            conn.execute(
                "INSERT INTO menu_items (id, short_id, name, category, price_cents, description,"
                " dietary, spice_default, aliases, par_level, available, sort)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (i["id"], i["short_id"], i["name"], i["category"], i["price_cents"],
                 i["description"], json.dumps(i["dietary"]), i["spice_default"],
                 json.dumps(i["aliases"]), i["par_level"], int(i["available"]), n),
            )
    return len(items)


def list_menu(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM menu_items ORDER BY sort").fetchall()
    return [
        {**dict(r), "dietary": json.loads(r["dietary"]), "aliases": json.loads(r["aliases"]),
         "available": bool(r["available"])}
        for r in rows
    ]


def today_bounds_utc(tz: str, now: datetime | None = None) -> tuple[str, str]:
    """UTC ISO [start, end) of the restaurant-local day containing `now`."""
    zone = ZoneInfo(tz)
    day = (now or datetime.now(timezone.utc)).astimezone(zone).date()
    start = datetime.combine(day, time.min, tzinfo=zone)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=zone)
    return (start.astimezone(timezone.utc).isoformat(), end.astimezone(timezone.utc).isoformat())


def sold_today(conn: sqlite3.Connection, tz: str, now: datetime | None = None) -> dict[str, int]:
    start, end = today_bounds_utc(tz, now)
    # money in flight (capturing, capture_pending) holds stock until it settles or reverts
    rows = conn.execute(
        "SELECT items FROM orders WHERE (status IN ('paid','ready','picked_up')"
        " AND paid_at >= ? AND paid_at < ?) OR status IN ('capturing','capture_pending')",
        (start, end),
    ).fetchall()
    sold: dict[str, int] = {}
    for r in rows:
        for line in json.loads(r["items"]):
            sold[line["item_id"]] = sold.get(line["item_id"], 0) + line["qty"]
    return sold


def remaining_stock(conn: sqlite3.Connection, item_id: str, tz: str, now: datetime | None = None) -> int:
    row = conn.execute("SELECT par_level FROM menu_items WHERE id = ?", (item_id,)).fetchone()
    return max(0, row["par_level"] - sold_today(conn, tz, now).get(item_id, 0))


def sales_by_hour(conn: sqlite3.Connection, tz: str, now: datetime | None = None) -> dict[str, list[int]]:
    """Per item, quantities paid today per restaurant-local hour (settled orders only; in-flight captures have no
    paid_at yet)."""
    start, end = today_bounds_utc(tz, now)
    zone, hours = ZoneInfo(tz), {}
    for r in conn.execute("SELECT items, paid_at FROM orders WHERE status IN ('paid','ready','picked_up')"
                          " AND paid_at >= ? AND paid_at < ?", (start, end)):
        hour = datetime.fromisoformat(r["paid_at"]).astimezone(zone).hour
        for line in json.loads(r["items"]):
            hours.setdefault(line["item_id"], [0] * 24)[hour] += line["qty"]
    return hours


def menu_with_stats(conn: sqlite3.Connection, tz: str) -> dict:
    sold, hours = sold_today(conn, tz), sales_by_hour(conn, tz)
    items = [{**i, "sold_today": sold.get(i["id"], 0), "remaining": max(0, i["par_level"] - sold.get(i["id"], 0)),
              "sales_by_hour": hours.get(i["id"], [0] * 24)} for i in list_menu(conn)]
    return {"items": items, "sales_by_hour": [sum(h) for h in zip(*hours.values())] if hours else [0] * 24}


PUBLIC_FIELDS = ("id", "name", "category", "description", "price_cents", "dietary", "spice_default")


def public_menu(conn: sqlite3.Connection, tz: str) -> list[dict]:
    """What a customer may see: dish facts and whether it can be ordered now. No stock levels or sales."""
    sold = sold_today(conn, tz)
    return [{**{k: i[k] for k in PUBLIC_FIELDS}, "orderable": orderable(i, max(0, i["par_level"] - sold.get(i["id"], 0)))}
            for i in list_menu(conn)]


def update_item(conn: sqlite3.Connection, item_id: str, changes: dict) -> dict | None:
    """Apply price_cents / par_level / available / spice_default to a menu item; None if the item is unknown."""
    if changes:
        cols = {k: v if k == "spice_default" else int(v) for k, v in changes.items()}  # available is stored as 0/1
        with tx(conn):
            conn.execute(f"UPDATE menu_items SET {', '.join(f'{k}=?' for k in cols)} WHERE id=?",
                         (*cols.values(), item_id))
    return next((i for i in list_menu(conn) if i["id"] == item_id), None)


def orderable(item: dict, remaining: int) -> bool:
    return item["available"] and remaining > 0


def menu_for_prompt(
    conn: sqlite3.Connection, tz: str, now: datetime | None = None
) -> tuple[list[dict], list[dict]]:
    sold = sold_today(conn, tz, now)
    ok: list[dict] = []
    out: list[dict] = []
    for i in list_menu(conn):
        i["remaining"] = max(0, i["par_level"] - sold.get(i["id"], 0))
        (ok if orderable(i, i["remaining"]) else out).append(i)
    return ok, out


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def resolve_item(
    conn: sqlite3.Connection, text: str, tz: str, now: datetime | None = None
) -> dict | None:
    """Resolve a spoken dish name or id to an orderable menu item, else None."""
    items = menu_for_prompt(conn, tz, now)[0]
    raw, norm = text.strip().lower(), _norm(text)
    if not norm:
        return None
    spoken = [t for t in norm.split() if len(t) >= 3]

    def token_match(i: dict) -> bool:
        return all(any(n.startswith(s) for s in spoken) for n in _norm(i["name"]).split())

    steps = (
        lambda i: raw in (i["id"].lower(), i["short_id"].lower()),
        lambda i: _norm(i["name"]) == norm,
        lambda i: norm in map(_norm, i["aliases"]),
        token_match,
    )
    for step in steps:
        hits = [i for i in items if step(i)]
        if len(hits) == 1:
            return hits[0]
    # First-best difflib hit; ties across items are not detected
    names = {_norm(n): i for i in items for n in [i["name"], *i["aliases"]]}
    close = difflib.get_close_matches(norm, list(names), n=1, cutoff=0.82)
    return names[close[0]] if close else None
