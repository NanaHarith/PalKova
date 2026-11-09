"""Owner command bar: one plain-English request becomes a grid state (AG Grid AI Toolkit schema), an answer from
PayPal's Agent Toolkit (read-only tools), or a refund proposal the owner confirms on screen. The LLM never moves
money: a refund runs only from POST /api/refunds, after the owner's confirm."""
import json
import logging
import sqlite3
from datetime import datetime, timezone
from functools import cache
from zoneinfo import ZoneInfo

import jsonschema

from app.orders import OrderError, refundable_by_number, sales_count

log = logging.getLogger(__name__)

MAX_ROUNDS = 4
# grid features the toolkit schema can carry; aggregation and pivot never appear in it
FEATURES = ["aggregation", "filter", "sort", "pivot", "columnVisibility", "columnSizing", "rowGroup"]
READ_ONLY = ("list_transactions", "list_disputes", "get_dispute")
# only these fields reach the LLM: no payer names, emails or addresses
TXN_KEYS = ("transaction_id", "transaction_event_code", "transaction_initiation_date", "transaction_amount",
            "fee_amount", "transaction_status", "invoice_id")
DISPUTE_KEYS = ("dispute_id", "reason", "status", "dispute_state", "dispute_amount", "create_time", "update_time",
                "seller_response_due_date", "dispute_life_cycle_stage", "dispute_outcome")
REFUSALS = {
    "not_found": "There's no paid order #{n} in our records.",
    "not_refundable": "Order #{n} isn't paid, so there's nothing to refund.",
    "already_refunded": "Order #{n} has already been refunded.",
}
SCREENS = {"orders": "the kitchen board (today's orders)", "menu": "the menu and stock grid"}

SYSTEM = """You are the command bar on a restaurant owner's screen. Each request is one of:
1. Change what the grid shows (filter, sort, group, columns): call set_grid_state. In gridState, set a feature to \
null to leave it unchanged; to clear a feature, return it with empty contents. Number filters always take exactly \
two conditions: when only one comparison is needed, use operator AND and make the second condition \
{{type: notBlank, filter: null, filterTo: null}}. Give a one-sentence explanation in plain words, money in \
dollars; never mention cents, column ids or filter types.
2. A question about money in PayPal (takings, transactions, disputes): use the PayPal tools, then answer in one or \
two short sentences with amounts in dollars. PayPal's transaction report can lag recent payments by a few hours; \
say so when the answer looks short.
3. A refund: when the request names an order number, call propose_refund at once; do not ask the owner to \
confirm, the screen does that before any money moves. Refunds are always for the whole order. With no order \
number, ask for it.
4. A question about how many dishes or items we sold, or our own sales by dish: call sales_count with dates from \
"now", then answer in one short sentence. For what sells with, is paired with or goes with a dish, name that \
dish and use paired_with. With no period named, use the last 30 days. If refunded_excluded is above zero, mention it.
Anything else: say in one sentence what you can do. The owner is on {screen}. Now: {now} ({tz})."""


class CommandError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _grid_tool(grid_schema: dict) -> dict:
    # The toolkit schema's refs are root-relative (#/$defs/...), so its $defs must sit at our root.
    grid_schema = dict(grid_schema)
    defs = grid_schema.pop("$defs", {})
    return {"type": "function", "function": {
        "name": "set_grid_state", "strict": True,
        "description": "Change what the grid on screen shows: filters, sort, grouping, visible columns.",
        "parameters": {"$defs": defs, "type": "object", "additionalProperties": False,
                       "properties": {"gridState": grid_schema, "explanation": {"type": "string"}},
                       "required": ["gridState", "explanation"]}}}


REFUND_TOOL = {"type": "function", "function": {
    "name": "propose_refund", "strict": True,
    "description": "Ask the owner to confirm a full refund of one of our orders, by order number. Moves no money.",
    "parameters": {"type": "object", "additionalProperties": False, "required": ["order_number"],
                   "properties": {"order_number": {"type": "string", "description": "e.g. 2278"}}}}}


SALES_TOOL = {"type": "function", "function": {
    "name": "sales_count", "strict": True,
    "description": "Counts units sold of dishes whose name contains `dish`, over paid orders in a date range; "
                   "returns per-dish quantities and dollar sales, and with a dish named, paired_with: the other dishes "
                   "ordered alongside it. No customer data.",
    "parameters": {"type": "object", "additionalProperties": False, "required": ["dish", "start_date", "end_date"],
                   "properties": {
                       "dish": {"type": "string", "description": "part of a dish name, case-insensitive; empty for all dishes"},
                       "start_date": {"type": "string", "description": "YYYY-MM-DD, inclusive, restaurant time"},
                       "end_date": {"type": "string", "description": "YYYY-MM-DD, inclusive, restaurant time"}}}}}


