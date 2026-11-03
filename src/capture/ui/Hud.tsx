/** The always-visible recording pill. Runs in its own small, always-on-top window. */
import { useEffect, useState } from "react";
import { formatTimecode } from "../core/time";
import { onRecState, recStatus, recStop, recTogglePause, type RecState } from "../platform/desktop";

export function Hud() {
  const [state, setState] = useState<RecState>({ status: "recording", elapsedMs: 0 });
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    recStatus().then(setState).catch(() => undefined);
    const sub = onRecState(setState);
    return () => void sub.then((f) => f());
  }, []);

  const paused = state.status === "paused";
  return (
    <div className="hud" role="group" aria-label="Recording controls" data-tauri-drag-region>
      <span className={`rec-dot ${paused ? "paused" : ""}`} aria-hidden="true" />
      <span className="time" aria-live="off">{formatTimecode(state.elapsedMs)}</span>
      <span className="label">{paused ? "Paused" : "Recording"}</span>
      <button className="pause" onClick={() => void recTogglePause()} disabled={stopping} title="Ctrl+Shift+P">
        {paused ? "Resume" : "Pause"}
      </button>
      <button
        className="stop"
        onClick={() => {
          setStopping(true);
          void recStop();
        }}
        disabled={stopping}
        title="Ctrl+Shift+2"
      >
        {stopping ? "Saving…" : "Stop"}
      </button>
    </div>
  );
}
