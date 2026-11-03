import { useEffect, useState } from "react";
import { api, CleanupReport, CleanupSummary, formatBytes, n, Progress } from "../api";
import ProgressBar from "../components/ProgressBar";

type Props = { onChanged: () => void; onError: (e: string) => void };

export default function Cleanup({ onChanged, onError }: Props) {
  const [s, setS] = useState<CleanupSummary | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [files, setFiles] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<CleanupReport | null>(null);

  const load = async () => {
    try {
      const sum = await api.cleanupSummary();
      setS(sum);
      // Proton is where the library lives, so it starts unticked.
      setPicked(new Set(sum.sources.filter((x) => x.kind !== "proton").map((x) => x.source_id)));
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => {
    load();
    const un = api.onCleanupProgress(setProgress);
    return () => { un.then((f) => f()); };
  }, []);

  if (!s) return <div className="empty"><p>Checking what's safe to remove…</p></div>;
  const chosen = s.sources.filter((x) => picked.has(x.source_id));
  const total = chosen.reduce((a, x) => a + x.files, 0);
  const bytes = chosen.reduce((a, x) => a + x.bytes, 0);

  const run = async () => {
    setConfirm(false);
    try {
      setReport(await api.cleanupRun([...picked]));
    } catch (e) {
      onError(String(e));
    } finally {
      setProgress(null);
      setFiles(null);
      load();
      onChanged();
    }
  };

  return (
    <>
      <div className="top"><h1>Clean-up</h1><span className="sub">Remove originals that are now safely in your library</span></div>
      <div className="cleanup">
        <div className="grow">
          <div className="stat-row">
            <div className="stat"><b>{n(s.copied)}</b><span>files copied to the library</span></div>
            <div className="stat"><b>{n(s.backed_up)}</b><span>checked on the backup</span></div>
            <div className="stat"><b className={s.failed ? "warn" : "good"}>{n(s.failed)}</b><span>not yet copied</span></div>
          </div>
          {s.sources.length === 0 ? (
            <div className="empty inline">
              <h2>Nothing to clean up yet</h2>
              <p>Originals become safe to remove once they're copied into the library{s.backed_up === 0 ? " and checked on the backup" : ""}. Run Organise first.</p>
            </div>
          ) : (
            <div className="table-card">
              <div className="trow head"><span /><span>Source</span><span>Files</span><span>Space</span><span>What happens</span></div>
              {s.sources.map((x) => {
                const on = picked.has(x.source_id);
                return (
                  <div key={x.source_id} className="trow" onClick={() => {
                    const next = new Set(picked);
                    on ? next.delete(x.source_id) : next.add(x.source_id);
                    setPicked(next);
                    setFiles(null);
                  }}>
                    <span className={`check ${on ? "on" : ""}`}>{on ? "✓" : ""}</span>
                    <b>{x.name}</b>
                    <span>{n(x.files)}</span>
                    <span>{formatBytes(x.bytes)}</span>
                    <span className="muted">{x.destination}</span>
                  </div>
                );
              })}
              {s.sources.some((x) => x.kind === "proton") && (
                <div className="trow foot-note muted">Proton Drive starts unticked: those originals live alongside your library, so only tick it if you want them gone.</div>
              )}
              <div className="trow foot-note muted">Google Photos in the cloud is never touched. Delete from there yourself once you're happy.</div>
            </div>
          )}
          {files && (
            <div className="file-list">
              {files.slice(0, 2000).map((f) => <div key={f} className="ellipsis">{f}</div>)}
              {files.length > 2000 && <div className="muted">…and {n(files.length - 2000)} more</div>}
            </div>
          )}
          {progress && <ProgressBar label="Moving originals to the bin" p={progress} />}
          {report && (
            <div className={`note ${report.errors.length ? "bad" : ""}`}>
              <span className="dot" />Binned {n(report.binned)} files, freed {formatBytes(report.freed_bytes)}.
              {report.skipped > 0 && ` Left ${n(report.skipped)} alone because they changed since copying.`}
              {report.errors.length > 0 && ` ${report.errors.length} problems: ${report.errors.slice(0, 3).join("; ")}`}
            </div>
          )}
        </div>
        {s.sources.length > 0 && (
          <div className="side-card">
            <div className="eyebrow">Ready to bin</div>
            <div className="big-num">{n(total)} files</div>
            <p className="muted">Frees {formatBytes(bytes)}. Every file has a verified copy in the library{s.backed_up ? " and on the backup" : ""}.</p>
            <div className="note"><span className="dot" />Files go to each source's bin, not deleted</div>
            {confirm ? (
              <>
                <p className="amber">Sure? This moves {n(total)} originals to the bin.</p>
                <button className="btn pri" onClick={run}>Yes, move to bin</button>
                <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
              </>
            ) : (
              <button className="btn pri" disabled={!total || !!progress} onClick={() => setConfirm(true)}>Move {n(total)} files to bin</button>
            )}
            <button className="btn" disabled={!total} onClick={async () => setFiles(await api.cleanupFiles([...picked]))}>Review file list</button>
          </div>
        )}
      </div>
    </>
  );
}
