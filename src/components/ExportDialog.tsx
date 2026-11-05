import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ExportFormat, ExportNaming, ExportOptions, ExportReport, n, Progress } from "../api";
import ProgressBar from "./ProgressBar";

type Props = {
  ids: number[];
  onClose: () => void;
  onError: (e: string) => void;
  /** Runs first, e.g. so the editor can save edits still waiting to be saved. */
  beforeExport?: () => Promise<void>;
};

const KEY = "safelight.export-options";
const SIZES: [string, number | null][] = [["Full size", null], ["3840 px", 3840], ["2048 px · web", 2048], ["1080 px · social", 1080]];
const FORMATS: [ExportFormat, string][] = [["jpeg", "JPEG"], ["png", "PNG"], ["tiff", "TIFF"]];
const NAMES: [ExportNaming, string, string][] = [
  ["original", "Original name", "IMG_1234.jpg"],
  ["suffix", "Name + edited", "IMG_1234 edited.jpg"],
  ["date_number", "Date + number", "2025-07-12 001.jpg"],
];

function saved(): ExportOptions {
  const base: ExportOptions = { folder: "", format: "jpeg", quality: 90, max_edge: null, naming: "suffix" };
  try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return base; }
}

/** Choose how to export one or many photos, then export them with their edits. */
export default function ExportDialog({ ids, onClose, onError, beforeExport }: Props) {
  const [o, setO] = useState<ExportOptions>(saved);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const busy = progress !== null && !report;
  const set = (p: Partial<ExportOptions>) => setO((v) => ({ ...v, ...p }));

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private window */ }
  }, [o]);
  useEffect(() => {
    const un = api.onExportProgress(setProgress);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { un.then((f) => f()); window.removeEventListener("keydown", onKey, true); };
  }, [busy]);

  const pickFolder = async () => {
    const dir = await open({ directory: true, title: "Export to which folder?", defaultPath: o.folder || undefined });
    if (typeof dir === "string") set({ folder: dir });
  };
  const run = async () => {
    setProgress({ done: 0, total: ids.length });
    try {
      await beforeExport?.();
      setReport(await api.exportItems(ids, o));
    } catch (e) {
      onError(String(e));
      setProgress(null);
    }
  };

  const what = ids.length === 1 ? "1 photo" : `${n(ids.length)} photos`;
  const ext = o.format === "jpeg" ? "jpg" : o.format === "png" ? "png" : "tif";
  return (
    <div className="modal-back" onClick={() => !busy && onClose()}>
      <div className="modal export" role="dialog" aria-label="Export" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">Export</div>
        <h2>Export {what}</h2>
        {!report && (
          <>
            <div className="ex-field">
              <div className="label">Folder</div>
              <button className="folder-pick" onClick={pickFolder} disabled={busy}>{o.folder || "Choose a folder…"}</button>
            </div>
            <div className="ex-field">
              <div className="label">Format</div>
              <div className="row start wrap">
                {FORMATS.map(([f, label]) => <button key={f} className={`chip small ${o.format === f ? "on" : ""}`} aria-pressed={o.format === f} onClick={() => set({ format: f })}>{label}</button>)}
              </div>
            </div>
            {o.format === "jpeg" && (
              <label className="slider ex-field">
                <div className="row"><span className="label">Quality</span><span className="val">{o.quality}</span></div>
                <input type="range" min={50} max={100} value={o.quality} onChange={(e) => set({ quality: Number(e.target.value) })} />
              </label>
            )}
            <div className="ex-field">
              <div className="label">Size (longest side)</div>
              <div className="row start wrap">
                {SIZES.map(([label, m]) => <button key={label} className={`chip small ${o.max_edge === m ? "on" : ""}`} aria-pressed={o.max_edge === m} onClick={() => set({ max_edge: m })}>{label}</button>)}
              </div>
            </div>
            <div className="ex-field">
              <div className="label">File names</div>
              <div className="row start wrap">
                {NAMES.map(([k, label]) => <button key={k} className={`chip small ${o.naming === k ? "on" : ""}`} aria-pressed={o.naming === k} onClick={() => set({ naming: k })}>{label}</button>)}
              </div>
              <span className="muted small">For example {NAMES.find((x) => x[0] === o.naming)![2].replace(/jpg$/, ext)}. Existing files are never overwritten.</span>
            </div>
          </>
        )}
        {busy && <ProgressBar label="Exporting" p={progress!} />}
        {report && (
          <div className={`note ${report.errors.length ? "bad" : ""}`}>
            <span className="dot" />
            Exported {n(report.exported)} of {what} to {o.folder}.
            {report.errors.length > 0 && ` ${n(report.errors.length)} couldn't be exported: ${report.errors.slice(0, 3).join("; ")}`}
          </div>
        )}
        <div className="row end">
          {report ? (
            <>
              {report.files[0] && <button className="btn" onClick={() => api.revealInExplorer(report.files[0]).catch((e) => onError(String(e)))}>Show in Explorer</button>}
              <button className="btn pri" onClick={onClose} autoFocus>Done</button>
            </>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="btn pri" disabled={busy || !o.folder} onClick={run}>Export {what}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
