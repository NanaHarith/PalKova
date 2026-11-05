import { useEffect, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";
import { ApiError, money, startWebCall, type Cart, type LineState, type PaymentReady } from "../api";
import PayPanel from "./PayPanel";
import { MicIcon } from "../icons";

type Phase = "idle" | "connecting" | "live" | "ended" | "error" | "busy" | "limited";
type Said = { who: "you" | "us"; text: string };
type Transcript = { type: string; role?: string; transcriptType?: string; transcript?: string };

/** Four flip digits; a new token number turns each digit over. */
function TokenBoard({ token }: { token: string | null }) {
  const digits = (token ?? "").padStart(4, " ").slice(-4).split("");
  return (
    <div className="token" aria-live="polite">
      <span className="screw tl" /><span className="screw tr" /><span className="screw bl" /><span className="screw br" />
      <span className="token-label">Your token</span>
      <span className="token-digits" aria-label={token ? `Order number ${token}` : "No order yet"}>
        {digits.map((d, i) => <span className="flip num" key={`${i}-${d}`} style={{ animationDelay: `${i * 90}ms` }}>{d.trim() || "–"}</span>)}
      </span>
    </div>
  );
}

export default function TalkPanel({ line, clientId }: { line: LineState | null; clientId: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [said, setSaid] = useState<Said[]>([]);
  const [cart, setCart] = useState<Cart | null>(null);
  const [payment, setPayment] = useState<PaymentReady | null>(null);
  const [paid, setPaid] = useState(false);
  const call = useRef<Vapi | null>(null);
  const feed = useRef<EventSource | null>(null);
  const log = useRef<HTMLOListElement>(null);

  const hangUp = () => { call.current?.stop(); };
  useEffect(() => () => { call.current?.stop(); feed.current?.close(); }, []);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [said]);

  const add = (who: Said["who"], text: string) => setSaid((s) => {
    const last = s[s.length - 1];  // the assistant speaks sentence by sentence: keep one bubble per turn
    return last?.who === who && who === "us" ? [...s.slice(0, -1), { who, text: `${last.text} ${text}` }] : [...s, { who, text }];
  });

  async function start() {
    setPhase("connecting"); setSaid([]); setCart(null); setPayment(null); setPaid(false);
    let web;
    try {
      web = await startWebCall();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setPhase(status === 409 ? "busy" : status === 429 ? "limited" : "error");
      return;
    }

    // Cart and payment come from our server; words come from the call itself.
    feed.current?.close();
    const es = new EventSource(`/api/voice/web/events/${web.stream_token}`);
    es.addEventListener("cart", (e) => setCart(JSON.parse((e as MessageEvent).data) as Cart));
    es.addEventListener("payment_ready", (e) => { setPayment(JSON.parse((e as MessageEvent).data) as PaymentReady); setPaid(false); });
    es.addEventListener("ended", () => es.close());
    feed.current = es;

    // The call already exists server-side; the SDK only joins its room, so it needs no API key.
    const v = new Vapi("server-created-call");
    v.on("call-start", () => setPhase("live"));
    v.on("call-end", () => setPhase((p) => (p === "error" ? p : "ended")));
    v.on("error", () => setPhase("error"));
    v.on("message", (m: Transcript) => {
      if (m.type === "transcript" && m.transcriptType === "final" && m.transcript)
        add(m.role === "user" ? "you" : "us", m.transcript);
    });
    call.current = v;
    try {
      await v.reconnect({ webCallUrl: web.web_call_url, id: web.call_id,
        ...(web.call_token ? { transport: { callToken: web.call_token } } : {}) });
    } catch {
      setPhase("error");
    }
  }

  const open = line?.active === true;
  const talking = phase === "connecting" || phase === "live";

  return (
    <section className="counter" aria-label="Order counter">
      <TokenBoard token={payment?.order_number ?? null} />
      <div className={`window${open ? " is-open" : ""}`}>
        <span className="screw tl" /><span className="screw tr" />
        <div className="window-sill">
          {open && (
            <>
              <h2 className="window-title">Talk to order</h2>
              <div className="talk-row">
                <button
                  className={`mic is-${phase}`}
                  onClick={talking ? hangUp : start}
                  aria-label={talking ? "Hang up" : "Start talking"}
                >
                  <MicIcon />
                  <span>{phase === "connecting" ? "Connecting" : phase === "live" ? "Hang up" : paid ? "New order" : "Tap to talk"}</span>
                </button>
                <p className="talk-hint">
                  {paid && payment ? `Paid. Order #${payment.order_number} will be ready in about ${line.ready_minutes} minutes.`
                    : phase === "live" ? "Listening. Say what you'd like, then your name."
                    : phase === "error" ? "The microphone or connection failed. Allow the mic and tap again."
                    : phase === "busy" ? "All our lines are busy. Please try again in a few minutes."
                    : phase === "limited" ? "That's a lot of calls from here. Please try again in an hour, or call us."
                    : phase === "ended" && !payment ? "Call ended. Tap to start again."
                    : "Say what you'd like. We price it as you go, and you pay with PayPal right here."}
                </p>
              </div>

              <div className={`ticket${paid ? " is-paid" : ""}`}>
                {said.length > 0 && (
                  <ol className="said" ref={log}>
                    {said.map((s, i) => <li key={i} className={`said-${s.who}`}><b>{s.who === "you" ? "You" : "Kaveri"}</b> {s.text}</li>)}
                  </ol>
                )}
                {cart && cart.lines.length > 0 ? (
                  <table className="cart">
                    <tbody>
                      {cart.lines.map((l) => (
                        <tr key={`${l.item_id}-${l.spice}`}><td className="num">{l.qty}×</td><td>{l.name}{l.spice && l.spice !== "mild" && <small> {l.spice}</small>}</td><td className="num">{money(l.line_cents)}</td></tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr><td /><td>Tax</td><td className="num">{money(cart.tax_cents)}</td></tr>
                      <tr className="cart-total"><td /><td>Total</td><td className="num">{money(cart.total_cents)}</td></tr>
                    </tfoot>
                  </table>
                ) : (
                  said.length === 0 && <p className="ticket-empty">Your order will appear on this ticket.</p>
                )}
                {payment && paid && (
                  <div className="stamp" role="status">
                    <span className="stamp-word">Paid</span>
                    <span className="stamp-line">Order #{payment.order_number} · ready in about <span className="num">{line.ready_minutes}</span> min</span>
                  </div>
                )}
                {payment && !paid && (clientId
                  ? <PayPanel payment={payment} clientId={clientId} readyMinutes={line.ready_minutes} onPaid={() => setPaid(true)} />
                  : <p className="pay-msg">PayPal couldn't load. Call +1 350-250-3546 and quote order #{payment.order_number}.</p>)}
              </div>
            </>
          )}
        </div>
        <div className="housing" aria-hidden="true" />
        <div className="shutter">
          {line && !open && (
            <div className="closed-plate" role="status">
              <span className="screw tl" /><span className="screw tr" />
              <strong>Closed</strong>
              <span>This line isn't taking orders right now. Please check back later.</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
