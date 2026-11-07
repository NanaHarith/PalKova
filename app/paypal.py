"""PayPal: Orders and Subscriptions via the server SDK, webhook verify and raw REST via httpx."""
import json
import time
from decimal import Decimal
from typing import Mapping

import httpx
from paypalserversdk.exceptions.error_exception import ErrorException
from paypalserversdk.http.auth.o_auth_2 import ClientCredentialsAuthCredentials
from paypalserversdk.models.cancel_subscription_request import CancelSubscriptionRequest
from paypalserversdk.models.refund_request import RefundRequest
from paypalserversdk.paypal_serversdk_client import Environment, PaypalServersdkClient

from app.config import restaurant

DECLINES = {"INSTRUMENT_DECLINED", "ORDER_NOT_APPROVED"}
# below SQLite's busy_timeout (app/db.py): a create held inside a write tx must not outlast the waiters
SDK_TIMEOUT_SECONDS = 10


def _money(cents: int) -> dict:
    return {"currency_code": "USD", "value": f"{cents // 100}.{cents % 100:02d}"}


def _cents(value: str) -> int:
    return int(Decimal(value) * 100)


def _usd_cents(amount: dict) -> int | None:
    """None for any other currency, which never equals an order total, so it reads as an amount mismatch."""
    return _cents(amount["value"]) if amount["currency_code"] == "USD" else None


