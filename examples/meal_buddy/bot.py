"""Meal Buddy: a Discord bot that pings at meal times and orders food through Grok and a restaurant's MCP server.

Grok (xAI Responses API) calls the restaurant's remote MCP tools itself: search_menu, create_order,
get_order_status. The human pays by opening the PayPal link; the bot never sees payment details.
Once an order exists the bot polls its status straight from the MCP server and reports the ready time.
"""

import asyncio
import json
import os
import re
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

import discord
import httpx

OWNER_ID = int(os.environ.get("DISCORD_USER_ID") or 0)
MCP_URL = os.environ["PALKOVA_URL"].rstrip("/") + "/mcp"
MODEL = os.environ.get("XAI_MODEL", "grok-4.3")
TZ = ZoneInfo(os.environ.get("MEAL_TZ", "America/New_York"))
MEAL_TIMES = [t.strip() for t in os.environ.get("MEAL_TIMES", "12:30,19:00").split(",")]
CUSTOMER_NAME = os.environ.get("CUSTOMER_NAME", "")

INSTRUCTIONS = (
    "You are Meal Buddy, a short, friendly food assistant for one person, chatting on Discord in plain text "
    "(no markdown). You order from one restaurant through its tools. When it is a meal time, call search_menu, "
    "suggest two or three dishes with their prices, and ask what they feel like. Never invent dishes; if "
    "something is not on the menu, say so and offer the closest matches the tool returns. Before create_order, "
    "confirm the dishes, quantities and the name for pickup"
    + (f" (default: {CUSTOMER_NAME})" if CUSTOMER_NAME else "")
    + ". After create_order, send the order number, the total and the payment_url exactly as returned, and say "
    "you will message them once it is paid with the time it will be ready. Orders are pickup only."
)

xai = httpx.Client(base_url="https://api.x.ai/v1", timeout=180,
                   headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"})
grok_lock = threading.Lock()
last_response_id: str | None = None
watching: set[str] = set()
tasks: set[asyncio.Task] = set()  # asyncio keeps only weak references to running tasks

intents = discord.Intents.default()
intents.message_content = True
bot = discord.Client(intents=intents)
home: discord.abc.Messageable | None = None  # where the bot talks: the owner's DMs, or the last channel they used


def ask_grok(text: str) -> tuple[str, set[str]]:
    """One turn on the running conversation; returns the reply and any order numbers Grok created."""
    global last_response_id
    body = {"model": MODEL, "input": [{"role": "user", "content": text}],
            "tools": [{"type": "mcp", "server_url": MCP_URL, "server_label": "kaveri_kitchen"}]}
    with grok_lock:
        # xAI rejects `instructions` with previous_response_id; a system message in the first turn stays in the thread.
        if last_response_id:
            body["previous_response_id"] = last_response_id
        else:
            body["input"].insert(0, {"role": "system", "content": INSTRUCTIONS})
        r = xai.post("/responses", json=body)
        r.raise_for_status()
        data = r.json()
        last_response_id = data["id"]
    reply = "".join(c.get("text", "") for item in data.get("output", []) if item.get("type") == "message"
                    for c in item.get("content", []))
    # Tool results come back as JSON strings inside the output; read order numbers out of the raw response
    # so this doesn't depend on the exact output item schema.
    numbers = set(re.findall(r'order_number\\*"\s*:\s*\\*"(\d{4})', json.dumps(data)))
    return reply or "(no reply)", numbers


async def grok(text: str) -> str:
    reply, numbers = await asyncio.to_thread(ask_grok, text)
    for number in numbers - watching:
        watching.add(number)
        tasks.add(asyncio.create_task(watch_order(number)))
    return reply


def order_status(number: str) -> dict:
    r = httpx.post(MCP_URL, timeout=60, headers={"Accept": "application/json, text/event-stream"}, json={
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "get_order_status", "arguments": {"order_number": number}}})
    return json.loads(r.json()["result"]["content"][0]["text"])


def clock(iso: str) -> str:
    return datetime.fromisoformat(iso).astimezone(TZ).strftime("%I:%M %p").lstrip("0")


async def say(text: str) -> None:
    await home.send(text[:2000])


async def watch_order(number: str) -> None:
    deadline = asyncio.get_running_loop().time() + 20 * 60  # payment links expire after 15 minutes
    while asyncio.get_running_loop().time() < deadline:
        try:
            s = await asyncio.to_thread(order_status, number)
        except (httpx.HTTPError, KeyError, ValueError):
            await asyncio.sleep(20)  # a sleeping free-tier host can take a while to wake
            continue
        status = s.get("status")
        if status in ("paid", "ready", "picked_up"):
            await say(f"Order #{number} is paid ({s['total']}). It will be ready for pickup at "
                      f"{clock(s['ready_by'])}." if s.get("ready_by") else f"Order #{number} is paid.")
            break
        if status in ("cancelled", "expired") or "error" in s:
            await say(f"Order #{number} is {status or 'not found'}; nothing was charged. Want to try again?")
            break
        await asyncio.sleep(20)
    watching.discard(number)


def meal_prompt(now: datetime) -> str:
    meal = "breakfast" if now.hour < 11 else "lunch" if now.hour < 16 else "dinner"
    return (f"It is {now.strftime('%H:%M')}, {meal} time. Start the conversation: greet me, suggest a few "
            "dishes from today's menu, and ask what I'd like to eat.")


async def meal_clock() -> None:
    fired: set[tuple] = set()
    while True:
        now = datetime.now(TZ)
        hm = now.strftime("%H:%M")
        if hm in MEAL_TIMES and (now.date(), hm) not in fired:
            fired.add((now.date(), hm))
            for _ in range(3):  # xAI has answered a meal ping with a one-off 429
                try:
                    await say(await grok(meal_prompt(now)))
                    break
                except httpx.HTTPError as e:
                    print("meal ping failed:", e)
                    await asyncio.sleep(60)
        await asyncio.sleep(20)


async def setup_hook() -> None:
    global home
    if not OWNER_ID:
        print("DISCORD_USER_ID not set: DM the bot and it will reply with your user id.")
        return
    home = await (await bot.fetch_user(OWNER_ID)).create_dm()
    tasks.add(asyncio.create_task(meal_clock()))
    print(f"Meal Buddy up: pings at {', '.join(MEAL_TIMES)} {TZ.key}; MCP {MCP_URL}")

bot.setup_hook = setup_hook


@bot.event
async def on_message(msg: discord.Message) -> None:
    global home
    if msg.author.bot or not msg.content:
        return
    if msg.author.id != OWNER_ID:  # private bot: only its owner can order
        if isinstance(msg.channel, discord.DMChannel):
            await msg.channel.send(f"This bot is private. Your user id is {msg.author.id}.")
        return
    home = msg.channel
    text = msg.content.strip()
    if text in ("/start", "/ping", "ping"):
        text = meal_prompt(datetime.now(TZ))
    async with msg.channel.typing():
        try:
            reply = await grok(text)
        except httpx.HTTPError as e:
            print("grok error:", e.response.text if isinstance(e, httpx.HTTPStatusError) else e)
            reply = f"Grok didn't answer ({e.__class__.__name__}); try again in a moment."
    await say(reply)


if __name__ == "__main__":
    bot.run(os.environ["DISCORD_BOT_TOKEN"])
