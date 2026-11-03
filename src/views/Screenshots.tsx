import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, fileName, fileUrl, n, Progress, ShotCategory, ShotInfo, ShotMove, ShotSettingKey, ShotSuggestion, Source } from "../api";
import { isTyping } from "../shortcuts";

type Props = {
  sources: Source[];
  onChanged: () => void;
  onError: (e: string) => void;
  /** Bumped by App when the watcher files or queues something, so the lists reload. */
  tick: number;
};

const SURENESS: { id: "careful" | "balanced" | "relaxed"; label: string; hint: string }[] = [
  { id: "careful", label: "Careful", hint: "Files only when 85% sure" },
  { id: "balanced", label: "Balanced", hint: "Files when 70% sure" },
  { id: "relaxed", label: "Relaxed", hint: "Files when 55% sure" },
];

const pct = (c: number) => `${Math.round(c * 100)}%`;
const ext = (p: string) => (p.includes(".") ? "." + p.split(".").pop()!.toLowerCase() : "");
const when = (t: string) => new Date(t.replace(" ", "T")).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const folderOf = (p: string) => p.split(/[\\/]/).slice(-2, -1)[0] ?? "";

/** Screenshot filing, brought over from Snapsort: a review list for the ones Safelight isn't
 * sure about, a log of everything filed (each one can be put back), and the import settings. */
