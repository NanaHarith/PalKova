// The owner's Takings screen: an AG Studio dashboard over the last 90 days of paid orders, themed as
// part of the board, with the "Ordered together" widget and the kitchen analyst on Studio's agents.
import { useEffect, useMemo, useRef, useState } from "react";
import { AgStudioAiModule } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { AuthError, getMenu, getOrders, type MenuItem, type Order } from "../api";
import { takingsAi } from "../studio/ai";
import { takingsData } from "../studio/data";
import { pairingsWidget, type Basket } from "../studio/Pairings";
import { takingsReport } from "../studio/report";
import { takingsTheme } from "../studio/theme";

const DAYS = 90;
const LICENSE = import.meta.env.VITE_AG_STUDIO_LICENSE ?? "";
const MODULES = [AgStudioAiModule];
// Viewing: the page alone, no empty filter panel. Editing: the kitchen analyst, then Studio's widget palette;
// the agents map fields themselves, so the data and filter panels stay out of the way.
const PANELS = { view: { right: [] }, edit: { right: ["ai", "edit"] } } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const widgets = (defaults: any) => createWidgets({
  additionalTypes: [pairingsWidget],
  menu: [{ label: "Kaveri Kitchen", widgetIds: ["ordered-together"] }, ...defaults.menu],
} as never);

export default function Takings({ version, onSignedOut }: { version: number; onSignedOut: () => void }) {
  const [loaded, setLoaded] = useState<{ orders: Order[]; menu: MenuItem[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  // The analyst's ordered_together tool reads the latest baskets; the harness itself is built once.
  const baskets = useRef<Basket[]>([]);
  const ai = useMemo(() => takingsAi(() => baskets.current), []);

  useEffect(() => {
    Promise.all([getOrders(DAYS), getMenu()]).then(([orders, m]) => { setLoaded({ orders, menu: m.items }); setFailed(false); })
      .catch((e) => (e instanceof AuthError ? onSignedOut() : setFailed(true)));
  }, [version, onSignedOut]);

  const data = useMemo(() => (loaded ? takingsData(loaded.orders, loaded.menu) : null), [loaded]);
  baskets.current = (data?.sources.find((s) => s.id === "lines") as { data?: { order_id: string; dish: string }[] } | undefined)
    ?.data?.map((l) => ({ order: l.order_id, dish: l.dish })) ?? [];

  return (
    <>
      <div className="tool-row tool-row-solo takings-row">
        <p className="takings-note">
          Paid orders from the last {DAYS} days, in dollars kept after refunds.
        </p>
        <button className="act act-quiet" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? "Done" : "Ask the analyst or edit"}
        </button>
      </div>
      {failed && !data && <div className="loading">Can't reach the server. Takings will load when it's back.</div>}
      {!failed && !data && <div className="loading">Loading takings…</div>}
      {data && (
        <div className="takings">
          <AgStudioProvider licenseKey={LICENSE} modules={MODULES}>
            <AgStudio
              data={data}
              initialState={takingsReport}
              widgets={widgets}
              theme={takingsTheme}
              loadThemeGoogleFonts={false}
              mode={editing ? "edit" : "view"}
              panels={PANELS as never}
              ai={ai}
              style={{ height: "100%", width: "100%" }}
            />
          </AgStudioProvider>
        </div>
      )}
    </>
  );
}
