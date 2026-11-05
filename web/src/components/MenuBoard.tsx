import { useEffect, useRef, useState } from "react";
import { money, type PublicItem } from "../api";

const ORDER = ["Starters", "Breads", "Drinks", "Desserts", "Mains"];  // Mains get the right-hand column to themselves
const TAG: Record<string, string> = {
  veg: "Veg", vegan: "Vegan", egg: "Egg", gluten: "Gluten", contains_dairy: "Dairy", contains_nuts: "Nuts",
};

/** The painted wall menu: rows letter in the first time the board scrolls into view. */
export default function MenuBoard({ items }: { items: PublicItem[] | null }) {
  const ref = useRef<HTMLElement>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || painted) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setPainted(true), { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, [painted]);

  const cats = ORDER.filter((c) => items?.some((i) => i.category === c));
  let n = 0;  // row index across the board, for the paint stagger

  return (
    <section className={`menu-board${painted ? " is-painted" : ""}`} id="menu" ref={ref} aria-labelledby="menu-title">
      <span className="screw tl" /><span className="screw tr" /><span className="screw bl" /><span className="screw br" />
      <h2 id="menu-title" className="board-title">Menu</h2>
      <p className="board-sub">Tax is added on your ticket. Dishes struck through in red are finished for today.</p>
      {!items && <p className="board-sub">Lettering the board…</p>}
      <div className="board-cols">
        {[cats.filter((c) => c !== "Mains"), cats.filter((c) => c === "Mains")].map((col, k) => (
          <div className="board-col" key={k}>
          {col.map((c) => (
          <div className={`board-cat cat-${c.toLowerCase()}`} key={c}>
            <h3>{c}</h3>
            <ul>
              {items!.filter((i) => i.category === c).map((i) => (
                <li key={i.id} className={i.orderable ? "dish" : "dish is-out"} style={{ "--i": n++ } as React.CSSProperties}>
                  <div className="dish-line">
                    <span className="dish-name">{i.name}</span>
                    <span className="dish-dots" aria-hidden="true" />
                    <span className="dish-price num">{money(i.price_cents)}</span>
                  </div>
                  <p className="dish-desc">
                    {i.description}
                    {(i.dietary.length > 0 || i.spice_default === "hot") && (
                      <span className="dish-tags">
                        {i.spice_default === "hot" && <span className="tag tag-hot">Hot</span>}
                        {i.dietary.map((d) => TAG[d] && <span className="tag" key={d}>{TAG[d]}</span>)}
                      </span>
                    )}
                  </p>
                  {!i.orderable && <span className="sold-out">Sold out</span>}
                </li>
              ))}
            </ul>
          </div>
          ))}
          </div>
        ))}
      </div>
    </section>
  );
}
