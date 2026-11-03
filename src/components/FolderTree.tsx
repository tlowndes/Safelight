import { useMemo, useState } from "react";
import { FolderNode, FolderRef, KIND_NAMES, n, Source } from "../api";

type Props = { nodes: FolderNode[]; sources: Source[]; selected: FolderRef | null; onSelect: (f: FolderRef | null) => void };

const key = (f: FolderRef) => `${f.source_id}:${f.path}`;
const parentKey = (f: FolderNode) => `${f.source_id}:${f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}`;

/** Every source and its folders, as they are on disk. Click a folder to see what's inside it. */
export default function FolderTree({ nodes, sources, selected, onSelect }: Props) {
  // Sources start open and folders start closed; this holds the ones the user has flipped.
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const hasChildren = useMemo(() => new Set(nodes.filter((f) => f.depth > 0).map(parentKey)), [nodes]);
  const byKey = useMemo(() => new Map(nodes.map((f) => [key(f), f])), [nodes]);
  const isOpen = (f: FolderNode) => (f.depth === 0) !== flipped.has(key(f));

  /** Shown when every folder above it is open. */
  const visible = (f: FolderNode) => {
    for (let p = f.depth > 0 ? byKey.get(parentKey(f)) : undefined; p; p = p.depth > 0 ? byKey.get(parentKey(p)) : undefined) {
      if (!isOpen(p)) return false;
    }
    return true;
  };
  const toggle = (f: FolderNode) => {
    const next = new Set(flipped);
    next.has(key(f)) ? next.delete(key(f)) : next.add(key(f));
    setFlipped(next);
  };
  const isOn = (f: FolderNode) => selected !== null && selected.source_id === f.source_id && selected.path === f.path;
  const kind = (id: number) => sources.find((s) => s.id === id)?.kind ?? "";

  return (
    <nav className="folders" aria-label="Folders">
      <div className="folders-head">Folders</div>
      <button className={`folder ${selected === null ? "on" : ""}`} onClick={() => onSelect(null)}>
        <span className="twisty" />
        <span className="ellipsis">All photos</span>
      </button>
      {nodes.filter(visible).map((f) => {
        const kids = hasChildren.has(key(f));
        const expanded = isOpen(f);
        return (
          <button key={key(f)} className={`folder ${isOn(f) ? "on" : ""} ${f.depth === 0 ? "root" : ""}`}
            style={{ paddingLeft: 6 + f.depth * 14 }} title={f.depth === 0 ? KIND_NAMES[kind(f.source_id)] : f.path}
            aria-expanded={kids ? expanded : undefined}
            onClick={() => { onSelect({ source_id: f.source_id, path: f.path }); if (kids && !expanded) toggle(f); }}>
            <span className={`twisty ${kids ? (expanded ? "open" : "") : "none"}`}
              onClick={(e) => { if (!kids) return; e.stopPropagation(); toggle(f); }} aria-hidden="true">
              {kids && <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>}
            </span>
            {f.depth === 0
              ? <span className="mono">{f.name.trim().charAt(0).toUpperCase() || "?"}</span>
              : <svg className="ficon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z" /></svg>}
            <span className="ellipsis">{f.name}</span>
            <small>{n(f.count)}</small>
          </button>
        );
      })}
    </nav>
  );
}
