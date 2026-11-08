"""Settings from the environment (.env locally, env vars on the host) and the restaurant config file."""
import json
import os
from dataclasses import dataclass, fields
from functools import cache
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    """One field per environment variable, lowercase."""

    public_base_url: str = ""
    database_path: str = "./data/palkova.db"
    restaurant_tz: str = "America/New_York"
    owner_password: str = ""
    session_secret: str = ""
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_sms_from: str = ""
    twilio_messaging_service_sid: str = ""
    forward_number: str = ""
    call_limit_exempt_number: str = ""
    llm_provider: str = "openai"
    llm_model: str = ""
    command_llm_model: str = ""
    studio_llm_model: str = ""
    llm_api_key: str = ""
    paypal_client_id: str = ""
    paypal_client_secret: str = ""
    paypal_webhook_id: str = ""
    paypal_plan_id: str = ""
    vite_paypal_client_id: str = ""
    vite_ag_grid_license: str = ""
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    db_snapshot_bucket: str = ""
    vapi_api_key: str = ""
    vapi_public_key: str = ""
    vapi_webhook_secret: str = ""


@cache
def get_settings() -> Settings:
    load_dotenv(ROOT / ".env")  # real env vars win over .env
    return Settings(**{f.name: os.environ.get(f.name.upper()) or f.default for f in fields(Settings)})


@cache
def restaurant() -> dict:
    return json.loads((ROOT / "config" / "restaurant.json").read_text(encoding="utf-8"))