class PayPal:
    def __init__(self, client_id: str, client_secret: str, base_url: str = "https://api-m.sandbox.paypal.com",
                 http: httpx.Client | None = None, sdk=None):
        self.client_id, self.client_secret, self.base_url = client_id, client_secret, base_url.rstrip("/")
        self.http = http or httpx.Client(timeout=30)
        self.sdk = sdk or PaypalServersdkClient(
            client_credentials_auth_credentials=ClientCredentialsAuthCredentials(
                o_auth_client_id=client_id, o_auth_client_secret=client_secret),
            environment=Environment.SANDBOX, timeout=SDK_TIMEOUT_SECONDS)
        self._token, self._token_exp = "", 0.0
        self._toolkit = None

    def _auth(self) -> str:
        if time.time() >= self._token_exp:
            r = self.http.post(f"{self.base_url}/v1/oauth2/token", auth=(self.client_id, self.client_secret),
                               data={"grant_type": "client_credentials"})
            r.raise_for_status()
            data = r.json()
            self._token, self._token_exp = data["access_token"], time.time() + data["expires_in"] - 60
        return f"Bearer {self._token}"

    def request(self, method: str, path: str, json: dict | list | None = None, params: dict | None = None) -> dict:
        r = self.http.request(method, f"{self.base_url}{path}", json=json, params=params,
                              headers={"Authorization": self._auth()})
        r.raise_for_status()
        return r.json() if r.content else {}

    def create_order(self, order: dict, generation: int) -> dict:
        oid, base = order["id"], order["base_url"].rstrip("/")
        body = {
            "intent": "CAPTURE",
            "purchase_units": [{
                "custom_id": oid,
                "invoice_id": f"pk-{oid}-{generation}",
                "amount": {**_money(order["total_cents"]), "breakdown": {
                    "item_total": _money(order["subtotal_cents"]), "tax_total": _money(order["tax_cents"])}},
                "items": [{"name": i["name"][:127], "quantity": str(i["qty"]),
                           "unit_amount": _money(i["unit_price_cents"])} for i in order["items"]],
            }],
            "payment_source": {"paypal": {"experience_context": {
                "user_action": "PAY_NOW", "shipping_preference": "NO_SHIPPING",
                "brand_name": restaurant()["name"],
                "return_url": f"{base}/pay/return", "cancel_url": f"{base}/pay/cancel",
                # Otherwise Chrome on Android hands a sandbox order to the installed (live) PayPal app,
                # which can't open it. Raw REST because the SDK's model drops this field.
                "app_switch_preference": {"launch_paypal_app": False}}}},
        }
        r = self.http.post(f"{self.base_url}/v2/checkout/orders", json=body, timeout=SDK_TIMEOUT_SECONDS,
                           headers={"Authorization": self._auth(), "PayPal-Request-Id": f"create-{oid}-{generation}"})
        r.raise_for_status()
        data = r.json()
        links = {link["rel"]: link["href"] for link in data.get("links", [])}
        return {"id": data["id"], "approve_url": links.get("payer-action") or links.get("approve"),
                "status": data["status"]}

    def get_order(self, paypal_order_id: str) -> dict:
        """Order status and amount, plus the capture (None when absent). The order turns COMPLETED as soon as
        a capture is attempted, so only `capture_status` says whether the money actually moved."""
        data = json.loads(self.sdk.orders.get_order({"id": paypal_order_id}).text)
        unit = data["purchase_units"][0]
        cap = ((unit.get("payments") or {}).get("captures") or [{}])[0]
        return {"id": data["id"], "status": data["status"], "amount_cents": _usd_cents(unit["amount"]),
                "capture_status": cap.get("status"), "capture_id": cap.get("id"),
                "capture_amount_cents": _usd_cents(cap["amount"]) if cap else None}

    def capture_order(self, paypal_order_id: str) -> dict:
        try:
            r = self.sdk.orders.capture_order({"id": paypal_order_id, "paypal_request_id": f"capture-{paypal_order_id}"})
        except ErrorException as e:
            issues = {d.get("issue") for d in json.loads(e.response.text or "{}").get("details", [])}
            if e.response.status_code == 422 and issues & DECLINES:
                return {"status": "DECLINED", "capture_id": None, "amount_cents": None}
            raise
        cap = json.loads(r.text)["purchase_units"][0]["payments"]["captures"][0]
        return {"status": cap["status"], "capture_id": cap["id"], "amount_cents": _usd_cents(cap["amount"])}

    def refund_capture(self, capture_id: str, cents: int) -> dict:
        """Refunds `cents` of one capture. The request id is per capture, so a repeat returns the same refund."""
        try:
            r = self.sdk.payments.refund_captured_payment({
                "capture_id": capture_id, "body": RefundRequest.from_dictionary({"amount": _money(cents)}),
                "paypal_request_id": f"refund-{capture_id}", "prefer": "return=representation"})
        except ErrorException as e:
            if 400 <= e.response.status_code < 500:  # PayPal said no; no money moved
                issues = {d.get("issue") for d in json.loads(e.response.text or "{}").get("details", [])}
                return {"status": "REFUSED", "refund_id": None, "issues": sorted(i for i in issues if i)}
            raise
        data = json.loads(r.text)
        return {"status": data["status"], "refund_id": data["id"], "issues": []}

    def toolkit(self, method: str, params: dict) -> dict:
        """One PayPal Agent Toolkit tool, run with this client's credentials. Installed with --no-deps (its
        framework adapters pin old openai/langchain), so it is imported here, not at startup."""
        if method == "list_transactions":
            # The toolkit sends a literal transaction_id=None, which makes PayPal return no rows; same query, minus empties.
            from paypal_agent_toolkit.shared.transactions.parameters import ListTransactionsParameters
            query = ListTransactionsParameters(**params).model_dump(exclude={"transaction_id", "search_months"})
            for k in ("start_date", "end_date"):  # the model's default dates carry no offset; PayPal 400s on that
                if query[k] and not (query[k].endswith("Z") or "+" in query[k] or "-" in query[k][11:]):
                    query[k] += "Z"
            return self.request("GET", "/v1/reporting/transactions", params={k: v for k, v in query.items() if v})
        if self._toolkit is None:
            from paypal_agent_toolkit.shared.api import PayPalAPI
            from paypal_agent_toolkit.shared.configuration import Context
            self._toolkit = PayPalAPI(self.client_id, self.client_secret, Context(sandbox=True))
        out = self._toolkit.run(method, params)
        return json.loads(out) if isinstance(out, str) else out

    def get_subscription(self, sub_id: str) -> dict:
        data = json.loads(self.sdk.subscriptions.get_subscription({"id": sub_id}).text)
        return {"id": data["id"], "status": data["status"], "plan_id": data.get("plan_id")}

    def cancel_subscription(self, sub_id: str, reason: str = "Cancelled from dashboard") -> None:
        self.sdk.subscriptions.cancel_subscription({"id": sub_id, "body": CancelSubscriptionRequest(reason=reason)})

    def verify_webhook(self, headers: Mapping[str, str], body: bytes, webhook_id: str) -> bool:
        out = self.request("POST", "/v1/notifications/verify-webhook-signature", json={
            "auth_algo": headers.get("paypal-auth-algo"), "cert_url": headers.get("paypal-cert-url"),
            "transmission_id": headers.get("paypal-transmission-id"),
            "transmission_sig": headers.get("paypal-transmission-sig"),
            "transmission_time": headers.get("paypal-transmission-time"),
            "webhook_id": webhook_id, "webhook_event": json.loads(body)})
        return out.get("verification_status") == "SUCCESS"
