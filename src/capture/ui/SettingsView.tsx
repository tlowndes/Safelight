import { useState } from "react";
import { PRESETS, type PresetId } from "../core/presets";
import { openDataFolder } from "../platform/desktop";
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, validateAccelerator, type HotkeyAction } from "../services/settings";
import type { CaptureCtl } from "./useCapture";

/** Turns a keydown into "Ctrl+Shift+4" style text. */
function accelFromEvent(e: React.KeyboardEvent): string | null {
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean) as string[];
  const named = /^F\d{1,2}$/.test(key) || key === "PrintScreen" ? key : key === " " ? "Space" : /^[A-Z0-9]$/.test(key) ? key : null;
  if (!named) return null;
  return [...parts, named].join("+");
}

export function SettingsView({ k }: { k: CaptureCtl }) {
  const s = k.settings!;
  const [draft, setDraft] = useState(s.hotkeys);
  const errors = Object.fromEntries(
    (Object.keys(draft) as HotkeyAction[]).map((a) => {
      const own = validateAccelerator(draft[a]);
      const dupe = draft[a] && Object.entries(draft).some(([b, v]) => b !== a && v.toLowerCase() === draft[a].toLowerCase());
      return [a, own ?? (dupe ? "Already used by another action." : null)];
    }),
  ) as Record<HotkeyAction, string | null>;
  const failures = new Map(k.hotkeyFailures.map((f) => [f.action, f.reason]));
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.hotkeys);
  const valid = Object.values(errors).every((e) => !e);

  return (
    <div className="settings">
      <h2>Capture settings</h2>

      <section>
        <h3>Keyboard shortcuts</h3>
        <p className="hint">These work from any app. Click a box and press the new shortcut; clear it to turn that shortcut off.</p>
        {(Object.keys(HOTKEY_LABELS) as HotkeyAction[]).map((a) => (
          <div key={a} className="row" style={{ alignItems: "flex-start" }}>
            <label htmlFor={`hk-${a}`} style={{ paddingTop: 6 }}>{HOTKEY_LABELS[a]}</label>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <input
                id={`hk-${a}`}
                className="field mono"
                value={draft[a]}
                placeholder="Off"
                onKeyDown={(e) => {
                  if (e.key === "Tab") return;
                  e.preventDefault();
                  if (e.key === "Backspace" || e.key === "Delete") return setDraft({ ...draft, [a]: "" });
                  const accel = accelFromEvent(e);
                  if (accel) setDraft({ ...draft, [a]: accel });
                }}
                onChange={() => undefined}
                aria-invalid={!!errors[a]}
              />
              {(errors[a] || failures.get(a)) && <span className="fielderr">{errors[a] ?? failures.get(a)}</span>}
            </div>
          </div>
        ))}
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn primary" disabled={!dirty || !valid} onClick={() => void k.updateSettings({ hotkeys: draft })}>Save shortcuts</button>
          <button className="btn" onClick={() => setDraft(DEFAULT_HOTKEYS)}>Restore defaults</button>
        </div>
      </section>

      <section>
        <h3>Capture</h3>
        <div className="row">
          <label htmlFor="set-copy">Copy screenshots to the clipboard as well as saving them</label>
          <span className="switch">
            <input id="set-copy" type="checkbox" checked={s.copyScreenshots} onChange={(e) => void k.updateSettings({ copyScreenshots: e.target.checked })} />
            <span />
          </span>
        </div>
        <div className="row">
          <label htmlFor="set-min">Minimise Safelight while recording</label>
          <span className="switch">
            <input id="set-min" type="checkbox" checked={s.minimiseOnRecord} onChange={(e) => void k.updateSettings({ minimiseOnRecord: e.target.checked })} />
            <span />
          </span>
        </div>
        <div className="row">
          <label htmlFor="set-tray">Keep Safelight in the tray when you close it, so these shortcuts keep working</label>
          <span className="switch">
            <input id="set-tray" type="checkbox" checked={s.closeToTray} onChange={(e) => void k.updateSettings({ closeToTray: e.target.checked })} />
            <span />
          </span>
        </div>
        <div className="row">
          <label htmlFor="set-fps">Recording frame rate</label>
          <select id="set-fps" className="field" value={s.fps} onChange={(e) => void k.updateSettings({ fps: Number(e.target.value) as 15 | 30 | 60 })}>
            <option value={15}>15 fps (smallest files)</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps (smooth, heavier)</option>
          </select>
        </div>
        <div className="row">
          <label htmlFor="set-preset">Default export format</label>
          <select id="set-preset" className="field" value={s.defaultPreset} onChange={(e) => void k.updateSettings({ defaultPreset: e.target.value as PresetId })}>
            {Object.values(PRESETS).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      </section>

      <section>
        <h3>Storage</h3>
        <p className="hint">Everything stays on this PC. Screenshots, recordings and exports are saved to this folder, which is also a library source, so every capture shows up in All photos:</p>
        <code>{k.config?.dataDir}</code>
        <p className="hint">
          To move it, set <code>SAFELIGHT_CAPTURE_DIR</code> in a <code>.env</code> file next to Safelight and restart. Trims, callouts and export history are kept in Safelight's app data folder, beside the catalogue.
        </p>
        <div><button className="btn" onClick={() => void openDataFolder()}>Open folder</button></div>
      </section>

      <section>
        <h3>Tools</h3>
        <div className="row">ffmpeg {k.ffmpegOk ? <span className="pill ok">Found</span> : <span className="pill rec">Missing</span>}</div>
        {!k.ffmpegOk && <p className="hint">Install with <code>winget install Gyan.FFmpeg</code>, then restart Safelight.</p>}
        <div className="row">
          Local transcripts (whisper.cpp) {k.transcriptReady.ready ? <span className="pill ok">Ready</span> : <span className="pill grey">Not set up</span>}
        </div>
        {!k.transcriptReady.ready && <p className="hint">{k.transcriptReady.reason}</p>}
        <p className="hint">Safelight {k.config?.version} · no accounts, no telemetry, no uploads.</p>
      </section>
    </div>
  );
}
