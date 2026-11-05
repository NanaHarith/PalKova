// Typed calls to the owner API. Money is integer cents from the server; the UI never computes totals.

export type Channel = "phone" | "web" | "agent";
export type Status =
  | "pending_payment" | "capturing" | "capture_pending" | "paid" | "ready" | "picked_up" | "cancelled" | "expired";

export type Line = { item_id: string; name: string; qty: number; spice?: string | null; note?: string | null; line_cents: number };

export type Order = {
  id: string;
  number: string;
  channel: Channel;
  customer_name: string;
  items: Line[];
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  status: Status;
  created_at: string;
  paid_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  paid_cents: number | null;
  flags: { alerts?: string[]; alerts_at?: Record<string, string>; dismissed?: Record<string, string>; refunded_cents?: number };
};

export type MenuItem = {
  id: string; name: string; category: string; price_cents: number; par_level: number; available: boolean;
  dietary: string[]; spice_default: Spice | null; sold_today: number; remaining: number; sales_by_hour: number[];  // 24 local hours, paid today
};
export type Spice = "mild" | "medium" | "hot";

export type LineState = { active: boolean; restaurant: string; ready_minutes: number; busy: boolean };

export class AuthError extends Error {}
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
  if (r.status === 401) throw new AuthError();
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json();
}

export const login = (password: string) =>
  req<{ ok: boolean }>("/owner/login", { method: "POST", body: JSON.stringify({ password }) });
export const getOrders = (days = 1) => req<Order[]>(`/api/orders?days=${days}`);  // days=1 is today only
export const patchOrder = (id: string, action: "ready" | "picked_up" | "cancel") =>
  req<Order>(`/api/orders/${id}`, { method: "PATCH", body: JSON.stringify({ action }) });
export const dismissAlert = (id: string, alert: string) =>
  req<Order>(`/api/orders/${id}/dismiss`, { method: "POST", body: JSON.stringify({ alert }) });
export const getMenu = () => req<{ items: MenuItem[]; sales_by_hour: number[] }>("/api/menu");
export const patchMenu = (id: string, fields: Partial<Pick<MenuItem, "price_cents" | "par_level" | "available" | "spice_default">>) =>
  req<MenuItem>(`/api/menu/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
export const getLine = () => req<LineState>("/api/line");

// PayPal subscription statuses, upper case as PayPal sends them; null when none was ever set up.
export type Subscription = { status: string | null; active: boolean; paypal_subscription_id: string | null; checked_at: string | null };
export const getSubscription = () => req<Subscription>("/api/subscription");
export const storeSubscription = (subscription_id: string) =>
  req<Subscription>("/api/subscription", { method: "POST", body: JSON.stringify({ subscription_id }) });
export const syncSubscription = () => req<Subscription>("/api/subscription/sync", { method: "POST" });
export const cancelSubscription = () => req<Subscription>("/api/subscription/cancel", { method: "POST" });

// Owner command bar. The server answers with a grid state to apply, a sentence, or a refund to confirm.
export type GridName = "orders" | "menu";
export type RefundOrder = Pick<Order, "id" | "number" | "customer_name" | "channel" | "status" | "created_at"> & { paid_cents: number };
export type CommandReply =
  | { kind: "grid"; state: Record<string, unknown>; propertiesToIgnore: string[]; explanation: string }
  | { kind: "answer"; text: string }
  | { kind: "refund"; order: RefundOrder };
export type RefundResult = { status: string; refund_id: string | null; order_number: string; amount_cents: number };
export type Exchange = { q: string; a: string };
export const command = (grid: GridName, query: string, current_state: unknown, schema: unknown, history: Exchange[]) =>
  req<CommandReply>("/api/command", { method: "POST", body: JSON.stringify({ grid, query, current_state, schema, history }) });
export const refund = (order_id: string) =>
  req<RefundResult>("/api/refunds", { method: "POST", body: JSON.stringify({ order_id }) });

export type FeedState = "live" | "reconnecting";

/** Server-sent events: order.* carry a full order; menu.updated a menu item. */
export function events(onEvent: (name: string, data: unknown) => void, onState: (s: FeedState) => void): () => void {
  const es = new EventSource("/api/events");
  for (const name of ["order.paid", "order.updated", "order.cancelled", "order.alert", "menu.updated"])
    es.addEventListener(name, (e) => onEvent(name, JSON.parse((e as MessageEvent).data)));
  es.onopen = () => onState("live");
  es.onerror = () => onState("reconnecting");  // EventSource retries on its own
  return () => es.close();
}

// Public page: dish facts and orderability only, no stock levels or sales.
export type PublicItem = {
  id: string; name: string; category: string; description: string; price_cents: number;
  dietary: string[]; spice_default: Spice | null; orderable: boolean;
};
export type CartLine = { item_id: string; name: string; qty: number; spice: string | null; line_cents: number };
export type Cart = { lines: CartLine[]; subtotal_cents: number; tax_cents: number; total_cents: number };
export type PaymentReady = { order_number: string; paypal_order_id: string; total_cents: number };
export type CaptureResult = { result: string; order_number: string | null; status: Status | null };

export const getPublicMenu = () => req<PublicItem[]>("/api/public/menu");
export const getConfig = () => req<{ paypal_client_id: string; plan_id: string }>("/api/config");
export const capture = (paypal_order_id: string) =>
  req<CaptureResult>("/api/pay/capture", { method: "POST", body: JSON.stringify({ paypal_order_id }) });

export const money =(cents: number) => `$${(cents / 100).toFixed(2)}`;
