/** The Capture screen: capture controls on top, then the list of captures, the editor or settings. */
import { formatBytes } from "../core/time";
import { openDataFolder } from "../platform/desktop";
import { CaptureBar } from "./CaptureBar";
import { Editor } from "./Editor";
import { IconFolder, IconSettings } from "./icons";
import { Library } from "./Library";
import { ScreenshotView } from "./ScreenshotView";
import { SettingsView } from "./SettingsView";
import type { CaptureCtl } from "./useCapture";

export function CaptureView({ k }: { k: CaptureCtl }) {
  if (k.boot.state === "loading") {
    return (
      <div className="cap">
        <div className="state" role="status">
          <div className="spin" />
          <h2>Getting capture ready</h2>
          <p>Checking the Captures folder and ffmpeg.</p>
        </div>
      </div>
    );
  }
  if (k.boot.state === "browser") {
    return (
      <div className="cap">
        <div className="state">
          <h2>Capture needs the desktop app</h2>
          <p>This is the web preview. Screenshots, recordings and exports need Safelight running on Windows.</p>
        </div>
      </div>
    );
  }
  if (k.boot.state === "error") {
    return (
      <div className="cap">
        <div className="state">
          <h2>{k.boot.error.title}</h2>
          <p>{k.boot.error.message}</p>
          <div className="acts">
            <button className="btn primary" onClick={() => window.location.reload()}>Try again</button>
          </div>
        </div>
      </div>
    );
  }

  const { view, counts, filter } = k;
  const tab = (f: typeof filter, label: string) => (
    <button
      className={`chip ${view.name === "library" && filter === f ? "on" : ""}`}
      aria-pressed={view.name === "library" && filter === f}
      onClick={() => {
        k.setFilter(f);
        k.setView({ name: "library" });
      }}
    >
      {label} <small>{counts[f]}</small>
    </button>
  );

  return (
    <div className="cap">
      <div className="cap-top">
        <h1>Capture</h1>
        <span className="sub">Screenshots and screen recordings. Everything lands in your library.</span>
      </div>
      <CaptureBar k={k} />
      <div className="cap-tabs">
        {tab("all", "All captures")}
        {tab("video", "Recordings")}
        {tab("screenshot", "Screenshots")}
        <span className="cap-store" title={k.config?.dataDir}>{formatBytes(k.storageBytes)} in Captures</span>
        <button className="btn ghost" onClick={() => void openDataFolder()}><IconFolder /> Open folder</button>
        <button className={`btn ghost ${view.name === "settings" ? "on" : ""}`} aria-pressed={view.name === "settings"} onClick={() => k.setView({ name: "settings" })}>
          <IconSettings /> Settings
        </button>
      </div>
      {!k.ffmpegOk && (
        <div className="banner err" role="alert">
          <b>ffmpeg isn't installed.</b> Capture and export need it. Run <span className="kbd">winget install Gyan.FFmpeg</span>, then restart Safelight.
        </div>
      )}
      {k.hotkeyFailures.length > 0 && (
        <div className="banner" role="status">
          <b>Some shortcuts didn't register:</b> {k.hotkeyFailures.map((f) => `${f.accelerator} (${f.reason})`).join(", ")}
          <button className="btn" onClick={() => k.setView({ name: "settings" })}>Change shortcuts</button>
        </div>
      )}
      {k.saving && (
        <div className="banner" role="status">
          <div className="spin" style={{ width: 16, height: 16 }} /> Saving your recording…
        </div>
      )}
      <div className="cap-body">
        {view.name === "library" && <Library k={k} />}
        {view.name === "screenshot" && <ScreenshotView k={k} id={view.id} />}
        {view.name === "editor" && <Editor k={k} id={view.id} key={view.id} />}
        {view.name === "settings" && <SettingsView k={k} />}
      </div>
    </div>
  );
}
