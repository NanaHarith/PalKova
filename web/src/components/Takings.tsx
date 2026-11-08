// The owner's Takings screen: an AG Studio dashboard over the last 90 days of paid orders, themed as
// part of the board, with the "Ordered together" widget and the kitchen analyst on Studio's agents.
import { useEffect, useMemo, useState } from "react";
import { AgStudioAiModule } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { AuthError, getOrders, type Order } from "../api";
import { takingsAi } from "../studio/ai";
import { takingsData } from "../studio/data";
import { pairingsWidget } from "../studio/Pairings";
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
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const ai = useMemo(takingsAi, []);

  useEffect(() => {
    getOrders(DAYS).then((o) => { setOrders(o); setFailed(false); })
      .catch((e) => (e instanceof AuthError ? onSignedOut() : setFailed(true)));
  }, [version, onSignedOut]);

  const data = useMemo(() => (orders ? takingsData(orders) : null), [orders]);

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
