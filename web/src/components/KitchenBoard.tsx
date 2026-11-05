import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { themeQuartz, type ColDef, type GridApi, type OverlaySelectorFunc, type RowClassParams, type RowHeightParams } from "ag-grid-community";
import { type Order, type Status, money } from "../api";
import { channelIcon, channelLabel } from "../icons";

export type Action = "ready" | "picked_up" | "cancel";
export type BoardContext = { readyMinutes: number; now: number; arrivedAt: Map<string, number>; act: (o: Order, a: Action) => void };

// Paid orders first (they need cooking), then in-flight payments, ready, waiting, done. Oldest first within each.
const RANK: Record<Status, number> = {
  paid: 0, capturing: 1, capture_pending: 1, ready: 2, pending_payment: 3, picked_up: 4, cancelled: 5, expired: 6,
};
export const STATUS_WORD: Record<Status, string> = {
  pending_payment: "Awaiting payment", capturing: "Payment processing", capture_pending: "Payment processing",
  paid: "Paid · cook", ready: "Ready", picked_up: "Picked up", cancelled: "Cancelled", expired: "Expired",
};
const STATUS_SHORT: Record<Status, string> = { ...STATUS_WORD, pending_payment: "Awaiting", capturing: "Processing", capture_pending: "Processing" };
const STEP: Record<Status, string> = {
  pending_payment: "waiting", capturing: "processing", capture_pending: "processing", paid: "paid", ready: "ready",
  picked_up: "done", cancelled: "void", expired: "void",
};
const NEXT: Partial<Record<Status, [Action, string]>> = {
  paid: ["ready", "Mark ready"], ready: ["picked_up", "Picked up"], pending_payment: ["cancel", "Cancel"],
};

const AFTER_PICKUP = ["capture_refunded", "capture_reversed"];
const today = (iso: string | null) => !!iso && new Date(iso).toDateString() === new Date().toDateString();

/** The alerts that still need the owner: any on an open order; a refund or reversal on a picked-up order if it arrived today. */
export const liveAlerts = (o: Order) => {
  const all = (o.flags.alerts ?? []).filter((a) => !o.flags.dismissed?.[a]);
  if (o.status === "picked_up")
    return all.filter((a) => AFTER_PICKUP.includes(a) && today(o.flags.alerts_at?.[a] ?? o.picked_up_at));
  return ["cancelled", "expired"].includes(o.status) ? [] : all;
};
/** Mirrors the server's fully_refunded: a refund with no recorded amount was a full one. */
const refunded = (o: Order) =>
  !!o.flags.alerts?.includes("capture_refunded") && o.paid_cents !== null && (o.flags.refunded_cents ?? o.paid_cents) >= o.paid_cents;
export const flagged = (o: Order) => liveAlerts(o).length > 0;
const alertLabel = (o: Order) => {
  const a = liveAlerts(o);
  return a.includes("capture_refunded") ? "Refunded" : a.includes("capture_reversed") ? "Reversed" : "Check payment";
};
const statusLabel = (o: Order, words: Record<Status, string>) =>
  flagged(o) ? alertLabel(o) : o.status !== "cancelled" && o.flags.alerts?.includes("capture_refunded") ? "Refunded" : words[o.status];
const step = (o: Order) => (flagged(o) ? "alert" : STEP[o.status]);

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const minutesBetween = (a: number, b: number) => Math.round((b - a) / 60_000);

export const theme = themeQuartz.withParams({
  fontFamily: "Barlow, system-ui, sans-serif",
  fontSize: 16,
  backgroundColor: "#F8F4EF",
  foregroundColor: "#1C1519",
  textColor: "#1C1519",
  headerBackgroundColor: "#EDE6DE",
  headerTextColor: "#5B5157",
  headerFontWeight: 600,
  headerFontSize: 13,
  headerHeight: 40,
  rowHeight: 68,
  rowBorder: { color: "#E3DAD0" },
  borderColor: "#E3DAD0",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHoverColor: "#F1E9EC",
  accentColor: "#6B1540",
  cellHorizontalPadding: 14,
  iconSize: 18,
  valueChangeValueHighlightBackgroundColor: "#EBCB6B",
  // menu grid range charts: the charted cells take silk tints, not the library's green and blue
  rangeSelectionChartCategoryBackgroundColor: "#F0D6E2",
  rangeSelectionChartBackgroundColor: "#EFE8E0",
});

function NumberCell({ data }: CustomCellRendererProps<Order>) {
  return (
    <span className="stack">
      <span className="order-no">{data!.number}</span>
      <span className="sub status-inline">{statusLabel(data!, STATUS_SHORT)}</span>
    </span>
  );
}

