"""Owner routes: password login with a signed cookie, and the subscription controls."""
import asyncio
import hmac
import json
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from openai import APIStatusError
from pydantic import BaseModel, ConfigDict, Field

from app.config import restaurant
from app.db import connect
from app.events import hub
from app.menu import menu_with_stats, public_menu, update_item
from app.command import CommandError, run_command
from app.orders import OrderError, check_refundable, dismiss_alert, get_order, recent_orders, transition
from app.studio import sse, turn_request
from app.subscription import _row, cancel, line_is_active, store_subscription, sync

COOKIE = "pk_owner"
MAX_AGE = 7 * 24 * 3600
HEARTBEAT_SECONDS = 15

router = APIRouter()


class LoginBody(BaseModel):
    password: str


class SubscriptionBody(BaseModel):
    subscription_id: str


def _signer(request: Request) -> URLSafeTimedSerializer:
    secret = request.app.state.settings.session_secret
    if not secret:  # an empty key signs and verifies, so anyone could forge the owner cookie
        raise HTTPException(503, "SESSION_SECRET is not set")
    return URLSafeTimedSerializer(secret, salt=COOKIE)


def require_owner(request: Request) -> None:
    try:
        _signer(request).loads(request.cookies.get(COOKIE, ""), max_age=MAX_AGE)
    except BadSignature:
        raise HTTPException(401)


@router.post("/owner/login")
def login(body: LoginBody, request: Request, response: Response):
    s = request.app.state.settings
    if not s.owner_password or not hmac.compare_digest(body.password.encode(), s.owner_password.encode()):
        raise HTTPException(401)
    response.set_cookie(COOKIE, _signer(request).dumps("owner"), max_age=MAX_AGE, httponly=True, samesite="lax",
                        secure=s.public_base_url.startswith("https"))
    return {"ok": True}


def _subscription(request: Request, action) -> dict:
    conn = connect(request.app.state.settings.database_path)
    try:
        action(conn)
        row = _row(conn)
        return {"status": row.get("status"), "active": line_is_active(conn),
                "paypal_subscription_id": row.get("paypal_subscription_id"), "checked_at": row.get("checked_at")}
    finally:
        conn.close()


@contextmanager
def _db(request: Request):
    conn = connect(request.app.state.settings.database_path)
    try:
        yield conn
    finally:
        conn.close()


class OrderAction(BaseModel):
    action: Literal["ready", "picked_up", "cancel"]


class AlertDismiss(BaseModel):
    alert: str


class MenuPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    price_cents: int | None = Field(None, ge=1)
    par_level: int | None = Field(None, ge=0)
    available: bool | None = None
    spice_default: Literal["mild", "medium", "hot"] | None = None  # sent as null: the dish has no spice level


@router.get("/api/orders", dependencies=[Depends(require_owner)])
def list_orders(request: Request, days: int = Query(1, ge=1, le=90)):
    with _db(request) as conn:
        return recent_orders(conn, request.app.state.tz, days)


@router.patch("/api/orders/{order_id}", dependencies=[Depends(require_owner)])
def patch_order(order_id: str, body: OrderAction, request: Request):
    with _db(request) as conn:
        try:
            order = transition(conn, order_id, body.action)
        except OrderError as e:
            raise HTTPException(404 if e.code == "not_found" else 409, e.code)
    hub.publish("order.updated", order)
    return order


@router.post("/api/orders/{order_id}/dismiss", dependencies=[Depends(require_owner)])
def dismiss_order_alert(order_id: str, body: AlertDismiss, request: Request):
    with _db(request) as conn:
        try:
            order = dismiss_alert(conn, order_id, body.alert)
        except OrderError as e:
            raise HTTPException(404 if e.code == "not_found" else 409, e.code)
    hub.publish("order.updated", order)
    return order


@router.get("/api/menu", dependencies=[Depends(require_owner)])
def get_menu(request: Request):
    with _db(request) as conn:
        return menu_with_stats(conn, request.app.state.tz)


@router.patch("/api/menu/{item_id}", dependencies=[Depends(require_owner)])
def patch_menu(item_id: str, body: MenuPatch, request: Request):
    changes = body.model_dump(exclude_none=True)
    if "spice_default" in body.model_fields_set:
        changes["spice_default"] = body.spice_default
    with _db(request) as conn:
        item = update_item(conn, item_id, changes)
    if item is None:
        raise HTTPException(404)
    hub.publish("menu.updated", item)
    return item


