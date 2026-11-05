"""Vapi phone channel: one webhook maps Vapi's server messages onto VoiceTools.

The phone number carries no assistant, so every inbound call starts with an assistant-request: the line gate
and call limits run there, and a refused call hears the error text. Calls are steered through each call's
control URL, which can hang up or transfer the call: it is never logged and never sent to a browser."""

import asyncio
import hmac
import json
import logging
import time
from dataclasses import dataclass

import httpx
from fastapi import APIRouter, Request, Response

from app.config import restaurant
from app.db import connect, now_utc, tx
from app.events import hub
from app.menu import menu_for_prompt
from app.subscription import line_is_active
from app.voice.limits import MAX_CALL_SECONDS, MAX_CALLS_PER_NUMBER, calls_from
from app.voice.prompt import build_prompt
from app.voice.tools import TOOL_SCHEMAS, Conversation, VoiceTools

log = logging.getLogger(__name__)

WEBHOOK_PATH = "/voice/vapi"
SECRET_HEADER = "X-Vapi-Secret"
PARAMS = {t["function"]["name"]: list(t["function"]["parameters"]["properties"]) for t in TOOL_SCHEMAS}
SWEEP_AFTER_SECONDS = MAX_CALL_SECONDS + 120  # a call whose end message never came

router = APIRouter()


class Vapi:
    def __init__(self, public_key: str):
        self.public_key = public_key  # control URLs require it once controlAuthenticationEnabled is on

    async def control(self, url: str, body: dict) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(url, json=body, headers={"Authorization": f"Bearer {self.public_key}"})
        except httpx.HTTPError as e:  # the exception text carries the URL: log the type only
            log.warning("vapi control %s failed: %s", body["type"], type(e).__name__)
            return False
        if r.status_code >= 300:
            log.warning("vapi control %s returned %s", body["type"], r.status_code)
        return r.status_code < 300


@dataclass
class LiveCall:
    conv: Conversation
    vapi: Vapi
    forward_number: str
    started: float
    tools: VoiceTools | None = None
    control_url: str | None = None

    async def _control(self, body: dict) -> bool:
        return bool(self.control_url) and await self.vapi.control(self.control_url, body)

    async def hangup(self) -> None:
        await self._control({"type": "end-call"})

    async def transfer(self) -> bool:
        return await self._control({"type": "transfer", "content": "Putting you through now.",
                                    "destination": {"type": "number", "number": self.forward_number}})

    async def say(self, text: str, system_note: str) -> None:
        """Hub speaker: payment and sold-out news while the caller is still on the line."""
        await self._control({"type": "say", "content": text})
        await self._control({"type": "add-message", "message": {"role": "system", "content": system_note},
                             "triggerResponseEnabled": False})


def assistant_config(s, items: list[dict], sold_out: list[dict]) -> dict:
    r = restaurant()
    return {
        "firstMessage": f"Hi, this is {r['name']}. What can I get you today?",
        "model": {"provider": "openai", "model": s.llm_model or "gpt-4.1-mini", "temperature": 0.3,
                  "messages": [{"role": "system", "content": build_prompt(r, items, sold_out)}],
                  "tools": [{"type": "function", "function": t["function"]} for t in TOOL_SCHEMAS]},
        "voice": {"provider": "vapi", "voiceId": "Rohan"},
        "transcriber": {"provider": "deepgram", "model": "nova-3", "language": "en",
                        "keyterm": [i["name"] for i in items]},
        "maxDurationSeconds": MAX_CALL_SECONDS,
        "server": {"url": s.public_base_url.rstrip("/") + WEBHOOK_PATH,
                   "headers": {SECRET_HEADER: s.vapi_webhook_secret}},
        "serverMessages": ["tool-calls", "status-update", "end-of-call-report"],
        "monitorPlan": {"controlEnabled": True, "controlAuthenticationEnabled": True},
    }


def _caller(msg: dict) -> str:
    customer = msg.get("customer") or (msg.get("call") or {}).get("customer") or {}
    return customer.get("number") or "anonymous"  # hidden numbers share one count


