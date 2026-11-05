import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, formatBytes, ImportOptions, ImportPreview, ImportReport, n, Progress } from "../api";
import ProgressBar from "../components/ProgressBar";

type Props = { onImported: (sourceId: number) => void; onError: (e: string) => void };

const KEY = "safelight.import-options";

/** Copy photos off a camera card or phone into a folder on this PC, then add them to the library. */
export default function Import({ onImported, onError }: Props) {
  const [o, setO] = useState<ImportOptions>(() => {
    const base: ImportOptions = { from: "", to: "", folders: "by_date", rename: "original" };
    try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) ?? "{}"), from: "" }; } catch { return base; }
  });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [looking, setLooking] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const busy = progress !== null && !report;
  const set = (p: Partial<ImportOptions>) => setO((v) => ({ ...v, ...p }));

  useEffect(() => { if (!o.to) api.importDefaultFolder().then((to) => set({ to })).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ ...o, from: "" })); } catch { /* private window */ } }, [o]);
  useEffect(() => { const un = api.onImportProgress(setProgress); return () => { un.then((f) => f()); }; }, []);
  useEffect(() => {
    if (!o.from) return setPreview(null);
    let live = true;
    setLooking(true);
    setReport(null);
    api.importPreview(o.from).then((p) => live && setPreview(p)).catch((e) => live && onError(String(e))).finally(() => live && setLooking(false));
    return () => { live = false; };
  }, [o.from]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (which: "from" | "to") => {
    const dir = await open({ directory: true, title: which === "from" ? "Import from which card or folder?" : "Copy photos into which folder?", defaultPath: o[which] || undefined });
    if (typeof dir === "string") set({ [which]: dir });
  };
  const run = async () => {
    setProgress({ done: 0, total: preview?.new ?? 0 });
    try {
      const r = await api.importRun(o);
      setReport(r);
      if (r.source_id !== null && r.copied > 0) onImported(r.source_id);
    } catch (e) { onError(String(e)); setProgress(null); }
  };
  const example = `${o.folders === "by_date" ? "2026/2026-07-12/" : ""}${o.rename === "date_time" ? "2026-07-12 14.03.22.jpg" : "IMG_1234.jpg"}`;

  return (
    <>
      <div className="top"><h1>Import</h1><span className="sub">Copy photos off a camera card, phone or folder. The originals on the card are left alone.</span></div>
      <div className="import">
        <div className="card">
          <div className="ex-field">
            <div className="label">From</div>
            <button className="folder-pick" onClick={() => pick("from")} disabled={busy}>{o.from || "Choose a camera card, phone or folder…"}</button>
            {looking && <span className="muted small">Looking for photos…</span>}
            {preview && !looking && (
              <span className="small">
                {n(preview.found)} photos and videos found · <b>{n(preview.new)} new</b> ({formatBytes(preview.bytes)})
                {preview.already > 0 && <span className="muted"> · {n(preview.already)} already in your library, skipped</span>}
              </span>
            )}
          </div>
          <div className="ex-field">
            <div className="label">To</div>
            <button className="folder-pick" onClick={() => pick("to")} disabled={busy}>{o.to || "Choose a folder…"}</button>
          </div>
          <div className="ex-field">
            <div className="label">Folders</div>
            <div className="row start wrap">
              <button className={`chip small ${o.folders === "by_date" ? "on" : ""}`} aria-pressed={o.folders === "by_date"} onClick={() => set({ folders: "by_date" })}>By date</button>
              <button className={`chip small ${o.folders === "none" ? "on" : ""}`} aria-pressed={o.folders === "none"} onClick={() => set({ folders: "none" })}>All in one folder</button>
            </div>
          </div>
          <div className="ex-field">
            <div className="label">File names</div>
            <div className="row start wrap">
              <button className={`chip small ${o.rename === "original" ? "on" : ""}`} aria-pressed={o.rename === "original"} onClick={() => set({ rename: "original" })}>Keep the camera's names</button>
              <button className={`chip small ${o.rename === "date_time" ? "on" : ""}`} aria-pressed={o.rename === "date_time"} onClick={() => set({ rename: "date_time" })}>Date and time</button>
            </div>
            <span className="muted small">For example {example}. Every copy is checked byte for byte before it counts.</span>
          </div>
          {busy && <ProgressBar label="Copying" p={progress!} />}
          {report && (
            <div className={`note ${report.errors.length ? "bad" : ""}`}>
              <span className="dot" />
              Copied {n(report.copied)} ({formatBytes(report.bytes)}){report.skipped ? `, skipped ${n(report.skipped)} already in the library` : ""}. {report.copied > 0 ? "They're being added to All photos now." : ""}
              {report.errors.length > 0 && ` ${n(report.errors.length)} couldn't be copied: ${report.errors.slice(0, 3).join("; ")}`}
            </div>
          )}
          <div className="row end">
            <button className="btn pri" disabled={busy || !o.from || !o.to || !preview?.new} onClick={run}>
              {preview?.new ? `Import ${n(preview.new)}` : "Import"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
