"""One-shot PayPal sandbox setup: catalog product, subscription billing plan and webhook.

Run once from the repo root, after the app is deployed and PUBLIC_BASE_URL points at it:

    python -m scripts.setup_paypal

Reads PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PUBLIC_BASE_URL from .env / the environment.
The product and plan are created fresh on every run. The webhook is reused when one already exists
for the same URL (PayPal rejects duplicates), with its event list replaced by EVENTS. Paste the two printed lines into .env and the host's environment.
"""
import sys

from app.config import get_settings
from app.paypal import PayPal

EVENTS = [
    "CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REVERSED",
    "PAYMENT.CAPTURE.REFUNDED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.CANCELLED",
    "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
    "PAYMENT.SALE.COMPLETED",
]


def main() -> None:
    s = get_settings()
    missing = [n for n in ("paypal_client_id", "paypal_client_secret", "public_base_url") if not getattr(s, n)]
    if missing:
        sys.exit(f"Missing in .env: {', '.join(n.upper() for n in missing)}")
    paypal = PayPal(s.paypal_client_id, s.paypal_client_secret)

    product = paypal.request("POST", "/v1/catalogs/products", {
        "name": "Kaveri Kitchen AI ordering line", "type": "SERVICE", "category": "SOFTWARE"})
    # Raw JSON, not the SDK's PlanRequest: its parser turns total_cycles 0 (renew forever) into 1, which
    # ends the subscription after its first paid month.
    plan_id = paypal.request("POST", "/v1/billing/plans", {
        "product_id": product["id"], "name": "Kaveri Kitchen AI ordering line", "status": "ACTIVE",
        "billing_cycles": [
            {"frequency": {"interval_unit": "DAY", "interval_count": 7}, "tenure_type": "TRIAL",
             "sequence": 1, "total_cycles": 1},
            {"frequency": {"interval_unit": "MONTH", "interval_count": 1}, "tenure_type": "REGULAR",
             "sequence": 2, "total_cycles": 0,
             "pricing_scheme": {"fixed_price": {"currency_code": "USD", "value": "99.00"}}},
        ],
        "payment_preferences": {"auto_bill_outstanding": True, "payment_failure_threshold": 3,
                                "setup_fee": {"currency_code": "USD", "value": "0"}},
    })["id"]

    url = f"{s.public_base_url.rstrip('/')}/paypal/webhook"
    events = [{"name": n} for n in EVENTS]
    existing = paypal.request("GET", "/v1/notifications/webhooks").get("webhooks", [])
    hook = next((h for h in existing if h["url"] == url), None)
    if not hook:
        hook = paypal.request("POST", "/v1/notifications/webhooks", {"url": url, "event_types": events})
    elif sorted(e["name"] for e in hook["event_types"]) != sorted(EVENTS):
        # A reused webhook may predate an event we now handle; PayPal rejects a PATCH that changes nothing.
        paypal.request("PATCH", f"/v1/notifications/webhooks/{hook['id']}",
                       [{"op": "replace", "path": "/event_types", "value": events}])

    print("Paste these two lines into .env and the host's environment:")
    print(f"PAYPAL_PLAN_ID={plan_id}")
    print(f"PAYPAL_WEBHOOK_ID={hook['id']}")


if __name__ == "__main__":
    main()