def _assistant_request(app, msg: dict) -> dict:
    s, name = app.state.settings, restaurant()["name"]
    cid, caller = (msg.get("call") or {}).get("id"), _caller(msg)
    if not cid:
        return {"error": "Sorry, something went wrong. Please call back."}
    conn = connect(s.database_path)
    try:
        if not line_is_active(conn):
            return {"error": f"Sorry, {name} isn't taking phone orders right now."}
        if cid not in app.state.vapi_calls:
            if caller != s.call_limit_exempt_number and calls_from(conn, caller) >= MAX_CALLS_PER_NUMBER:
                return {"error": "Sorry, this number has called too often today. Please try again later."}
            if not app.state.call_slots.acquire():
                return {"error": "Sorry, all our lines are busy. Please call back in a few minutes."}
            with tx(conn):
                conn.execute("INSERT OR IGNORE INTO conversations (id, channel, from_number, started_at) "
                             "VALUES (?, 'phone', ?, ?)", (cid, caller, now_utc()))
            live = LiveCall(Conversation(cid, "phone", None if caller == "anonymous" else caller),
                            app.state.vapi, s.forward_number, time.monotonic())

            async def no_screen(kind: str, data: dict) -> None:  # a phone call has no page to update
                return None

            live.tools = VoiceTools(lambda: connect(s.database_path), app.state.paypal, app.state.sms, restaurant(),
                                    s, no_screen, live.hangup, live.transfer if s.forward_number else None,
                                    app.state.text_limiter)
            app.state.vapi_calls[cid] = live
        items, sold_out = menu_for_prompt(conn, s.restaurant_tz)
    finally:
        conn.close()
    return {"assistant": assistant_config(s, items, sold_out)}


def _end(app, cid: str | None) -> None:
    live = app.state.vapi_calls.pop(cid, None)
    if live is None:
        return
    app.state.call_slots.release()
    hub.unregister(cid)
    conn = connect(app.state.settings.database_path)
    try:
        with tx(conn):
            conn.execute("UPDATE conversations SET ended_at=? WHERE id=?", (now_utc(), cid))
    finally:
        conn.close()


async def _run_tool(live: LiveCall | None, tc: dict) -> dict:
    fn = tc.get("function") or {}
    name, args = fn.get("name"), fn.get("arguments") or {}
    try:
        args = json.loads(args) if isinstance(args, str) else args
        if live is None:
            result = {"error": "call_not_found"}
        elif name not in PARAMS or not isinstance(args, dict):
            result = {"error": "unknown_tool"}
        else:
            result = await getattr(live.tools, name)(live.conv, **{k: args[k] for k in PARAMS[name] if k in args})
    except (ValueError, TypeError):  # bad JSON, or a required argument missing
        result = {"error": "bad_arguments"}
    return {"name": name, "toolCallId": tc.get("id"), "result": json.dumps(result)}


@router.post(WEBHOOK_PATH)
async def vapi_webhook(request: Request):
    secret = request.app.state.settings.vapi_webhook_secret
    if not secret:
        return Response(status_code=503)
    if not hmac.compare_digest(request.headers.get(SECRET_HEADER, "").encode(), secret.encode()):
        return Response(status_code=401)
    try:
        msg = (await request.json()).get("message") or {}
    except (ValueError, AttributeError):
        return Response(status_code=400)
    app, calls = request.app, request.app.state.vapi_calls
    for cid in [c for c, live in calls.items() if time.monotonic() - live.started > SWEEP_AFTER_SECONDS]:
        _end(app, cid)

    kind, call = msg.get("type"), msg.get("call") or {}
    if kind == "assistant-request":
        return await asyncio.to_thread(_assistant_request, app, msg)
    live = calls.get(call.get("id"))
    if live and not live.control_url and (url := (call.get("monitor") or {}).get("controlUrl")):
        live.control_url = url
        hub.register(live.conv.conversation_id, live)
    if kind == "tool-calls":
        return {"results": [await _run_tool(live, tc) for tc in msg.get("toolCallList") or []]}
    if kind == "end-of-call-report" or (kind == "status-update" and msg.get("status") == "ended"):
        _end(app, call.get("id"))
    return {}
