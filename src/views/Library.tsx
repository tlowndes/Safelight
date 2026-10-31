import { useMemo, useState } from "react";
import { dateTimeLabel, Item, monthLabel, MonthGroup, n, Stats } from "../api";
import Thumb from "../components/Thumb";

type Filter = "all" | "photo" | "video" | "dupes" | "edited";
type Props = { groups: MonthGroup[]; stats: Stats | null; sourceCount: number; onAddSources: () => void; onOpen: (id: number) => void };

export default function Library({ groups, stats, sourceCount, onAddSources, onOpen }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const keep = (i: Item) =>
      (filter === "all" ||
        (filter === "dupes" ? i.has_exact_duplicate : filter === "edited" ? i.edited : i.kind === filter)) &&
      (!q || i.path.toLowerCase().includes(q) || (i.taken_at ?? "").includes(q));
    return groups.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
  }, [groups, filter, query]);

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
      </div>
      <div className="grid">
        {shown.map((g) => (
          <section key={g.month} id={`m-${g.month}`}>
            <div className="mh"><b>{monthLabel(g.month)}</b><span>{g.items.length} items</span></div>
            <div className="tiles">
              {g.items.map((i) => (
                <Thumb key={i.id} item={i} onClick={i.kind === "photo" ? () => onOpen(i.id) : undefined}>
                  <span className="hover-info">{dateTimeLabel(i.taken_at)}</span>
                  {i.has_exact_duplicate && <span className="dup">Copy</span>}
                  {i.edited && <span className="edited">Edited</span>}
                </Thumb>
              ))}
            </div>
          </section>
        ))}
        {shown.length === 0 && <p className="muted">No matches.</p>}
      </div>
      <nav className="scrub">
        {years.map((y) => (
          <a key={y} href={`#m-${groups.find((g) => g.month.startsWith(y))?.month}`}>{y}</a>
        ))}
      </nav>
    </>
  );
}
