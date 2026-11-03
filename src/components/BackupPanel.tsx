import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, BackupStatus, formatBytes, n, Progress, relDay } from "../api";
import ProgressBar from "./ProgressBar";

/** NAS backup: folder, weekly switch, status and Back up now. Copy only, nothing is ever deleted. */
export default function BackupPanel({ onError }: { onError: (e: string) => void }) {
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [typed, setTyped] = useState("");
  const [lastError, setLastError] = useState("");

  const load = () => api.backupStatus().then(setSt).catch((e) => onError(String(e)));
  useEffect(() => {
    load();
    const un1 = api.onBackupProgress(setProgress);
    // Also catches the weekly backup finishing while this screen is open.
    const un2 = api.onBackupFinished((r) => {
      setProgress(null);
      setLastError(r.Err ?? "");
      load();
    });
    return () => { un1.then((f) => f()); un2.then((f) => f()); };
  }, []);

  const setRoot = async (dir: string) => {
    if (!dir.trim()) return;
    await api.setSetting("backup_root", dir.trim());
    setTyped("");
    load();
  };
  const pick = async () => {
    const dir = await open({ directory: true, title: "Choose the backup folder on the NAS" });
    if (typeof dir === "string") setRoot(dir);
  };
  const backUpNow = async () => {
    setLastError("");
    try {
      await api.runBackup();
    } catch (e) {
      setLastError(String(e));
    } finally {
      setProgress(null);
      load();
    }
  };

  if (!st) return null;
  const running = progress && progress.stage !== "done";
  const r = st.last_report;

  return (
    <div className="backup">
      <button className="folder-pick" onClick={pick}>{st.backup_root ?? "Choose a folder on the NAS…"}</button>
      <input
        className="path-input"
        placeholder="or type a network path, e.g. \\NAS\Photos"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && setRoot(typed)}
        onBlur={() => typed && setRoot(typed)}
      />
      {st.backup_root && (
        <>
          <label className="switch-row compact">
            <input type="checkbox" checked={st.weekly} onChange={async (e) => {
              await api.setSetting("auto_backup", e.target.checked ? "1" : "0");
              load();
            }} />
            <span className="switch" />
            <span><b>Back up every week</b></span>
          </label>
          <div className="backup-status small">
            <div className="conn"><span className={`dot ${st.reachable ? "ok" : "off"}`} /> {st.reachable ? "NAS connected" : "Can't reach the NAS right now"}</div>
            <div className="muted">
              {st.last_run ? `Last backup ${relDay(st.last_run)}` : "Not backed up yet"}
              {st.weekly && st.next_due && !st.due && ` · next ${relDay(st.next_due)}`}
              {st.weekly && st.due && (st.reachable ? " · due now" : " · will run when the NAS is back")}
            </div>
            <div className="muted">
              {st.waiting > 0 ? `${n(st.waiting)} files waiting · ${formatBytes(st.waiting_bytes)}` : "Everything is backed up"}
            </div>
            {r && r.errors.length > 0 && <div className="warn">{n(r.errors.length)} files couldn't be copied last time: {r.errors.slice(0, 2).join("; ")}</div>}
            {lastError && <div className="warn">{lastError}</div>}
          </div>
          {running ? (
            <ProgressBar label="Backing up and checking every file" p={progress!} />
          ) : (
            <button className="btn small" disabled={!st.reachable || st.waiting === 0} onClick={backUpNow}>Back up now</button>
          )}
          <div className="dim small">Copies only. Nothing on the NAS is ever deleted or overwritten.</div>
        </>
      )}
    </div>
  );
}
