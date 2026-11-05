"""Order line validation, merging, money totals and spoken amounts. Pure functions, integer cents only."""
import hashlib
import json

MAX_QTY = 10
MAX_LINES = 20


class LineError(ValueError):
    """Invalid order lines; `code` is one of qty_range, too_many_lines, empty."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def merge_lines(lines: list[dict]) -> list[dict]:
    """Merge lines with the same (item_id, spice): sum qty, join notes with '; '. First-seen order."""
    merged: dict[tuple, dict] = {}
    for ln in lines:
        key = (ln["item_id"], ln.get("spice"))
        if key not in merged:
            merged[key] = dict(ln)
            continue
        cur = merged[key]
        cur["qty"] += ln["qty"]
        if ln.get("note"):
            cur["note"] = f"{cur['note']}; {ln['note']}" if cur.get("note") else ln["note"]
    return list(merged.values())


def validate_lines(lines: list[dict]) -> None:
    """Raise LineError for no lines, more than 20 merged lines, or any qty not an int in 1-10 after merging."""
    if any(type(ln.get("qty")) is not int for ln in lines):  # not bool, float or str: money stays integer
        raise LineError("qty_range")
    merged = merge_lines(lines)
    if not merged:
        raise LineError("empty")
    if len(merged) > MAX_LINES:
        raise LineError("too_many_lines")
    if any(not 1 <= ln["qty"] <= MAX_QTY for ln in merged):
        raise LineError("qty_range")


def compute_totals(priced_lines: list[dict], tax_rate_bps: int) -> dict:
    lines = [{**ln, "line_cents": ln["unit_price_cents"] * ln["qty"]} for ln in priced_lines]
    subtotal = sum(ln["line_cents"] for ln in lines)
    tax = (subtotal * tax_rate_bps + 5000) // 10000
    return {"lines": lines, "subtotal_cents": subtotal, "tax_cents": tax, "total_cents": subtotal + tax}


def items_hash(lines: list[dict]) -> str:
    key = sorted((ln["item_id"], ln["qty"], ln.get("spice") or "") for ln in lines)
    return hashlib.sha256(json.dumps(key).encode()).hexdigest()


def cents_to_str(cents: int) -> str:
    return f"${cents // 100}.{cents % 100:02d}"


_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen"
).split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _words(n: int) -> str:
    """0-9999 in English words."""
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + (f"-{_ONES[n % 10]}" if n % 10 else "")
    if n < 1000:
        return f"{_ONES[n // 100]} hundred" + (f" {_words(n % 100)}" if n % 100 else "")
    return f"{_ONES[n // 1000]} thousand" + (f" {_words(n % 1000)}" if n % 1000 else "")


def cents_to_words(cents: int) -> str:
    """Spoken amount for TTS, e.g. 2450 -> 'twenty-four dollars and fifty cents'. Supports up to $9,999.99."""
    dollars, c = divmod(cents, 100)
    parts = []
    if dollars or not c:
        parts.append(f"{_words(dollars)} dollar{'' if dollars == 1 else 's'}")
    if c:
        parts.append(f"{_words(c)} cent{'' if c == 1 else 's'}")
    return " and ".join(parts)
