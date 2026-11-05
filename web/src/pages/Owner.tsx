import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GridApi } from "ag-grid-community";
import { ApiError, AuthError, dismissAlert, events, getLine, getOrders, patchOrder, type FeedState, type LineState, type Order } from "../api";
import KitchenBoard, { liveAlerts, type Action, type BoardContext } from "../components/KitchenBoard";
import CommandBar from "../components/CommandBar";
import MenuGrid from "../components/MenuGrid";
import SubscriptionPanel from "../components/SubscriptionPanel";
import { AlertIcon } from "../icons";

const RESYNC_MS = 60_000;  // new unpaid orders and expiries send no event; a quiet re-read catches them
const TICK_MS = 15_000;

const ALERT_WORDS: Record<string, string> = {
  capture_declined: "payment was declined",
  capture_failed: "payment failed",
  capture_reversed: "payment was reversed",
  capture_refunded: "payment was refunded",
  amount_mismatch: "the paid amount did not match the order",
  capture_orphaned: "a payment could not be matched to it",
};
const RANGES = [{ days: 1, label: "Today" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }];
const ACTION_WORDS: Record<Action, string> = { ready: "mark ready", picked_up: "mark picked up", cancel: "cancel" };

export default function Owner({ onSignedOut }: { onSignedOut: () => void }) {
  const [rows, setRows] = useState<Order[] | null>(null);
  const [byId, setById] = useState<Map<string, Order>>(new Map());
  const [line, setLine] = useState<LineState | null>(null);
  const [feed, setFeed] = useState<FeedState>("reconnecting");
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState("");
  const [arrivals, setArrivals] = useState(0);
  const [days, setDays] = useState(1);
  const [panel, setPanel] = useState(false);
  const [view, setView] = useState<"orders" | "menu">("orders");
  const [menuOpened, setMenuOpened] = useState(false);  // the menu grid mounts on first visit, then stays live
  const [menuVersion, setMenuVersion] = useState(0);
  const daysRef = useRef(days);  // read by load(), so changing the range doesn't reopen the event stream
  const grid = useRef<GridApi<Order> | null>(null);
  const arrivedAt = useRef(new Map<string, number>());
  const mirror = useRef(new Map<string, Order>());

  const fail = useCallback((e: unknown) => {
    if (e instanceof AuthError) onSignedOut();
    else setNotice("Can't reach the server. The board will catch up when it's back.");
  }, [onSignedOut]);

  const load = useCallback(async () => {
    try {
      const list = await getOrders(daysRef.current);
      mirror.current = new Map(list.map((o) => [o.id, o]));
      setById(mirror.current);
      if (grid.current) grid.current.setGridOption("rowData", list);
      else setRows(list);
    } catch (e) { fail(e); }
  }, [fail]);

  const upsert = useCallback((o: Order) => {
    const known = mirror.current.has(o.id);
    const next = new Map(mirror.current);
    if (o.status === "expired") next.delete(o.id); else next.set(o.id, o);
    mirror.current = next;
    setById(next);
    const api = grid.current;
    if (!api) return;
    if (o.status === "expired") api.applyTransactionAsync({ remove: [o] });
    else api.applyTransactionAsync(known ? { update: [o] } : { add: [o] }, (res) => {
      // A new paid order: keep it in view when the board is near the top (FIFO may place it below the fold).
      const node = [...res.add, ...res.update][0];
      if (!node) return;
      // The number cell also shows the status on phones; its own value never changes, so AG Grid would not repaint it.
      api.refreshCells({ rowNodes: [node], columns: ["number", "band", "action"], force: true, suppressFlash: true });
      if (arrivedAt.current.has(o.id) && api.getVerticalPixelRange().top < 80) api.ensureNodeVisible(node);
    });
  }, []);

  useEffect(() => {
    load();
    // A line that is off opens the subscription panel, so the way back on is the first thing seen.
    getLine().then((l) => { setLine(l); if (!l.active) setPanel(true); }).catch(() => {});
    const stop = events((name, data) => {
      // Stock moves with every paid or reverted order, so any of these re-reads the menu (if it is open).
      if (name === "menu.updated" || name === "order.paid" || name === "order.updated") setMenuVersion((v) => v + 1);
      if (!name.startsWith("order.")) return;
      const o = data as Order;
      if (name === "order.paid") { arrivedAt.current.set(o.id, Date.now()); setArrivals((n) => n + 1); }
      upsert(o);
    }, (s) => { setFeed(s); if (s === "live") { load(); setMenuVersion((v) => v + 1); } });
    const resync = setInterval(load, RESYNC_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => { stop(); clearInterval(resync); clearInterval(tick); };
  }, [load, upsert]);

  // Only the time-based cells change on a tick; rows are never redrawn, so taps in progress survive.
  useEffect(() => { grid.current?.refreshCells({ columns: ["placed", "ready_by", "status"], force: true, suppressFlash: true }); }, [now]);

  const act = useCallback(async (o: Order, a: Action) => {
    arrivedAt.current.delete(o.id);  // acted on: the arrival tint ends
    try {
      upsert(await patchOrder(o.id, a));
      setNotice("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNotice(`Order ${o.number} changed on another screen, so it can't ${ACTION_WORDS[a]} now. The board has been refreshed.`);
        load();
      } else fail(e);
    }
  }, [upsert, load, fail]);

  const dismiss = async (o: Order, alert: string) => {
    try { upsert(await dismissAlert(o.id, alert)); } catch (e) { fail(e); }
  };

  const pickRange = (d: number) => { daysRef.current = d; setDays(d); load(); };
  const pickView = (v: "orders" | "menu") => { setView(v); if (v === "menu") setMenuOpened(true); };

  const jumpTo = (id: string) => {
    const node = grid.current?.getRowNode(id);
    if (!node) return;
    grid.current!.ensureNodeVisible(node, "middle");
    grid.current!.flashCells({ rowNodes: [node] });
  };

  const orders = [...byId.values()];
  const count = (...s: Order["status"][]) => orders.filter((o) => s.includes(o.status)).length;
  const alerts = orders.flatMap((o) => liveAlerts(o).map((a) => ({ o, a })));
  const context = useMemo<BoardContext>(
    () => ({ readyMinutes: line?.ready_minutes ?? 20, now, arrivedAt: arrivedAt.current, act }),
    [line, now, act]);

  return (
    <div className="owner">
      <header className="rail">
        <div className="brand">
          <span className="wordmark">PalKova</span>
          <span className="tenant">{line?.restaurant ?? "Kitchen"}</span>
          <nav className="views" aria-label="Screens">
            <button aria-pressed={view === "orders"} onClick={() => pickView("orders")}>Orders</button>
            <button aria-pressed={view === "menu"} onClick={() => pickView("menu")}>Menu &amp; stock</button>
          </nav>
        </div>
        <div className="rail-mid">
          <dl className="counts" aria-label={RANGES.find((r) => r.days === days)!.label}>
            <div><dt>To cook</dt><dd key={arrivals} className={arrivals ? "pulse" : ""}>{count("paid")}</dd></div>
            <div><dt>Ready</dt><dd>{count("ready")}</dd></div>
            <div><dt>Awaiting payment</dt><dd>{count("pending_payment", "capturing", "capture_pending")}</dd></div>
          </dl>
          <div className="range" role="group" aria-label="Show orders from" hidden={view !== "orders"}>
            {RANGES.map((r) => (
              <button key={r.days} aria-pressed={days === r.days} onClick={() => pickRange(r.days)}>{r.label}</button>
            ))}
          </div>
        </div>
        <div className="status-line">
          {line && (
            <button className={`pill pill-btn ${line.active ? "pill-on" : "pill-off"}`} aria-expanded={panel}
              aria-controls="line-panel" title="Subscription" onClick={() => setPanel((p) => !p)}>
<span><span className="pill-long">Ordering line</span><span className="pill-short">Line</span> {line.active ? "on" : "off"}</span>
            </button>
          )}
          <span className={`pill ${feed === "live" ? "pill-on" : "pill-warn"}`} aria-live="polite">
            {feed === "live" ? "Live" : "Reconnecting…"}
          </span>
          <time className="clock">{new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
        </div>
      </header>

      {panel && (
        <SubscriptionPanel onSignedOut={onSignedOut} onClose={() => setPanel(false)}
          onLine={(active) => setLine((l) => (l ? { ...l, active } : l))} />
      )}

      {alerts.length > 0 && (
        <section className="alerts" role="alert">
          {alerts.map(({ o, a }) => (
            <p key={o.id + a}>
              <AlertIcon />
              <button className="alert-jump" onClick={() => jumpTo(o.id)}>Order {o.number}</button>
              <span>{ALERT_WORDS[a] ?? a.replaceAll("_", " ")}{o.status === "picked_up" ? " after pickup." : ". Check PayPal before handing it over."}</span>
              <button className="link" aria-label={`Dismiss alert for order ${o.number}`} onClick={() => dismiss(o, a)}>Dismiss</button>
            </p>
          ))}
        </section>
      )}

      {notice && (
        <p className="notice" role="status">
          <span>{notice}</span>
          <button className="link" onClick={() => setNotice("")}>Dismiss</button>
        </p>
      )}

      {/* Both screens stay mounted once seen, so live orders keep landing while the owner edits the menu. */}
      <div className="view" hidden={view !== "orders"}>
        {rows === null
          ? <div className="loading">Loading orders…</div>
          : <>
            <CommandBar grid="orders" api={() => grid.current} onSignedOut={onSignedOut} />
            <KitchenBoard rows={rows} context={context} onReady={(api) => { grid.current = api; }} />
          </>}
      </div>
      {menuOpened && (
        <div className="view" hidden={view !== "menu"}>
          <MenuGrid version={menuVersion} onNotice={setNotice} onSignedOut={onSignedOut} />
        </div>
      )}
    </div>
  );
}