def _sales_result(conn: sqlite3.Connection, tz: str, args: dict) -> dict:
    try:
        r = sales_count(conn, tz, args["dish"], args["start_date"], args["end_date"])
    except ValueError:
        return {"error": "Dates must be YYYY-MM-DD."}
    return {**r, "dishes": [{"name": d["name"], "quantity": d["quantity"], "sales": f"{d['sales_cents'] / 100:.2f}"}
                            for d in r["dishes"]]}


@cache
def paypal_tools() -> tuple:
    from paypal_agent_toolkit.shared.tools import tools  # installed --no-deps; see PayPal.toolkit
    out = []
    for t in tools:
        if t["method"] not in READ_ONLY:
            continue
        params = t["args_schema"].model_json_schema()
        if t["method"] == "list_transactions":
            # The toolkit's search-by-id path passes an argument its client.get() doesn't take; dates only
            for k in ("transaction_id", "search_months"):
                params["properties"].pop(k)
        out.append({"type": "function", "function": {
            "name": t["method"], "description": t["description"], "parameters": params}})
    return tuple(out)


def _trim(method: str, out: dict) -> dict:
    if method == "list_transactions":
        # T00xx payments and T11xx refunds only: funding, transfers and fees would inflate takings
        return {"transactions": [{k: d["transaction_info"].get(k) for k in TXN_KEYS}
                                 for d in out.get("transaction_details", [])
                                 if d.get("transaction_info", {}).get("transaction_event_code", "").startswith(("T00", "T11"))]}
    if method == "list_disputes":
        return {"disputes": [{k: i.get(k) for k in DISPUTE_KEYS} for i in out.get("items", [])]}
    return {k: out.get(k) for k in DISPUTE_KEYS}


def _refund_reply(conn: sqlite3.Connection, number: str) -> dict:
    try:
        o = refundable_by_number(conn, number)
    except OrderError as e:
        return {"kind": "answer", "text": REFUSALS[e.code].format(n=number.lstrip("#"))}
    return {"kind": "refund", "order": {k: o[k] for k in (
        "id", "number", "customer_name", "channel", "status", "paid_cents", "created_at")}}


def run_command(llm, model: str, paypal, conn: sqlite3.Connection, *, tz: str, grid: str, query: str,
                current_state: dict, schema: dict, history=()) -> dict:
    """The prompt carries only the request, the owner's last few requests with the bar's replies (`history` of
    (q, a) pairs), the grid's state and schema, trimmed PayPal results, and per-dish sales totals; never order rows
    or customer names."""
    grid_tool = _grid_tool(schema)
    now = datetime.now(timezone.utc).astimezone(ZoneInfo(tz)).isoformat(timespec="minutes")
    messages = [
        {"role": "system", "content": SYSTEM.format(screen=SCREENS[grid], now=now, tz=tz)},
        *[{"role": role, "content": text} for q, a in history for role, text in (("user", q), ("assistant", a))],
        {"role": "user", "content": f"Current grid state:\n{json.dumps(current_state)}\n\nRequest: {query}"},
    ]
    for _ in range(MAX_ROUNDS):
        msg = llm.chat.completions.create(model=model, messages=messages, parallel_tool_calls=False,
                                          tools=[grid_tool, REFUND_TOOL, SALES_TOOL, *paypal_tools()]).choices[0].message
        if not msg.tool_calls:
            return {"kind": "answer", "text": msg.content or ""}
        call = msg.tool_calls[0]
        name, args = call.function.name, json.loads(call.function.arguments or "{}")
        if name == "set_grid_state":
            try:
                jsonschema.validate(args, grid_tool["function"]["parameters"])
            except jsonschema.ValidationError:
                raise CommandError("invalid_state")
            # Derived here, not by the LLM: it listed features it had just changed.
            ignore = [f for f in FEATURES if args["gridState"].get(f) is None]
            return {"kind": "grid", "state": args["gridState"], "propertiesToIgnore": ignore,
                    "explanation": args["explanation"]}
        if name == "propose_refund":
            return _refund_reply(conn, args["order_number"])
        if name == "sales_count":
            result = _sales_result(conn, tz, args)
        elif name not in READ_ONLY:
            raise CommandError("unknown_tool")
        else:
            try:
                result = _trim(name, paypal.toolkit(name, args))
            except Exception:
                log.exception("paypal toolkit %s failed", name)
                result = {"error": "PayPal didn't answer that request."}
        messages += [
            {"role": "assistant", "content": msg.content, "tool_calls": [{
                "id": call.id, "type": "function", "function": {"name": name, "arguments": call.function.arguments}}]},
            {"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)},
        ]
    return {"kind": "answer", "text": "That took too many steps. Try asking for one thing at a time."}
