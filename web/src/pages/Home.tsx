import { useEffect, useState } from "react";
import { getConfig, getLine, getPublicMenu, type LineState, type PublicItem } from "../api";
import TalkPanel from "../components/TalkPanel";
import MenuBoard from "../components/MenuBoard";
import biryani from "../photos/biryani.jpg";
import butterChicken from "../photos/butter-chicken.jpg";
import lassi from "../photos/mango-lassi.jpg";
import "../home.css";

// Prints pinned to the wall. Licences and sources: src/photos/CREDITS.md.
const PRINTS = [
  { src: biryani, alt: "Biryani with egg and raita, served on a banana leaf", caption: "Biryani on a banana leaf" },
  { src: butterChicken, alt: "Butter chicken in a white dish with a basket of naan behind it", caption: "Butter chicken and naan" },
  { src: lassi, alt: "Mango lassi seen from above, with a straw", caption: "Mango lassi" },
];

/** The steel tumbler and dabara on the counter ledge, with the steam that never stops. */
const Tumbler = () => (
  <svg className="tumbler" viewBox="0 0 120 150" aria-hidden="true">
    <g className="steam" fill="none" stroke="#F2EBDD" strokeWidth="4" strokeLinecap="round">
      <path className="wisp w1" d="M48 52c-8-10 8-16 0-28s6-16 2-22" />
      <path className="wisp w2" d="M62 54c-8-12 10-16 2-30s6-14 2-22" />
      <path className="wisp w3" d="M76 52c-8-10 8-16 0-28" />
    </g>
    <path d="M38 58h44l-5 62H43Z" fill="#B9C2C4" />
    <path d="M38 58h44l-1 10H39Z" fill="#DCE2E3" />
    <path d="M47 72l3 42" stroke="#E8EDEE" strokeWidth="4" strokeLinecap="round" />
    <path d="M14 122h92l-9 20H23Z" fill="#9FAAAD" />
    <path d="M14 122h92l-2 5H16Z" fill="#C9D0D2" />
  </svg>
);

const DownArrow = () => (
  <svg className="down" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v15M6 13l6 6 6-6" />
  </svg>
);

const Arrow = () => (
  <svg className="arrow" viewBox="0 0 110 70" aria-hidden="true">
    <path className="arrow-stroke" d="M8 60C40 64 74 52 98 28" fill="none" stroke="#E8B12A" strokeWidth="8" strokeLinecap="round" />
    <path className="arrow-head" d="M78 22l22 3-5 21" fill="none" stroke="#E8B12A" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function Home() {
  const [line, setLine] = useState<LineState | null>(null);
  const [menu, setMenu] = useState<PublicItem[] | null>(null);
  const [clientId, setClientId] = useState("");

  useEffect(() => {
    document.title = "Kaveri Kitchen";
    const theme = document.querySelector('meta[name="theme-color"]');
    const was = theme?.getAttribute("content");
    theme?.setAttribute("content", "#0D4F52");
    getLine().then(setLine).catch(() => setLine({ active: false, restaurant: "Kaveri Kitchen", ready_minutes: 20, busy: false }));
    getPublicMenu().then(setMenu).catch(() => setMenu([]));
    getConfig().then((c) => setClientId(c.paypal_client_id)).catch(() => {});
    return () => { if (was) theme?.setAttribute("content", was); };
  }, []);
  const closed = line !== null && !line.active;

  return (
    <div className="home">
      <header className="wall-top">
        <div className="sign-col">
          <span className="nail n1" aria-hidden="true" /><span className="nail n2" aria-hidden="true" />
          <div className="sign">
            <span className="screw tl" /><span className="screw tr" /><span className="screw bl" /><span className="screw br" />
            <h1>Kaveri<br />Kitchen</h1>
            <p className="sign-line">South Indian cooking, and the dishes our regulars asked for. Pickup only.</p>
          </div>
          <ul className="plaques">
            <li className="plaque plaque-red">Pickup only</li>
            <li className="plaque plaque-cream">
              {closed ? "Counter closed" : <>Ready in about <span className="num">{line?.ready_minutes ?? 20}</span> min</>}
            </li>
            <li className="plaque plaque-ink"><a href="#menu">See the menu <DownArrow /></a></li>
          </ul>
        </div>
        <div className="counter-col">
          {!closed && <div className="order-here" aria-hidden="true"><span>Order<br />here</span><Arrow /></div>}
          <TalkPanel line={line} clientId={clientId} />
          <div className="ledge"><Tumbler /></div>
          {line?.active && <a className="counter-call" href="tel:+13502503546">Or call <span className="num">+1 350-250-3546</span></a>}
        </div>
      </header>

      <div className="lower">
      <section className="story" aria-labelledby="story-title">
        <h2 id="story-title">A short board and a hot griddle</h2>
        <div className="story-body">
          <p>
            Kaveri Kitchen is a small pickup counter that cooks the way a Chennai mess does: a short board, a hot griddle,
            and food that comes out fast. The South Indian dishes are the ones we grew up eating. The others arrived with
            our regulars, one request at a time, until the board needed a second column.
          </p>
          <p>
            Ordering works like the counter does. Tell us what you want, out loud, and we write the ticket as you speak.
            Pay with PayPal on this page and we start cooking.
          </p>
        </div>
        <dl className="facts">
          <div><dt>Hours</dt><dd>Every day<br />11 AM – 10 PM</dd></div>
          <div><dt>Address</dt><dd>123 Gay Street<br />Knoxville, TN 37901</dd></div>
          <div><dt>Phone</dt><dd><a href="tel:+13502503546" className="num">+1 350-250-3546</a></dd></div>
        </dl>
        <ul className="prints">
          {PRINTS.map((p) => (
            <li className="print" key={p.caption}>
              <span className="tack" aria-hidden="true" />
              <img src={p.src} alt={p.alt} width={800} height={600} loading="lazy" />
              <span className="print-cap">{p.caption}</span>
            </li>
          ))}
        </ul>
      </section>

      <MenuBoard items={menu} />

      <footer className="foot">
        <p>Kaveri Kitchen is a fictional restaurant, made up to show PalKova taking orders. The voice ordering is real; payments run in the PayPal sandbox.</p>
        <p className="credits">
          Photos via Wikimedia Commons, resized and cropped:{" "}
          <a href="https://commons.wikimedia.org/wiki/File:Ambur_Mutton_Briyani.jpg">Sreenorainee</a> and{" "}
          <a href="https://commons.wikimedia.org/wiki/File:CreamyButterChicken.jpg">Amar Nath Adak</a>,{" "}
          <a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>;{" "}
          <a href="https://commons.wikimedia.org/wiki/File:Mango_Lassi_.jpg">Misaochan</a>,{" "}
          <a href="https://creativecommons.org/licenses/by-sa/3.0">CC BY-SA 3.0</a>.
        </p>
        <a href="/owner" target="_blank" rel="noopener">Kitchen login</a>
      </footer>
      </div>
    </div>
  );
}
