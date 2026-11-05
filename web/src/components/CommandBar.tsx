import { useEffect, useRef, useState } from "react";
import type { GridApi, GridState, StructuredSchemaColumnParams } from "ag-grid-community";
import { ApiError, AuthError, command, money, refund, type Exchange, type GridName, type RefundOrder, type RefundResult } from "../api";
import { channelLabel, ReturnIcon } from "../icons";

/** What the LLM may know about each grid's columns. Set values only for closed lists, never customer names. */
const COLUMNS: Record<GridName, Record<string, StructuredSchemaColumnParams>> = {
  orders: {
    status: { includeSetValues: true, description: "order status; pending_payment = unpaid, paid = needs cooking" },
    channel: { includeSetValues: true, description: "how the order came in" },
    placed: { description: "date the order was placed (local calendar day)" },
    total: { description: "order total in US dollars" },
    customer_name: { description: "customer's first name" },
    items: { description: "dishes in the order, e.g. '2× Masala Dosa'" },
  },
  menu: {
    category: { includeSetValues: true },
    available: { includeSetValues: true, description: "true when the dish is on the menu" },
    spice_default: { includeSetValues: true, description: "default spice level; blank when the dish has none" },
    price: { description: "price in US dollars" },
    par_level: { description: "how many the kitchen makes today" },
    sold_today: { description: "number sold today" },
    remaining: { description: "number left today; 0 = sold out" },
  },
};
const PLACEHOLDER: Record<GridName, string> = {
  orders: "Paid orders over $40 · takings this week · refund 2278",
  menu: "Dishes running low · sort by sold today · open disputes",
};
const ERRORS: Record<string, string> = {
  invalid_state: "That didn't turn into a view the grid can show. Nothing changed; try saying it another way.",
  llm_not_configured: "The command bar isn't set up on this server yet.",
  already_refunded: "That order has already been refunded. No money moved.",
  not_refundable: "That order isn't paid, so there's nothing to refund. No money moved.",
  not_found: "That order isn't in our records any more. No money moved.",
};
const REFUND_WORD: Record<string, string> = { COMPLETED: "done", PENDING: "pending at PayPal", FAILED: "failed", CANCELLED: "cancelled" };

type Shown =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "view"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string }
  | { kind: "refund"; order: RefundOrder; sending: boolean; error?: string }
  | { kind: "refunded"; result: RefundResult };

