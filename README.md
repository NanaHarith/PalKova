# PalKova

An ordering line that makes a restaurant agent-ready. Anyone's AI agent can order from one engine; every order is priced on the server and paid through PayPal, and no agent can spend a cent on its own.

Built for the PayPal AI Hackathon. The restaurant, **Kaveri Kitchen**, is fictional, and every payment runs in the PayPal sandbox. No real food, no real money.

## What it does

- **Amount-checked capture.** PayPal approves; the server then checks that the order is still current, the amount matches and the dishes are in stock, and only then captures. If the order changed after a link went out, the old link is never charged.
- **Agents cannot spend.** An agent gets a `payment_url` and hands it to its person, who pays on the restaurant's pay page with PayPal or a card. The card form is PayPal's too: card details go to PayPal, never to the restaurant. The agent never sees payment details.
- **Owner tools.** A live kitchen board and a menu and stock grid (AG Grid), plus an "Ask" bar that filters the grids, answers takings and sales questions, and proposes refunds. The AI can find a refund; only the owner's tap can make it, and the server re-checks it first.
- **PayPal at both ends.** Customers pay through PayPal Orders v2. The restaurant pays for the line through PayPal Subscriptions: cancel, and the line stops taking orders.

## Try it

- Restaurant page: https://palkova.hariths.com. Talk to order in the browser, or call (350) 250-3546.
- Pay: on the pay page, tap *Debit or Credit Card* and use the sandbox test card shown there. No PayPal account needed.
- Owner board: https://palkova.hariths.com/owner. Judges get the password with the Devpost submission.

## Connect an MCP client

Add `{PUBLIC_BASE_URL}/mcp` as a remote MCP server (streamable HTTP, no auth).

| Tool | What it does |
|---|---|
| `search_menu(query?, dietary?)` | Orderable dishes with price and remaining stock. A dish not on the menu returns "not on today's menu" and the closest matches, never a substitute. |
| `create_order(items, customer_name)` | Prices the order on the server and returns the `order_id`, number, lines, total, `payment_url` and `expires_at` (15 minutes). Limited to 10 orders per hour per IP. |
| `get_order_status(order_id)` | Status, the link while unpaid, and the ready time once paid. Takes the random `order_id`, not the 4-digit number, so nobody can look up someone else's order by guessing. |

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

The [`Dockerfile`](Dockerfile) builds the web app and the Python service; any host that runs a container with a persistent volume will do. The live demo runs on Railway:

1. Create a service from this repo. Railway builds the Dockerfile.
2. Attach a volume (for example at `/data`) and set `DATABASE_PATH=/data/palkova.db`. SQLite lives there, so it survives redeploys.
3. Set the variables from `.env.example`, a long random `SESSION_SECRET`, and `PUBLIC_BASE_URL` to the service's HTTPS URL. Leave `DB_SNAPSHOT_BUCKET` blank; it is only for hosts without a disk.
4. Run `python -m scripts.setup_paypal` once with the deployed `PUBLIC_BASE_URL`. It creates the catalog product, billing plan and webhook and prints their ids; set `PAYPAL_PLAN_ID` and `PAYPAL_WEBHOOK_ID`.

Run one instance only: call slots and rate limits are kept in memory.

## Licence

Code: MIT, see [`LICENSE`](LICENSE). The photos in `web/src/photos/` keep their own Creative Commons licences, listed in [`CREDITS.md`](web/src/photos/CREDITS.md).
