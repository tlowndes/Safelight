import { useEffect, useState } from "react";
import { toFriendly, type FriendlyError } from "../core/errors";
import { basename } from "../core/filenames";
import { PRESETS, type PresetId } from "../core/presets";
import type { EditRecipe } from "../core/recipe";
import { formatBytes } from "../core/time";
import { openMicSettings } from "../platform/desktop";
import type { Capture } from "../services/library";
import { exportCapture, type ExportResult } from "../services/pipeline";
import { IconClose, IconCopy, IconFolder } from "./icons";
import type { CaptureCtl } from "./useCapture";

type Phase =
  | { name: "idle" }
  | { name: "running"; progress: number }
  | { name: "done"; result: ExportResult }
  | { name: "error"; error: FriendlyError };

export function ExportPanel(props: { k: CaptureCtl; capture: Capture; recipe: EditRecipe; errors: string[]; onClose: () => void }) {
  const { k, capture, recipe, errors } = props;
  const [preset, setPreset] = useState<PresetId>(k.settings?.defaultPreset ?? "mp4-h264");
  const [sidecars, setSidecars] = useState(true);
  const [burn, setBurn] = useState(true);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const running = phase.name === "running";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !running && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function run() {
    if (!k.ports) return;
    setPhase({ name: "running", progress: 0 });
    try {
      const result = await exportCapture(k.ports, {
        capture,
        recipe,
        presetId: preset,
        includeSidecars: sidecars,
        burnAnnotations: burn,
        onProgress: (p) => setPhase({ name: "running", progress: p }),
      });
      setPhase({ name: "done", result });
      void k.refresh();
      void k.landInLibrary();
    } catch (err) {
      setPhase({ name: "error", error: toFriendly(err) });
    }
  }

  const progress = phase.name === "running" ? Math.round(phase.progress * 100) : 0;
  const video = phase.name === "done" ? phase.result.files[0] : null;

  return (
    <div className="drawer-bg" onPointerDown={(e) => e.target === e.currentTarget && !running && props.onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header>
          <h3 id="export-title">Export</h3>
          <button className="btn icon ghost" aria-label="Close" onClick={props.onClose} disabled={running}>
            <IconClose />
          </button>
        </header>
        <div className="content">
          {phase.name === "done" && video ? (
            <div className="successbox" role="status">
              <span className="pill ok">Exported</span>
              <b>{basename(video.path)}</b>
              <span className="muted">{formatBytes(video.sizeBytes)} · saved on this PC and added to your library, nothing uploaded</span>
              <div className="files">
                {phase.result.files.map((f) => (
                  <div key={f.path}>
                    <span>
                      <span className="muted">{f.label}</span>
                      <br />
                      <code>{basename(f.path)}</code>
                    </span>
                    <button className="btn icon ghost" aria-label={`Copy path of ${f.label}`} title="Copy path" onClick={() => void k.copyPath(f.path)}>
                      <IconCopy />
                    </button>
                  </div>
                ))}
              </div>
              <div className="acts" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={() => void k.copyPath(video.path)}>
                  <IconCopy /> Copy file path
                </button>
                <button className="btn" onClick={() => void k.reveal(video.path)}>
                  <IconFolder /> Show in Explorer
                </button>
                <button className="btn" onClick={() => setPhase({ name: "idle" })}>Export another</button>
              </div>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="Format" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.values(PRESETS).map((p) => (
                  <button key={p.id} className="preset" role="radio" aria-checked={preset === p.id} disabled={running} onClick={() => setPreset(p.id)}>
                    <span>
                      <b>{p.label}</b>
                      <small>{p.description}</small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="row">
                <label htmlFor="exp-sidecars">Poster frame, transcript and summary</label>
                <span className="switch">
                  <input id="exp-sidecars" type="checkbox" checked={sidecars} disabled={running} onChange={(e) => setSidecars(e.target.checked)} />
                  <span />
                </span>
              </div>
              <div className="row">
                <label htmlFor="exp-burn">Burn in callouts and cursor highlight</label>
                <span className="switch">
                  <input id="exp-burn" type="checkbox" checked={burn} disabled={running} onChange={(e) => setBurn(e.target.checked)} />
                  <span />
                </span>
              </div>
              {capture.transcriptStatus === "pending" && sidecars && (
                <p className="hint">The transcript is still being generated. Export now and the summary will note it, or wait a moment.</p>
              )}

              {errors.length > 0 && (
                <ul className="errors" role="alert">
                  {errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}

              {phase.name === "error" && (
                <div className="errors" role="alert" style={{ gap: 8 }}>
                  <b>{phase.error.title}</b>
                  <span style={{ whiteSpace: "pre-line" }}>{phase.error.message}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {phase.error.recoverable && <button className="btn" onClick={() => void run()}>Try again</button>}
                    {phase.error.action === "open-mic-settings" && <button className="btn" onClick={() => void openMicSettings()}>Open privacy settings</button>}
                  </div>
                </div>
              )}

              {running ? (
                <div role="status" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="row"><b>Rendering with ffmpeg…</b><span className="mono">{progress}%</span></div>
                  <div className="prog" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>
                  <span className="hint">Saving to {k.config?.dataDir}\Exports</span>
                </div>
              ) : (
                <button className="btn primary" style={{ justifyContent: "center" }} disabled={errors.length > 0} onClick={() => void run()}>
                  Export {PRESETS[preset].ext.toUpperCase()}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
