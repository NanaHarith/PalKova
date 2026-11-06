import { useEffect, useState } from "react";
import { getConfig, getPayLink, money, type PayLink } from "../api";
import PayPanel from "../components/PayPanel";
import "../home.css";

/** Where a texted payment link lands: the order slip, pinned to the same wall as the counter, with the
 * PayPal buttons on it. The card button fills in right here, so no PayPal account is needed. */
export default function Pay({ pid }: { pid: string }) {
  const [link, setLink] = useState<PayLink | null | "missing">(null);
  const [clientId, setClientId] = useState("");

  useEffect(() => {
    document.title = "Pay · Kaveri Kitchen";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#0D4F52");
    getPayLink(pid).then(setLink).catch(() => setLink("missing"));
    getConfig().then((c) => setClientId(c.paypal_client_id)).catch(() => {});
  }, [pid]);

  const l = link === "missing" ? null : link;
  const note = link === "missing" ? "We couldn't find that order. Check the link in your text, or call +1 350-250-3546."
    : l?.state === "processing" ? "Your payment is processing. We'll text you when it clears."
    : l?.state === "replaced" ? "This order changed after this link was sent. Use the newest link we texted you."
    : l?.state === "closed" ? "This order is no longer open, and you have not been charged. Call us to order again."
    : null;

  return (
    <div className="home paypage">
      <main className="slip-wrap">
        <header className="slip-sign">
          <span className="screw tl" /><span className="screw tr" />
          <h1>Kaveri Kitchen</h1>
          <p>Pickup only · pay for your order</p>
        </header>

        {/* Above the slip, so the test card stays in view while the card form is open. */}
        {l?.state === "open" && (
          <aside className="chalk">
            <p><b>No PayPal account?</b> Tap <b>Debit or Credit Card</b>. The form opens right here.</p>
            <p>
              This is a demo on PayPal's sandbox, so no real money moves. Never enter a real card. Use the test
              card <span className="num card-no">4111 1111 1111 1111</span>, any future expiry date and any three-digit CVV.
            </p>
          </aside>
        )}

        <div className={`ticket slip${l?.state === "paid" ? " is-paid" : ""}`} aria-busy={link === null}>
          <span className="tack" aria-hidden="true" />
          {l && (
            <>
              <p className="slip-no">Order <span className="num">#{l.order_number}</span></p>
              <table className="cart">
                <tbody>
                  {l.lines.map((ln, i) => (
                    <tr key={i}><td className="num">{ln.qty}×</td><td>{ln.name}</td><td className="num">{money(ln.line_cents)}</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td /><td>Tax</td><td className="num">{money(l.tax_cents)}</td></tr>
                  <tr className="cart-total"><td /><td>Total</td><td className="num">{money(l.total_cents)}</td></tr>
                </tfoot>
              </table>
            </>
          )}
          {link === null && <p className="ticket-empty">Finding your order…</p>}
          {note && <p className="pay-msg slip-note" role="status">{note}</p>}
          {l?.state === "paid" && (
            <div className="stamp" role="status">
              <span className="stamp-word">Paid</span>
              <span className="stamp-line">Order #{l.order_number} · ready in about <span className="num">{l.ready_minutes}</span> min</span>
            </div>
          )}
          {l?.state === "open" && (clientId
            ? <PayPanel payment={l} clientId={clientId} readyMinutes={l.ready_minutes}
                onPaid={() => setLink({ ...l, state: "paid" })} />
            : <p className="ticket-empty">Loading PayPal…</p>)}
        </div>
      </main>
    </div>
  );
}
