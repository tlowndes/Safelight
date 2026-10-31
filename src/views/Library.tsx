import { useMemo, useState } from "react";
import { fileExt, Item, monthLabel, MonthGroup, previewUrl, Stats } from "../api";

type Filter = "all" | "photo" | "video" | "dupes";
type Props = { groups: MonthGroup[]; stats: Stats | null; sourceCount: number; onAddSources: () => void };

export default function Library({ groups, stats, sourceCount, onAddSources }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((i) =>
          (filter === "all" || (filter === "dupes" ? i.has_exact_duplicate : i.kind === filter)) &&
          (!q || i.path.toLowerCase().includes(q) || (i.taken_at ?? "").includes(q)),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, filter, query]);

  const total = (stats?.photos ?? 0) + (stats?.videos ?? 0);
  const years = [...new Set(groups.map((g) => g.month.slice(0, 4)).filter((y) => y !== "unda"))];

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
        <span className="sub">{total.toLocaleString("en-GB")} photos and videos from {sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
        <input className="search" placeholder="Search file names or dates, e.g. 2024-06" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="chips">
        {chip("all", "All")}
        {chip("photo", "Photos")}
        {chip("video", "Videos")}
        {chip("dupes", `Exact duplicates · ${(stats?.exact_duplicate_files ?? 0).toLocaleString("en-GB")}`)}
      </div>
      <div className="grid">
        {shown.map((g) => (
          <section key={g.month} id={`m-${g.month}`}>
            <div className="mh"><b>{monthLabel(g.month)}</b><span>{g.items.length} items</span></div>
            <div className="tiles">{g.items.map((i) => <Tile key={i.id} item={i} />)}</div>
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

function Tile({ item }: { item: Item }) {
  const url = previewUrl(item);
  const title = `${item.path}\n${item.taken_at ?? "No date"}${item.date_source ? ` (from ${item.date_source})` : ""}`;
  return (
    <div className="ph" title={title}>
      {url ? <img src={url} loading="lazy" alt="" /> : <span className="fmt">{fileExt(item.path)}</span>}
      {item.kind === "video" && <span className="vid">▶</span>}
      {item.has_exact_duplicate && <span className="dup">Duplicate</span>}
    </div>
  );
}
