import { useState } from "react";
import { Collection, Label, LABEL_NAMES, LABELS, Rules } from "../api";

type Props = {
  /** Editing an existing smart collection, or making a new one. */
  editing?: Collection;
  smart: boolean;
  onSave: (name: string, rules: Rules | null) => Promise<void>;
  onClose: () => void;
};

/** Name a collection and, for a smart one, choose what it holds. */
export default function CollectionDialog({ editing, smart, onSave, onClose }: Props) {
  const [name, setName] = useState(editing?.name ?? "");
  const [r, setR] = useState<Rules>(editing?.rules ?? {});
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Rules>) => setR((v) => ({ ...v, ...p }));
  const chip = (on: boolean, label: string, click: () => void) => (
    <button className={`chip small ${on ? "on" : ""}`} aria-pressed={on} onClick={click}>{label}</button>
  );
  const save = async () => {
    setBusy(true);
    try { await onSave(name, smart ? r : null); onClose(); } finally { setBusy(false); }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal export" role="dialog" aria-label="Collection" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && name.trim()) save(); }}>
        <div className="eyebrow">{smart ? "Smart collection" : "Collection"}</div>
        <h2>{editing ? `Edit ${editing.name}` : smart ? "New smart collection" : "New collection"}</h2>
        <input className="text-input" autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        {smart && (
          <>
            <p className="muted small">Holds every photo that matches all of these, and keeps up as you rate and label.</p>
            <div className="ex-field">
              <div className="label">Stars at least</div>
              <div className="row start wrap">
                {chip(!r.min_rating, "Any", () => set({ min_rating: null }))}
                {[1, 2, 3, 4, 5].map((k) => chip(r.min_rating === k, "★".repeat(k), () => set({ min_rating: k })))}
              </div>
            </div>
            <div className="ex-field">
              <div className="label">Flag</div>
              <div className="row start wrap">
                {chip(r.flag == null, "Any", () => set({ flag: null }))}
                {chip(r.flag === 1, "Picks", () => set({ flag: 1 }))}
                {chip(r.flag === 0, "Unflagged", () => set({ flag: 0 }))}
                {chip(r.flag === -1, "Rejected", () => set({ flag: -1 }))}
              </div>
            </div>
            <div className="ex-field">
              <div className="label">Colour label</div>
              <div className="row start wrap">
                {chip(!r.label, "Any", () => set({ label: null }))}
                {LABELS.map((l: Label) => (
                  <button key={l} className={`chip small ${r.label === l ? "on" : ""}`} aria-pressed={r.label === l} onClick={() => set({ label: l })}>
                    <span className={`label-dot ${l}`} />{LABEL_NAMES[l]}
                  </button>
                ))}
              </div>
            </div>
            <div className="ex-field">
              <div className="label">Kind and edits</div>
              <div className="row start wrap">
                {chip(!r.kind, "Photos and videos", () => set({ kind: null }))}
                {chip(r.kind === "photo", "Photos", () => set({ kind: "photo" }))}
                {chip(r.kind === "video", "Videos", () => set({ kind: "video" }))}
                <span style={{ width: 8 }} />
                {chip(r.edited == null, "Edited or not", () => set({ edited: null }))}
                {chip(r.edited === true, "Edited", () => set({ edited: true }))}
                {chip(r.edited === false, "Not edited", () => set({ edited: false }))}
              </div>
            </div>
            <div className="row start" style={{ gap: 10 }}>
              <label className="ex-field" style={{ flex: 1 }}><span className="label">From year</span>
                <input className="text-input" inputMode="numeric" placeholder="Any" value={r.year_from ?? ""} onChange={(e) => set({ year_from: e.target.value ? Number(e.target.value) || null : null })} /></label>
              <label className="ex-field" style={{ flex: 1 }}><span className="label">To year</span>
                <input className="text-input" inputMode="numeric" placeholder="Any" value={r.year_to ?? ""} onChange={(e) => set({ year_to: e.target.value ? Number(e.target.value) || null : null })} /></label>
            </div>
            <label className="ex-field"><span className="label">Words in the file path</span>
              <input className="text-input" placeholder="e.g. Lisbon or wedding" value={r.text ?? ""} onChange={(e) => set({ text: e.target.value || null })} /></label>
          </>
        )}
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={busy || !name.trim()} onClick={save}>{editing ? "Save" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}
