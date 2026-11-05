import { useEffect, useRef, useState } from "react";
import { api, fileName, fileUrl, Item } from "../api";

type Props = { items: Item[]; start?: number; onClose: () => void; onError: (e: string) => void };

const SECONDS = [3, 4, 6, 10];

/** Full-screen slideshow of photos with their edits, cross-fading from one to the next. */
export default function Slideshow({ items, start = 0, onClose, onError }: Props) {
  const photos = items.filter((i) => i.kind === "photo");
  const [at, setAt] = useState(Math.min(start, Math.max(0, photos.length - 1)));
  const [playing, setPlaying] = useState(true);
  const [secs, setSecs] = useState(4);
  const [chrome, setChrome] = useState(true);
  /** Rendered JPEGs by item id: edits applied, sized for the screen. */
  const [rendered, setRendered] = useState<Record<number, string>>({});
  const asked = useRef(new Set<number>());
  const [shown, setShown] = useState<{ a: string | null; b: string | null; front: "a" | "b" }>({ a: null, b: null, front: "a" });

  // Render the current photo and the next two ahead of time.
  useEffect(() => {
    for (const k of [at, at + 1, at + 2]) {
      const p = photos[k % Math.max(1, photos.length)];
      if (!p || asked.current.has(p.id)) continue;
      asked.current.add(p.id);
      api.renderForPrint([p.id], 2560)
        .then(([path]) => setRendered((r) => ({ ...r, [p.id]: fileUrl(path) })))
        .catch((e) => onError(String(e)));
    }
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-fade: load the next picture into the hidden layer, then flip which layer is in front.
  const current = photos[at] ? rendered[photos[at].id] : undefined;
  useEffect(() => {
    if (!current) return;
    setShown((s) => {
      const back = s.front === "a" ? "b" : "a";
      if (s[s.front] === current) return s;
      return { ...s, [back]: current, front: back };
    });
  }, [current]);

  // Advance once the current photo is on screen.
  useEffect(() => {
    if (!playing || !current || photos.length < 2) return;
    const t = setTimeout(() => setAt((a) => (a + 1) % photos.length), secs * 1000);
    return () => clearTimeout(t);
  }, [playing, current, secs, at, photos.length]);

  // Hide the controls when the mouse is still.
  useEffect(() => {
    if (!chrome) return;
    const t = setTimeout(() => setChrome(false), 2500);
    return () => clearTimeout(t);
  }, [chrome, at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); setChrome(true); }
      else if (e.key === "ArrowRight") setAt((a) => (a + 1) % photos.length);
      else if (e.key === "ArrowLeft") setAt((a) => (a - 1 + photos.length) % photos.length);
    };
    window.addEventListener("keydown", onKey);
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [photos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!photos.length) return null;
  return (
    <div className={`slideshow ${chrome ? "" : "still"}`} onMouseMove={() => setChrome(true)} role="dialog" aria-label="Slideshow">
      {(["a", "b"] as const).map((l) => shown[l] && <img key={l} src={shown[l]!} alt="" className={shown.front === l ? "front" : ""} />)}
      {!current && <span className="ss-wait">Preparing {fileName(photos[at].path)}…</span>}
      <div className="ss-bar">
        <button className="btn small" onClick={() => setAt((a) => (a - 1 + photos.length) % photos.length)} aria-label="Previous">‹</button>
        <button className="btn small" onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
        <button className="btn small" onClick={() => setAt((a) => (a + 1) % photos.length)} aria-label="Next">›</button>
        <span>{at + 1} of {photos.length}</span>
        <label className="row" style={{ gap: 6 }}>
          Each photo
          <select value={secs} onChange={(e) => setSecs(Number(e.target.value))}>
            {SECONDS.map((s) => <option key={s} value={s}>{s} s</option>)}
          </select>
        </label>
        <button className="btn small" onClick={onClose}>Close · Esc</button>
      </div>
    </div>
  );
}
