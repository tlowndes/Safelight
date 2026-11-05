import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, dateTimeLabel, fileExt, fileName, fileUrl, formatBytes, isViewable, Item, ItemSmart, n, thumbUrl } from "../api";
import { isTyping } from "../shortcuts";

type Props = {
  items: Item[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onEdit: (id: number) => void;
  onRate: (id: number, rating: number) => void;
  onFlag: (id: number, flag: number) => void;
  onHide: (id: number) => void;
  onDelete: (id: number) => void;
  /** A dialog is open on top: leave the keys to it. */
  paused?: boolean;
  sourceName: (id: number) => string;
  /** Show photos that look like this one (when smart tagging is on). */
  onSimilar?: (item: Item) => void;
  /** Search the library for a person, place or tag. */
  onSearch?: (q: string) => void;
  /** Close the viewer and open the folder tree at this photo's folder. */
  onShowInFolder: (item: Item) => void;
  /** Open Windows Explorer with the file selected. */
  onShowInExplorer: (item: Item) => void;
};

/** Scale and top-left offset of the picture inside the stage. `fit` = scaled to fit. */
type View = { s: number; x: number; y: number; fit: boolean };

const MAX_ZOOM = 8;
const DATE_FROM: Record<string, string> = { exif: "from camera data", takeout: "from Google Takeout", filename: "from the file name", mtime: "from the file's modified time" };

export default function Loupe({ items, index, onIndex, onClose, onEdit, onRate, onFlag, onHide, onDelete, paused, sourceName, onSimilar, onSearch, onShowInFolder, onShowInExplorer }: Props) {
  const item = items[index];
  const stage = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLImageElement & HTMLVideoElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0, fit: true });
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState(true);
  const [chrome, setChrome] = useState(true);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const wheel = useRef({ acc: 0, last: 0 });
  const [smart, setSmart] = useState<ItemSmart | null>(null);

  useEffect(() => {
    if (!item) return;
    let live = true;
    setSmart(null);
    api.itemSmart(item.id).then((s) => live && setSmart(s)).catch(() => {});
    return () => { live = false; };
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick the best picture: the original when the webview can show it, otherwise a cached
  // full-screen JPEG made by the Rust side (HEIC, RAW, TIFF). Show the thumbnail meanwhile.
  useEffect(() => {
    if (!item) return;
    setNatural(null);
    setFailed(false);
    setView((v) => ({ ...v, fit: true }));
    if (item.kind === "video" || isViewable(item)) {
      setSrc(fileUrl(item.path));
      return;
    }
    setSrc(thumbUrl(item));
    let live = true;
    api.viewImage(item.id).then((p) => live && setSrc(fileUrl(p))).catch(() => live && !item.thumb && setFailed(true));
    return () => { live = false; };
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = () => {
    const r = stage.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1, left: r?.left ?? 0, top: r?.top ?? 0 };
  };
  const fitView = useCallback((): View => {
    if (!natural) return { s: 1, x: 0, y: 0, fit: true };
    const { w, h } = box();
    const s = Math.min(w / natural.w, h / natural.h, 1);
    return { s, x: (w - natural.w * s) / 2, y: (h - natural.h * s) / 2, fit: true };
  }, [natural]);

  /** Keep the picture centred on an axis where it's smaller than the stage, and stop it
   * being dragged off the edge where it's bigger. */
  const clamp = useCallback((v: View): View => {
    if (!natural) return v;
    const { w, h } = box();
    const iw = natural.w * v.s, ih = natural.h * v.s;
    const x = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, v.x));
    const y = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, v.y));
    return { ...v, x, y };
  }, [natural]);

  /** Zoom to scale `s`, keeping the point under (px, py) still. */
  const zoomTo = useCallback((s: number, px?: number, py?: number) => {
    setView((v) => {
      const fit = fitView();
      const cur = v.fit ? fit : v;
      const target = Math.min(MAX_ZOOM, s);
      if (target <= fit.s + 1e-4) return fit;
      const { w, h } = box();
      const cx = px ?? w / 2, cy = py ?? h / 2;
      const k = target / cur.s;
      return clamp({ s: target, x: cx - (cx - cur.x) * k, y: cy - (cy - cur.y) * k, fit: false });
    });
  }, [fitView, clamp]);

  const toggleZoom = useCallback((px?: number, py?: number) => {
    if (view.fit) zoomTo(Math.max(1, fitView().s * 1.0001), px, py);
    else setView(fitView());
  }, [view.fit, zoomTo, fitView]);

  // Refit when the picture loads or the window changes size.
  useLayoutEffect(() => {
    if (view.fit) setView(fitView());
    const ro = new ResizeObserver(() => setView((v) => (v.fit ? fitView() : clamp(v))));
    if (stage.current) ro.observe(stage.current);
    return () => ro.disconnect();
  }, [natural]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((d: number) => {
    const next = Math.max(0, Math.min(items.length - 1, index + d));
    if (next !== index) onIndex(next);
  }, [index, items.length, onIndex]);

  // Plain wheel: next / previous photo. Ctrl + wheel: zoom at the cursor.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const step = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
        zoomTo((view.fit ? fitView().s : view.s) * step, e.clientX - r.left, e.clientY - r.top);
        return;
      }
      // Touchpads send many small deltas: add them up, and move at most one photo per 140 ms.
      const w = wheel.current;
      const now = performance.now();
      w.acc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (Math.abs(w.acc) >= 40 && now - w.last > 140) {
        go(w.acc > 0 ? 1 : -1);
        w.acc = 0;
        w.last = now;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [go, zoomTo, fitView, view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || !item || paused) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      let used = true;
      if (ctrl && (k === "=" || k === "+")) zoomTo((view.fit ? fitView().s : view.s) * 1.25);
      else if (ctrl && (k === "-" || k === "_")) zoomTo((view.fit ? fitView().s : view.s) / 1.25);
      else if (ctrl && k === "0") setView(fitView());
      else if (ctrl && (k === "r" || k === "R")) onShowInExplorer(item);
      else if (ctrl && (k === "e" || k === "E")) { if (item.kind === "photo") onEdit(item.id); }
      else if (ctrl) used = false;
      else if (k === "ArrowRight" || k === "ArrowDown") go(1);
      else if (k === "ArrowLeft" || k === "ArrowUp") go(-1);
      else if (k === "Home") onIndex(0);
      else if (k === "End") onIndex(items.length - 1);
      else if (k === "Escape" || k === "g" || k === "G") onClose();
      else if ((k === "f" || k === "F") && e.shiftKey) onShowInFolder(item);
      else if (k === "d" || k === "D" || k === "Delete") onDelete(item.id);
      else if (k === "z" || k === "Z") toggleZoom();
      else if (k === "i" || k === "I") setInfo((v) => !v);
      else if (k === "Tab") setChrome((v) => !v);
      else if (/^[0-5]$/.test(k)) onRate(item.id, Number(k));
      else if (k === "p" || k === "P") onFlag(item.id, item.flag === 1 ? 0 : 1);
      else if (k === "x" || k === "X") onFlag(item.id, item.flag === -1 ? 0 : -1);
      else if (k === "u" || k === "U") onFlag(item.id, 0);
      else if (k === "h" || k === "H") onHide(item.id);
      else if (k === " " && item.kind === "video" && media.current) media.current.paused ? media.current.play() : media.current.pause();
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) return null;

  const onDown = (e: React.PointerEvent) => {
    if (view.fit || e.button !== 0) return;
    drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => clamp({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
  };
  const onUp = () => { drag.current = null; setDragging(false); };
  const onDouble = (e: React.MouseEvent) => {
    if (item.kind === "video") return;
    const r = box();
    toggleZoom(e.clientX - r.left, e.clientY - r.top);
  };

  const shown = view.fit ? fitView() : view;
  const style = natural ? { width: natural.w, height: natural.h, transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.s})` } : { opacity: 0 };
  const pct = natural ? Math.round(shown.s * 100) : null;
  const onLoaded = (w: number, h: number) => { if (w && h) setNatural({ w, h }); };

  // Filmstrip: a window of photos either side of this one.
  const from = Math.max(0, Math.min(index - 7, items.length - 15));
  const strip = items.slice(from, from + 15);

  return (
    <div className={`loupe ${chrome ? "" : "chrome-off"}`} role="dialog" aria-label="Photo viewer">
      <div ref={stage} className={`stage-area ${view.fit ? "" : "zoomed"} ${dragging ? "dragging" : ""}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble}>
        {item.kind === "video" && src ? (
          <video key={item.id} ref={media} className="pic" src={src} controls autoPlay style={style}
            onLoadedMetadata={(e) => onLoaded(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} onError={() => setFailed(true)} />
        ) : src && !failed ? (
          <img key={src} ref={media} className="pic" src={src} alt={fileName(item.path)} draggable={false} style={style}
            onLoad={(e) => onLoaded(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} onError={() => setFailed(true)} />
        ) : null}
        {(failed || !src) && <div className="msg">{failed ? `Safelight can't show this ${fileExt(item.path)} file yet.` : "Loading…"}</div>}
      </div>

      <div className="lbar">
        <button className="pill glass" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>Library · G
        </button>
        <div className="pill glass">
          <b className="ellipsis" style={{ maxWidth: 360 }}>{fileName(item.path)}</b>
          <span className="muted">{n(index + 1)} of {n(items.length)}</span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="pill glass tools">
          <button className={info ? "on" : ""} aria-label="Details (I)" title="Details (I)" onClick={() => setInfo((v) => !v)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
          </button>
          <button aria-label="Fit or 100% (Z)" title="Fit / 100% (Z)" onClick={() => toggleZoom()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
          <button aria-label="Show in folder tree (Shift+F)" title="Show in folder tree (Shift+F)" onClick={() => onShowInFolder(item)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z" /><path d="M10 13.5h6M13.5 11l2.5 2.5-2.5 2.5" /></svg>
          </button>
          <button aria-label="Hide from library (H)" title="Hide from library (H)" onClick={() => onHide(item.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3 4.1M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.8 9.8 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          </button>
        </div>
        {item.kind === "photo" && <button className="pill edit" onClick={() => onEdit(item.id)}>Edit · Ctrl+E</button>}
      </div>

      {info && (
        <aside className="info glass" aria-label="Photo details">
          <div>
            <h2>{fileName(item.path)}</h2>
            <div className="when">{dateTimeLabel(item.taken_at)}{item.date_source && ` · ${DATE_FROM[item.date_source] ?? item.date_source}`}</div>
          </div>
          <div className="row">
            <div className="rate" role="group" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((r) => (
                <button key={r} className={item.rating >= r ? "on" : ""} aria-label={`${r} star${r > 1 ? "s" : ""}`} aria-pressed={item.rating === r}
                  onClick={() => onRate(item.id, item.rating === r ? 0 : r)}>★</button>
              ))}
            </div>
            <div className="flags">
              <button className={`pick ${item.flag === 1 ? "on" : ""}`} aria-pressed={item.flag === 1} onClick={() => onFlag(item.id, item.flag === 1 ? 0 : 1)}>Pick</button>
              <button className={`reject ${item.flag === -1 ? "on" : ""}`} aria-pressed={item.flag === -1} onClick={() => onFlag(item.id, item.flag === -1 ? 0 : -1)}>Reject</button>
            </div>
          </div>
          <dl>
            <dt>File</dt><dd>{fileExt(item.path)}{item.width && item.height ? ` · ${item.width} × ${item.height}` : ""} · {formatBytes(item.size)}</dd>
            <dt>Source</dt><dd>{sourceName(item.source_id)}</dd>
            <dt>Folder</dt>
            <dd>
              <button className="path-link" title="Show in folder tree (Shift+F)" onClick={() => onShowInFolder(item)}>
                {item.path.slice(0, Math.max(0, item.path.length - fileName(item.path).length - 1))}
              </button>
              <span className="path-actions">
                <button className="link" onClick={() => onShowInFolder(item)}>Show in folder tree</button>
                <button className="link" onClick={() => onShowInExplorer(item)}>Show in Explorer</button>
              </span>
            </dd>
            <dt>Fingerprint</dt><dd className="mono-text" title={item.sha256}>{item.sha256.slice(0, 8)}…{item.sha256.slice(-8)}</dd>
          </dl>
          {smart && (smart.people.length > 0 || smart.faces > 0 || smart.place || smart.tags.length > 0 || onSimilar) && (
            <div className="smart-facts" aria-label="Found by smart tagging">
              {(smart.people.length > 0 || smart.faces > 0) && (
                <div><div className="label">People</div><div className="tag-cloud">
                  {smart.people.map((p) => <button key={p} className="tag" onClick={() => onSearch?.(p)}>{p}</button>)}
                  {smart.faces > smart.people.length && <span className="muted small">{smart.people.length ? "+ " : ""}{n(smart.faces - smart.people.length)} unnamed</span>}
                </div></div>
              )}
              {smart.place && <div><div className="label">Place</div><div className="tag-cloud"><button className="tag" onClick={() => onSearch?.(smart.place!.split(",")[0])}>{smart.place}</button></div></div>}
              {smart.tags.length > 0 && (
                <div><div className="label">Tags</div><div className="tag-cloud">
                  {smart.tags.map((t) => <button key={t} className="tag smart" onClick={() => onSearch?.(t)}>{t}</button>)}
                </div></div>
              )}
              {onSimilar && <div className="row start"><button className="btn small" onClick={() => onSimilar(item)}>Find similar photos</button></div>}
            </div>
          )}
          {item.has_exact_duplicate && (
            <div className="copy-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>
              <span>An exact copy is in another folder or source</span>
            </div>
          )}
        </aside>
      )}

      {item.kind === "photo" && (
        <div className="hint glass">
          <b>{view.fit ? "Fit" : `${pct}%`}</b><span>Wheel · next</span><span>Ctrl + wheel · zoom at cursor</span><span>Double-click · {view.fit ? "100%" : "fit"}</span>
        </div>
      )}

      <div className="strip glass" aria-label="Filmstrip">
        {strip.map((it, i) => {
          const url = thumbUrl(it);
          return (
            <button key={it.id} className={from + i === index ? "on" : ""} aria-label={fileName(it.path)} onClick={() => onIndex(from + i)}>
              {url ? <img src={url} alt="" draggable={false} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
