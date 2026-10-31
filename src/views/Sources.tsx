import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ScanProgress, Source } from "../api";

const KINDS = [
  { kind: "proton", name: "Proton Drive", hint: "Your Proton Drive sync folder on this PC" },
  { kind: "gdrive", name: "Google Drive", hint: "The Google Drive for desktop folder, e.g. G:\\My Drive" },
  { kind: "takeout", name: "Google Photos", hint: "A folder with your unzipped Google Takeout export" },
  { kind: "nas", name: "NAS", hint: "A mapped drive or network share, e.g. \\\\NAS\\photos" },
];

type Props = { sources: Source[]; progress: ScanProgress | null; onScan: (id: number) => Promise<void>; onChanged: () => void; onDone: () => void };

export default function Sources({ sources, progress, onScan, onChanged, onDone }: Props) {
  const [busy, setBusy] = useState(false);

  const pick = async (kind: string, name: string) => {
    const dir = await open({ directory: true, title: `Choose your ${name} folder` });
    if (typeof dir !== "string") return;
    const id = await api.addSource(name, kind, dir);
    onChanged();
    setBusy(true);
    await onScan(id);
    setBusy(false);
  };

  const rescanAll = async () => {
    setBusy(true);
    for (const s of sources) await onScan(s.id);
    setBusy(false);
  };

  const scanning = progress ? sources.find((s) => s.id === progress.source_id) : undefined;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="onboard">
      <div className="eyebrow">Sources</div>
      <h1>Where are your photos?</h1>
      <p className="lead">Safelight only reads from these. Nothing is moved or deleted until you've seen the new library and said yes.</p>
      <div className="cards">
        {KINDS.map((k) => {
          const added = sources.filter((s) => s.kind === k.kind);
          return (
            <div key={k.kind} className={`card ${added.length ? "" : "todo"}`}>
              <div className="card-head"><div className="mark">{k.name[0]}</div><div><b>{k.name}</b><div className="muted small">{k.hint}</div></div></div>
              <div className="card-body">
                {added.length === 0 && <span className="muted">Not added yet</span>}
                {added.map((s) => (
                  <div key={s.id} className="ok">
                    ✓ {s.root}<br />{s.item_count.toLocaleString("en-GB")} photos and videos
                    <button className="link" onClick={async () => { await api.removeSource(s.id); onChanged(); }}>Remove</button>
                  </div>
                ))}
              </div>
              <button className={`btn ${added.length ? "" : "pri"}`} disabled={busy} onClick={() => pick(k.kind, k.name)}>
                {added.length ? "Add another folder" : "Choose folder"}
              </button>
            </div>
          );
        })}
      </div>
      {progress && (
        <div className="progress">
          <div className="row"><b>Scanning {scanning?.name ?? "source"}</b><span className="muted">{progress.done.toLocaleString("en-GB")} of {progress.total.toLocaleString("en-GB")}</span></div>
          <div className="bar"><b style={{ width: `${pct}%` }} /></div>
          <div className="muted small ellipsis">{progress.current}</div>
        </div>
      )}
      <div className="foot">
        <span className="muted">Re-scans only read new or changed files, so they're quick.</span>
        <div className="row">
          <button className="btn" disabled={busy || sources.length === 0} onClick={rescanAll}>Re-scan all</button>
          <button className="btn pri" disabled={sources.length === 0} onClick={onDone}>See the library →</button>
        </div>
      </div>
    </div>
  );
}
