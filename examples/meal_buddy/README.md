# Meal Buddy

A proactive customer agent: a Discord bot that messages you at meal times, asks what you want to eat, and orders it from a PalKova restaurant. It uses no PalKova code; it only talks to the restaurant's public MCP server.

1. At 12:30 and 19:00 (America/New_York by default) the bot asks Grok to start a conversation. Grok calls `search_menu` on the restaurant's MCP server and suggests a few dishes.
2. You reply in plain words. Grok confirms the order with you, then calls `create_order` and sends back the order number, the total and a `payment_url`.
3. You open the link and pay on the restaurant's pay page with PayPal or a card. Neither the bot nor Grok ever sees payment details.
4. The bot polls `get_order_status` every 20 seconds and tells you when the order is paid and what time it will be ready for pickup.

Grok reaches the MCP server through the xAI Responses API's remote MCP tool (`{"type": "mcp", "server_url": ...}`), so the restaurant's tools run on xAI's side; the bot only relays messages and watches the order.

## Setup

1. In the Discord Developer Portal, create an application and open **Bot**: copy the token and turn on **Message Content Intent**.
2. Under **OAuth2 → URL Generator**, tick the `bot` scope and the View Channels, Send Messages and Read Message History permissions. Open the generated URL and add the bot to a server you own (a bot can only DM people it shares a server with).
3. Get an xAI API key from the xAI console (API billing; separate from a Grok app plan).
4. Set the environment variables and run:

   ```bash
   export DISCORD_BOT_TOKEN=...
   export XAI_API_KEY=...
   export PALKOVA_URL=https://your-palkova-host   # the restaurant's PUBLIC_BASE_URL
   uv run --no-project --with discord.py --with httpx --with tzdata python bot.py
   ```

5. DM the bot. It replies with your user id. Set `DISCORD_USER_ID` to it and restart. The bot only answers you, in its DMs or in any channel of that server.
6. Send `ping` to start a meal conversation without waiting for the clock.

Optional: `MEAL_TIMES` (default `12:30,19:00`), `MEAL_TZ` (default `America/New_York`), `XAI_MODEL` (default `grok-4.3`), `CUSTOMER_NAME` (the pickup name Grok suggests).

The bot runs as one long-lived process (a Discord gateway connection plus an in-process meal clock), so it costs nothing to schedule. Leave it running on any machine that stays on during meal times.
