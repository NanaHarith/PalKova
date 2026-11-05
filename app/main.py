"""App assembly: routes and startup."""
import asyncio
import logging
from contextlib import asynccontextmanager
from html import escape
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from mcp.server.transport_security import TransportSecuritySettings
from openai import OpenAI

from app.agent_mcp import AgentTools, RateLimiter, build_mcp
from app.config import ROOT, Settings, get_settings, restaurant
from app.db import connect, init_db
from app.events import hub
from app.menu import seed_menu
from app.notify import make_on_paid, make_on_sold_out
from app.orders import PAID_STATES, capture_if_current, expire_and_poll
from app.owner import router as owner_router
from app.paypal import PayPal
from app.sms import Sms
from app.storage import DbSnapshot
from app.subscription import subscription_handlers
from app.voice.limits import CallSlots
from app.voice.tools import MAX_TEXTS_PER_NUMBER, TEXT_WINDOW_SECONDS
from app.voice.vapi import WEB_CALLS_PER_IP, Vapi, router as vapi_router
from app.webhooks import handle_paypal_webhook, order_handlers

log = logging.getLogger(__name__)

TICK_SECONDS = 20


class _NoSms:
    """Stand-in when Twilio credentials are not configured."""

    def send(self, to: str, body: str) -> None:
        log.warning("sms not configured; dropped a message")


class CaptureBody(BaseModel):
    paypal_order_id: str


def _page(message: str) -> HTMLResponse:
    return HTMLResponse(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{escape(restaurant()['name'])}</title>"
        '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">'
        f"<p style=\"font-size:1.25rem\">{escape(message, quote=False)}</p></body>"
    )


def _result_message(r: dict) -> str:
    order = r["order"]
    paid = f"Paid — order #{order['number']}, ready in about {restaurant()['ready_minutes']} minutes." if order else ""
    match r["result"]:
        case "paid":
            return paid
        case "not_pending" if order["status"] in PAID_STATES:
            return paid
        case "not_pending" if order["status"] in ("capturing", "capture_pending"):
            return "Your payment is still processing. Please check back shortly."
        case "not_pending":
            return "This order is no longer open. You have not been charged."
        case "superseded":
            return "This link was replaced — please use the latest one we sent."
        case "declined":
            return "Payment didn't go through — please try another method."
        case "sold_out":
            return f"Sorry, {' and '.join(r['sold_out'])} sold out. You have not been charged."
        case "capture_pending":
            return "Your payment is still processing. Please check back shortly."
        case "mismatch":
            return "We couldn't confirm the payment amount, so this order isn't placed. Please ask the restaurant for help."
        case "not_approved":
            return "This payment hasn't been approved yet. Please go back and approve it in PayPal."
        case _:
            return "We couldn't find that order."


def create_app(settings: Settings | None = None, paypal=None, sms=None, llm=None) -> FastAPI:
    s = settings or get_settings()
    paypal = paypal or PayPal(s.paypal_client_id, s.paypal_client_secret)
    llm = llm or (OpenAI(api_key=s.llm_api_key) if s.llm_api_key else None)  # owner command bar
    sms = sms or (Sms(s.twilio_account_sid, s.twilio_auth_token, s.twilio_sms_from, s.twilio_messaging_service_sid)
                  if s.twilio_account_sid and s.twilio_auth_token else _NoSms())
    on_paid = make_on_paid(hub, sms, restaurant())
    on_sold_out = make_on_sold_out(hub, restaurant())

    snapshot = (DbSnapshot(s.supabase_url, s.supabase_service_role_key, s.db_snapshot_bucket)
                if s.db_snapshot_bucket else None)

    def tick() -> None:
        conn = connect(s.database_path)
        try:
            expire_and_poll(conn, paypal, tz=s.restaurant_tz, on_paid=on_paid, on_sold_out=on_sold_out)
            if snapshot:
                snapshot.save(conn)
        finally:
            conn.close()

    async def loop_forever() -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                await asyncio.to_thread(tick)
            except Exception:
                log.exception("expiry tick failed")

    agent = build_mcp(AgentTools(s, paypal, RateLimiter()))
    agent_app = agent.streamable_http_app(
        stateless_http=True, json_response=True,
        # public no-auth endpoint behind the host's proxy; rebinding protection guards localhost servers
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        Path(s.database_path).parent.mkdir(parents=True, exist_ok=True)
        if snapshot:
            snapshot.restore(s.database_path)
        conn = connect(s.database_path)
        try:
            init_db(conn)
            seed_menu(conn)
        finally:
            conn.close()
        hub.bind(asyncio.get_running_loop())
        task = asyncio.create_task(loop_forever())
        async with agent.session_manager.run():
            yield
        task.cancel()
        if snapshot:
            conn = connect(s.database_path)
            try:
                snapshot.save(conn)
            finally:
                conn.close()

    app = FastAPI(title="PalKova", lifespan=lifespan)
    app.state.settings = s
    app.state.paypal, app.state.sms, app.state.llm = paypal, sms, llm
    app.state.on_paid, app.state.on_sold_out = on_paid, on_sold_out
    app.state.tz = s.restaurant_tz
    app.state.call_slots = CallSlots()
    app.state.text_limiter = RateLimiter(MAX_TEXTS_PER_NUMBER, TEXT_WINDOW_SECONDS)
    app.state.vapi, app.state.vapi_calls = Vapi(s.vapi_public_key), {}
    app.state.web_call_limiter = RateLimiter(WEB_CALLS_PER_IP, 3600)
    app.include_router(owner_router)
    app.include_router(vapi_router)
    app.router.routes.extend(agent_app.routes)  # a Mount would 307 POST /mcp to /mcp/

    def capture(pid: str) -> dict:
        conn = connect(s.database_path)
        try:
            return capture_if_current(conn, paypal, pid, tz=s.restaurant_tz, on_paid=on_paid, on_sold_out=on_sold_out)
        finally:
            conn.close()

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.post("/paypal/webhook")
    async def paypal_webhook(request: Request) -> Response:
        raw, headers = await request.body(), request.headers

        def run() -> int:
            conn = connect(s.database_path)
            try:
                handlers = {**order_handlers(conn, paypal, tz=s.restaurant_tz, on_paid=on_paid, on_sold_out=on_sold_out),
                            **subscription_handlers(conn, paypal)}
                return handle_paypal_webhook(conn, paypal, headers, raw,
                                             webhook_id=s.paypal_webhook_id, handlers=handlers)
            finally:
                conn.close()

        return Response(status_code=await asyncio.to_thread(run))

    @app.get("/pay/return")
    def pay_return(token: str):
        return _page(_result_message(capture(token)))

    @app.get("/pay/cancel")
    def pay_cancel():
        return _page("Payment cancelled. Your order is not placed until it's paid.")

    @app.post("/api/pay/capture")
    def pay_capture(body: CaptureBody):
        r = capture(body.paypal_order_id)
        o = r["order"]  # status tells the page whether a not_pending order is already paid
        return {"result": r["result"], "order_number": o["number"] if o else None, "status": o["status"] if o else None}

    dist = ROOT / "web" / "dist"
    if dist.is_dir():  # built by `npm run build`; absent in tests and API-only runs
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/")
        @app.get("/owner")
        def spa():
            return FileResponse(dist / "index.html")

    return app


app = create_app()
