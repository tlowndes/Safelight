import { useEffect, useMemo, useRef, useState } from "react";
import { api, dateTimeLabel, formatBytes, Item, monthLabel, MonthGroup, n, Stats } from "../api";
import Thumb from "../components/Thumb";
import DeleteDialog from "../components/DeleteDialog";

type Filter = "all" | "photo" | "video" | "dupes" | "edited";
type Props = {
  groups: MonthGroup[];
  stats: Stats | null;
  sourceCount: number;
  onAddSources: () => void;
  onOpen: (id: number) => void;
  onChanged: () => void;
  onError: (e: string) => void;
};

export default function Library({ groups, stats, sourceCount, onAddSources, onOpen, onChanged, onError }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const anchor = useRef<number | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const keep = (i: Item) =>
      (filter === "all" ||
        (filter === "dupes" ? i.has_exact_duplicate : filter === "edited" ? i.edited : i.kind === filter)) &&
      (!q || i.path.toLowerCase().includes(q) || (i.taken_at ?? "").includes(q));
    return groups.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
  }, [groups, filter, query]);
  const flat = useMemo(() => shown.flatMap((g) => g.items), [shown]);

  // Drop selections that are no longer in the library.
  useEffect(() => {
    const ids = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
    setSelected((s) => new Set([...s].filter((id) => ids.has(id))));
  }, [groups]);

  const selecting = selected.size > 0;
  const selectedBytes = useMemo(() => flat.filter((i) => selected.has(i.id)).reduce((a, i) => a + i.size, 0), [flat, selected]);

  const toggle = (id: number, e?: React.MouseEvent) => {
    const next = new Set(selected);
    if (e?.shiftKey && anchor.current !== null) {
      const a = flat.findIndex((i) => i.id === anchor.current);
      const b = flat.findIndex((i) => i.id === id);
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
    if (selecting || e.shiftKey || e.ctrlKey || e.metaKey) return toggle(i.id, e);
    if (i.kind === "photo") onOpen(i.id);
  };

  const selectMonth = (g: MonthGroup) => {
    const all = g.items.every((i) => selected.has(i.id));
    const next = new Set(selected);
    g.items.forEach((i) => (all ? next.delete(i.id) : next.add(i.id)));
    setSelected(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || confirming) return;
      if (e.key === "Escape") setSelected(new Set());
      if ((e.key === "Delete" || e.key === "Backspace") && selecting) setConfirming(true);
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSelected(new Set(flat.map((i) => i.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const total = (stats?.photos ?? 0) + (stats?.videos ?? 0);
  const years = [...new Set(groups.map((g) => g.month.slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))];

  if (total === 0) {
    return (
      <div className="empty">
        <h2>Nothing here yet</h2>
        <p>Add Proton Drive, Google Drive, a Google Photos Takeout folder or your NAS, and Safelight will gather everything into one timeline. Nothing is moved or deleted.</p>
        <button className="btn pri" onClick={onAddSources}>Add sources</button>
      </div>
    );
  }

  const chip = (k: Filter, label: string) => (
    <button className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{label}</button>
  );

  return (
    <>
      <div className="top">
        <h1>Library</h1>
        <span className="sub">{n(total)} photos and videos from {sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
        <input className="search" placeholder="Search file names or dates, e.g. 2024-06" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="chips">
        {chip("all", "All")}
        {chip("photo", "Photos")}
        {chip("video", "Videos")}
        {chip("edited", "Edited")}
        {chip("dupes", `Exact copies · ${n(stats?.exact_duplicate_files ?? 0)}`)}
        {notice && <span className="muted small notice" onClick={() => setNotice("")}>{notice}</span>}
      </div>
      <div className={`grid ${selecting ? "selecting" : ""}`}>
        {shown.map((g) => (
          <section key={g.month} id={`m-${g.month}`}>
            <div className="mh">
              <b>{monthLabel(g.month)}</b><span>{g.items.length} items</span>
              <button className="link month-select" onClick={() => selectMonth(g)}>
                {g.items.every((i) => selected.has(i.id)) ? "Deselect month" : "Select month"}
              </button>
            </div>
            <div className="tiles">
              {g.items.map((i) => {
                const on = selected.has(i.id);
                return (
                  <Thumb key={i.id} item={i} className={on ? "picked" : ""} onClick={(e) => clickTile(i, e)}>
                    <span className={`tick ${on ? "on" : ""}`} title="Select" onClick={(e) => { e.stopPropagation(); toggle(i.id, e); }}>{on ? "✓" : ""}</span>
                    <span className="hover-info">{dateTimeLabel(i.taken_at)}</span>
                    {i.has_exact_duplicate && <span className="dup">Copy</span>}
                    {i.edited && <span className="edited">Edited</span>}
                  </Thumb>
                );
              })}
            </div>
          </section>
        ))}
        {shown.length === 0 && <p className="muted">No matches.</p>}
      </div>
      {!selecting && (
        <nav className="scrub">
          {years.map((y) => (
            <a key={y} href={`#m-${groups.find((g) => g.month.startsWith(y))?.month}`}>{y}</a>
          ))}
        </nav>
      )}
      {selecting && (
        <div className="select-bar">
          <b>{n(selected.size)} selected</b>
          <span className="muted">{formatBytes(selectedBytes)} · Shift-click to select a range</span>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setSelected(new Set(flat.map((i) => i.id)))}>Select all {n(flat.length)}</button>
          <button className="btn" onClick={() => setSelected(new Set())}>Clear (Esc)</button>
          <button className="btn" onClick={async () => {
            const ids = [...selected];
            try {
              await api.setReference(ids, true);
              setSelected(new Set());
              setNotice(`Moved ${n(ids.length)} to Reference › To sort`);
              onChanged();
            } catch (e) { onError(String(e)); }
          }}>Move to Reference</button>
          <button className="btn danger" onClick={() => setConfirming(true)}>Delete {n(selected.size)}…</button>
        </div>
      )}
      {confirming && (
        <DeleteDialog
          ids={[...selected]}
          onClose={() => setConfirming(false)}
          onError={onError}
          onDone={(r) => {
            setSelected(new Set());
            setNotice(`Binned ${n(r.photos)} photo${r.photos === 1 ? "" : "s"} (${n(r.files)} files, ${formatBytes(r.freed_bytes)})`);
            onChanged();
          }}
        />
      )}
    </>
  );
}
