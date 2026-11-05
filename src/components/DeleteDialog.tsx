import { useEffect, useRef, useState } from "react";
import { api, DeleteReport, formatBytes, n, Progress } from "../api";
import ProgressBar from "./ProgressBar";

type Props = { ids: number[]; onClose: () => void; onDone: (r: DeleteReport) => void; onError: (e: string) => void };

/** Confirm, then bin the photos everywhere Safelight knows them. With "Ask before deleting" off
 * (setting confirm_delete = 0) it skips the question and only shows up for progress or errors. */
export default function DeleteDialog({ ids, onClose, onDone, onError }: Props) {
  const [ask, setAsk] = useState<boolean | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<DeleteReport | null>(null);
  const started = useRef(false);
  const busy = progress !== null && !report;

  useEffect(() => {
    const un = api.onDeleteProgress(setProgress);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { un.then((f) => f()); window.removeEventListener("keydown", onKey); };
  }, [busy]);

  const run = async () => {
    if (started.current) return;
    started.current = true;
    setProgress({ done: 0, total: ids.length });
    try {
      if (dontAsk) await api.setSetting("confirm_delete", "0");
      const r = await api.deleteItems(ids);
      setReport(r);
      onDone(r);
      if (!r.errors.length) onClose();
    } catch (e) {
      onError(String(e));
      onClose();
    }
  };

  useEffect(() => {
    api.settings().then((s) => {
      setAsk(s.confirm_delete);
      if (!s.confirm_delete) run();
    }, () => setAsk(true));
  }, []);

  // Quick delete: stay out of the way unless it's slow enough for a progress bar, or something failed.
  if (ask === null) return null;
  if (!ask && !report?.errors.length && (!progress || progress.total < 20)) return null;

  const what = ids.length === 1 ? "this photo" : `${n(ids.length)} photos`;
  return (
    <div className="modal-back" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">Delete</div>
        <h2>{ask ? `Move ${what} to the bin?` : `Moving ${what} to the bin`}</h2>
        {ask && (
          <p className="muted">
            Safelight bins the original, any exact copies in your other sources, and the copies it made in your library and backup.
            They go to the Recycle Bin (or a "Safelight bin" folder on the NAS), so you can still restore them until you empty it.
          </p>
        )}
        {busy && <ProgressBar label="Moving to the bin" p={progress!} />}
        {report && report.errors.length > 0 && (
          <div className="note bad"><span className="dot" />Binned {n(report.files)} files ({formatBytes(report.freed_bytes)}). {report.errors.length} couldn't be moved: {report.errors.slice(0, 3).join("; ")}</div>
        )}
        <div className="row end">
          {ask && !report && (
            <label className="dont-ask">
              <input type="checkbox" checked={dontAsk} disabled={busy} onChange={(e) => setDontAsk(e.target.checked)} />
              <span>Don't ask again <span className="small">(turn it back on in Sources)</span></span>
            </label>
          )}
          <button className="btn" disabled={busy} onClick={onClose}>{report ? "Close" : "Cancel"}</button>
          {ask && !report && <button className="btn danger" disabled={busy} onClick={run} autoFocus>Move to bin</button>}
        </div>
      </div>
    </div>
  );
}
