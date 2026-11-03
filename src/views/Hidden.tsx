import { useCallback, useEffect, useState } from "react";
import { api, dateTimeLabel, Item, n } from "../api";
import Thumb from "../components/Thumb";

/** Photos the user hid from the library. Nothing here was moved or deleted. */
export default function Hidden({ onChanged, onError }: { onChanged: () => void; onError: (e: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(() => api.hiddenItems().then(setItems).catch((e) => onError(String(e))), [onError]);
  useEffect(() => { load(); }, [load]);

  const unhide = async (ids: number[]) => {
    try {
      await api.setHidden(ids, false);
      setSelected(new Set());
      await load();
      onChanged();
    } catch (e) { onError(String(e)); }
  };
  const toggle = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  return (
    <>
      <div className="top">
        <h1>Hidden</h1>
        <span className="sub">Kept on disk, left out of the library, duplicates and organising</span>
      </div>
      {items && items.length === 0 && (
        <div className="empty">
          <h2>Nothing hidden</h2>
          <p>Press H on a photo, or select some and choose Hide, to keep them out of your library. Their files stay exactly where they are.</p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className={`grid ${selected.size ? "selecting" : ""}`}>
          <div className="tiles" style={{ marginTop: 6 }}>
            {items.map((i) => {
              const on = selected.has(i.id);
              return (
                <Thumb key={i.id} item={i} className={on ? "picked" : ""} onClick={() => toggle(i.id)}>
                  <span className={`tick ${on ? "on" : ""}`}>{on ? "✓" : ""}</span>
                  <span className="hover-info">{dateTimeLabel(i.taken_at)}</span>
                </Thumb>
              );
            })}
          </div>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="select-bar">
          <b>{selected.size ? `${n(selected.size)} selected` : `${n(items.length)} hidden`}</b>
          {selected.size > 0 && <button className="btn" onClick={() => setSelected(new Set())}>Clear</button>}
          <button className="btn" onClick={() => setSelected(new Set(items.map((i) => i.id)))}>Select all</button>
          <button className="btn pri" disabled={!selected.size} onClick={() => unhide([...selected])}>Show in library</button>
        </div>
      )}
    </>
  );
}
