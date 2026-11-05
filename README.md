# PalKova

An ordering line that makes a restaurant agent-ready. Anyone's AI agent can order from one engine; every order is priced on the server and paid through PayPal, and no agent can spend a cent on its own.

Built for the PayPal AI Hackathon. The restaurant, **Kaveri Kitchen**, is fictional, and every payment runs in the PayPal sandbox. No real food, no real money.

## What it does

- **Amount-checked capture.** PayPal approves; the server then checks that the order is still current, the amount matches and the dishes are in stock, and only then captures. If the order changed after a link went out, the old link is never charged.
- **Agents cannot spend.** An agent gets a `payment_url` and hands it to its person, who approves in PayPal. The agent never sees payment details.
- **Owner tools.** A live kitchen board and a menu and stock grid (AG Grid), plus an "Ask" bar that filters the grids, answers takings and sales questions, and proposes refunds. The AI can find a refund; only the owner's tap can make it, and the server re-checks it first.
- **PayPal at both ends.** Customers pay through PayPal Orders v2. The restaurant pays for the line through PayPal Subscriptions: cancel, and the line stops taking orders.

## Connect an MCP client

Add `{PUBLIC_BASE_URL}/mcp` as a remote MCP server (streamable HTTP, no auth).

| Tool | What it does |
|---|---|
| `search_menu(query?, dietary?)` | Orderable dishes with price and remaining stock. A dish not on the menu returns "not on today's menu" and the closest matches, never a substitute. |
| `create_order(items, customer_name)` | Prices the order on the server and returns the number, lines, total, `payment_url` and `expires_at` (15 minutes). Limited to 10 orders per hour per IP. |
| `get_order_status(order_number)` | Status, the link while unpaid, and the ready time once paid. |

[`examples/meal_buddy/`](examples/meal_buddy/) is a proactive agent built on this endpoint alone: a Discord bot that messages you at meal times and contains no PalKova code.

## Run locally

Needs [uv](https://docs.astral.sh/uv/), Node 20+ and sandbox accounts for each service in `.env.example`.

```bash
uv venv --python 3.12
uv pip install --python .venv -e .
# --no-deps is required: a normal install downgrades openai
uv pip install --python .venv --no-deps paypal-agent-toolkit==1.11.0

cp .env.example .env        # then fill it in
(cd web && npm ci && npm run build)

.venv/bin/python -m uvicorn app.main:app --port 8000    # .venv\Scripts\python on Windows
```

PayPal webhooks and return links need a public HTTPS URL in `PUBLIC_BASE_URL`.

## Deploy

[`render.yaml`](render.yaml) describes the service. Create a Blueprint from this repo and fill in the variables marked `sync: false`, then run `python -m scripts.setup_paypal` once with the deployed `PUBLIC_BASE_URL`. It creates the catalog product, billing plan and webhook and prints their ids; set `PAYPAL_PLAN_ID` and `PAYPAL_WEBHOOK_ID`.

## Licence

Code: MIT, see [`LICENSE`](LICENSE). The photos in `web/src/photos/` keep their own Creative Commons licences, listed in [`CREDITS.md`](web/src/photos/CREDITS.md).