export default function Screenshots({ sources, onChanged, onError, tick }: Props) {
  const [info, setInfo] = useState<ShotInfo | null>(null);
  const [tab, setTab] = useState<"review" | "filed">("review");
  const [queue, setQueue] = useState<ShotSuggestion[]>([]);
  const [moves, setMoves] = useState<ShotMove[]>([]);
  const [cur, setCur] = useState(0);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sorting, setSorting] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [lastFiled, setLastFiled] = useState<ShotMove | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, q, m] = await Promise.all([api.shotInfo(), api.shotQueue(), api.shotMoves(query || null)]);
      setInfo(i);
      setQueue(q);
      setMoves(m);
    } catch (e) { onError(String(e)); }
  }, [query, onError]);
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => {
    const un = api.onShotsProgress((p) => setSorting(p.done < p.total ? p : null));
    return () => { un.then((f) => f()); };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? queue.filter((s) => s.description.toLowerCase().includes(q) || s.text.toLowerCase().includes(q)) : queue;
  }, [queue, query]);
  const sel = shown[Math.min(cur, shown.length - 1)] ?? null;
  const cats = info?.categories ?? [];

  const fileIt = async (s: ShotSuggestion, edits: { category?: string; description?: string }) => {
    setBusy(true);
    try {
      const m = await api.shotFile(s.path, edits);
      setLastFiled(m);
      await load();
      onChanged();
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };
  const leave = async (s: ShotSuggestion) => {
    try { await api.shotLeave(s.path); await load(); onChanged(); } catch (e) { onError(String(e)); }
  };
  const undo = async (m: ShotMove) => {
    try {
      await api.shotUndo(m.id);
      if (lastFiled?.id === m.id) setLastFiled(null);
      await load();
      onChanged();
    } catch (e) { onError(String(e)); }
  };
  const sortExisting = async () => {
    setSorting({ done: 0, total: 1 });
    try {
      const added = await api.shotSortExisting();
      setTab("review");
      setCur(0);
      if (!added) onError("No loose screenshots to sort. Everything in the folder is filed or already waiting.");
      await load();
      onChanged();
    } catch (e) { onError(String(e)); } finally { setSorting(null); }
  };

  // Keyboard: arrows move through the list, Ctrl+Z puts back the last one filed. Enter, Delete
  // and F2 are handled by the inspector, which knows the edited name and folder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen || isTyping(e)) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && lastFiled && !lastFiled.undone) { e.preventDefault(); undo(lastFiled); return; }
      if (tab !== "review" || !shown.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setCur((c) => Math.min(c + 1, shown.length - 1)); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setCur((c) => Math.max(c - 1, 0)); }
      else if (e.key === "Home") setCur(0);
      else if (e.key === "End") setCur(shown.length - 1);
      else if (e.key === " ") { e.preventDefault(); setPreview((p) => !p); }
      else if (e.key === "Escape") setPreview(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const st = info?.settings;
  const inLibrary = st ? sources.some((s) => st.folder.toLowerCase().startsWith(s.root.toLowerCase())) : false;

  return (
    <>
      <div className="top">
        <h1>Screenshots</h1>
        <div className="seg tabs" role="tablist">
          <button role="tab" aria-selected={tab === "review"} className={tab === "review" ? "on" : ""} onClick={() => setTab("review")}>To review{queue.length > 0 && <span className="count">{n(queue.length)}</span>}</button>
          <button role="tab" aria-selected={tab === "filed"} className={tab === "filed" ? "on" : ""} onClick={() => setTab("filed")}>Filed</button>
        </div>
        <input id="shots-search" className="search" placeholder="Search names and the words in them…" value={query} onChange={(e) => { setQuery(e.target.value); setCur(0); }} />
        <button className="btn" disabled={!!sorting} onClick={sortExisting} title="Read the screenshots already in the folder and put them on the review list">{sorting ? `Reading ${n(sorting.done)} of ${n(sorting.total)}…` : "Sort existing"}</button>
        <button className="btn ghost" onClick={() => setSettingsOpen(true)}>Settings</button>
      </div>

      {st && (
        <div className="shot-status">
          <span className={`dot ${st.watch ? "live" : ""}`} />
          <span>{st.watch ? "Watching" : "Paused"} <b className="ellipsis">{st.folder}</b></span>
          <span className="muted">· {st.reader === "claude" && st.has_api_key ? "Read by Claude, with PC reading as a back-up" : "Read on this PC, nothing leaves it"}</span>
          <span className="muted">· {st.auto_file ? `${SURENESS.find((x) => x.id === st.sureness)?.hint ?? "Files when 70% sure"}` : "Always asks first"}</span>
          {!info!.ocr && <span className="muted">· Reading on the PC needs Windows</span>}
        </div>
      )}

      {tab === "review" && (shown.length === 0 ? (
        <div className="empty">
          <div className="eyebrow">{query ? "No matches" : "All sorted"}</div>
          <h2>{query ? "Nothing waiting matches that" : "Nothing to review"}</h2>
          <p>New screenshots are read as they're saved. Safelight names and files the ones it's sure about, and puts the rest here for a quick look. Nothing is ever deleted.</p>
          {!query && <button className="btn pri" disabled={!!sorting} onClick={sortExisting}>Sort existing screenshots</button>}
        </div>
      ) : (
        <div className="split wide shots">
          <div className="list" role="listbox" aria-label="Screenshots to review">
            <div className="label">{n(shown.length)} waiting</div>
            {shown.map((s, i) => (
              <button key={s.path} role="option" aria-selected={sel?.path === s.path} className={`list-row shot-row ${sel?.path === s.path ? "on" : ""}`} onClick={() => setCur(i)}>
                <img src={fileUrl(s.path)} alt="" loading="lazy" />
                <div>
                  <b className="ellipsis">{s.description}</b>
                  <span className="muted small">{cats.find((c) => c.id === s.category)?.label ?? "Other"} · {pct(s.confidence)} sure</span>
                </div>
              </button>
            ))}
          </div>
          {sel && (
            <Inspector
              key={sel.path + sel.engine + sel.found}
              s={sel}
              cats={cats}
              datePrefix={st?.date_prefix ?? true}
              destination={st?.destination ?? ""}
              canClaude={!!st?.has_api_key}
              busy={busy}
              onFile={(edits) => fileIt(sel, edits)}
              onLeave={() => leave(sel)}
              onPreview={() => setPreview(true)}
              onReread={async (engine) => {
                setBusy(true);
                try { await api.shotReread(sel.path, engine); await load(); } catch (e) { onError(String(e)); } finally { setBusy(false); }
              }}
            />
          )}
        </div>
      ))}

      {tab === "filed" && (
        <div className="detail">
          {moves.length === 0 ? (
            <p className="muted">{query ? "Nothing filed matches that." : "Nothing filed yet. Every screenshot Safelight files is listed here, and can be put back."}</p>
          ) : (
            <div className="table-card shot-log">
              {moves.map((m) => (
                <div key={m.id} className={`trow ${m.undone ? "undone" : ""}`}>
                  <img src={fileUrl(m.undone ? m.from : m.to)} alt="" loading="lazy" />
                  <div className="grow">
                    <b className="ellipsis">{m.name}</b>
                    <span className="muted small ellipsis">{m.undone ? `Put back as ${fileName(m.from)}` : `${folderOf(m.to)} · was ${fileName(m.from)}`}</span>
                  </div>
                  <span className="muted small">{m.auto ? "By itself" : "By you"} · {m.engine === "claude" ? "Claude" : "PC"} · {when(m.at)}</span>
                  {m.undone ? <span className="muted small put-back">Put back</span> : <button className="btn small" onClick={() => undo(m)}>Put back</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {lastFiled && !lastFiled.undone && tab === "review" && (
        <div className="toast" onClick={() => setLastFiled(null)}>
          Filed in {cats.find((c) => c.id === lastFiled.category)?.label} as {lastFiled.name} · <u onClick={(e) => { e.stopPropagation(); undo(lastFiled); }}>Undo</u> <kbd>Ctrl Z</kbd>
          <button onClick={(e) => { e.stopPropagation(); setLastFiled(null); }} aria-label="Dismiss">×</button>
        </div>
      )}

      {preview && sel && (
        <div className="modal-back shot-preview" onClick={() => setPreview(false)}>
          <img src={fileUrl(sel.path)} alt={sel.description} />
        </div>
      )}

      {settingsOpen && st && (
        <SettingsDialog
          info={info!}
          inLibrary={inLibrary}
          onClose={() => setSettingsOpen(false)}
          onError={onError}
          onChanged={async () => { await load(); onChanged(); }}
        />
      )}
    </>
  );
}

type InspectorProps = {
  s: ShotSuggestion; cats: ShotCategory[]; datePrefix: boolean; destination: string; canClaude: boolean; busy: boolean;
  onFile: (edits: { category?: string; description?: string }) => void; onLeave: () => void; onPreview: () => void;
  onReread: (engine: "device" | "claude") => void;
};

function Inspector({ s, cats, datePrefix, destination, canClaude, busy, onFile, onLeave, onPreview, onReread }: InspectorProps) {
  const [name, setName] = useState(s.description);
  const [category, setCategory] = useState(s.category);
  const [showText, setShowText] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const cat = cats.find((c) => c.id === category);
  const newName = `${datePrefix ? s.date + " " : ""}${name.trim() || "Screenshot"}${ext(s.path)}`;
  const file = () => onFile({ category: category !== s.category ? category : undefined, description: name !== s.description ? name : undefined });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || document.querySelector(".modal, .keys")) return;
      const inName = e.target === nameRef.current;
      if (e.key === "Enter" && (inName || !isTyping(e))) { e.preventDefault(); file(); }
      else if (e.key === "F2") { e.preventDefault(); nameRef.current?.focus(); nameRef.current?.select(); }
      else if (e.key === "Delete" && !isTyping(e)) { e.preventDefault(); onLeave(); }
      else if (inName && e.key === "Escape") nameRef.current?.blur();
      else if (!isTyping(e) && !e.ctrlKey && !e.metaKey && /^[1-7]$/.test(e.key) && cats[Number(e.key) - 1]) setCategory(cats[Number(e.key) - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="detail inspector">
      <button className="shot-stage" onClick={onPreview} title="Preview (Space)">
        <img src={fileUrl(s.path)} alt={s.description} />
      </button>
      <div className="field">
        <label htmlFor="shot-name">Name <kbd>F2</kbd></label>
        <input id="shot-name" ref={nameRef} className="text-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck />
        <span className="muted small ellipsis" title={`${destination}\\${cat?.folder}\\${newName}`}>{cat?.folder}\{newName}</span>
      </div>
      <div className="field">
        <label>Folder</label>
        <div className="chips">
          {cats.map((c, i) => (
            <button key={c.id} className={`chip small folder-chip ${category === c.id ? "on" : ""}`} aria-pressed={category === c.id} onClick={() => setCategory(c.id)} title={`Press ${i + 1}`}>{c.label}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>How sure</label>
        <div className="sure"><div className="bar"><b style={{ width: pct(s.confidence) }} /></div><span>{pct(s.confidence)}</span></div>
        <span className="muted small">
          Read {s.engine === "claude" ? "by Claude" : "on this PC"}
          {" · "}
          {s.engine === "claude" || !canClaude
            ? <button className="link" disabled={busy} onClick={() => onReread("device")}>Read again on the PC</button>
            : <button className="link" disabled={busy} onClick={() => onReread("claude")}>Ask Claude for a sharper name</button>}
        </span>
        {s.note && <div className="note"><span className="dot" />{s.note}</div>}
      </div>
      {s.text && (
        <div className="field">
          <button className="link" onClick={() => setShowText(!showText)}>{showText ? "Hide" : "Show"} the text it found</button>
          {showText && <pre className="found-text">{s.text}</pre>}
        </div>
      )}
      <div className="row end inspector-actions">
        <button className="btn ghost" disabled={busy} onClick={onLeave} title="Take it off the list and leave the file where it is">Leave it <kbd>Del</kbd></button>
        <button className="btn pri" disabled={busy} onClick={file}>File it <kbd>Enter</kbd></button>
      </div>
    </div>
  );
}

function SettingsDialog({ info, inLibrary, onClose, onError, onChanged }: { info: ShotInfo; inLibrary: boolean; onClose: () => void; onError: (e: string) => void; onChanged: () => void }) {
  const st = info.settings;
  const [key, setKey] = useState("");
  const set = async (k: ShotSettingKey, v: string) => {
    try { await api.shotSet(k, v); onChanged(); } catch (e) { onError(String(e)); }
  };
  const pick = async (k: "folder" | "destination", title: string) => {
    const dir = await open({ directory: true, title });
    if (typeof dir === "string") set(k, dir);
  };
  const toggle = (k: ShotSettingKey, on: boolean, label: string, hint: string) => (
    <label className="switch-row">
      <input type="checkbox" checked={on} onChange={(e) => set(k, e.target.checked ? "1" : "0")} />
      <span className="switch" />
      <span><b>{label}</b><span className="muted small"> · {hint}</span></span>
    </label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal shot-settings" role="dialog" aria-modal="true" aria-label="Screenshot settings" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="eyebrow">Screenshots</div>
        <h2>Import settings</h2>

        <div className="field">
          <label>Screenshot folder</label>
          <div className="path-row"><span className="ellipsis">{st.folder}</span><button className="btn small" onClick={() => pick("folder", "Where Windows saves screenshots")}>Change</button></div>
        </div>
        <div className="field">
          <label>File them into</label>
          <div className="path-row"><span className="ellipsis">{st.destination}</span><button className="btn small" onClick={() => pick("destination", "Where the Design, Web, Code… folders go")}>Change</button></div>
          <span className="muted small">Category folders (Design, Web, Code, Receipts, Chats, Documents, Other) are made here.</span>
        </div>

        {toggle("watch", st.watch, "Watch for new screenshots", "read each one as it's saved")}
        {toggle("auto_file", st.auto_file, "File by itself when sure", "otherwise everything waits for review")}
        <div className="field">
          <label>How sure before filing by itself</label>
          <div className="seg text">
            {SURENESS.map((x) => <button key={x.id} className={st.sureness === x.id ? "on" : ""} title={x.hint} onClick={() => set("sureness", x.id)}>{x.label}</button>)}
          </div>
        </div>
        {toggle("date_prefix", st.date_prefix, "Start names with the date", "e.g. 2026-10-31 Figma – Onboarding flow")}

        <div className="field">
          <label>Reading</label>
          <div className="seg text">
            <button className={st.reader === "device" ? "on" : ""} onClick={() => set("reader", "device")}>On this PC</button>
            <button className={st.reader === "claude" ? "on" : ""} onClick={() => set("reader", "claude")}>Claude</button>
          </div>
          <span className="muted small">
            {st.reader === "device"
              ? "Uses the text reader built into Windows. Nothing leaves this PC."
              : "Each new screenshot is sent to the Anthropic API for a sharper name. If Claude can't be reached, it's read on the PC instead."}
          </span>
        </div>
        {st.reader === "claude" && (
          <>
            <div className="field">
              <label>Claude model</label>
              <div className="seg text">
                <button className={st.claude_model === "best" ? "on" : ""} onClick={() => set("claude_model", "best")}>Best names</button>
                <button className={st.claude_model === "cheapest" ? "on" : ""} onClick={() => set("claude_model", "cheapest")}>Cheapest</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="shot-key">Claude API key</label>
              <div className="path-row">
                <input id="shot-key" className="text-input" type="password" autoComplete="off" placeholder={st.has_api_key ? "Saved · paste a new one to replace it" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} />
                <button className="btn small" disabled={!key.trim()} onClick={async () => { try { await api.shotSetApiKey(key); setKey(""); onChanged(); } catch (e) { onError(String(e)); } }}>Save</button>
                {st.has_api_key && <button className="btn small ghost" onClick={async () => { await api.shotSetApiKey(""); onChanged(); }}>Remove</button>}
              </div>
              <span className="muted small">Stored encrypted with your Windows account.</span>
            </div>
          </>
        )}

        {!inLibrary && (
          <div className="note"><span className="dot" /><span>The screenshot folder isn't one of your sources yet, so filed screenshots won't show in the library.{" "}
            <button className="link" onClick={async () => { try { await api.addSource("Screenshots", "local", st.folder); onChanged(); } catch (e) { onError(String(e)); } }}>Add it as a source</button></span>
          </div>
        )}
        <div className="row end"><button className="btn pri" onClick={onClose} autoFocus>Done</button></div>
      </div>
    </div>
  );
}
