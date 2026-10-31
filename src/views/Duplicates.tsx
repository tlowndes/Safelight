import { useEffect, useState } from "react";
import { api, dateTimeLabel, DupGroup, fileName, formatBytes, n, Stats } from "../api";
import Thumb from "../components/Thumb";

type Props = { stats: Stats | null; onChanged: () => void; onError: (e: string) => void; onNext: () => void };

export default function Duplicates({ stats, onChanged, onError, onNext }: Props) {
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [keep, setKeep] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const g = await api.dupGroups();
      setGroups(g);
      setCurrent((c) => Math.min(c, Math.max(0, g.length - 1)));
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => { load(); }, []);

  const group = groups?.[current];
  useEffect(() => {
    if (group) setKeep(new Set([group.members[group.best].item.id]));
  }, [group?.key]);

  const decide = async (keepIds: number[]) => {
    if (!group) return;
    const drop = group.members.map((m) => m.item.id).filter((id) => !keepIds.includes(id));
    try {
      await api.dupResolve(keepIds, drop);
      await load();
      onChanged();
    } catch (e) {
      onError(String(e));
    }
  };

  const keepBestAll = async () => {
    if (!groups) return;
    for (const g of groups) {
      const best = g.members[g.best].item.id;
      await api.dupResolve([best], g.members.map((m) => m.item.id).filter((id) => id !== best));
    }
    await load();
    onChanged();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "Enter" && keep.size) decide([...keep]);
      if (e.key === "n") group && decide(group.members.map((m) => m.item.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!groups) return <div className="empty"><p>Looking for look-alikes…</p></div>;

  return (
    <>
      <div className="top">
        <h1>Duplicates</h1>
        <span className="sub">
          {n(groups.length)} look-alike groups to check · {n(stats?.exact_duplicate_files ?? 0)} exact copies merged automatically
        </span>
        <div className="row" style={{ marginLeft: "auto" }}>
          {groups.length > 1 && <button className="btn" onClick={keepBestAll}>Keep best in all {n(groups.length)}</button>}
          {group && <button className="btn" onClick={() => decide(group.members.map((m) => m.item.id))}>Not duplicates (N)</button>}
          {group && <button className="btn pri" disabled={!keep.size} onClick={() => decide([...keep])}>Keep selected, drop others ⏎</button>}
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="empty">
          <div className="eyebrow">All clear</div>
          <h2>No look-alikes left to check</h2>
          <p>Exact copies are merged automatically, so only one of each goes into your new library. {stats && stats.needing_thumbnails > 0 && `Still making previews for ${n(stats.needing_thumbnails)} files, so more may appear.`}</p>
          <button className="btn pri" onClick={onNext}>Next: organise →</button>
        </div>
      ) : (
        <div className="split">
          <div className="list">
            {groups.slice(0, 300).map((g, i) => (
              <button key={g.key} className={`list-row ${i === current ? "on" : ""}`} onClick={() => setCurrent(i)}>
                <Thumb item={g.members[0].item} className="mini" />
                <div>
                  <div className="strong ellipsis">{fileName(g.members[0].item.path)}</div>
                  <div className="muted small">{g.members.length} copies · {g.similarity}% match</div>
                </div>
              </button>
            ))}
          </div>
          {group && (
            <div className="detail">
              <div className="row start"><b className="h3">{fileName(group.members[0].item.path)}</b><span className="muted">{group.members.length} copies look the same · {group.similarity}% visual match</span></div>
              <p className="muted">Safelight suggests keeping the highest-quality copy and moves the best date onto it. Dropped copies are only binned later, after you approve clean-up. Click a copy to choose which to keep.</p>
              <div className="compare">
                {group.members.map((m) => {
                  const on = keep.has(m.item.id);
                  const toggle = () => {
                    const next = new Set(keep);
                    on ? next.delete(m.item.id) : next.add(m.item.id);
                    setKeep(next);
                  };
                  return (
                    <div key={m.item.id} className={`copy ${on ? "on" : ""}`} onClick={toggle}>
                      <Thumb item={m.item} className="big">{on && <span className="dup">★ Keep</span>}</Thumb>
                      <div className="copy-body">
                        <div className="row"><b>{m.source_name}</b>{m === group.members[group.best] && <span className="amber small">Best</span>}</div>
                        <table>
                          <tbody>
                            <tr><td>Size</td><td>{m.item.width && m.item.height ? `${m.item.width} × ${m.item.height}` : "Unknown"}</td></tr>
                            <tr><td>File</td><td>{m.item.path.split(".").pop()?.toUpperCase()} · {formatBytes(m.item.size)}</td></tr>
                            <tr><td>Date taken</td><td>{dateTimeLabel(m.item.taken_at)}</td></tr>
                            <tr><td>Date from</td><td>{m.item.date_source ?? "—"}</td></tr>
                            {m.copies > 1 && <tr><td>Exact copies</td><td>{m.copies}</td></tr>}
                          </tbody>
                        </table>
                        <div className="muted small ellipsis" title={m.item.path}>{m.item.path}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="note"><span className="dot" />Nothing is deleted here. Binned files can be restored from each source.</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
