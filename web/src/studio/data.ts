// The Takings screen's data: paid orders and their dishes, from the same /api/orders the board reads.
// Customer names are left out on purpose: the dashboard's agents query these tables, and what they
// read goes to the model.
import type { AgDataSourcesDefinition } from "ag-studio";
import type { Order } from "../api";
import { channelLabel } from "../icons";

const dollars = (cents: number | null | undefined) => (cents ?? 0) / 100;
const USD = { format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) };
const SHORT_DAY = { format: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }) };
const day = (iso: string) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };

/** An order that took money at some point: still held, handed back, or reversed. */
const tookMoney = (o: Order) => o.paid_cents != null && o.paid_cents > 0;

function refundedCents(o: Order): number {
  const alerts = o.flags.alerts ?? [];
  if (!alerts.includes("capture_refunded") && !alerts.includes("capture_reversed")) return 0;
  return o.flags.refunded_cents ?? o.paid_cents ?? 0;  // rows from before partial amounts were kept were full refunds
}

export function takingsData(orders: Order[]): AgDataSourcesDefinition {
  const paid = orders.filter(tookMoney);
  return {
    description: "Paid orders at one restaurant, Kaveri Kitchen (pickup only), in US dollars, and the dishes in them.",
    sources: [
      {
        id: "orders",
        name: "Orders",
        description: "One row per paid order. Takings is what the restaurant kept: paid minus refunded.",
        data: paid.map((o) => {
          const refunded = refundedCents(o);
          return {
            id: o.id, number: o.number, placed: new Date(o.created_at), day: day(o.created_at),
            channel: channelLabel[o.channel], refunded_yes: refunded > 0 ? "Refunded" : "Kept",
            paid: dollars(o.paid_cents), refunded: dollars(refunded), takings: dollars((o.paid_cents ?? 0) - refunded),
            items: o.items.reduce((n, l) => n + l.qty, 0),
          };
        }),
        fields: [
          { id: "id", name: "Order id", format: "textFormat", hide: true },
          { id: "number", name: "Order", format: "textFormat" },
          { id: "placed", name: "Placed", format: "dateTimeFormat" },
          { id: "day", name: "Day", format: "dateFormat", formatOptions: SHORT_DAY },
          { id: "channel", name: "Channel", format: "textFormat", cardinality: "low", description: "How the order came in: Phone, Web or Agent (an AI assistant over MCP)." },
          { id: "refunded_yes", name: "Refund", format: "textFormat", cardinality: "low" },
          { id: "paid", name: "Paid", format: "currencyFormat", formatOptions: USD },
          { id: "refunded", name: "Refunded", format: "currencyFormat", formatOptions: USD },
          { id: "takings", name: "Takings", format: "currencyFormat", formatOptions: USD },
          { id: "items", name: "Items", format: "integerFormat" },
        ],
      },
      {
        id: "lines",
        name: "Dishes ordered",
        description: "One row per dish line in a paid order.",
        data: paid.flatMap((o) => o.items.map((l) => ({
          order_id: o.id, dish: l.name, qty: l.qty, sales: dollars(l.line_cents),
          day: day(o.created_at), channel: channelLabel[o.channel],
        }))),
        fields: [
          { id: "order_id", name: "Order id", format: "textFormat", hide: true },
          { id: "dish", name: "Dish", format: "textFormat", cardinality: "medium" },
          { id: "qty", name: "Quantity", format: "integerFormat" },
          { id: "sales", name: "Dish sales", format: "currencyFormat", formatOptions: USD },
          { id: "day", name: "Day", format: "dateFormat", formatOptions: SHORT_DAY },
          { id: "channel", name: "Channel", format: "textFormat", cardinality: "low" },
        ],
      },
    ],
    relationships: [{
      id: "lines-orders", type: "many-to-one",
      source: { tableId: "lines", fieldId: "order_id" }, target: { tableId: "orders", fieldId: "id" },
    }],
  };
}
