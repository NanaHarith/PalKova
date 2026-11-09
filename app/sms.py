"""Twilio SMS: transactional texts only."""
import logging

from twilio.rest import Client

from app.totals import cents_to_str

log = logging.getLogger(__name__)


def payment_link_text(restaurant: str, number: str, total_cents: int, url: str) -> str:
    # The link goes last, alone on its line: phones take trailing punctuation into the link and break the token.
    return f"{restaurant}: pay for order #{number} ({cents_to_str(total_cents)}). Reply STOP to opt out.\n{url}"


def paid_text(restaurant: str, number: str, minutes: int) -> str:
    return f"{restaurant}: payment received for order #{number}. Ready in about {minutes} min."


class Sms:
    def __init__(self, account_sid: str, auth_token: str, from_number: str, messaging_service_sid: str = ""):
        self.client = Client(account_sid, auth_token)
        # A messaging service sets the sender brand; without one, send from the number.
        self.sender = {"messaging_service_sid": messaging_service_sid} if messaging_service_sid else {"from_": from_number}

    def send(self, to: str, body: str) -> str | None:
        try:
            return self.client.messages.create(to=to, body=body, **self.sender).sid
        except Exception:  # Twilio API errors and transport errors alike; never raise into capture
            log.exception("sms send failed")
            return None
