import { useState } from "react";
import { PayPalButtons, PayPalScriptProvider, usePayPalScriptReducer } from "@paypal/react-paypal-js";
import { capture, money, type CaptureResult, type PaymentReady } from "../api";

const PAID = ["paid", "ready", "picked_up"];

/** What the customer reads after PayPal hands back; `again` keeps the buttons up for another try. */
function outcome(r: CaptureResult, readyMinutes: number): { text: string; paid: boolean; again: boolean } {
  if (r.result === "paid" || (r.result === "not_pending" && PAID.includes(r.status ?? "")))
    return { text: `Paid. Order #${r.order_number} will be ready in about ${readyMinutes} minutes.`, paid: true, again: false };
  switch (r.result) {
    case "declined": return { text: "PayPal declined that payment. Try again or choose another way to pay.", paid: false, again: true };
    case "capture_pending": return { text: "Your payment is processing. The counter will tell you when it clears.", paid: false, again: false };
    case "sold_out": return { text: "Sorry, a dish sold out before payment went through. You have not been charged.", paid: false, again: false };
    case "superseded": return { text: "This order changed. Pay with the newest buttons.", paid: false, again: false };
    default: return { text: "We couldn't take that payment. You have not been charged.", paid: false, again: true };
  }
}

/** Capture, or follow a capture another trigger (PayPal's webhook, the server's poll) already started:
 * the server answers `not_pending` while it is in flight, so ask again until it settles. */
async function captureSettled(pid: string): Promise<CaptureResult> {
  for (let i = 0; i < 10; i++) {
    const r = await capture(pid);
    if (!(r.result === "not_pending" && (r.status === "capturing" || r.status === "capture_pending"))) return r;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return { result: "capture_pending", order_number: null, status: "capture_pending" };
}

/** A PayPal script that never loads would otherwise leave an empty space where the buttons go. */
function ScriptFailed({ order }: { order: string }) {
  const [{ isRejected }] = usePayPalScriptReducer();
  return isRejected ? <p className="pay-msg">PayPal couldn't load. Call +1 350-250-3546 and quote order #{order}.</p> : null;
}

export default function PayPanel({ payment, clientId, readyMinutes, onPaid }:
  { payment: PaymentReady; clientId: string; readyMinutes: number; onPaid: () => void }) {
  const [msg, setMsg] = useState<ReturnType<typeof outcome> | null>(null);
  const settle = (m: ReturnType<typeof outcome>) => (m.paid ? onPaid() : setMsg(m));

  return (
    <div className="pay">
      <div className="pay-head">
        <span>Order #{payment.order_number}</span>
        <span className="num">{money(payment.total_cents)}</span>
      </div>
      {msg && <p className="pay-msg" role="status">{msg.text}</p>}
      {(!msg || msg.again) && (
        <PayPalScriptProvider options={{ clientId, currency: "USD", intent: "capture" }}>
          <ScriptFailed order={payment.order_number} />
          <PayPalButtons
            key={payment.paypal_order_id}  // a changed order brings a new PayPal order: remount the buttons
            style={{ layout: "vertical", shape: "rect", color: "gold", label: "pay", height: 48 }}
            createOrder={async () => payment.paypal_order_id}
            onApprove={async () => settle(outcome(await captureSettled(payment.paypal_order_id), readyMinutes))}
            onCancel={() => setMsg({ text: "Payment cancelled. Your order isn't placed until it's paid.", paid: false, again: true })}
            onError={() => setMsg({ text: "PayPal couldn't open. Try again in a moment.", paid: false, again: true })}
          />
        </PayPalScriptProvider>
      )}
    </div>
  );
}
