import Updater from "./Updater";
import { formatBytes, n, Progress, Source, Stats } from "../api";

export type View = "library" | "hidden" | "duplicates" | "organise" | "cleanup" | "reference" | "edit" | "sources";

const icons: Record<string, JSX.Element> = {
  library: <path d="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" />,
  hidden: <path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3 4.1M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.8 9.8 0 0 0 4.4-1" />,
  duplicates: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  organise: <path d="M3 6h6l2 2h10v11H3z" />,
  cleanup: <path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14" />,
  reference: <path d="M6 3h12v18l-6-4-6 4z" />,
  edit: <><circle cx="12" cy="12" r="3" /><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /></>,
};

/** The Safelight mark: a graphite lens with an amber glow at its centre. */
export function Logo() {
  return (
    <svg viewBox="0 0 220 220" aria-hidden="true">
      <defs>
        <linearGradient id="sl-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2C2C31" /><stop offset="1" stopColor="#0C0C0E" /></linearGradient>
        <radialGradient id="sl-core" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stopColor="#FFE7B8" /><stop offset="0.45" stopColor="#FFB547" /><stop offset="1" stopColor="#D9730D" /></radialGradient>
      </defs>
      <rect width="220" height="220" rx="50" fill="url(#sl-bg)" />
      <circle cx="110" cy="110" r="74" fill="#2E2E34" />
      <circle cx="110" cy="110" r="62" fill="#101012" />
      <circle cx="110" cy="110" r="28" fill="url(#sl-core)" />
    </svg>
  );
}

type Props = { view: View; onView: (v: View) => void; sources: Source[]; stats: Stats | null; thumbs: Progress | null; onShortcuts: () => void };

export default function Sidebar({ view, onView, sources, stats, thumbs, onShortcuts }: Props) {
  const nav = (key: View, label: string, badge?: string | number, attn = false) => (
    <button className={`nav ${view === key ? "on" : ""}`} aria-current={view === key ? "page" : undefined} onClick={() => onView(key)}>
      <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[key]}</svg>
      {label}
      {badge !== undefined && badge !== 0 && badge !== "0" && <span className={`badge ${attn ? "attn" : ""}`}>{badge}</span>}
    </button>
  );
  const shown = stats ? stats.photos + stats.videos - stats.hidden : undefined;
  return (
    <aside className="side" aria-label="Sidebar">
      <div className="logo"><Logo />Safelight</div>
      {nav("library", "All photos", shown !== undefined ? n(shown) : undefined)}
      {nav("hidden", "Hidden", stats ? n(stats.hidden) : undefined)}
      {nav("reference", "Reference", stats ? n(stats.reference) : undefined)}
      {nav("edit", "Edit")}

      <div className="sect">Needs a look</div>
      {nav("duplicates", "Duplicates", stats ? n(stats.exact_duplicate_files) : undefined, true)}
      {nav("organise", "Organise")}
      {nav("cleanup", "Clean-up")}

      <div className="sect">Sources</div>
      {sources.map((s) => (
        <div className="src" key={s.id} title={s.root}>
          <span className="mono">{s.name.trim().charAt(0).toUpperCase() || "?"}</span>
          <span className="ellipsis">{s.name}</span>
          <small>{s.last_scanned ? n(s.item_count) : "Not scanned"}</small>
        </div>
      ))}
      <button className={`src add ${view === "sources" ? "on" : ""}`} onClick={() => onView("sources")}>+ Manage sources</button>

      {stats && (
        <div className="store">
          {thumbs ? (
            <>
              <b>Making previews</b>
              <div className="bar"><b style={{ width: `${(thumbs.done / thumbs.total) * 100}%` }} /></div>
              <p>{n(thumbs.done)} of {n(thumbs.total)}</p>
            </>
          ) : (
            <p>{n(stats.photos)} photos and {n(stats.videos)} videos · {formatBytes(stats.total_bytes)} across {sources.length} source{sources.length === 1 ? "" : "s"}.</p>
          )}
        </div>
      )}
      <div className="private">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        <div><b>Private by design</b><span>No account, no uploads. The catalogue lives on this PC.</span></div>
      </div>
      <button className="src add" onClick={onShortcuts}>Keyboard shortcuts <small><kbd>?</kbd></small></button>
      <Updater />
    </aside>
  );
}
