import { useEffect, useState } from "react";
import { api, fileName, fileUrl, isViewable, Item, LABEL_NAMES, thumbUrl } from "../api";
import { isTyping } from "../shortcuts";

/** The best picture the webview can show for an item: the original, or a cached JPEG. */
export function useBestSrc(item: Item | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!item) return setSrc(null);
    if (item.kind === "video" || isViewable(item)) return setSrc(fileUrl(item.path));
    setSrc(thumbUrl(item));
    let live = true;
    api.viewImage(item.id).then((p) => live && setSrc(fileUrl(p))).catch(() => {});
    return () => { live = false; };
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return src;
}

function Pane({ item, focused, onFocus, onRemove, tag }: { item: Item; focused: boolean; onFocus: () => void; onRemove?: () => void; tag?: string }) {
  const src = useBestSrc(item);
  return (
    <figure className={`cmp-pane ${focused ? "on" : ""} ${item.flag === -1 ? "rejected" : ""}`} onClick={onFocus}>
      {tag && <span className="cmp-tag">{tag}</span>}
      {onRemove && <button className="cmp-x" title="Take out of the survey" aria-label="Take out of the survey" onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>}
      <div className="cmp-img">
        {item.kind === "video" ? <video src={src ?? undefined} controls /> : src ? <img src={src} alt="" /> : null}
      </div>
      <figcaption>
        <span className="ellipsis">{fileName(item.path)}</span>
        {item.label && <i className={`label-dot ${item.label}`} title={LABEL_NAMES[item.label]} />}
        {item.flag === 1 && <span className="flag pick">Pick</span>}
        {item.flag === -1 && <span className="flag">Rejected</span>}
        <span className="stars">{item.rating > 0 ? "★".repeat(item.rating) : ""}</span>
      </figcaption>
    </figure>
  );
}

type Props = {
  /** The photos to choose between, in library order. */
  items: Item[];
  mode: "compare" | "survey";
  onMode: (m: "compare" | "survey") => void;
  onRate: (id: number, rating: number) => void;
  onFlag: (id: number, flag: number) => void;
  onLabel: (id: number, label: string | null) => void;
  onClose: (focused: number | null) => void;
};

/** Compare (C): two photos side by side. Survey (N): every chosen photo at once. */
export default function Compare({ items, mode, onMode, onRate, onFlag, onLabel, onClose }: Props) {
  const [pool, setPool] = useState(items.map((i) => i.id));
  // Keep the photos fresh as ratings change, and drop any that leave the library.
  const live = pool.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);
  const [select, setSelect] = useState(0);
  const [candidate, setCandidate] = useState(Math.min(1, items.length - 1));
  const [focus, setFocus] = useState(0);
  const shown = mode === "compare" ? [live[select], live[candidate]].filter(Boolean) as Item[] : live;
  const focusedItem = mode === "compare" ? shown[focus] : live[focus];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const id = focusedItem?.id;
      const count = live.length;
      if (k === "Escape" || k === "g" || k === "G") { e.preventDefault(); onClose(id ?? null); }
      else if (k === "c" || k === "C") onMode("compare");
      else if (k === "n" || k === "N") onMode("survey");
      else if (k === "ArrowRight" || k === "ArrowLeft") {
        e.preventDefault();
        const step = k === "ArrowRight" ? 1 : -1;
        if (mode === "compare") {
          if (count < 2) return;
          let c = candidate;
          do c = (c + step + count) % count; while (c === select);
          setCandidate(c);
          setFocus(1);
        } else setFocus((f) => (f + step + count) % count);
      }
      else if (mode === "compare" && (k === "ArrowUp" || k === "ArrowDown")) {
        // Make the candidate the new select, like Lightroom's "Make select".
        e.preventDefault();
        setSelect(candidate);
        setCandidate(select);
      }
      else if (id === undefined) return;
      else if (/^[0-5]$/.test(k)) onRate(id, Number(k));
      else if (/^[6-9]$/.test(k)) {
        const label = ["red", "yellow", "green", "blue"][Number(k) - 6];
        onLabel(id, focusedItem?.label === label ? null : label);
      }
      else if (k === "p" || k === "P") onFlag(id, 1);
      else if (k === "x" || k === "X") onFlag(id, -1);
      else if (k === "u" || k === "U") onFlag(id, 0);
      else if (k === "/" && mode === "survey") remove(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const remove = (id: number) => {
    const next = pool.filter((p) => p !== id);
    if (next.length === 0) return onClose(null);
    setPool(next);
    setFocus((f) => Math.min(f, next.length - 1));
    setSelect(0);
    setCandidate(Math.min(1, next.length - 1));
  };

  const cols = mode === "compare" ? 2 : Math.ceil(Math.sqrt(live.length * 1.6));
  return (
    <div className="compare" role="dialog" aria-label={mode === "compare" ? "Compare" : "Survey"}>
      <div className="cmp-top">
        <div className="seg" role="group" aria-label="Mode">
          <button className={mode === "compare" ? "on" : ""} onClick={() => onMode("compare")}>Compare · C</button>
          <button className={mode === "survey" ? "on" : ""} onClick={() => onMode("survey")}>Survey · N</button>
        </div>
        <span className="muted small">
          {mode === "compare"
            ? `${live.length} photos · ← → change the candidate · ↑ makes it the select · 0–5 rate · P pick · X reject`
            : `${live.length} photos · click to focus · / takes one out · 0–5 rate · P pick · X reject`}
        </span>
        <button className="btn" onClick={() => onClose(focusedItem?.id ?? null)}>Done · Esc</button>
      </div>
      <div className="cmp-grid" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))` }}>
        {shown.map((i, k) => (
          <Pane key={`${i.id}-${k}`} item={i} focused={(mode === "compare" ? focus : focus) === (mode === "compare" ? k : live.indexOf(i))}
            tag={mode === "compare" ? (k === 0 ? "Select" : "Candidate") : undefined}
            onFocus={() => setFocus(mode === "compare" ? k : live.indexOf(i))}
            onRemove={mode === "survey" ? () => remove(i.id) : undefined} />
        ))}
      </div>
    </div>
  );
}