class Exchange(BaseModel):
    q: str = Field(max_length=500)
    a: str = Field(max_length=500)


class CommandBody(BaseModel):
    grid: Literal["orders", "menu"]
    query: str = Field(min_length=1, max_length=300)
    current_state: dict
    grid_schema: dict = Field(alias="schema")
    history: list[Exchange] = Field(default_factory=list, max_length=3)


class RefundBody(BaseModel):
    order_id: str


@router.post("/api/command", dependencies=[Depends(require_owner)])
def command(body: CommandBody, request: Request):
    llm = request.app.state.llm
    if llm is None:
        raise HTTPException(503, "llm_not_configured")
    with _db(request) as conn:
        try:
            s = request.app.state.settings
            return run_command(llm, s.command_llm_model or s.llm_model, request.app.state.paypal, conn,
                               tz=request.app.state.tz, grid=body.grid, query=body.query,
                               current_state=body.current_state, schema=body.grid_schema,
                               history=[(h.q, h.a) for h in body.history])
        except CommandError as e:
            raise HTTPException(422, e.code)


@router.post("/api/studio/responses", dependencies=[Depends(require_owner)])
def studio_turn(body: dict, request: Request):
    """One turn of the Takings dashboard's agents. Errors go back as JSON, which Studio's adapter reads."""
    llm, s = request.app.state.llm, request.app.state.settings
    if llm is None:
        return JSONResponse({"error": {"message": "The assistant isn't set up on this server."}}, 503)
    try:
        stream = llm.responses.create(**turn_request(body, s.studio_llm_model or s.command_llm_model or s.llm_model))
    except APIStatusError as e:
        return JSONResponse({"error": {"message": e.message}}, e.status_code)
    return StreamingResponse(sse(stream), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


@router.post("/api/refunds", dependencies=[Depends(require_owner)])
def refund(body: RefundBody, request: Request):
    """The owner's confirm from the command bar: full refund of our own capture; the webhook raises the alert."""
    with _db(request) as conn:
        try:
            order = check_refundable(get_order(conn, body.order_id))
        except OrderError as e:
            raise HTTPException(404 if e.code == "not_found" else 409, e.code)
    r = request.app.state.paypal.refund_capture(order["capture_id"], order["paid_cents"])
    if r["status"] == "REFUSED":
        raise HTTPException(409, "refused: " + ", ".join(r["issues"]))
    return {"status": r["status"], "refund_id": r["refund_id"], "order_number": order["number"],
            "amount_cents": order["paid_cents"]}


@router.get("/api/events", dependencies=[Depends(require_owner)])
async def events():
    async def stream():
        q = hub.subscribe()
        try:
            while True:
                try:
                    name, data = await asyncio.wait_for(q.get(), HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"event: {name}\ndata: {json.dumps(data)}\n\n"
        finally:
            hub.unsubscribe(q)
    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/api/line")
def line(request: Request):
    with _db(request) as conn:
        return {"active": line_is_active(conn), "restaurant": restaurant()["name"],
                "ready_minutes": restaurant()["ready_minutes"], "busy": request.app.state.call_slots.full}


@router.get("/api/public/menu")
def menu_public(request: Request):
    with _db(request) as conn:
        return public_menu(conn, request.app.state.tz)


@router.get("/api/config")
def public_config(request: Request):
    s = request.app.state.settings
    return {"paypal_client_id": s.paypal_client_id, "plan_id": s.paypal_plan_id}


@router.get("/api/subscription", dependencies=[Depends(require_owner)])
def get_subscription(request: Request):
    return _subscription(request, lambda conn: None)


@router.post("/api/subscription", dependencies=[Depends(require_owner)])
def post_subscription(body: SubscriptionBody, request: Request):
    paypal, plan_id = request.app.state.paypal, request.app.state.settings.paypal_plan_id

    def store(conn):
        try:
            store_subscription(conn, paypal, body.subscription_id, plan_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return _subscription(request, store)


@router.post("/api/subscription/sync", dependencies=[Depends(require_owner)])
def sync_subscription(request: Request):
    return _subscription(request, lambda conn: sync(conn, request.app.state.paypal))


@router.post("/api/subscription/cancel", dependencies=[Depends(require_owner)])
def cancel_subscription(request: Request):
    return _subscription(request, lambda conn: cancel(conn, request.app.state.paypal))
