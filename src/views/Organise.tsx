import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, CopyReport, dayLabel, EventSuggestion, fileUrl, formatBytes, Item, n, PlanSummary, Progress } from "../api";
import ProgressBar from "../components/ProgressBar";
import Thumb from "../components/Thumb";

type Props = { onChanged: () => void; onError: (e: string) => void; onNext: () => void };

export default function Organise({ onChanged, onError, onNext }: Props) {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [events, setEvents] = useState<EventSuggestion[]>([]);
  const [refs, setRefs] = useState<Item[]>([]);
  const [showRefs, setShowRefs] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<CopyReport | null>(null);
  const [autoRef, setAutoRef] = useState(true);
  const [checked, setChecked] = useState<string>("");

  const load = async () => {
    try {
      const [p, e, r, st] = await Promise.all([api.planSummary(), api.suggestEvents(), api.referenceSuggestions(), api.settings()]);
      setAutoRef(st.auto_reference);
      setPlan(p);
      setEvents(e);
      setRefs(r);
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => {
    load();
    const un = api.onCopyProgress(setProgress);
    return () => { un.then((f) => f()); };
  }, []);

  const chooseFolder = async (key: "library_root" | "backup_root", title: string) => {
    const dir = await open({ directory: true, title });
    if (typeof dir !== "string") return;
    await api.setSetting(key, dir);
    load();
  };

  const keyOf = (e: EventSuggestion) => `${e.start_day}_${e.end_day}`;
  const saveEvent = async (e: EventSuggestion) => {
    const name = (names[keyOf(e)] ?? e.name).trim();
    if (!name) return;
    await api.saveEvent(name, e.start_day, e.end_day);
    load();
  };

  const acceptRefs = async (yes: boolean, ids = refs.map((r) => r.id)) => {
    await api.setReference(ids, yes);
    load();
    onChanged();
  };

  const copy = async () => {
    setReport(null);
    try {
      const r = await api.runCopy();
      setReport(r);
    } catch (e) {
      onError(String(e));
    } finally {
      setProgress(null);
      load();
      onChanged();
    }
  };

  if (!plan) return <div className="empty"><p>Working out the new library…</p></div>;
  const copying = progress && progress.stage !== "done";
  const depth = (p: string) => p.split("/").length - 1;

  return (
    <>
      <div className="top"><h1>Organise</h1><span className="sub">Preview the new library before anything is copied</span></div>
      <div className="split wide">
        <div className="list tree">
          <div className="label">Library folder</div>
          <button className="folder-pick" onClick={() => chooseFolder("library_root", "Choose where the library lives (e.g. a folder in Proton Drive)")}>
            {plan.library_root ?? "Choose a folder in Proton Drive…"}
          </button>
          <div className="label">Backup mirror</div>
          <button className="folder-pick" onClick={() => chooseFolder("backup_root", "Choose the backup folder (e.g. on the NAS)")}>
            {plan.backup_root ?? "Choose a folder on the NAS…"}
          </button>
          <div className="label">New structure</div>
          {plan.tree.filter((t) => depth(t.path) < 3).slice(0, 400).map((t) => (
            <div key={t.path} className={`tree-row ${t.path.includes(" ") && depth(t.path) === 2 ? "amber" : ""}`} style={{ paddingLeft: depth(t.path) * 16 }}>
              {t.path.split("/").pop()} <span className="dim">{n(t.count)}</span>
            </div>
          ))}
        </div>
        <div className="detail">
          <div className="row start">
            <b className="h3">Events</b>
            <span className="muted">{events.filter((e) => e.id === null).length} suggested from busy days · {events.filter((e) => e.id !== null).length} named</span>
          </div>
          <p className="muted">Name a trip or occasion and its photos go together in a folder like "2024-06 Barcelona". Unnamed days just use the month.</p>
          {events.length === 0 && <p className="muted">No busy stretches found yet.</p>}
          <div className="events">
            {events.slice(0, 60).map((e) => (
              <div key={keyOf(e)} className="event">
                <div className="event-thumbs">
                  {e.sample_thumbs.map((t) => <img key={t} src={fileUrl(t)} alt="" />)}
                </div>
                <div className="grow">
                  <div className="dim small">{dayLabel(e.start_day)}{e.end_day !== e.start_day && ` – ${dayLabel(e.end_day)}`} · {n(e.count)} items</div>
                  <input
                    className="event-name"
                    placeholder="Name this event"
                    value={names[keyOf(e)] ?? e.name}
                    onChange={(x) => setNames({ ...names, [keyOf(e)]: x.target.value })}
                    onKeyDown={(x) => x.key === "Enter" && saveEvent(e)}
                  />
                </div>
                {e.id !== null && <button className="btn" onClick={async () => { await api.deleteEvent(e.id!); load(); }}>Remove</button>}
                <button className={`btn ${e.id !== null && (names[keyOf(e)] ?? e.name) === e.name ? "accepted" : ""}`} onClick={() => saveEvent(e)}>
                  {e.id !== null && (names[keyOf(e)] ?? e.name) === e.name ? "✓ Saved" : "Save"}
                </button>
              </div>
            ))}
          </div>

          <label className="switch-row">
            <input type="checkbox" checked={autoRef} onChange={async (e) => {
              setAutoRef(e.target.checked);
              await api.setSetting("auto_reference", e.target.checked ? "1" : "0");
              if (e.target.checked && refs.length) await acceptRefs(true);
            }} />
            <span className="switch" />
            <span>
              <b>Move likely reference images automatically after each scan</b>
              <span className="muted small"> · they go to Reference › To sort. Anything you send back as a photo stays put.</span>
              {checked && <span className="good small"> · {checked}</span>}
            </span>
            <button className="btn small" style={{ marginLeft: "auto" }} onClick={async (e) => {
              e.preventDefault();
              try {
                const moved = await api.checkReference();
                setChecked(moved ? `Moved ${n(moved)} to Reference` : "Nothing new found");
                load();
                onChanged();
              } catch (x) { onError(String(x)); }
            }}>Check now</button>
          </label>
          {refs.length > 0 && (
            <div className="ref-card">
              <div className="grow">
                <b>{n(refs.length)} likely design reference images</b>
                <div className="muted small">Screenshots and saved images with no camera data. Accepted ones go to Reference, sorted later into topics.</div>
              </div>
              <button className="btn" onClick={() => setShowRefs(!showRefs)}>{showRefs ? "Hide" : "Review"}</button>
              <button className="btn" onClick={() => acceptRefs(false)}>They're photos</button>
              <button className="btn pri" onClick={() => acceptRefs(true)}>Move all to Reference</button>
            </div>
          )}
          {showRefs && (
            <div className="tiles small-tiles">
              {refs.slice(0, 200).map((r) => (
                <Thumb key={r.id} item={r} onClick={() => acceptRefs(false, [r.id])}>
                  <span className="hover-info">Click: it's a photo</span>
                </Thumb>
              ))}
            </div>
          )}

          {copying && <ProgressBar label="Copying and checking every file" p={progress!} />}
          {report && (
            <div className={`note ${report.errors.length ? "bad" : ""}`}>
              <span className="dot" />
              Copied {n(report.copied)} files, backed up {n(report.backed_up)}, {n(report.skipped)} already done.
              {report.errors.length > 0 && ` ${report.errors.length} problems: ${report.errors.slice(0, 3).join("; ")}`}
            </div>
          )}
        </div>
      </div>
      <div className="bottom-bar">
        <div>
          <b>{n(plan.to_copy)} files</b> <span className="muted">· {formatBytes(plan.to_copy_bytes)} to copy{plan.already_copied > 0 && ` · ${n(plan.already_copied)} already in the library`}</span>
          <div className="muted small">{n(plan.photos)} photos and videos · {n(plan.reference)} reference · {n(plan.undated)} undated</div>
        </div>
        <span className="muted" style={{ marginLeft: "auto" }}>Originals stay where they are</span>
        {plan.to_copy === 0 && plan.already_copied > 0 ? (
          <button className="btn pri" onClick={onNext}>Next: clean-up →</button>
        ) : (
          <button className="btn pri" disabled={!plan.library_root || !!copying || plan.to_copy === 0} onClick={copy}>
            {plan.library_root ? (plan.backup_root ? "Copy to library and backup" : "Copy to library") : "Choose a library folder first"}
          </button>
        )}
      </div>
    </>
  );
}
