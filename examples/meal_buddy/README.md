# Meal Buddy

A Discord bot that messages you at lunch and dinner, asks what you would like, and orders it from a PalKova restaurant. It contains no PalKova code: it reaches the restaurant only through its public MCP server, by way of Grok.

## How an order goes

1. At meal time (12:30 and 19:00, New York time, by default) the bot asks Grok to open the conversation. Grok calls `search_menu` and suggests a few dishes.
2. You answer in plain words. Grok confirms the order, calls `create_order`, and sends back the order number, the total and a payment link.
3. You open the link and pay on the restaurant's pay page with PayPal or a card. The card form is PayPal's, so card details go to PayPal. Neither the bot nor Grok ever sees them.
4. The bot checks `get_order_status` every 20 seconds and tells you when the order is paid and what time it will be ready for pickup.

Grok calls the restaurant's tools itself, through the xAI Responses API's remote MCP tool. The bot carries messages between Discord and Grok, keeps the meal clock and watches the order. Discord cannot call Grok on its own, so the bot has to run somewhere: on Railway, or on your computer.

## What you need

- **A Discord bot.** In the Discord Developer Portal, create an application. Under **Bot**, copy the token and turn on **Message Content Intent**. Under **OAuth2 → URL Generator**, tick the `bot` scope and the View Channels, Send Messages and Read Message History permissions, then open the generated URL and add the bot to a server you own. A bot can only DM people it shares a server with.
- **An xAI API key** from the xAI console. API billing is separate from a Grok app plan.
- **The restaurant's URL**: its `PUBLIC_BASE_URL`.

## Settings

| Variable | |
|---|---|
| `DISCORD_BOT_TOKEN` | Required. |
| `XAI_API_KEY` | Required. |
| `PALKOVA_URL` | Required. The restaurant's base URL; the bot adds `/mcp`. |
| `DISCORD_USER_ID` | Your Discord user id. Leave it blank at first, DM the bot, and it replies with your id. |
| `MEAL_TIMES` | Default `12:30,19:00`. |
| `MEAL_TZ` | Default `America/New_York`. |
| `XAI_MODEL` | Default `grok-4.3`. |
| `CUSTOMER_NAME` | The pickup name Grok suggests. |

The bot answers only `DISCORD_USER_ID`, in its DMs or in any channel of its server. Send `ping` to start a meal conversation without waiting for the clock.

Run one copy at a time. Two copies answer every message twice and both ping at meal times.

## Run it on Railway

Always on, nothing on your computer.

1. In the restaurant's Railway project, add a service from this repo. Set its root directory to `examples/meal_buddy`, its start command to `python bot.py`, and its watch paths to `examples/meal_buddy/**`, so a change to the restaurant app does not restart the bot. Railway installs `requirements.txt` by itself.
2. Set the variables above. In the same project, `PALKOVA_URL=${{palkova.PUBLIC_BASE_URL}}` follows the restaurant service (use your service's name in place of `palkova`).
3. Deploy. The log shows `Meal Buddy up: ...` and a connection to Discord's gateway. The bot needs no port or domain; it dials out.

## Run it on your computer

Put the variables in the repo's `.env` (they are listed at the end of `.env.example`), then from this folder:

```bash
uv run --env-file ../../.env --no-project --with discord.py --with httpx --with tzdata python bot.py
```

It runs while the terminal stays open.
