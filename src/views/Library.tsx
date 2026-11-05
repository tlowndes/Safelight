import { useEffect, useMemo, useRef, useState } from "react";
import { api, dateTimeLabel, fileName, FolderNode, FolderRef, formatBytes, Item, monthLabel, MonthGroup, n, Source, Stats } from "../api";
import Thumb from "../components/Thumb";
import FolderTree from "../components/FolderTree";
import DeleteDialog from "../components/DeleteDialog";
import Loupe from "./Loupe";
import { isTyping } from "../shortcuts";

type Filter = "all" | "photo" | "video" | "picks" | "rated" | "rejected" | "dupes" | "edited";
type Props = {
  groups: MonthGroup[];
  /** Search words, kept by the app so other screens can search the library. */
  query: string;
  onQuery: (q: string) => void;
  smartReady: boolean;
  stats: Stats | null;
  sources: Source[];
  onAddSources: () => void;
  onEdit: (id: number) => void;
  onPatch: (ids: number[], patch: Partial<Item>) => void;
  onChanged: () => void;
  onError: (e: string) => void;
};

const FOLDERS_KEY = "safelight.folders-open";
function folderPanelSaved() {
  try { return localStorage.getItem(FOLDERS_KEY) === "1"; } catch { return false; }
}

export default function Library({ groups: allGroups, query, onQuery: setQuery, smartReady, stats, sources, onAddSources, onEdit, onPatch, onChanged, onError }: Props) {
  // Folder tree: the panel, the chosen folder, and what's inside it.
  const [showFolders, setShowFolders] = useState(folderPanelSaved);
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [folder, setFolder] = useState<FolderRef | null>(null);
  const [folderGroups, setFolderGroups] = useState<MonthGroup[] | null>(null);
  useEffect(() => {
    try { localStorage.setItem(FOLDERS_KEY, showFolders ? "1" : "0"); } catch { /* private window */ }
  }, [showFolders]);
  // Reload the tree and the folder's photos whenever the library changes.
  useEffect(() => {
    if (showFolders) api.folderTree().then(setTree).catch((e) => onError(String(e)));
  }, [allGroups, showFolders]);
  useEffect(() => {
    if (!folder) { setFolderGroups(null); return; }
    let live = true;
    api.library(3000, folder).then((g) => live && setFolderGroups(g)).catch((e) => onError(String(e)));
    return () => { live = false; };
  }, [allGroups, folder?.source_id, folder?.path]);
  // Closing the panel goes back to everything.
  useEffect(() => { if (!showFolders) setFolder(null); }, [showFolders]);
  const groups = folder ? folderGroups ?? [] : allGroups;
  const patchItems = (ids: number[], p: Partial<Item>) => {
    onPatch(ids, p);
    const set = new Set(ids);
    setFolderGroups((gs) => gs && gs.map((g) => ({ ...g, items: g.items.map((i) => (set.has(i.id) ? { ...i, ...p } : i)) })));
  };
  const folderNode = folder ? tree.find((f) => f.source_id === folder.source_id && f.path === folder.path) : undefined;

  const [filter, setFilter] = useState<Filter>("all");
  /** Items smart search matched (people, places, tags, look), or null when not searching. */
  const [smartIds, setSmartIds] = useState<Set<number> | null>(null);
  const [similar, setSimilar] = useState<{ of: Item; items: Item[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [loupe, setLoupe] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number[] | null>(null);
  const confirming = deleting !== null;
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const anchor = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Smart search runs on the Rust side; wait for a pause in typing.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSmartIds(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.smartSearch(q).then((ids) => live && setSmartIds(new Set(ids))).catch(() => live && setSmartIds(null));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const showSimilar = async (item: Item) => {
    try {
      const items = await api.similar(item.id);
      setLoupe(null);
      setSimilar({ of: item, items: [item, ...items] });
    } catch (e) { onError(String(e)); }
  };

  const shown = useMemo(() => {
    if (similar) return [{ month: "similar", items: similar.items }];
    const q = query.trim().toLowerCase();
    const keep = (i: Item) =>
      (filter === "all" ||
        (filter === "dupes" ? i.has_exact_duplicate
          : filter === "edited" ? i.edited
          : filter === "picks" ? i.flag === 1
          : filter === "rejected" ? i.flag === -1
          : filter === "rated" ? i.rating > 0
          : i.kind === filter)) &&
      (!q || i.path.toLowerCase().includes(q) || (i.taken_at ?? "").includes(q) || !!smartIds?.has(i.id));
    return groups.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
  }, [groups, filter, query, smartIds, similar]);
  const flat = useMemo(() => shown.flatMap((g) => g.items), [shown]);
  const indexOf = (id: number | null) => (id === null ? -1 : flat.findIndex((i) => i.id === id));

  // Drop selections that are no longer in the library.
  useEffect(() => {
    const ids = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
    setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
  }, [groups]);

  const selecting = selected.size > 0;
  const selectedBytes = useMemo(() => flat.filter((i) => selected.has(i.id)).reduce((a, i) => a + i.size, 0), [flat, selected]);
  /** What a rating or flag key applies to: the selection, or else the focused photo. */
  const targets = () => (selecting ? [...selected] : cursor !== null ? [cursor] : []);

  const say = (text: string, undo?: () => void) => setNotice({ text, undo });
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const rate = async (ids: number[], rating: number) => {
    if (!ids.length) return;
    patchItems(ids, { rating });
    try { await api.setRating(ids, rating); } catch (e) { onError(String(e)); onChanged(); }
  };
  const flag = async (ids: number[], value: number) => {
    if (!ids.length) return;
    patchItems(ids, { flag: value });
    try { await api.setFlag(ids, value); } catch (e) { onError(String(e)); onChanged(); }
  };
  const hide = async (ids: number[]) => {
    if (!ids.length) return;
    // Keep the focus on the photo after the hidden ones, so H can be pressed again and again.
    const after = flat.find((i, k) => k > indexOf(ids[ids.length - 1]) && !ids.includes(i.id)) ?? [...flat].reverse().find((i) => !ids.includes(i.id));
    try {
      await api.setHidden(ids, true);
      setSelected(new Set());
      if (cursor !== null && ids.includes(cursor)) setCursor(after?.id ?? null);
      say(`Hid ${n(ids.length)} photo${ids.length === 1 ? "" : "s"} from the library. Files stay where they are.`, async () => {
        await api.setHidden(ids, false);
        setNotice(null);
        onChanged();
      });
      onChanged();
    } catch (e) { onError(String(e)); }
  };

  const toggle = (id: number, e?: React.MouseEvent) => {
    const next = new Set(selected);
    if (e?.shiftKey && anchor.current !== null) {
      const a = indexOf(anchor.current);
      const b = indexOf(id);
      if (a >= 0 && b >= 0) {
        for (const i of flat.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(i.id);
        setSelected(next);
        return;
      }
    }
    next.has(id) ? next.delete(id) : next.add(id);
    anchor.current = id;
    setSelected(next);
  };

  const clickTile = (i: Item, e: React.MouseEvent) => {
    setCursor(i.id);
    if (selecting || e.shiftKey || e.ctrlKey || e.metaKey) return toggle(i.id, e);
    setLoupe(i.id);
  };

  const selectMonth = (g: MonthGroup) => {
    const all = g.items.every((i) => selected.has(i.id));
    const next = new Set(selected);
    g.items.forEach((i) => (all ? next.delete(i.id) : next.add(i.id)));
    setSelected(next);
  };

  /** Move the focus to the tile visually above or below, wherever the month breaks fall. */
  const vertical = (from: number, dir: 1 | -1) => {
    const root = gridRef.current;
    const cur = root?.querySelector<HTMLElement>(`[data-id="${from}"]`);
    if (!root || !cur) return from;
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best: { id: number; score: number } | null = null;
    root.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => {
      const b = el.getBoundingClientRect();
      const dy = (b.top - r.top) * dir;
      if (dy < r.height / 2) return;
      const score = dy * 4 + Math.abs(b.left + b.width / 2 - cx);
      if (!best || score < best.score) best = { id: Number(el.dataset.id), score };
    });
    return (best as { id: number } | null)?.id ?? from;
  };

  // Keep the focused tile in view.
  useEffect(() => {
    if (cursor === null || loupe !== null) return;
    gridRef.current?.querySelector(`[data-id="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, loupe]);

  useEffect(() => {
    if (loupe !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || confirming) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const at = indexOf(cursor);
      const move = (id: number | undefined) => { if (id !== undefined) { setCursor(id); e.preventDefault(); } };
      if (k === "Escape") setSelected(new Set());
      else if ((k === "Delete" || k === "Backspace" || ((k === "d" || k === "D") && !ctrl)) && targets().length) { e.preventDefault(); setDeleting(targets()); }
      else if (k === "a" && ctrl) { e.preventDefault(); setSelected(new Set(flat.map((i) => i.id))); }
      else if (ctrl) return;
      else if (k === "ArrowRight") move(flat[Math.min(flat.length - 1, at + 1)]?.id ?? flat[0]?.id);
      else if (k === "ArrowLeft") move(flat[Math.max(0, at - 1)]?.id ?? flat[0]?.id);
      else if (k === "ArrowDown") move(cursor === null ? flat[0]?.id : vertical(cursor, 1));
      else if (k === "ArrowUp") move(cursor === null ? flat[0]?.id : vertical(cursor, -1));
      else if (k === "Home") move(flat[0]?.id);
      else if (k === "End") move(flat[flat.length - 1]?.id);
      else if (k === " " && cursor !== null) { e.preventDefault(); toggle(cursor); }
      else if ((k === "e" || k === "E" || k === "Enter") && (cursor ?? flat[0]?.id) !== undefined) { e.preventDefault(); setLoupe(cursor ?? flat[0].id); }
      else if ((k === "r" || k === "R") && cursor !== null && flat[at]?.kind === "photo") onEdit(cursor);
      else if (/^[0-5]$/.test(k)) rate(targets(), Number(k));
      else if (k === "p" || k === "P") flag(targets(), 1);
      else if (k === "x" || k === "X") flag(targets(), -1);
      else if (k === "u" || k === "U") flag(targets(), 0);
      else if (k === "h" || k === "H") hide(targets());
      else if (k === "f" || k === "F") setShowFolders((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const visible = (stats?.photos ?? 0) + (stats?.videos ?? 0) - (stats?.hidden ?? 0);
  const years = [...new Set(groups.map((g) => g.month.slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))];
  const sourceName = (id: number) => sources.find((s) => s.id === id)?.name ?? "Unknown source";

  if ((stats?.photos ?? 0) + (stats?.videos ?? 0) === 0) {
    return (
      <div className="empty">
        <span className="eyebrow">Library</span>
        <h2>Nothing here yet</h2>
        <p>Add Proton Drive, Google Drive, a Google Photos Takeout folder or your NAS, and Safelight will gather everything into one timeline. Nothing is moved or deleted.</p>
        <button className="btn pri" onClick={onAddSources}>Add sources</button>
      </div>
    );
  }

  const chip = (k: Filter, label: string) => (
    <button className={`chip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
  );
  const loupeIndex = indexOf(loupe);

  return (
    <>
      <div className="top">
        <h1 className="ellipsis">{folderNode ? folderNode.name : "All photos"}</h1>
        <span className="sub ellipsis">
          {folderNode
            ? `${n(folderNode.count)} in ${folderNode.depth === 0 ? "this source" : `${sources.find((s) => s.id === folderNode.source_id)?.name ?? "source"} › ${folderNode.path.split("/").join(" › ")}`}`
            : `${n(visible)} from ${sources.length} source${sources.length === 1 ? "" : "s"}`}
        </span>
        <label className="vh" htmlFor="library-search">Search</label>
        <input id="library-search" className="search" type="search" placeholder={smartReady ? "Search people, places, things or dates" : "Search names, places, tags or dates"} value={query}
          onChange={(e) => { setQuery(e.target.value); setSimilar(null); }} onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), setQuery(""))} />
        <div className="seg" role="group" aria-label="Panels">
          <button className={showFolders ? "on" : ""} aria-pressed={showFolders} aria-label="Folders (F)" title="Folders (F)" onClick={() => setShowFolders(!showFolders)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z" /></svg>
          </button>
        </div>
        <div className="seg" role="group" aria-label="View">
          <button className="on" aria-label="Grid (G)" title="Grid (G)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
          </button>
          <button aria-label="Loupe (E)" title="Loupe (E)" onClick={() => flat.length && setLoupe(cursor ?? flat[0].id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /></svg>
          </button>
        </div>
      </div>
      <div className="chips">
        {chip("all", "All")}
        {chip("photo", "Photos")}
        {chip("video", "Videos")}
        {chip("picks", "Picks")}
        {chip("rated", "Rated")}
        {chip("rejected", "Rejected")}
        {chip("edited", "Edited")}
        {chip("dupes", "Exact copies")}
      </div>
      {similar && (
        <div className="similar-bar" role="status">
          <span>Showing {n(similar.items.length - 1)} photo{similar.items.length === 2 ? "" : "s"} that look like {fileName(similar.of.path)}</span>
          <button className="btn small" onClick={() => setSimilar(null)}>Back to all photos</button>
        </div>
      )}
      <div className={`lib-body ${showFolders ? "with-folders" : ""}`}>
      {showFolders && <FolderTree nodes={tree} sources={sources} selected={folder} onSelect={(f) => { setFolder(f); setSelected(new Set()); setCursor(null); }} />}
      <div ref={gridRef} className={`grid ${selecting ? "selecting" : ""}`}>
        {shown.map((g) => (
          <section key={g.month} id={`m-${g.month}`}>
            <div className="mh">
              <b>{g.month === "similar" ? "Looks alike" : monthLabel(g.month)}</b><span>{n(g.items.length)} items</span>
              <button className="link month-select" onClick={() => selectMonth(g)}>
                {g.items.every((i) => selected.has(i.id)) ? "Deselect month" : "Select month"}
              </button>
            </div>
            <div className="tiles">
              {g.items.map((i) => {
                const on = selected.has(i.id);
                return (
                  <Thumb key={i.id} item={i} className={`${on ? "picked" : ""} ${cursor === i.id ? "cursor" : ""} ${i.flag === -1 ? "rejected" : ""}`}
                    onClick={(e) => clickTile(i, e)}>
                    <span className={`tick ${on ? "on" : ""}`} title="Select" onClick={(e) => { e.stopPropagation(); setCursor(i.id); toggle(i.id, e); }}>{on ? "✓" : ""}</span>
                    <span className="hover-info">{dateTimeLabel(i.taken_at)}</span>
                    {i.has_exact_duplicate && <span className="dup">Copy</span>}
                    {i.edited && <span className="edited">Edited</span>}
                    {(i.rating > 0 || i.flag !== 0) && (
                      <span className="meta">
                        {i.flag === 1 && <span className="flag pick">Pick</span>}
                        {i.flag === -1 && <span className="flag">Rejected</span>}
                        {i.rating > 0 && <span className="stars" aria-label={`${i.rating} stars`}>{"★".repeat(i.rating)}</span>}
                      </span>
                    )}
                  </Thumb>
                );
              })}
            </div>
          </section>
        ))}
        {shown.length === 0 && <p className="muted">{folder && folderGroups === null ? "Loading…" : "No matches."}{!smartReady && query.trim() && !folder ? " Turn on smart tagging in People & places to search by what's in a photo." : ""}</p>}
      </div>
      </div>
      {!selecting && (
        <nav className="scrub" aria-label="Years">
          {years.map((y) => (
            <a key={y} href={`#m-${groups.find((g) => g.month.startsWith(y))?.month}`}>{y}</a>
          ))}
        </nav>
      )}
      {notice && (
        <div className="toast" role="status">
          {notice.text}
          {notice.undo && <button onClick={notice.undo}><u>Undo</u></button>}
          <button aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
      {selecting && (
        <div className="select-bar">
          <b>{n(selected.size)} selected</b>
          <span className="muted small" style={{ padding: "0 6px" }}>{formatBytes(selectedBytes)} · 1–5 to rate</span>
          <button className="btn" onClick={() => flag([...selected], 1)}>Pick · P</button>
          <button className="btn" onClick={() => hide([...selected])}>Hide · H</button>
          <button className="btn" onClick={async () => {
            const ids = [...selected];
            try {
              await api.setReference(ids, true);
              setSelected(new Set());
              say(`Moved ${n(ids.length)} to Reference › To sort`);
              onChanged();
            } catch (e) { onError(String(e)); }
          }}>Move to Reference</button>
          <button className="btn" onClick={() => setSelected(new Set(flat.map((i) => i.id)))}>Select all {n(flat.length)}</button>
          <button className="btn" onClick={() => setSelected(new Set())}>Clear · Esc</button>
          <button className="btn danger" onClick={() => setDeleting([...selected])}>Delete · D</button>
        </div>
      )}
      {deleting && (
        <DeleteDialog
          ids={deleting}
          onClose={() => setDeleting(null)}
          onError={onError}
          onDone={(r) => {
            const gone = new Set(deleting);
            if (loupe !== null && gone.has(loupe)) {
              // Stay in the loupe on the next photo, like Hide does.
              const next = flat.slice(loupeIndex + 1).find((i) => !gone.has(i.id)) ?? flat.slice(0, loupeIndex).reverse().find((i) => !gone.has(i.id));
              setLoupe(next?.id ?? null);
              if (next) setCursor(next.id);
            } else if (cursor !== null && gone.has(cursor)) {
              const at = indexOf(cursor);
              const next = flat.slice(at + 1).find((i) => !gone.has(i.id)) ?? flat.slice(0, at).reverse().find((i) => !gone.has(i.id));
              setCursor(next?.id ?? null);
            }
            setSelected(new Set());
            say(`Binned ${n(r.photos)} photo${r.photos === 1 ? "" : "s"} (${n(r.files)} files, ${formatBytes(r.freed_bytes)})`);
            onChanged();
          }}
        />
      )}
      {loupe !== null && loupeIndex >= 0 && (
        <Loupe
          items={flat}
          index={loupeIndex}
          onIndex={(i) => { setLoupe(flat[i].id); setCursor(flat[i].id); }}
          onClose={() => { setCursor(loupe); setLoupe(null); }}
          onEdit={(id) => { setLoupe(null); onEdit(id); }}
          onRate={(id, r) => rate([id], r)}
          onFlag={(id, f) => flag([id], f)}
          onDelete={(id) => setDeleting([id])}
          paused={confirming}
          onHide={(id) => {
            const next = flat[loupeIndex + 1] ?? flat[loupeIndex - 1];
            hide([id]);
            if (next) setLoupe(next.id); else setLoupe(null);
          }}
          sourceName={sourceName}
          onSimilar={smartReady ? showSimilar : undefined}
          onSearch={(q) => { setLoupe(null); setSimilar(null); setQuery(q); }}
        />
      )}
    </>
  );
}
