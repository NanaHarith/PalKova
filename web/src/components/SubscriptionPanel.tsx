import { useEffect, useRef, useState } from "react";
import { PayPalButtons, PayPalScriptProvider, usePayPalScriptReducer } from "@paypal/react-paypal-js";
import {
  ApiError, AuthError, cancelSubscription, getConfig, getSubscription, storeSubscription, syncSubscription,
  type Subscription,
} from "../api";

// PayPal's own status words, said the way the kitchen would.
const STATUS_WORD: Record<string, string> = {
  ACTIVE: "Active", CANCELLED: "Cancelled", SUSPENDED: "Suspended", EXPIRED: "Expired",
  APPROVAL_PENDING: "Awaiting approval", APPROVED: "Approved",
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function ScriptFailed() {
  const [{ isRejected }] = usePayPalScriptReducer();
  return isRejected ? <p className="sub-msg">PayPal couldn't load. Check the connection and reload the page.</p> : null;
}

type Busy = "" | "sync" | "cancel" | "store";

export default function SubscriptionPanel({ onLine, onSignedOut, onClose }:
  { onLine: (active: boolean) => void; onSignedOut: () => void; onClose: () => void }) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [config, setConfig] = useState<{ paypal_client_id: string; plan_id: string } | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState("");
  const keepRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const run = async (b: Busy, call: () => Promise<Subscription>) => {
    setBusy(b); setMsg("");
    try {
      const s = await call();
      setSub(s); onLine(s.active);
      return s;
    } catch (e) {
      if (e instanceof AuthError) onSignedOut();
      else if (e instanceof ApiError && e.status === 400) setMsg("That subscription isn't on PalKova's plan, so the line stays off.");
      else setMsg("PayPal didn't answer. Nothing changed; try again in a moment.");
    } finally { setBusy(""); }
  };

  useEffect(() => {
    run("", getSubscription);
    getConfig().then(setConfig).catch(() => setMsg("Couldn't load the PayPal settings. Reload the page to try again."));
  }, []);  // once per open of the panel

  useEffect(() => { if (confirming) keepRef.current?.focus(); }, [confirming]);

  const doCancel = async () => {
    await run("cancel", cancelSubscription);
    setConfirming(false);
  };
  const back = () => { setConfirming(false); cancelRef.current?.focus(); };

  const status = sub?.status ?? null;
  const word = status ? (STATUS_WORD[status] ?? status.toLowerCase()) : "Not set up";

  return (
    <section id="line-panel" className="line-panel" aria-labelledby="line-panel-title"
      onKeyDown={(e) => { if (e.key === "Escape") (confirming ? back() : onClose()); }}>
      <div className="lp-state">
        <h2 id="line-panel-title">
          Subscription
          <span className={`sub-badge ${sub?.active ? "on" : "off"}`}>{sub ? word : "Checking…"}</span>
        </h2>
        <p className="lp-says">
          {!sub ? "Checking with PayPal…"
            : sub.active ? "The AI line is taking orders by phone, on the website and from agents."
            : "The AI line is off. Phone callers hear that the kitchen isn't taking orders, and the website shows the counter closed."}
        </p>
        {sub?.paypal_subscription_id && (
          <p className="sub">
            PayPal subscription <span className="num">{sub.paypal_subscription_id}</span>
            {sub.checked_at && <> · checked {ago(sub.checked_at)}</>}
          </p>
        )}
        {msg && <p className="sub-msg" role="status">{msg}</p>}
      </div>

      {sub && !sub.active && (
        <div className="lp-activate">
          <p className="lp-plan"><strong>Activate AI line</strong> 7-day free trial, then $99 a month. Cancel any time.</p>
          {config?.paypal_client_id && config.plan_id ? (
            <PayPalScriptProvider options={{ clientId: config.paypal_client_id, vault: true, intent: "subscription" }}>
              <ScriptFailed />
              <div className="lp-paypal" aria-busy={busy === "store"}>
                <PayPalButtons
                  fundingSource="paypal"  // one button; PayPal Credit beside it reads like a second choice to make
                  style={{ layout: "horizontal", shape: "rect", color: "gold", label: "subscribe", height: 48, tagline: false }}
                  createSubscription={(_d, a) => a.subscription.create({ plan_id: config.plan_id })}
                  onApprove={async (d) => { if (d.subscriptionID) await run("store", () => storeSubscription(d.subscriptionID!)); }}
                  onCancel={() => setMsg("Subscription not started. The line stays off.")}
                  onError={() => setMsg("PayPal couldn't open. Try again in a moment.")}
                />
              </div>
            </PayPalScriptProvider>
          ) : config && <p className="sub-msg">PayPal isn't configured on this server, so the line can't be activated here.</p>}
        </div>
      )}

      <div className="lp-actions">
        {confirming ? (
          <div className="lp-confirm" role="group" aria-labelledby="lp-confirm-q">
            <p id="lp-confirm-q">Cancel the subscription? The line goes off straight away.</p>
            <button ref={keepRef} className="act act-quiet" onClick={back} disabled={busy === "cancel"}>Keep it</button>
            <button className="act act-danger" onClick={doCancel} disabled={busy === "cancel"}>
              {busy === "cancel" ? "Cancelling…" : "Cancel subscription"}
            </button>
          </div>
        ) : (
          <>
            {sub?.paypal_subscription_id && (
              <button className="act act-quiet" onClick={() => run("sync", syncSubscription)} disabled={busy !== ""}>
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </button>
            )}
            {sub?.active && (
              <button ref={cancelRef} className="act act-quiet" onClick={() => setConfirming(true)} disabled={busy !== ""}>
                Cancel subscription
              </button>
            )}
          </>
        )}
        <button className="link lp-close" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}