const detail = (e: ApiError) => { try { return JSON.parse(e.message).detail as string; } catch { return ""; } };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The screen's toolbar row: the bar first, then whatever else the screen keeps there (`children`). */
export default function CommandBar({ grid, api, onSignedOut, children }: {
  grid: GridName; api: () => GridApi | null; onSignedOut: () => void; children?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Shown>({ kind: "idle" });
  const [viewChanged, setViewChanged] = useState(false);
  const history = useRef<Exchange[]>([]);  // the last 3 requests and the bar's replies; the model's short memory
  const input = useRef<HTMLInputElement>(null);
  const keep = useRef<HTMLButtonElement>(null);

  const fail = (e: unknown): string => {
    if (e instanceof AuthError) { onSignedOut(); return ""; }
    if (e instanceof ApiError) return ERRORS[detail(e)] ?? (detail(e).startsWith("refused")
      ? "PayPal refused this refund, so no money moved. Refund it from your PayPal account instead."
      : "Something went wrong on the server. Nothing changed.");
    return "Can't reach the server. Nothing changed.";
  };

  const ask = async () => {
    const g = api(), q = query.trim();
    if (!g || !q || shown.kind === "busy") return;
    setShown({ kind: "busy" });
    try {
      const schema = g.getStructuredSchema({ columns: COLUMNS[grid], exclude: ["aggregation", "pivot"] });
      const r = await command(grid, q, g.getState(), schema, history.current);
      // no customer name in what is remembered: the refund reply names only the order
      const a = r.kind === "grid" ? r.explanation : r.kind === "refund" ? `Refund proposed for order ${r.order.number}` : r.text;
      history.current = [...history.current, { q, a: a.slice(0, 500) }].slice(-3);
      if (r.kind === "grid") {
        g.setState(r.state as GridState, r.propertiesToIgnore as Parameters<GridApi["setState"]>[1]);
        setViewChanged(true);
        setShown({ kind: "view", text: r.explanation });
      } else if (r.kind === "refund") setShown({ kind: "refund", order: r.order, sending: false });
      else setShown({ kind: "answer", text: r.text });
      setQuery("");
    } catch (e) {
      setShown({ kind: "error", text: fail(e) });
    }
  };

  /** Back to the screen as built: column defaults (sort, hidden columns, widths), no filters, no grouping. */
  const showAll = () => {
    const g = api();
    g?.setFilterModel(null);
    g?.resetColumnState();
    setViewChanged(false);
    history.current = [];
    setShown({ kind: "idle" });
  };

  const sendRefund = async (order: RefundOrder) => {
    setShown({ kind: "refund", order, sending: true });
    try {
      setShown({ kind: "refunded", result: await refund(order.id) });
    } catch (e) {
      setShown({ kind: "refund", order, sending: false, error: fail(e) });
    }
  };

  const backOut = () => { setShown({ kind: "idle" }); input.current?.focus(); };
  // Keep it holds focus while the question is open, including after a failed refund (both buttons were disabled).
  useEffect(() => { if (shown.kind === "refund" && !shown.sending) keep.current?.focus(); }, [shown]);

  // The refund question points at its row, the way the alerts strip does.
  useEffect(() => {
    if (shown.kind !== "refund" || shown.sending || shown.error) return;
    const node = api()?.getRowNode(shown.order.id);
    if (node) { api()!.ensureNodeVisible(node, "middle"); api()!.flashCells({ rowNodes: [node] }); }
  }, [shown]);  // eslint-disable-line react-hooks/exhaustive-deps

  const busy = shown.kind === "busy";
  const filtered = viewChanged && grid === "orders";
  const refused = shown.kind === "refund" && !!shown.error?.startsWith("PayPal refused");
  const id = `cmd-q-${grid}`;  // both screens stay mounted
  return (<>
    <div className={`tool-row${filtered ? " tool-row-filtered" : ""}${children ? "" : " tool-row-solo"}`}>
    <div className="command">
      <form className="cmd-form" role="search" aria-label="Command bar" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <div className="cmd-field">
          <label className="cmd-ask" htmlFor={id}>Ask</label>
          <input id={id} ref={input} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={300}
            placeholder={PLACEHOLDER[grid]} enterKeyHint="go" autoComplete="off" aria-busy={busy}
            onKeyDown={(e) => { if (e.key === "Escape" && shown.kind !== "refund") { setQuery(""); setShown({ kind: "idle" }); } }} />
          <button className="cmd-go" type="submit" disabled={busy || !query.trim()} aria-label="Send"><ReturnIcon /></button>
        </div>
      </form>

      <div className="cmd-out" aria-live="polite">
        {busy && <p className="cmd-line cmd-quiet">Working on it…</p>}
        {shown.kind === "view" && <p className="cmd-line">{shown.text}</p>}
        {shown.kind === "answer" && <p className="cmd-line cmd-answer">{shown.text}</p>}
        {shown.kind === "error" && <p className="cmd-line cmd-error">{shown.text}</p>}
        {/* Said for as long as the board is narrowed, whatever the bar shows meanwhile. */}
        {filtered && !busy && <p className="cmd-line cmd-warn">New orders outside this view stay hidden.</p>}
      </div>
    </div>
    {viewChanged && (
      <button className="act act-quiet" onClick={showAll}>{grid === "orders" ? "Show all orders" : "Show the whole menu"}</button>
    )}
    {children}
    </div>

      {(shown.kind === "refund" || shown.kind === "refunded") && (
        <section className="cmd-refund" aria-label="Refund"
          onKeyDown={(e) => { if (e.key === "Escape" && shown.kind === "refund" && !shown.sending) backOut(); }}>
          {shown.kind === "refund" ? (
            <>
              <div className="cr-what">
                <h2>Refund order <span className="num">#{shown.order.number}</span> in full?</h2>
                <p className="cr-facts">
                  <span>{shown.order.customer_name}</span>
                  <span>{channelLabel[shown.order.channel]}</span>
                  <span className="num">Paid {money(shown.order.paid_cents)}</span>
                  <span className="num">{when(shown.order.created_at)}</span>
                </p>
                <p className="sub">The money goes back to the customer's PayPal. It can't be taken back from here.</p>
                {shown.error && <p className="cr-error" role="alert">{shown.error}</p>}
              </div>
              <div className="cr-actions">
                <button ref={keep} className="act act-quiet" onClick={backOut} disabled={shown.sending}>{refused ? "Done" : "Keep it"}</button>
                {!refused && (  // PayPal's no won't change on a retry
                  <button className="act act-danger" onClick={() => sendRefund(shown.order)} disabled={shown.sending}>
                    {shown.sending ? "Refunding…" : `Refund ${money(shown.order.paid_cents)}`}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="cr-what">
                <h2>Refunded <span className="num">{money(shown.result.amount_cents)}</span> for order <span className="num">#{shown.result.order_number}</span></h2>
                <p className="sub">PayPal: {REFUND_WORD[shown.result.status] ?? shown.result.status.toLowerCase()}. The board flags the order once PayPal's notice arrives.</p>
              </div>
              <div className="cr-actions">
                <button className="act act-quiet" onClick={backOut} autoFocus>Done</button>
              </div>
            </>
          )}
        </section>
      )}
  </>);
}
