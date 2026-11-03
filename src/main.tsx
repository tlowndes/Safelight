import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Flash } from "./capture/ui/Flash";
import { Hud } from "./capture/ui/Hud";
import { RegionPicker } from "./capture/ui/RegionPicker";
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "./styles.css";
import "./capture/capture.css";

// One bundle serves four windows: the main app, plus capture's recording HUD,
// region overlay and screenshot flash.
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
if (view === "hud") document.body.classList.add("hud-body");
if (view === "region") document.body.classList.add("region-body");
if (view === "flash") document.body.classList.add("flash-body");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {view === "hud" ? <Hud /> : view === "region" ? <RegionPicker purpose={params.get("purpose") ?? "screenshot"} /> : view === "flash" ? <Flash /> : <App />}
  </React.StrictMode>,
);
