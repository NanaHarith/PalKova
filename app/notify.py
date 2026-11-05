"""Fan-out callbacks for capture: dashboard event, spoken line on the live call, SMS."""
from typing import Callable

from app.events import Hub
from app.sms import Sms, paid_text


def make_on_paid(hub: Hub, sms: Sms, restaurant: dict) -> Callable[[dict], None]:
    def on_paid(order: dict) -> None:
        n, minutes = order["number"], restaurant["ready_minutes"]
        hub.publish("order.paid", order)
        if order.get("conversation_id"):
            hub.speak(order["conversation_id"],
                      f"Got your payment for order {n}. It'll be ready in about {minutes} minutes.",
                      f"SYSTEM: order {n} is paid. Thank the caller and end the call.")
        if order.get("sms_consent_at") and order.get("customer_phone"):
            sms.send(order["customer_phone"], paid_text(restaurant["name"], n, minutes))
    return on_paid


def make_on_sold_out(hub: Hub, restaurant: dict) -> Callable[[dict, list[str]], None]:
    def on_sold_out(order: dict, names: list[str]) -> None:
        hub.publish("order.cancelled", order)
        if order.get("conversation_id"):
            hub.speak(order["conversation_id"],
                      f"Sorry, {' and '.join(names)} just sold out, so I haven't charged you.",
                      f"SYSTEM: order {order['number']} was cancelled because an item sold out. Nothing was charged.")
    return on_sold_out
