// "Ordered together": the dish pairs that turn up in the same order most often. Studio's own widgets
// aggregate one field at a time; pairs need every order's whole basket, so this widget asks Studio for
// order-and-dish rows (with the page's filters applied) and counts the pairs itself.
import { useEffect, useState } from "react";
import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import type { AgWidgetDefinition } from "ag-studio-react";

type Pair = { a: string; b: string; orders: number };
const TOP = 6;

/** Each pair of distinct dishes counted once per order. */
export function pairs(rows: { order: string; dish: string }[]): { list: Pair[]; baskets: number } {
  const baskets = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.order || !r.dish) continue;
    (baskets.get(r.order) ?? baskets.set(r.order, new Set()).get(r.order)!).add(r.dish);
  }
  const counts = new Map<string, Pair>();
  let multi = 0;
  for (const dishes of baskets.values()) {
    const d = [...dishes].sort();
    if (d.length > 1) multi++;
    for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) {
      const key = `${d[i]}\u0000${d[j]}`;
      const p = counts.get(key) ?? { a: d[i], b: d[j], orders: 0 };
      p.orders++;
      counts.set(key, p);
    }
  }
  const list = [...counts.values()].sort((x, y) => y.orders - x.orders || x.a.localeCompare(y.a)).slice(0, TOP);
  return { list, baskets: multi };
}

type Mapping = { order: AgWidgetField[]; dish: AgWidgetField[] };

function Pairings({ dataMapping, widgetApi }: AgWidgetParams<{ dataMapping: Mapping; format?: object }>) {
  const [state, setState] = useState<{ list: Pair[]; baskets: number } | null>(null);
  const order = dataMapping.order?.[0], dish = dataMapping.dish?.[0];

  useEffect(() => {
    if (!order || !dish) { widgetApi.setDisplayState("incompleteDataMapping"); return; }
    let live = true;
    widgetApi.setDisplayState("loading");
    widgetApi.getData({ fields: [order, dish] }, { queryId: "pairings" }).then((r) => {
      if (!live) return;
      const rows = r.results.rows.map((row) => ({ order: String(row[order.key] ?? ""), dish: String(row[dish.key] ?? "") }));
      const result = pairs(rows);
      setState(result);
      widgetApi.setDisplayState(result.list.length ? "displayed" : "noData");
    }).catch(() => live && widgetApi.setDisplayState("noData"));
    return () => { live = false; };
  }, [order, dish, widgetApi]);

  if (!state?.list.length) return null;
  const top = state.list[0].orders;
  return (
    <div className="pairings">
      <ol>
        {state.list.map((p) => (
          <li key={p.a + p.b}>
            <span className="pr-dishes">{p.a} <span className="pr-and">with</span> {p.b}</span>
            <span className="pr-count num">{p.orders}</span>
            <span className="pr-track" aria-hidden="true"><span style={{ width: `${(p.orders / top) * 100}%` }} /></span>
          </li>
        ))}
      </ol>
      <p className="pr-foot num">Counted across {state.baskets} orders with two or more dishes.</p>
    </div>
  );
}

export const pairingsWidget: AgWidgetDefinition = {
  id: "ordered-together",
  label: "Ordered together",
  // Two plates side by side, in the board's icon stroke (24px grid, 1.75, round caps), drawn in silk.
  icon: { url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#6B1540" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="5"/><circle cx="16" cy="12" r="5"/><path d="M12 9.2v5.6"/></svg>')}` },
  dataMapping: {
    order: { type: "field", supportedRoles: ["category"], required: true,
      aiDescription: "The order id field, so dishes can be grouped into baskets." },
    dish: { type: "field", supportedRoles: ["category"], required: true, aiDescription: "The dish name field." },
  },
  ai: {
    label: "Ordered together",
    description: "The dish pairs that appear in the same order most often, counted once per order.",
    usage: "Use it to answer which dishes sell together, or to suggest combos.",
  },
  form: (p) => p.createDefaults({ dataMappingItems: [{ key: "order", label: "Order" }, { key: "dish", label: "Dish" }] }),
  comp: Pairings,
  defaultSize: { width: 480, height: 360 },
  minSize: { width: 300, height: 240 },
};
