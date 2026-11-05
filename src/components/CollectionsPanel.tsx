import { Collection, n } from "../api";

type Props = {
  collections: Collection[];
  selected: number | null;
  onSelect: (id: number | null) => void;
  onNew: (smart: boolean) => void;
  onEdit: (c: Collection) => void;
  onDelete: (c: Collection) => void;
};

/** Collections under the folder tree: plain ones you fill, smart ones that fill themselves. */
export default function CollectionsPanel({ collections, selected, onSelect, onNew, onEdit, onDelete }: Props) {
  return (
    <div className="collections">
      <div className="folders-head row">
        <span>Collections</span>
        <span className="row" style={{ gap: 2 }}>
          <button className="icon-btn" title="New collection" aria-label="New collection" onClick={() => onNew(false)}>+</button>
          <button className="icon-btn" title="New smart collection" aria-label="New smart collection" onClick={() => onNew(true)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4z" /></svg>
          </button>
        </span>
      </div>
      {collections.length === 0 && <p className="muted small" style={{ padding: "0 6px 8px" }}>Group photos without moving them. Smart ones fill themselves from rules.</p>}
      {collections.map((c) => (
        <div key={c.id} className={`folder coll ${selected === c.id ? "on" : ""}`} role="button" tabIndex={0}
          onClick={() => onSelect(selected === c.id ? null : c.id)} onKeyDown={(e) => e.key === "Enter" && onSelect(c.id)}>
          <span className="twisty none" />
          {c.rules
            ? <svg className="ficon" viewBox="0 0 24 24" aria-label="Smart collection"><path d="M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4z" /></svg>
            : <svg className="ficon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16" /></svg>}
          <span className="ellipsis">{c.name}</span>
          <small>{n(c.count)}</small>
          <span className="coll-tools">
            {c.rules && <button title="Edit rules" aria-label={`Edit ${c.name}`} onClick={(e) => { e.stopPropagation(); onEdit(c); }}>✎</button>}
            <button title="Delete collection (photos stay)" aria-label={`Delete ${c.name}`} onClick={(e) => { e.stopPropagation(); onDelete(c); }}>×</button>
          </span>
        </div>
      ))}
    </div>
  );
}
