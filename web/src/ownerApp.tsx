// The owner board and its grid library load only on /owner, keeping the public page light.
import { useState } from "react";
import { ModuleRegistry } from "ag-grid-community";
import { AllEnterpriseModule, LicenseManager } from "ag-grid-enterprise";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import Owner from "./pages/Owner";
import Login from "./pages/Login";

ModuleRegistry.registerModules([AllEnterpriseModule.with(AgChartsEnterpriseModule)]);  // charts: sparklines, range charts
LicenseManager.setLicenseKey(import.meta.env.VITE_AG_GRID_LICENSE ?? "");

export default function OwnerApp() {
  const [signedIn, setSignedIn] = useState(true);  // the board's first API call says otherwise with a 401
  return signedIn ? <Owner onSignedOut={() => setSignedIn(false)} /> : <Login onSignedIn={() => setSignedIn(true)} />;
}
