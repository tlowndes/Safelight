import { useEffect, useState } from "react";
import { api, formatBytes, Progress, UpdateInfo } from "../api";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Version line in the sidebar, plus an "update available" card when GitHub has a newer build. */
export default function Updater() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);

  const check = async (manual: boolean) => {
    if (manual) setStatus("Checking…");
    try {
      const u = await api.checkUpdate();
      setUpdate(u);
      setStatus(manual && !u ? "You're up to date" : "");
    } catch (e) {
      setStatus(manual ? String(e) : "");
    }
  };

  useEffect(() => {
    api.appVersion().then(setVersion).catch(() => {});
    check(false);
    const t = setInterval(() => check(false), SIX_HOURS);
    const un = api.onUpdateProgress(setProgress);
    return () => { clearInterval(t); un.then((f) => f()); };
  }, []);

  const install = async () => {
    if (!update) return;
    setProgress({ done: 0, total: update.size });
    try {
      await api.installUpdate(update.url);
    } catch (e) {
      setProgress(null);
      setStatus(String(e));
    }
  };

  return (
    <div className="updater">
      {update && (
        <div className="update-card">
          <b>Update available</b>
          <span className="muted small">Version {update.version} · you have {update.current}</span>
          {progress ? (
            <>
              <div className="bar"><b style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 5}%` }} /></div>
              <span className="muted small">{progress.done >= progress.total && progress.total ? "Installing, Safelight will restart…" : `Downloading ${formatBytes(progress.done)} of ${formatBytes(progress.total)}`}</span>
            </>
          ) : (
            <button className="btn pri small" onClick={install}>Install and restart</button>
          )}
        </div>
      )}
      <div className="version">
        <span>Safelight {version}</span>
        <button className="link" onClick={() => check(true)}>Check for updates</button>
      </div>
      {status && <div className="muted small">{status}</div>}
    </div>
  );
}
