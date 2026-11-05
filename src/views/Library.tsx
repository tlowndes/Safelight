import { useEffect, useMemo, useRef, useState } from "react";
import { api, Collection, dateTimeLabel, fileName, FolderNode, FolderRef, formatBytes, Item, Label, LABEL_NAMES, LABELS, monthLabel, MonthGroup, n, Rules, Source, Stats } from "../api";
import Thumb from "../components/Thumb";
import FolderTree from "../components/FolderTree";
import DeleteDialog from "../components/DeleteDialog";
import ExportDialog from "../components/ExportDialog";
import { useCopiedEdits } from "../editClipboard";
import CollectionsPanel from "../components/CollectionsPanel";
import CollectionDialog from "../components/CollectionDialog";
import Compare from "../components/Compare";
import Slideshow from "../components/Slideshow";
import PrintDialog from "../components/PrintDialog";
import WebGalleryDialog from "../components/WebGalleryDialog";
import Loupe from "./Loupe";
import { isTyping } from "../shortcuts";
import { Sort, sortItems, stackItems } from "../libraryView";

type Filter = "all" | "photo" | "video" | "picks" | "rated" | "rejected" | "dupes" | "edited";
const SORTS: [Sort, string][] = [["newest", "Capture time, newest"], ["oldest", "Capture time, oldest"], ["name", "File name"], ["rating", "Rating"], ["added", "Date added"], ["size", "File size"]];
const LABEL_KEYS: Record<string, Label> = { "6": "red", "7": "yellow", "8": "green", "9": "blue" };
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
  /** Photos chosen elsewhere, such as a place on the map. */
  pinned?: { title: string; ids: number[] } | null;
  onClearPinned?: () => void;
};

