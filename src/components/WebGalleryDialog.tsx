import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ExportReport, n, Progress } from "../api";
import ProgressBar from "./ProgressBar";

type Props = { ids: number[]; onClose: () => void; onError: (e: string) => void };

/** Make a self-contained web gallery (index.html plus pictures) that works offline or on any web host. */
export default function WebGalleryDialog({ ids, onClose, onError }: Props) {
  const [folder, setFolder] = useState("");
  const [title, setTitle] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const busy = progress !== null && !report;

  useEffect(() => {
    const un = api.onExportProgress(setProgress);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { un.then((f) => f()); window.removeEventListener("keydown", onKey, true); };
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    const dir = await open({ directory: true, title: "Make the gallery in which folder?" });
    if (typeof dir === "string") setFolder(dir);
  };
  const run = async () => {
    setProgress({ done: 0, total: ids.length });
    try { setReport(await api.webGallery(ids, folder, title.trim() || "Photos")); }
    catch (e) { onError(String(e)); setProgress(null); }
  };

  return (
    <div className="modal-back" onClick={() => !busy && onClose()}>
      <div className="modal export" role="dialog" aria-label="Web gallery" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">Web gallery</div>
        <h2>Make a web gallery of {n(ids.length)} photo{ids.length === 1 ? "" : "s"}</h2>
        {!report && (
          <>
            <div className="ex-field">
              <div className="label">Folder</div>
              <button className="folder-pick" onClick={pick} disabled={busy}>{folder || "Choose an empty folder…"}</button>
            </div>
            <label className="ex-field">
              <div className="label">Title</div>
              <input className="text-input" value={title} placeholder="Photos" onChange={(e) => setTitle(e.target.value)} disabled={busy} />
            </label>
            <p className="muted small">A single page with a grid and a full-screen viewer. Open index.html in any browser, or upload the folder to any web host. Nothing is uploaded by Safelight.</p>
          </>
        )}
        {busy && <ProgressBar label="Making the gallery" p={progress!} />}
        {report && (
          <div className={`note ${report.errors.length ? "bad" : ""}`}>
            <span className="dot" />
            Added {n(report.exported)} photos to the gallery in {folder}.
            {report.errors.length > 0 && ` ${n(report.errors.length)} couldn't be added: ${report.errors.slice(0, 3).join("; ")}`}
          </div>
        )}
        <div className="row end">
          {report ? (
            <>
              <button className="btn" onClick={() => api.revealInExplorer(`${folder}\\index.html`).catch((e) => onError(String(e)))}>Show in Explorer</button>
              <button className="btn pri" onClick={onClose} autoFocus>Done</button>
            </>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="btn pri" disabled={busy || !folder} onClick={run}>Make gallery</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
