import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow/700.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/anton/400.css";
import "./styles.css";
import Home from "./pages/Home";

const OwnerApp = lazy(() => import("./ownerApp"));

createRoot(document.getElementById("root")!).render(
  location.pathname === "/owner" ? <Suspense><OwnerApp /></Suspense> : <Home />,
);