const FOLDERS_KEY = "safelight.folders-open";
function folderPanelSaved() {
  try { return localStorage.getItem(FOLDERS_KEY) === "1"; } catch { return false; }
}
const VIEW_KEY = "safelight.library-view";
function viewSaved(): { sort: Sort; stack: boolean } {
  try { return { sort: "newest", stack: false, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") }; } catch { return { sort: "newest", stack: false }; }
}


export default function Library({ groups: allGroups, query, onQuery: setQuery, smartReady, stats, sources, onAddSources, onEdit, onPatch, onChanged, onError, pinned, onClearPinned }: Props) {
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
  // Collections: hand-picked or rule-based sets, shown under the folders.
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collection, setCollection] = useState<number | null>(null);
  const [collGroups, setCollGroups] = useState<MonthGroup[] | null>(null);
  const [collDialog, setCollDialog] = useState<{ smart: boolean; editing?: Collection; add?: number[] } | null>(null);
  const loadCollections = () => api.collections().then(setCollections).catch((e) => onError(String(e)));
  useEffect(() => { if (showFolders) loadCollections(); }, [allGroups, showFolders]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (collection === null) { setCollGroups(null); return; }
    let live = true;
    api.collectionItems(collection).then((g) => live && setCollGroups(g)).catch((e) => onError(String(e)));
    return () => { live = false; };
  }, [allGroups, collection, collections]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!showFolders) setCollection(null); }, [showFolders]);
  const coll = collections.find((c) => c.id === collection);

  const groups = collection !== null ? collGroups ?? [] : folder ? folderGroups ?? [] : allGroups;
  const patchItems = (ids: number[], p: Partial<Item>) => {
    onPatch(ids, p);
    const set = new Set(ids);
    const fix = (gs: MonthGroup[] | null) => gs && gs.map((g) => ({ ...g, items: g.items.map((i) => (set.has(i.id) ? { ...i, ...p } : i)) }));
    setFolderGroups(fix);
    setCollGroups(fix);
  };
  const folderNode = folder ? tree.find((f) => f.source_id === folder.source_id && f.path === folder.path) : undefined;

  const [filter, setFilter] = useState<Filter>("all");
  const [labelFilter, setLabelFilter] = useState<Label | null>(null);
  const [{ sort, stack }, setViewOpts] = useState(viewSaved);
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ sort, stack })); } catch { /* private window */ } }, [sort, stack]);
  /** Stacks the user has opened, by their top photo. */
  const [openStacks, setOpenStacks] = useState<Set<number>>(new Set());
  const [compare, setCompare] = useState<{ mode: "compare" | "survey"; ids: number[] } | null>(null);
  const [slideshow, setSlideshow] = useState<{ items: Item[]; start: number } | null>(null);
  const [printing, setPrinting] = useState<Item[] | null>(null);
  const [gallery, setGallery] = useState<number[] | null>(null);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  /** Items smart search matched (people, places, tags, look), or null when not searching. */
  const [smartIds, setSmartIds] = useState<Set<number> | null>(null);
  const [similar, setSimilar] = useState<{ of: Item; items: Item[] } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<number | null>(null);
  const [loupe, setLoupe] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number[] | null>(null);
  const confirming = deleting !== null;
  const [exportIds, setExportIds] = useState<number[] | null>(null);
  const copied = useCopiedEdits();
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  /** Right-click menu on a tile. */
  const [menu, setMenu] = useState<{ item: Item; x: number; y: number } | null>(null);
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
    const pin = pinned ? new Set(pinned.ids) : null;
    const q = query.trim().toLowerCase();
    const keep = (i: Item) =>
      (filter === "all" ||
        (filter === "dupes" ? i.has_exact_duplicate
          : filter === "edited" ? i.edited
          : filter === "picks" ? i.flag === 1
          : filter === "rejected" ? i.flag === -1
          : filter === "rated" ? i.rating > 0
          : i.kind === filter)) &&
      (!labelFilter || i.label === labelFilter) &&
      (!pin || pin.has(i.id)) &&
      (!q || i.path.toLowerCase().includes(q) || (i.taken_at ?? "").includes(q) || !!smartIds?.has(i.id));
    let gs: MonthGroup[] = groups.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
    if (sort === "oldest") gs = [...gs].reverse().map((g) => ({ ...g, items: [...g.items].reverse() }));
    else if (sort !== "newest") gs = [{ month: "sorted", items: sortItems(gs.flatMap((g) => g.items), sort) }];
    return gs;
  }, [groups, filter, labelFilter, query, smartIds, similar, sort, pinned]);
  /** Stacks by top photo id, when stacking is on: what each top tile hides. */
  const stacks = useMemo(() => {
    const m = new Map<number, Item[]>();
    if (!stack || similar) return m;
    for (const g of shown) for (const s of stackItems(g.items)) if (s.members.length > 1) m.set(s.top.id, s.members);
    return m;
  }, [shown, stack, similar]);
  const hiddenByStack = useMemo(() => {
    const h = new Set<number>();
    for (const [top, members] of stacks) if (!openStacks.has(top)) for (const i of members) if (i.id !== top) h.add(i.id);
    return h;
  }, [stacks, openStacks]);
  const openMembers = useMemo(() => new Set([...openStacks].flatMap((t) => (stacks.get(t) ?? []).map((m) => m.id))), [stacks, openStacks]);
  const visibleGroups = useMemo(
    () => (hiddenByStack.size ? shown.map((g) => ({ ...g, items: g.items.filter((i) => !hiddenByStack.has(i.id)) })) : shown),
    [shown, hiddenByStack],
  );
  const flat = useMemo(() => visibleGroups.flatMap((g) => g.items), [visibleGroups]);
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
  const label = async (ids: number[], value: Label | null) => {
    if (!ids.length) return;
    patchItems(ids, { label: value });
    try { await api.setLabel(ids, value); } catch (e) { onError(String(e)); onChanged(); }
  };
  /** A label key toggles: pressing red on a red photo clears it. */
  const toggleLabel = (ids: number[], value: Label) => {
    const all = ids.every((id) => flat.find((i) => i.id === id)?.label === value);
    label(ids, all ? null : value);
  };
  /** Compare the selection, or the focused photo and the one after it. */
  const startCompare = (mode: "compare" | "survey") => {
    let ids = selecting ? flat.filter((i) => selected.has(i.id)).map((i) => i.id) : [];
    if (ids.length < 2) {
      const at = Math.max(0, indexOf(cursor));
      ids = mode === "compare" ? flat.slice(at, at + 2).map((i) => i.id) : flat.slice(at, at + 6).map((i) => i.id);
    }
    if (ids.length < 2) return say("Choose at least two photos to compare.");
    setCompare({ mode, ids });
  };
  const selectionOrAll = () => (selecting ? flat.filter((i) => selected.has(i.id)) : flat);
  const addToCollection = async (id: number, ids: number[]) => {
    try {
      await api.addToCollection(id, ids);
      say(`Added ${n(ids.length)} to ${collections.find((c) => c.id === id)?.name ?? "the collection"}`);
      loadCollections();
    } catch (e) { onError(String(e)); }
  };
  const removeFromCollection = async (ids: number[]) => {
    if (collection === null) return;
    try {
      await api.removeFromCollection(collection, ids);
      setSelected(new Set());
      say(`Took ${n(ids.length)} out of ${coll?.name ?? "the collection"}. The photos stay in the library.`, async () => {
        await api.addToCollection(collection, ids);
        setNotice(null);
        loadCollections();
      });
      loadCollections();
    } catch (e) { onError(String(e)); }
  };
  const xmp = async (write: boolean) => {
    const ids = selectionOrAll().map((i) => i.id);
    try {
      if (write) {
        const r = await api.writeXmp(ids);
        say(`Saved ratings, labels and edits to ${n(r.written)} XMP sidecar${r.written === 1 ? "" : "s"}${r.errors.length ? `. ${n(r.errors.length)} skipped: ${r.errors[0]}` : ""}`);
      } else {
        const got = await api.readXmp(ids);
        say(got ? `Read ratings and labels from ${n(got)} XMP sidecar${got === 1 ? "" : "s"}` : "No XMP sidecars found next to these photos.");
        onChanged();
      }
    } catch (e) { onError(String(e)); }
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

  /** Open the folder tree at the folder this photo is in, with the photo focused. */
  const showInFolder = async (item: Item) => {
    try {
      const f = await api.itemFolder(item.id);
      if (!f) return say("This photo isn't inside any folder Safelight knows about.");
      setLoupe(null);
      setSimilar(null);
      setFilter("all");
      if (query) setQuery("");
      setSelected(new Set());
      setShowFolders(true);
      setCollection(null);
      setFolder(f);
      setCursor(item.id);
    } catch (e) { onError(String(e)); }
  };
  const showInExplorer = (item: Item) => api.revealInExplorer(item.path).catch((e) => onError(String(e)));

  /** Paste the copied look onto photos, each keeping its own crop. Undoable. */
  const pasteEdits = async (ids: number[]) => {
    const photos = ids.filter((id) => flat.find((i) => i.id === id)?.kind === "photo");
    if (!copied || !photos.length) return;
    try {
      const before = await api.pasteLook(photos, copied);
      onChanged();
      say(`Pasted settings onto ${n(photos.length)} photo${photos.length === 1 ? "" : "s"}`, async () => {
        await api.restoreEdits(before);
        setNotice(null);
        onChanged();
      });
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
  }, [cursor, loupe, folderGroups]);

  useEffect(() => {
    if (loupe !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || confirming || exportIds || compare || slideshow || printing || gallery || collDialog) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const at = indexOf(cursor);
      const move = (id: number | undefined) => { if (id !== undefined) { setCursor(id); e.preventDefault(); } };
      const focused = at >= 0 ? flat[at] : undefined;
      if (k === "Escape") { setMenu(null); setSelected(new Set()); }
      else if ((k === "r" || k === "R") && ctrl && focused) { e.preventDefault(); showInExplorer(focused); }
      else if ((k === "Delete" || k === "Backspace" || ((k === "d" || k === "D") && !ctrl)) && targets().length) { e.preventDefault(); setDeleting(targets()); }
      else if ((k === "e" || k === "E") && ctrl && !e.shiftKey) { e.preventDefault(); if (cursor !== null && flat[at]?.kind === "photo") onEdit(cursor); }
      else if (k === "a" && ctrl) { e.preventDefault(); setSelected(new Set(flat.map((i) => i.id))); }
      else if ((k === "v" || k === "V") && ctrl && e.shiftKey && targets().length) { e.preventDefault(); pasteEdits(targets()); }
      else if ((k === "e" || k === "E") && ctrl && e.shiftKey && targets().length) { e.preventDefault(); setExportIds(targets()); }
      else if (k === "Enter" && ctrl && flat.length) { e.preventDefault(); const list = selectionOrAll(); setSlideshow({ items: list, start: selecting ? 0 : Math.max(0, list.findIndex((i) => i.id === cursor)) }); }
      else if ((k === "p" || k === "P") && ctrl && flat.length) { e.preventDefault(); setPrinting(selectionOrAll()); }
      else if (ctrl) return;
      else if (k === "ArrowRight") move(flat[Math.min(flat.length - 1, at + 1)]?.id ?? flat[0]?.id);
      else if (k === "ArrowLeft") move(flat[Math.max(0, at - 1)]?.id ?? flat[0]?.id);
      else if (k === "ArrowDown") move(cursor === null ? flat[0]?.id : vertical(cursor, 1));
      else if (k === "ArrowUp") move(cursor === null ? flat[0]?.id : vertical(cursor, -1));
      else if (k === "Home") move(flat[0]?.id);
      else if (k === "End") move(flat[flat.length - 1]?.id);
      else if (k === " " && cursor !== null) { e.preventDefault(); toggle(cursor); }
      else if ((k === "e" || k === "E" || k === "Enter") && (cursor ?? flat[0]?.id) !== undefined) { e.preventDefault(); setLoupe(cursor ?? flat[0].id); }
      else if (/^[0-5]$/.test(k)) rate(targets(), Number(k));
      else if (LABEL_KEYS[k]) toggleLabel(targets(), LABEL_KEYS[k]);
      else if (k === "c" || k === "C") startCompare("compare");
      else if (k === "n" || k === "N") startCompare("survey");
      else if ((k === "s" || k === "S") && e.shiftKey) setViewOpts((v) => ({ ...v, stack: !v.stack }));
      else if ((k === "s" || k === "S") && focused && stacks.has(focused.id)) setOpenStacks((o) => { const x = new Set(o); x.has(focused.id) ? x.delete(focused.id) : x.add(focused.id); return x; });
      else if (k === "p" || k === "P") flag(targets(), 1);
      else if (k === "x" || k === "X") flag(targets(), -1);
      else if (k === "u" || k === "U") flag(targets(), 0);
      else if (k === "h" || k === "H") hide(targets());
      else if ((k === "f" || k === "F") && e.shiftKey && focused) showInFolder(focused);
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
        <h1 className="ellipsis">{coll ? coll.name : folderNode ? folderNode.name : "All photos"}</h1>
        <span className="sub ellipsis">
          {coll ? `${n(coll.count)} in this ${coll.rules ? "smart collection" : "collection"}` : folderNode
            ? `${n(folderNode.count)} in ${folderNode.depth === 0 ? "this source" : `${sources.find((s) => s.id === folderNode.source_id)?.name ?? "source"} › ${folderNode.path.split("/").join(" › ")}`}`
            : `${n(visible)} from ${sources.length} source${sources.length === 1 ? "" : "s"}`}
        </span>
        <label className="vh" htmlFor="library-search">Search</label>
        <input id="library-search" className="search" type="search" placeholder={smartReady ? "Search people, places, things or dates" : "Search names, places, tags or dates"} value={query}
          onChange={(e) => { setQuery(e.target.value); setSimilar(null); }} onKeyDown={(e) => e.key === "Escape" && (e.currentTarget.blur(), setQuery(""))} />
        <label className="vh" htmlFor="library-sort">Sort</label>
        <select id="library-sort" className="sort" value={sort} onChange={(e) => setViewOpts((v) => ({ ...v, sort: e.target.value as Sort }))} title="Sort">
          {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
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
          <button aria-label="Compare (C)" title="Compare (C)" onClick={() => startCompare("compare")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="1.5" /><rect x="13" y="5" width="8" height="14" rx="1.5" /></svg>
          </button>
          <button aria-label="Survey (N)" title="Survey (N)" onClick={() => startCompare("survey")}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="13" width="7" height="7" rx="1.5" /><rect x="14" y="13" width="7" height="7" rx="1.5" /><path d="M12 2v20" /></svg>
          </button>
        </div>
        <button className="btn small more-btn" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.right - 240, y: r.bottom + 6 }); }}>More…</button>
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
        <span className="chip-gap" />
        {LABELS.map((l) => (
          <button key={l} className={`label-chip ${labelFilter === l ? "on" : ""}`} aria-pressed={labelFilter === l} title={`${LABEL_NAMES[l]} label`} aria-label={`${LABEL_NAMES[l]} label`}
            onClick={() => setLabelFilter(labelFilter === l ? null : l)}><i className={`label-dot ${l}`} /></button>
        ))}
        <button className={`chip ${stack ? "on" : ""}`} aria-pressed={stack} title="Stack bursts (Shift S)" onClick={() => setViewOpts((v) => ({ ...v, stack: !v.stack }))}>Stack bursts</button>
      </div>
      {pinned && !similar && (
        <div className="similar-bar" role="status">
          <span>Showing {n(pinned.ids.length)} photo{pinned.ids.length === 1 ? "" : "s"} from {pinned.title} on the map</span>
          <button className="btn small" onClick={onClearPinned}>Back to all photos</button>
        </div>
      )}
      {similar && (
        <div className="similar-bar" role="status">
          <span>Showing {n(similar.items.length - 1)} photo{similar.items.length === 2 ? "" : "s"} that look like {fileName(similar.of.path)}</span>
          <button className="btn small" onClick={() => setSimilar(null)}>Back to all photos</button>
        </div>
      )}
      <div className={`lib-body ${showFolders ? "with-folders" : ""}`}>
      {showFolders && (
        <div className="lib-left">
          <FolderTree nodes={tree} sources={sources} selected={collection === null ? folder : null} onSelect={(f) => { setCollection(null); setFolder(f); setSelected(new Set()); setCursor(null); }} />
          <CollectionsPanel collections={collections} selected={collection}
            onSelect={(id) => { setCollection(id); setSelected(new Set()); setCursor(null); }}
            onNew={(smart) => setCollDialog({ smart })}
            onEdit={(c) => setCollDialog({ smart: !!c.rules, editing: c })}
            onDelete={async (c) => {
              if (!window.confirm(`Delete the collection "${c.name}"? The photos stay in your library.`)) return;
              try {
                await api.deleteCollection(c.id);
                if (collection === c.id) setCollection(null);
                say(`Deleted the collection ${c.name}. Its photos are still in the library.`);
                loadCollections();
              } catch (e) { onError(String(e)); }
            }} />
        </div>
      )}
      <div ref={gridRef} className={`grid ${selecting ? "selecting" : ""}`}>
        {visibleGroups.map((g) => (
          <section key={g.month} id={`m-${g.month}`}>
            <div className="mh">
              <b>{g.month === "similar" ? "Looks alike" : g.month === "sorted" ? SORTS.find((x) => x[0] === sort)![1] : monthLabel(g.month)}</b><span>{n(g.items.length)} items</span>
              <button className="link month-select" onClick={() => selectMonth(g)}>
                {g.items.every((i) => selected.has(i.id)) ? "Deselect month" : "Select month"}
              </button>
            </div>
            <div className="tiles">
              {g.items.map((i) => {
                const on = selected.has(i.id);
                const st = stacks.get(i.id);
                const inOpen = !st && openMembers.has(i.id);
                return (
                  <Thumb key={i.id} item={i} className={`${on ? "picked" : ""} ${cursor === i.id ? "cursor" : ""} ${i.flag === -1 ? "rejected" : ""} ${st ? (openStacks.has(i.id) ? "stack-open" : "stacked") : ""} ${inOpen ? "in-stack" : ""}`}
                    onClick={(e) => clickTile(i, e)}
                    onContextMenu={(e) => { e.preventDefault(); setCursor(i.id); setMenu({ item: i, x: e.clientX, y: e.clientY }); }}>
                    <span className={`tick ${on ? "on" : ""}`} title="Select" onClick={(e) => { e.stopPropagation(); setCursor(i.id); toggle(i.id, e); }}>{on ? "✓" : ""}</span>
                    <span className="hover-info">{dateTimeLabel(i.taken_at)}</span>
                    {i.has_exact_duplicate && <span className="dup">Copy</span>}
                    {i.edited && <span className="edited">Edited</span>}
                    {st && (
                      <button className="stack-count" title={openStacks.has(i.id) ? "Close stack (S)" : "Open stack (S)"}
                        onClick={(e) => { e.stopPropagation(); setOpenStacks((o) => { const x = new Set(o); x.has(i.id) ? x.delete(i.id) : x.add(i.id); return x; }); }}>
                        {openStacks.has(i.id) ? "‹" : ""}{n(st.length)}
                      </button>
                    )}
                    {i.versions > 0 && <span className="vcopies" title={`${n(i.versions + 1)} versions`}>{n(i.versions + 1)} versions</span>}
                    {(i.rating > 0 || i.flag !== 0 || i.label) && (
                      <span className="meta">
                        {i.label && <i className={`label-dot ${i.label}`} aria-label={`${LABEL_NAMES[i.label]} label`} />}
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
        {visibleGroups.length === 0 && <p className="muted">{(folder && folderGroups === null) || (collection !== null && collGroups === null) ? "Loading…" : coll && !coll.rules && groups.length === 0 ? "Nothing in this collection yet. Select photos, right-click and choose Add to collection." : "No matches."}{!smartReady && query.trim() && !folder ? " Turn on smart tagging in People & places to search by what's in a photo." : ""}</p>}
      </div>
      </div>
      {!selecting && (
        <nav className="scrub" aria-label="Years">
          {years.map((y) => (
            <a key={y} href={`#m-${groups.find((g) => g.month.startsWith(y))?.month}`}>{y}</a>
          ))}
        </nav>
      )}
      {menu && (
        <>
          <div className="menu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 200) }}>
            <button role="menuitem" onClick={() => { setMenu(null); showInFolder(menu.item); }}>Show in folder tree<kbd>Shift F</kbd></button>
            <button role="menuitem" onClick={() => { setMenu(null); showInExplorer(menu.item); }}>Show in Explorer<kbd>Ctrl R</kbd></button>
            <hr />
            <button role="menuitem" onClick={() => { setMenu(null); setLoupe(menu.item.id); }}>Open in loupe<kbd>E</kbd></button>
            {menu.item.kind === "photo" && <button role="menuitem" onClick={() => { setMenu(null); onEdit(menu.item.id); }}>Edit<kbd>Ctrl E</kbd></button>}
            {smartReady && <button role="menuitem" onClick={() => { setMenu(null); showSimilar(menu.item); }}>Find similar photos</button>}
            <hr />
            {copied && menu.item.kind === "photo" && (
              <button role="menuitem" onClick={() => { setMenu(null); pasteEdits(selected.has(menu.item.id) ? [...selected] : [menu.item.id]); }}>
                Paste settings{selected.has(menu.item.id) && selected.size > 1 ? ` to ${n(selected.size)}` : ""}<kbd>Ctrl Shift V</kbd>
              </button>
            )}
            <button role="menuitem" onClick={() => { setMenu(null); setExportIds(selected.has(menu.item.id) ? [...selected] : [menu.item.id]); }}>
              Export{selected.has(menu.item.id) && selected.size > 1 ? ` ${n(selected.size)}` : ""}…<kbd>Ctrl Shift E</kbd>
            </button>
            <hr />
            <div className="menu-labels" role="group" aria-label="Colour label">
              {LABELS.map((l, k) => (
                <button key={l} role="menuitem" className={menu.item.label === l ? "on" : ""} title={`${LABEL_NAMES[l]}${k < 4 ? ` (${k + 6})` : ""}`} aria-label={`${LABEL_NAMES[l]} label`}
                  onClick={() => { const ids = selected.has(menu.item.id) ? [...selected] : [menu.item.id]; setMenu(null); label(ids, menu.item.label === l ? null : l); }}>
                  <i className={`label-dot ${l}`} />
                </button>
              ))}
              {menu.item.label && <button role="menuitem" title="No label" onClick={() => { const ids = selected.has(menu.item.id) ? [...selected] : [menu.item.id]; setMenu(null); label(ids, null); }}>×</button>}
            </div>
            {collections.filter((c) => !c.rules).map((c) => (
              <button key={c.id} role="menuitem" onClick={() => { setMenu(null); addToCollection(c.id, selected.has(menu.item.id) ? [...selected] : [menu.item.id]); }}>Add to {c.name}</button>
            ))}
            <button role="menuitem" onClick={() => { setMenu(null); setShowFolders(true); setCollDialog({ smart: false, add: selected.has(menu.item.id) ? [...selected] : [menu.item.id] }); }}>New collection…</button>
            {coll && !coll.rules && <button role="menuitem" onClick={() => { setMenu(null); removeFromCollection(selected.has(menu.item.id) ? [...selected] : [menu.item.id]); }}>Remove from {coll.name}</button>}
            {stacks.has(menu.item.id) && <button role="menuitem" onClick={() => { setMenu(null); setOpenStacks((o) => { const x = new Set(o); x.has(menu.item.id) ? x.delete(menu.item.id) : x.add(menu.item.id); return x; }); }}>{openStacks.has(menu.item.id) ? "Close stack" : "Open stack"}<kbd>S</kbd></button>}
          </div>
        </>
      )}
      {more && (
        <>
          <div className="menu-scrim" onClick={() => setMore(null)} />
          <div className="menu" role="menu" style={{ left: Math.max(8, more.x), top: more.y }}>
            <button role="menuitem" onClick={() => { setMore(null); setSlideshow({ items: selectionOrAll(), start: 0 }); }}>Slideshow<kbd>Ctrl Enter</kbd></button>
            <button role="menuitem" onClick={() => { setMore(null); setPrinting(selectionOrAll()); }}>Print or make a book…<kbd>Ctrl P</kbd></button>
            <button role="menuitem" onClick={() => { setMore(null); setGallery(selectionOrAll().filter((i) => i.kind === "photo").map((i) => i.id)); }}>Make a web gallery…</button>
            <hr />
            <button role="menuitem" onClick={() => { setMore(null); xmp(true); }}>Save to XMP sidecars</button>
            <button role="menuitem" onClick={() => { setMore(null); xmp(false); }}>Read from XMP sidecars</button>
            <hr />
            <span className="menu-note">{selecting ? `Acts on the ${n(selected.size)} selected` : `Acts on all ${n(flat.length)} shown`}</span>
          </div>
        </>
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
          {copied && <button className="btn" title="Paste copied settings (Ctrl+Shift+V)" onClick={() => pasteEdits([...selected])}>Paste settings</button>}
          <button className="btn" title="Export (Ctrl+Shift+E)" onClick={() => setExportIds([...selected])}>Export…</button>
          {selected.size >= 2 && <button className="btn" title="Compare (C) or survey (N)" onClick={() => startCompare(selected.size === 2 ? "compare" : "survey")}>{selected.size === 2 ? "Compare · C" : "Survey · N"}</button>}
          {coll && !coll.rules && <button className="btn" onClick={() => removeFromCollection([...selected])}>Remove from collection</button>}
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
      {exportIds && <ExportDialog ids={exportIds} onClose={() => setExportIds(null)} onError={onError} />}
      {gallery && <WebGalleryDialog ids={gallery} onClose={() => setGallery(null)} onError={onError} />}
      {printing && <PrintDialog items={printing} onClose={() => setPrinting(null)} onError={onError} />}
      {slideshow && <Slideshow items={slideshow.items} start={slideshow.start} onClose={() => setSlideshow(null)} onError={onError} />}
      {collDialog && (
        <CollectionDialog smart={collDialog.smart} editing={collDialog.editing} onClose={() => setCollDialog(null)}
          onSave={async (name: string, rules: Rules | null) => {
            try {
              if (collDialog.editing) await api.updateCollection(collDialog.editing.id, name, rules);
              else {
                const id = await api.createCollection(name, rules);
                const add = collDialog.add ?? (selecting ? [...selected] : []);
                if (!rules && add.length) await api.addToCollection(id, add);
                setCollection(id);
              }
              await loadCollections();
            } catch (e) { onError(String(e)); throw e; }
          }} />
      )}
      {compare && (
        <Compare items={compare.ids.map((id) => flat.find((i) => i.id === id) ?? groups.flatMap((g) => g.items).find((i) => i.id === id)).filter((i): i is Item => !!i)}
          mode={compare.mode} onMode={(mode) => setCompare({ ...compare, mode })}
          onRate={(id, r) => rate([id], r)} onFlag={(id, f) => flag([id], f)} onLabel={(id, l) => label([id], l as Label | null)}
          onClose={(id) => { setCompare(null); if (id !== null) setCursor(id); }} />
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
          onLabel={(id, l) => label([id], l)}
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
          onShowInFolder={showInFolder}
          onShowInExplorer={showInExplorer}
        />
      )}
    </>
  );
}