function PlacedCell({ data, context }: CustomCellRendererProps<Order, unknown, BoardContext>) {
  const placed = new Date(data!.created_at);
  if (placed.toDateString() !== new Date(context.now).toDateString())  // an earlier day: the date leads, the time follows
    return (
      <span className="stack">
        <span className="num">{placed.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
        <span className="sub num">{clock(data!.created_at)}</span>
      </span>
    );
  const ago = minutesBetween(placed.getTime(), context.now);
  return (
    <span className="stack">
      <span className="num">{clock(data!.created_at)}</span>
      <span className="sub">{ago < 1 ? "just now" : `${ago} min ago`}</span>
    </span>
  );
}

function ChannelCell({ data }: CustomCellRendererProps<Order>) {
  const Icon = channelIcon[data!.channel];
  return <span className="channel" title={channelLabel[data!.channel]}><Icon /><span className="channel-label">{channelLabel[data!.channel]}</span></span>;
}

function TextCell({ value }: CustomCellRendererProps<Order>) {
  return <span className="ellipsis" title={value}>{value}</span>;
}

function ItemsCell({ value }: CustomCellRendererProps<Order>) {
  return <span className="items" title={value}>{value}</span>;
}

function readyBy(o: Order, ctx: BoardContext) {
  if (o.status !== "paid" || !o.paid_at) return null;
  const due = Date.parse(o.paid_at) + ctx.readyMinutes * 60_000;
  const left = minutesBetween(ctx.now, due);
  return { at: clock(new Date(due).toISOString()), left };
}

function StatusCell({ data, context }: CustomCellRendererProps<Order, unknown, BoardContext>) {
  const r = readyBy(data!, context);
  return (
    <span className="stack status-stack">
      <span className={`chip chip-${step(data!)}`}>{statusLabel(data!, STATUS_WORD)}</span>
      {r && <span className={`sub readyby-inline${r.left < 0 ? " late" : ""}`}>
        Ready {r.at} · {r.left < 0 ? `${-r.left} min late` : `in ${r.left} min`}
      </span>}
    </span>
  );
}

function ReadyByCell({ data, context }: CustomCellRendererProps<Order, unknown, BoardContext>) {
  const r = readyBy(data!, context);
  if (!r) return <span className="sub">—</span>;
  return (
    <span className="stack">
      <span className="num">{r.at}</span>
      <span className={r.left < 0 ? "sub late" : "sub"}>{r.left < 0 ? `${-r.left} min late` : `in ${r.left} min`}</span>
    </span>
  );
}

function ActionCell({ data, context }: CustomCellRendererProps<Order, unknown, BoardContext>) {
  const [confirming, setConfirming] = useState(false);
  const next = refunded(data!) && ["paid", "ready", "picked_up"].includes(data!.status)
    ? ["cancel", "Cancel order"] as [Action, string] : NEXT[data!.status];
  if (!next) return null;
  const [action, label] = next;
  if (action === "cancel") {
    return confirming ? (
      <button className="act act-danger" onClick={() => context.act(data!, "cancel")} onBlur={() => setConfirming(false)} autoFocus>
        Confirm cancel
      </button>
    ) : (
      <button className="act act-quiet" onClick={() => setConfirming(true)}>{label}</button>
    );
  }
  return <button className={`act act-${step(data!)}`} onClick={() => context.act(data!, action)}>{label}</button>;
}

function Detail({ data }: CustomCellRendererProps<Order>) {
  const o = data!;
  return (
    <div className="detail">
      <table>
        <tbody>
          {o.items.map((l, i) => (
            <tr key={i}>
              <td className="num qty">{l.qty}×</td>
              <td className="dish">{l.name}</td>
              <td className="sub">{l.spice ? `${l.spice} spice` : ""}</td>
              <td className="note">{l.note ?? ""}</td>
              <td className="num money">{money(l.line_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="sums">
        <dt>Channel</dt><dd>{channelLabel[o.channel]}</dd>
        <dt>Subtotal</dt><dd className="num">{money(o.subtotal_cents)}</dd>
        <dt>Tax</dt><dd className="num">{money(o.tax_cents)}</dd>
        <dt>Total</dt><dd className="num strong">{money(o.total_cents)}</dd>
      </dl>
    </div>
  );
}

/** Empty-grid words: one pair for an empty day, one for a view the command bar narrowed to nothing. */
export const emptyOverlays = (empty: [string, string], noMatch: [string, string]): OverlaySelectorFunc => {
  const say = ([head, line]: [string, string]) => () => <div className="empty"><strong>{head}</strong><span>{line}</span></div>;
  const words = { noRows: say(empty), noMatchingRows: say(noMatch) };
  return (p) => (p.overlayType === "noRows" || p.overlayType === "noMatchingRows" ? { component: words[p.overlayType] } : undefined);
};
const ORDER_OVERLAYS = emptyOverlays(["No orders yet today.", "Paid orders appear here the moment they are paid."],
  ["No orders match this view.", "Show all orders to see the full board."]);

const items = (o: Order) => o.items.map((l) => `${l.qty}× ${l.name}`).join(", ");

type Fit = "wide" | "tablet" | "narrow" | "compact" | "phone";
// Each set fits its band without sideways scrolling: tablet 954px, narrow 740px, compact 544px, phone 368px.
const fitFor = (w: number): Fit =>
  w > 1100 ? "wide" : w >= 960 ? "tablet" : w >= 760 ? "narrow" : w >= 560 ? "compact" : "phone";

// One column set per width band, handed to the grid whole so a resize never leaves columns half-moved.
// Tablet: ready-by moves under the status chip; total and channel into the expanded row. Narrow: placed leaves and
// columns tighten. Compact and phone: status sits under the number; phone also drops items.
function columnsFor(fit: Fit): ColDef<Order>[] {
  const wide = fit === "wide", phone = fit === "phone";
  const tight = fit === "narrow" || fit === "compact";
  return [
    { colId: "band", headerName: "", width: 24, minWidth: 24, maxWidth: 24, resizable: false, sortable: false, filter: false,
      cellClass: (p) => `band band-${step(p.data!)}` },
    { colId: "rank", hide: true, sort: "asc", sortIndex: 0, valueGetter: (p) => RANK[p.data!.status] },
    { field: "created_at", hide: true, sort: "asc", sortIndex: 1 },
    { field: "number", headerName: "No.", width: phone ? 116 : tight ? 120 : 132, cellRenderer: "agGroupCellRenderer",
      cellRendererParams: { innerRenderer: NumberCell } },
    { colId: "placed", headerName: "Placed", width: 112, cellRenderer: PlacedCell, sortable: false, hide: tight || phone,
      // local calendar day at midnight: what the date filter's default comparator expects
      filter: "agDateColumnFilter",
      filterValueGetter: (p) => { const d = new Date(p.data!.created_at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
    { field: "channel", headerName: "Channel", width: 116, cellRenderer: ChannelCell, hide: !wide },
    { field: "customer_name", headerName: "Customer", flex: 1, minWidth: phone ? 90 : fit === "compact" ? 100 : tight ? 110 : 124, maxWidth: 190, cellRenderer: TextCell, filter: "agTextColumnFilter" },
    { colId: "items", headerName: "Items", flex: 3, minWidth: fit === "compact" ? 140 : tight ? 150 : 200, valueGetter: (p) => items(p.data!), cellRenderer: ItemsCell, hide: phone,
      filter: "agTextColumnFilter" },  // "contains": the cell is one whole string, a set filter would match nothing
    { colId: "total", field: "total_cents", headerName: "Total", width: 96, type: "rightAligned", cellClass: "num", filter: "agNumberColumnFilter",
      // the command bar filters in dollars; a column id with "cents" in it made the model send cents anyway
      filterValueGetter: (p) => p.data!.total_cents / 100,
      valueFormatter: (p) => money(p.value), enableCellChangeFlash: true, hide: !wide },
    { field: "status", headerName: "Status", width: 186, cellRenderer: StatusCell, enableCellChangeFlash: true, hide: phone || fit === "compact" },
    { colId: "ready_by", headerName: "Ready by", width: 112, cellRenderer: ReadyByCell, sortable: false, filter: false, hide: !wide },
    { colId: "action", headerName: "", width: phone ? 138 : tight ? 150 : 176, cellRenderer: ActionCell, sortable: false, filter: false,
      cellClass: "action-cell", pinned: "right", lockPinned: true },
  ];
}

export default function KitchenBoard({ rows, context, onReady }: {
  rows: Order[]; context: BoardContext; onReady: (api: GridApi<Order>) => void;
}) {
  const [fit, setFit] = useState<Fit>(() => fitFor(window.innerWidth));
  const columns = useMemo(() => columnsFor(fit), [fit]);
  const api = useRef<GridApi<Order> | null>(null);
  const fitRef = useRef(fit);
  // Detail heights are computed from line count and width band (not measured), so an open row is
  // re-sized exactly when the band changes and never covers the next order.
  useEffect(() => { fitRef.current = fit; api.current?.resetRowHeights(); }, [fit]);
  const rowHeight = (p: RowHeightParams<Order>) => {
    if (!p.node.detail) return undefined;
    const lines = p.data?.items.length ?? 1;
    return fitRef.current === "phone" ? 32 + lines * 50 + 12 + 96 : 36 + Math.max(lines * 32, 96);
  };
  // Rules, not getRowClass: AG Grid re-evaluates them when a row's data changes, without redrawing the row.
  const rowClassRules = {
    "is-new": (p: RowClassParams<Order, BoardContext>) => !!p.data && p.data.status === "paid" && p.context.arrivedAt.has(p.data.id),
    "row-done": (p: RowClassParams<Order>) => p.data?.status === "picked_up",
    "row-void": (p: RowClassParams<Order>) => p.data?.status === "cancelled",
  };
  return (
    <div className={`board fit-${fit}`}>
      <AgGridReact<Order>
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        // filterable from the command bar only: no header filter buttons
        defaultColDef={{ suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true, filter: true }}
        context={context}
        getRowId={(p) => p.data.id}
        rowClassRules={rowClassRules}
        masterDetail
        detailCellRenderer={Detail}
        getRowHeight={rowHeight}
        animateRows
        suppressColumnMoveAnimation
        overlayComponentSelector={ORDER_OVERLAYS}
        onGridReady={(e) => { api.current = e.api; onReady(e.api); }}
        onGridSizeChanged={(e) => { if (e.clientWidth) setFit(fitFor(e.clientWidth)); }}  // 0 while the menu view hides it
      />
    </div>
  );
}
