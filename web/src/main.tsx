import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow/700.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/anton/400.css";
import "@fontsource-variable/anek-latin/standard.css";
import "./styles.css";
import Home from "./pages/Home";
import Pay from "./pages/Pay";

const OwnerApp = lazy(() => import("./ownerApp"));
const payLink = location.pathname.match(/^\/p\/([^/]+)$/);

createRoot(document.getElementById("root")!).render(
  location.pathname === "/owner" ? <Suspense><OwnerApp /></Suspense>
    : payLink ? <Pay pid={decodeURIComponent(payLink[1])} /> : <Home />,
);
