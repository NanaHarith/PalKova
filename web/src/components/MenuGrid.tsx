import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type { CellValueChangedEvent, ColDef, GridApi, RowClassParams, ValueParserParams } from "ag-grid-community";
import { ApiError, AuthError, DIET, getMenu, patchMenu, type MenuItem, money, type Spice } from "../api";
import type { AgChartTheme } from "ag-charts-types";
import { emptyOverlays, theme } from "./KitchenBoard";
import CommandBar from "./CommandBar";

type Ctx = { setAvailable: (m: MenuItem, on: boolean) => void; notice: (text: string) => void };
type Stock = "in" | "low" | "out" | "off";

// Low is the plan's rule: what is left is at most a fifth of the day's par.
const stock = (m: MenuItem): Stock =>
  !m.available ? "off" : m.remaining === 0 ? "out" : m.remaining <= 0.2 * m.par_level ? "low" : "in";
const STOCK_WORD: Record<Exclude<Stock, "in">, string> = { low: "Low", out: "Sold out", off: "Off menu" };
const diet = (m: MenuItem) => m.dietary.map((d) => DIET[d] ?? d).join(" · ");
const spiceWord = (s: Spice | null) => (s ? s[0].toUpperCase() + s.slice(1) : "None");
const hour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

/** "12.5", "$12.50" → 1250; anything else → null. The server checks again. */
function parsePrice(text: string): number | null {
  const m = /^\$?\s*(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents >= 1 ? cents : null;
}

// The band is this grid's korvai border: a gauge of what is left of the day's par, filled from the foot in silk.
function GaugeCell({ data }: CustomCellRendererProps<MenuItem>) {
  const m = data!;
  const fill = m.available && m.par_level > 0 ? Math.min(1, m.remaining / m.par_level) : 0;
  return <span className="gauge" style={{ transform: `scaleY(${fill})` }} />;
}

function DishCell({ data }: CustomCellRendererProps<MenuItem>) {
  const m = data!;
  return (
    <span className="stack mg-dish">
      <span className="mg-name ellipsis" title={m.name}>{m.name}</span>
      <span className="sub mg-sub ellipsis">
        {m.category}
        {/* the Spice column leaves at the two narrowest bands; the word stays readable here */}
        {m.spice_default && <span className="mg-spice"> · {spiceWord(m.spice_default)}</span>}
        {diet(m) && ` · ${diet(m)}`}
      </span>
    </span>
  );
}

function FieldCell({ valueFormatted, value }: CustomCellRendererProps<MenuItem>) {
  return <span className="field num">{valueFormatted ?? value}</span>;
}

function SpiceCell({ data }: CustomCellRendererProps<MenuItem>) {
  const s = data!.spice_default;
  return <span className={`field field-word${s ? "" : " field-none"}`}>{spiceWord(s)}</span>;
}

function RemainingCell({ data }: CustomCellRendererProps<MenuItem>) {
  const m = data!, s = stock(m);
  return (
    <span className="remaining">
      <span className="num">{m.remaining}</span>
      {s !== "in" && <span className={`chip chip-stock-${s}`}>{STOCK_WORD[s]}</span>}
    </span>
  );
}

function AvailableCell({ data, context }: CustomCellRendererProps<MenuItem, unknown, Ctx>) {
  const m = data!;
  return (
    <button className="switch" role="switch" aria-checked={m.available} aria-label={`${m.name} on the menu`}
      onClick={() => context.setAvailable(m, !m.available)}>
      <span className="switch-track" aria-hidden="true" />
      {m.available ? <span>On<span className="sw-long"> menu</span></span> : <span>Off</span>}
    </button>
  );
}

type Fit = "full" | "tablet" | "narrow" | "compact" | "phone";
// Each set fits its band without sideways scrolling: full 1338px, tablet 1066px, narrow 862px, compact 550px, phone 348px.
const fitFor = (w: number): Fit =>
  w >= 1350 ? "full" : w >= 1080 ? "tablet" : w >= 880 ? "narrow" : w >= 560 ? "compact" : "phone";

/** The hours shown: the same window on every row (so bars compare), spanning the day's first to last sale,
 *  at least eight hours wide; lunch to close before anything sells. */
function serviceHours(rows: MenuItem[]): [number, number] {
  const sold = rows.reduce((t, m) => t.map((n, h) => n + m.sales_by_hour[h]), Array(24).fill(0) as number[]);
  const first = sold.findIndex((n) => n > 0), last = 23 - [...sold].reverse().findIndex((n) => n > 0);
  if (first < 0) return [11, 22];
  const lo = Math.max(0, Math.min(first, last - 7));
  return [lo, Math.min(23, Math.max(last, lo + 7))];
}

function columnsFor(fit: Fit, peak: number, hours: [number, number]): ColDef<MenuItem>[] {
  const full = fit === "full", phone = fit === "phone", compact = fit === "compact";
  const price = (p: ValueParserParams<MenuItem, number, Ctx>) => {
    if (typeof p.newValue === "number") return p.newValue;  // already cents (paste between price cells)
    if (String(p.newValue).trim() === money(p.oldValue!)) return p.oldValue;  // opened and closed unchanged
    const cents = parsePrice(String(p.newValue));
    if (cents === null) p.context.notice(`${p.data.name} keeps ${money(p.oldValue!)}: a price looks like 12.50.`);
    return cents ?? p.oldValue;
  };
  return [
    { colId: "band", headerName: "", width: 24, minWidth: 24, maxWidth: 24, resizable: false, sortable: false, filter: false,
      cellClass: "band band-stock", cellRenderer: GaugeCell, suppressNavigable: true, headerTooltip: "Stock left of today's par" },
    { field: "name", headerName: "Dish", flex: 1, minWidth: phone ? 120 : compact ? 110 : 150, filter: "agTextColumnFilter",
      cellRenderer: DishCell, cellClass: full ? "dish-cell" : "dish-cell with-sub" },
    { field: "category", headerName: "Category", width: 112, hide: !full },
    { colId: "dietary", headerName: "Dietary", width: 140, valueGetter: (p) => diet(p.data!), hide: !full, filter: "agTextColumnFilter",
      cellClass: "sub-cell" },
    { field: "spice_default", headerName: "Spice", width: 116, editable: true, singleClickEdit: true, hide: compact || phone,
      cellEditor: "agRichSelectCellEditor", cellEditorParams: { values: ["mild", "medium", "hot", null], formatValue: spiceWord },
      valueFormatter: (p) => spiceWord(p.value), cellRenderer: SpiceCell, enableCellChangeFlash: true },
    // 128: room for the sort and filter marks beside "Price"; the command bar filters it in dollars
    { colId: "price", field: "price_cents", headerName: "Price", width: compact ? 92 : 128, type: "rightAligned", editable: true, filter: NUM,
      filterValueGetter: (p) => p.data!.price_cents / 100,
      singleClickEdit: true, cellEditor: "agTextCellEditor", cellEditorParams: { useFormatter: true },  // edit in dollars
      valueFormatter: (p) => money(p.value),
      valueParser: price, cellRenderer: FieldCell, enableCellChangeFlash: true, hide: phone },
    { field: "par_level", headerName: "Par", width: compact ? 80 : 88, type: "rightAligned", editable: true, filter: NUM,
      singleClickEdit: true, cellEditor: "agNumberCellEditor", cellEditorParams: { min: 0, max: 9999, precision: 0 },
      cellRenderer: FieldCell, enableCellChangeFlash: true, hide: phone },
    { field: "sold_today", headerName: "Sold", headerTooltip: "Sold today", width: 88, type: "rightAligned", cellClass: "num", filter: NUM,
      enableCellChangeFlash: true, hide: compact || phone },
    { field: "remaining", headerName: "Left", width: phone ? 92 : compact ? 120 : 136, cellRenderer: RemainingCell, filter: NUM,
      enableCellChangeFlash: true },
    { colId: "sales_by_hour", headerName: `Today ${hour(hours[0])}–${hour(hours[1] + 1)}`, width: 160, sortable: false, filter: false,
      valueGetter: (p) => p.data!.sales_by_hour.slice(hours[0], hours[1] + 1),
      cellRenderer: "agSparklineCellRenderer", cellClass: "spark-cell", hide: !(full || fit === "tablet"),
      cellRendererParams: { sparklineOptions: {
        type: "bar", direction: "vertical", fill: "#5B5157", max: peak, padding: { top: 14, bottom: 14 },
        tooltip: { renderer: ({ xValue, yValue }: { xValue: number; yValue: number }) =>
          ({ content: `${hour(hours[0] + xValue)} · ${yValue} sold` }) },
      } } },
    { field: "available", headerName: "On menu", width: phone ? 112 : compact ? 124 : 156, cellRenderer: AvailableCell,
      cellClass: "switch-cell", sortable: false, pinned: "right", lockPinned: true },
  ];
}

// Every column filterable (set filter; counts and money take NUM), so the command bar can filter any of them.
// Header menus stay hidden, so filters are only ever set from the bar.
const DEFAULT_COL: ColDef<MenuItem> = {
  suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, suppressMovable: true, filter: true };
const NUM = "agNumberColumnFilter";
const MENU_OVERLAYS = emptyOverlays(["No dishes yet.", "The menu loads from the restaurant's menu file."],
  ["No dishes match this view.", "Show the whole menu to see every dish."]);

// Chart palette: silk first, then quiet neutrals; the order ramp's gold and teal mean order steps, not series.
const chartThemes: Record<string, AgChartTheme> = { palkova: { baseTheme: "ag-default", palette: {
  fills: ["#6B1540", "#5B5157", "#B5738F", "#8A7B84", "#3F0C26"], strokes: ["#561033", "#3F383C", "#8F4F6B", "#6E6169", "#2A0819"],
}, overrides: { common: { background: { fill: "#F8F4EF" }, title: { fontFamily: "Barlow" },
  axes: { category: { label: { fontFamily: "Barlow", color: "#5B5157" } }, number: { label: { fontFamily: "Barlow", color: "#5B5157" } } } } } } };

export default function MenuGrid({ version, onNotice, onSignedOut }: {
  version: number; onNotice: (text: string) => void; onSignedOut: () => void;
}) {
  const [rows, setRows] = useState<MenuItem[] | null>(null);
  const [fit, setFit] = useState<Fit>(() => fitFor(window.innerWidth));
  const api = useRef<GridApi<MenuItem> | null>(null);
  const reverting = useRef(false);

  const fail = (e: unknown) => {
    if (e instanceof AuthError) onSignedOut();
    else onNotice("Can't reach the server. The menu will catch up when it's back.");
  };
  const load = () => getMenu().then((m) => setRows(m.items)).catch(fail);
  // menu.updated and paid orders bump the version; the server's numbers replace ours, changed cells flash.
  useEffect(() => { load(); }, [version]);  // eslint-disable-line react-hooks/exhaustive-deps

  const peak = Math.max(1, ...(rows ?? []).flatMap((m) => m.sales_by_hour));
  const [lo, hi] = serviceHours(rows ?? []);
  const columns = useMemo(() => columnsFor(fit, peak, [lo, hi]), [fit, peak, lo, hi]);

  const save = async (m: MenuItem, fields: Parameters<typeof patchMenu>[1], undo: () => void) => {
    try {
      await patchMenu(m.id, fields);
      onNotice("");  // an earlier rejection no longer describes the menu
      load();
    } catch (e) {
      undo();
      if (e instanceof ApiError && e.status === 422) onNotice(`${m.name} wasn't changed: the server didn't accept that value.`);
      else if (e instanceof ApiError && e.status === 404) { onNotice(`${m.name} is no longer on the menu list.`); load(); }
      else fail(e);
    }
  };

  const edited = (e: CellValueChangedEvent<MenuItem>) => {
    if (reverting.current || e.newValue === e.oldValue) return;
    const field = e.colDef.field as "price_cents" | "par_level" | "spice_default";
    if (field === "par_level" && (!Number.isInteger(e.newValue) || e.newValue < 0)) {
      reverting.current = true; e.node.setDataValue(field, e.oldValue); reverting.current = false;
      return onNotice("Par must be a whole number, 0 or more.");
    }
    save(e.data, { [field]: e.newValue }, () => {
      reverting.current = true; e.node.setDataValue(field, e.oldValue); reverting.current = false;
    });
  };

  const context = useMemo<Ctx>(() => ({
    setAvailable: (m, on) => {
      const node = api.current?.getRowNode(m.id);
      node?.setData({ ...m, available: on });
      save(m, { available: on }, () => node?.setData(m));
    },
    notice: onNotice,
  }), []);  // eslint-disable-line react-hooks/exhaustive-deps

  const rowClassRules = {
    "row-low": (p: RowClassParams<MenuItem>) => !!p.data && stock(p.data) === "low",
    "row-out": (p: RowClassParams<MenuItem>) => !!p.data && (stock(p.data) === "out" || stock(p.data) === "off"),
  };

  const counts = (rows ?? []).reduce((c, m) => ({ ...c, [stock(m)]: c[stock(m)] + 1 }), { in: 0, low: 0, out: 0, off: 0 });
  const chartSold = () => api.current?.createRangeChart({
    cellRange: { columns: ["name", "sold_today"] }, chartType: "groupedBar", chartThemeName: "palkova",
    chartThemeOverrides: { common: { title: { enabled: true, text: "Sold today", fontFamily: "Barlow", fontWeight: 600 } } },
  });

  if (rows === null) return <div className="loading">Loading the menu…</div>;
  return (
    <div className="menu-view">
      <CommandBar grid="menu" api={() => api.current} onSignedOut={onSignedOut}>
        <p className="menu-summary">
          <span><strong className="num">{rows.length}</strong> dishes</span>
          <span><strong className="num">{counts.low}</strong> low</span>
          <span><strong className="num">{counts.out}</strong> sold out</span>
          <span><strong className="num">{counts.off}</strong> off the menu</span>
        </p>
        <p className="menu-hint">Tap a {fit === "compact" || fit === "phone" ? "price or par" : "spice, price or par"} to change it.<span className="hint-more"> Select cells and right-click to chart them.</span></p>
        <button className="act act-quiet menu-chart" onClick={chartSold}>Chart sold today</button>
      </CommandBar>
      <div className={`board menu-grid fit-${fit}`}>
        <AgGridReact<MenuItem>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={DEFAULT_COL}
          context={context}
          getRowId={(p) => p.data.id}
          rowClassRules={rowClassRules}
          cellSelection
          enableCharts
          customChartThemes={chartThemes}
          chartThemes={["palkova"]}
          stopEditingWhenCellsLoseFocus
          overlayComponentSelector={MENU_OVERLAYS}
          onCellValueChanged={edited}
          suppressColumnMoveAnimation
          onGridReady={(e) => { api.current = e.api; }}
          onGridSizeChanged={(e) => { if (e.clientWidth) setFit(fitFor(e.clientWidth)); }}
        />
      </div>
    </div>
  );
}
