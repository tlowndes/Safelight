import Updater from "./Updater";
import { formatBytes, n, Progress, Source, Stats } from "../api";

export type View = "library" | "duplicates" | "organise" | "cleanup" | "reference" | "edit" | "sources";

const icons: Record<string, JSX.Element> = {
  library: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  duplicates: <><rect x="2" y="4" width="8" height="10" rx="1.5" /><path d="M6 2h7a1 1 0 0 1 1 1v9" /></>,
  organise: <path d="M2 4h4l1.5 1.5H14V13H2z" />,
  cleanup: <><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5" /></>,
  reference: <path d="M3 2h10v12l-5-3-5 3z" />,
  edit: <><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></>,
};

type Props = { view: View; onView: (v: View) => void; sources: Source[]; stats: Stats | null; thumbs: Progress | null };

export default function Sidebar({ view, onView, sources, stats, thumbs }: Props) {
  const nav = (key: View, label: string, badge?: string | number) => (
    <button className={`nav ${view === key ? "on" : ""}`} onClick={() => onView(key)}>
      <svg viewBox="0 0 16 16">{icons[key]}</svg>
      {label}
      {badge !== undefined && badge !== 0 && badge !== "0" && <span className="badge">{badge}</span>}
    </button>
  );
  return (
    <aside className="side">
      <div className="logo"><i />Safelight</div>
      {nav("library", "Library")}
      {nav("duplicates", "Duplicates")}
      {nav("organise", "Organise")}
      {nav("cleanup", "Clean-up")}
      {nav("reference", "Reference", stats ? n(stats.reference) : undefined)}
      {nav("edit", "Edit")}

      <div className="sect">Sources</div>
      {sources.map((s) => (
        <div className="src" key={s.id} title={s.root}>
          <span className={`dot ${s.last_scanned ? "" : "pending"}`} />
          {s.name}
          <small>{n(s.item_count)}</small>
        </div>
      ))}
      <button className={`src add ${view === "sources" ? "on" : ""}`} onClick={() => onView("sources")}>+ Manage sources</button>

      {stats && (
        <>
          <div className="sect">Catalogue</div>
          <div className="src">Photos<small>{n(stats.photos)}</small></div>
          <div className="src">Videos<small>{n(stats.videos)}</small></div>
          <div className="store">
            {thumbs ? (
              <>
                <b>Making previews</b>
                <div className="bar"><b style={{ width: `${(thumbs.done / thumbs.total) * 100}%` }} /></div>
                <p>{n(thumbs.done)} of {n(thumbs.total)}</p>
              </>
            ) : (
              <p>{formatBytes(stats.total_bytes)} across {sources.length} source{sources.length === 1 ? "" : "s"}.</p>
            )}
          </div>
        </>
      )}
      <Updater />
    </aside>
  );
}
