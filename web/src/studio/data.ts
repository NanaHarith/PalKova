// The Takings screen's data: paid orders and their dishes, from the same /api/orders the board reads.
// Customer names are left out on purpose: the dashboard's agents query these tables, and what they
// read goes to the model.
import type { AgDataSourcesDefinition } from "ag-studio";
import type { MenuItem, Order } from "../api";
import { channelLabel } from "../icons";

const dollars = (cents: number | null | undefined) => (cents ?? 0) / 100;
const USD = { format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) };
const SHORT_DAY = { format: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }) };
const day = (iso: string) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const hour = (iso: string) => new Date(iso).getHours();
const minutesBetween = (from: string | null, to: string | null) =>
  from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 60000) : null;
const diet = (m: MenuItem | undefined) =>
  !m ? "Unknown" : m.dietary.includes("vegan") ? "Vegan" : m.dietary.includes("veg") ? "Vegetarian" : "Non-veg";
const spiceLabel = (s: string | null | undefined) => (s ? s[0].toUpperCase() + s.slice(1) : "No spice");

/** An order that took money at some point: still held, handed back, or reversed. */
const tookMoney = (o: Order) => o.paid_cents != null && o.paid_cents > 0;

function refundedCents(o: Order): number {
  const alerts = o.flags.alerts ?? [];
  if (!alerts.includes("capture_refunded") && !alerts.includes("capture_reversed")) return 0;
  return o.flags.refunded_cents ?? o.paid_cents ?? 0;  // rows from before partial amounts were kept were full refunds
}

export function takingsData(orders: Order[], menu: MenuItem[]): AgDataSourcesDefinition {
  const paid = orders.filter(tookMoney);
  const dish = new Map(menu.map((m) => [m.id, m]));
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
            hour: hour(o.created_at), ready_minutes: minutesBetween(o.paid_at, o.ready_at),
            turnaround_minutes: minutesBetween(o.paid_at, o.picked_up_at),
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
          { id: "hour", name: "Hour", format: "integerFormat", description: "Local hour the order was placed, 0 to 23." },
          { id: "ready_minutes", name: "Minutes to ready", format: "integerFormat", description: "Minutes from payment to the kitchen marking it ready; blank if never marked ready." },
          { id: "turnaround_minutes", name: "Turnaround minutes", format: "integerFormat", description: "Minutes from payment to the customer picking the order up; blank if not picked up yet." },
        ],
      },
      {
        id: "lines",
        name: "Dishes ordered",
        description: "One row per dish line in a paid order.",
        data: paid.flatMap((o) => o.items.map((l) => ({
          order_id: o.id, dish: l.name, qty: l.qty, sales: dollars(l.line_cents),
          day: day(o.created_at), channel: channelLabel[o.channel], hour: hour(o.created_at),
          category: dish.get(l.item_id)?.category ?? "Unknown", diet: diet(dish.get(l.item_id)), spice: spiceLabel(l.spice),
        }))),
        fields: [
          { id: "order_id", name: "Order id", format: "textFormat", hide: true },
          { id: "dish", name: "Dish", format: "textFormat", cardinality: "medium" },
          { id: "qty", name: "Quantity", format: "integerFormat" },
          { id: "sales", name: "Dish sales", format: "currencyFormat", formatOptions: USD },
          { id: "day", name: "Day", format: "dateFormat", formatOptions: SHORT_DAY },
          { id: "channel", name: "Channel", format: "textFormat", cardinality: "low" },
          { id: "hour", name: "Hour", format: "integerFormat", description: "Local hour the order was placed, 0 to 23." },
          { id: "category", name: "Course", format: "textFormat", cardinality: "low", description: "Menu section: Starters, Mains, Breads, Drinks or Desserts." },
          { id: "diet", name: "Diet", format: "textFormat", cardinality: "low", description: "Vegan, Vegetarian (not vegan) or Non-veg, from the menu's dietary tags." },
          { id: "spice", name: "Spice", format: "textFormat", cardinality: "low", description: "Spice level ordered: Mild, Medium, Hot, or No spice for dishes without one." },
        ],
      },
    ],
    relationships: [{
      id: "lines-orders", type: "many-to-one",
      source: { tableId: "lines", fieldId: "order_id" }, target: { tableId: "orders", fieldId: "id" },
    }],
  };
}
