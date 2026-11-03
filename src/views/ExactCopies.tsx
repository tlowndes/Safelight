import { useEffect, useState } from "react";
import { api, dateTimeLabel, ExactGroup, fileName, formatBytes, KIND_NAMES, MoveBatch, n, Progress, SpareSummary } from "../api";
import Thumb from "../components/Thumb";
import ProgressBar from "../components/ProgressBar";
import { isTyping } from "../shortcuts";

type Props = { tabs: JSX.Element; onChanged: () => void; onError: (e: string) => void };

/** Byte-identical copies across sources. The Proton Drive copy is suggested first, Google last. */
export default function ExactCopies({ tabs, onChanged, onError }: Props) {
  const [groups, setGroups] = useState<ExactGroup[] | null>(null);
  const [spares, setSpares] = useState<SpareSummary | null>(null);
  const [log, setLog] = useState<MoveBatch[]>([]);
  const [current, setCurrent] = useState(0);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const [g, s, l] = await Promise.all([api.exactGroups(), api.spareSummary(), api.moveBatches()]);
      setGroups(g);
      setSpares(s);
      setLog(l);
      setCurrent((c) => Math.min(c, Math.max(0, g.length - 1)));
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => {
    load();
    const un = api.onMoveProgress(setProgress);
    return () => { un.then((f) => f()); };
  }, []);

  const group = groups?.[current];
  useEffect(() => {
    if (group) setKeep(new Set(group.copies.filter((c) => c.keep).map((c) => c.item.id)));
  }, [group?.sha256, group?.decided]);

  const after = async () => { await load(); onChanged(); };
  const decide = async () => {
    if (!group || !keep.size) return;
    try {
      await api.exactResolve(group.sha256, [...keep]);
      // Stay on the same row index: the decided set sinks to the bottom, the next one moves up.
      await after();
    } catch (e) { onError(String(e)); }
  };
  const keepAll = async () => {
    try {
      const count = await api.exactKeepPreferredAll();
      setNotice(`Kept the preferred copy in ${n(count)} set${count === 1 ? "" : "s"}. The others are hidden from your library, still on disk.`);
      await after();
    } catch (e) { onError(String(e)); }
  };
  const reset = async () => {
    if (!group) return;
    try { await api.exactReset(group.sha256); await after(); } catch (e) { onError(String(e)); }
  };
  const moveSpares = async () => {
    setProgress({ done: 0, total: spares?.files ?? 0 });
    try {
      const r = await api.moveSpares();
      const extra = [r.skipped && `${n(r.skipped)} left where they are because a file changed or has edits`, r.errors.length && `${r.errors.length} couldn't be moved`].filter(Boolean).join(", ");
      setNotice(`Moved ${n(r.moved)} spare copies (${formatBytes(r.bytes)}) to Safelight bin.${extra ? ` ${extra}.` : ""}`);
      await after();
    } catch (e) { onError(String(e)); }
    setProgress(null);
    setConfirming(false);
  };
  const undo = async (batch: number) => {
    try {
      const r = await api.undoMoves(batch);
      setNotice(`Put ${n(r.restored)} file${r.restored === 1 ? "" : "s"} back.${r.errors.length ? ` ${r.errors.length} couldn't go back because a file is already there.` : ""}`);
      await after();
      api.processThumbnails().then(onChanged).catch(() => {});
    } catch (e) { onError(String(e)); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || confirming || !groups) return;
      if (e.key === "Enter" && keep.size) decide();
      else if (e.key === "ArrowDown") { e.preventDefault(); setCurrent((c) => Math.min(groups.length - 1, c + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setCurrent((c) => Math.max(0, c - 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!groups) return <div className="empty"><p>Looking for exact copies…</p></div>;
  const open = groups.filter((g) => !g.decided).length;
  const sourcesOf = (g: ExactGroup) => [...new Set(g.copies.map((c) => KIND_NAMES[c.source_kind] ?? c.source_name))].join(", ");

  return (
    <>
      <div className="top">
        <h1>Duplicates</h1>
        {tabs}
        <span className="sub">{n(open)} to review · Proton Drive copies are kept first, Google last</span>
        <div className="row" style={{ marginLeft: "auto" }}>
          {open > 0 && <button className="btn" onClick={keepAll}>Keep preferred in all {n(open)}</button>}
          {group && <button className="btn pri" disabled={!keep.size} onClick={decide}>Keep selected ⏎</button>}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <div className="eyebrow">All clear</div>
          <h2>No exact copies</h2>
          <p>Every photo and video is in one place only.</p>
        </div>
      ) : (
        <div className="split">
          <div className="list">
            {groups.slice(0, 500).map((g, i) => (
              <button key={g.sha256} className={`list-row ${i === current ? "on" : ""}`} onClick={() => setCurrent(i)}>
                <Thumb item={g.copies[0].item} className="mini" />
                <div>
                  <div className="strong ellipsis">{fileName(g.copies[0].item.path)}</div>
                  <div className="muted small ellipsis">{g.copies.length} copies · {g.decided ? "Decided" : sourcesOf(g)}</div>
                </div>
              </button>
            ))}
          </div>
          {group && (
            <div className="detail">
              <div className="row start">
                <b className="h3">{fileName(group.copies[0].item.path)}</b>
                <span className="muted">{group.copies.length} byte-identical copies · {formatBytes(group.copies[0].item.size)} each</span>
                {group.decided && <button className="btn small" onClick={reset}>Review again</button>}
              </div>
              <p className="muted">
                These files are exactly the same. Safelight suggests keeping the Proton Drive copy, then NAS, then other folders, then Google.
                Copies you don't keep leave your library straight away but stay on disk until you move them below. Click a copy to choose.
              </p>
              <div className="compare">
                {group.copies.map((c, k) => {
                  const on = keep.has(c.item.id);
                  const toggle = () => {
                    const next = new Set(keep);
                    on ? next.delete(c.item.id) : next.add(c.item.id);
                    setKeep(next);
                  };
                  return (
                    <div key={c.item.id} className={`copy ${on ? "on" : ""}`} onClick={toggle} role="checkbox" aria-checked={on} tabIndex={0}
                      onKeyDown={(e) => e.key === " " && (e.preventDefault(), toggle())}>
                      <Thumb item={c.item} className="big">{on && <span className="dup">★ Keep</span>}</Thumb>
                      <div className="copy-body">
                        <div className="row"><b>{c.source_name}</b>{k === 0 && <span className="amber small">Preferred</span>}</div>
                        <table>
                          <tbody>
                            <tr><td>Source</td><td>{KIND_NAMES[c.source_kind] ?? c.source_kind}</td></tr>
                            <tr><td>Date taken</td><td>{dateTimeLabel(c.item.taken_at)}</td></tr>
                            <tr><td>Date from</td><td>{c.item.date_source ?? "—"}</td></tr>
                            <tr><td>Status</td><td>{c.item.copy_status === "keep" ? "Kept" : c.item.copy_status === "spare" ? "Spare, hidden" : "Not decided"}</td></tr>
                          </tbody>
                        </table>
                        <div className="muted small ellipsis" title={c.item.path}>{c.item.path}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="note"><span className="dot" />Choosing here only changes the catalogue. No file moves until you say so.</div>
            </div>
          )}
        </div>
      )}

      {(spares?.files || log.some((b) => b.undone < b.files) || notice) && (
        <div className="spares">
          {notice && <div className="note"><span className="dot" />{notice}<button className="link" onClick={() => setNotice(null)}>Dismiss</button></div>}
          {spares && spares.files > 0 && (
            <div className="row">
              <span>
                <b>{n(spares.files)} spare {spares.files === 1 ? "copy" : "copies"}</b>
                <span className="muted"> · {formatBytes(spares.bytes)} · {spares.sources.map((s) => `${n(s.files)} in ${s.name}`).join(", ")}</span>
              </span>
              <button className="btn" onClick={() => setConfirming(true)}>Move to Safelight bin…</button>
            </div>
          )}
          {log.filter((b) => b.undone < b.files).slice(0, 3).map((b) => (
            <div key={b.batch} className="row">
              <span className="muted small">Moved {n(b.files - b.undone)} spare copies ({formatBytes(b.bytes)}) on {dateTimeLabel(b.at)}</span>
              <button className="btn small" onClick={() => undo(b.batch)}>Undo</button>
            </div>
          ))}
        </div>
      )}

      {confirming && spares && (
        <div className="modal-back" onClick={() => !progress && setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="eyebrow">Spare copies</div>
            <h2>Move {n(spares.files)} spare {spares.files === 1 ? "copy" : "copies"} to Safelight bin?</h2>
            <p className="muted">
              Each one goes into a "Safelight bin" folder at the top of its own source, for example Google Drive › Safelight bin › {new Date().toISOString().slice(0, 10)}.
              Nothing is deleted, and you can undo this. Safelight first checks the kept copy is still there and unchanged.
              Empty the bin folder yourself when you're happy, to free up {formatBytes(spares.bytes)}.
            </p>
            {progress && <ProgressBar label="Moving spare copies" p={progress} />}
            <div className="row end">
              <button className="btn" disabled={!!progress} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="btn pri" disabled={!!progress} onClick={moveSpares} autoFocus>Move to Safelight bin</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
