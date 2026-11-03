import { useEffect, useMemo, useRef, useState } from "react";
import { SHORTCUTS } from "../shortcuts";

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "?" && !q)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, q]);

  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return SHORTCUTS;
    return SHORTCUTS.map((g) => ({
      ...g,
      items: g.items.filter((s) => `${g.name} ${s.does} ${s.keys.join(" ")} ${s.where ?? ""}`.toLowerCase().includes(t)),
    })).filter((g) => g.items.length);
  }, [q]);

  return (
    <div className="keys-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="keys-head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <label className="vh" htmlFor="keys-find">Find a shortcut</label>
          <input id="keys-find" ref={input} type="search" placeholder="Find a shortcut, e.g. zoom" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="keys-hint">Press <kbd>?</kbd> anywhere · <kbd>Esc</kbd> to close</span>
        </div>
        <div className="keys-body">
          {groups.map((g) => (
            <section key={g.name}>
              <h2>{g.name}</h2>
              {g.items.map((s, i) => (
                <div className="keys-row" key={i}>
                  <span>{s.does}{s.where && <small className="muted"> · {s.where}</small>}</span>
                  <div className="combo">
                    {s.keys.map((k, j) => (k === "/" ? <span key={j}>/</span> : <kbd key={j}>{k}</kbd>))}
                  </div>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <p className="muted">No shortcut matches “{q}”.</p>}
        </div>
      </div>
    </div>
  );
}
