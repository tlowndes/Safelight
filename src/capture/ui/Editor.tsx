/**
 * Non-destructive editor: trim, crop, zoom, cursor highlight, text callouts
 * and key moments. Edits are a recipe saved to the library; the original
 * recording is never changed.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  createRecipe, evenRect, MAX_CALLOUT_LENGTH, MAX_MARKER_LABEL, MAX_ZOOM, MIN_CLIP_MS, newId, parseRecipe, validateRecipe,
  type EditRecipe, type Rect,
} from "../core/recipe";
import { formatTimecode } from "../core/time";
import { fileUrl } from "../platform/desktop";
import { renameCapture, sourceInfoOf, updateRecipe, type Capture } from "../services/library";
import { ExportPanel } from "./ExportPanel";
import {
  IconBack, IconCrop, IconCursor, IconExport, IconFolder, IconMarker, IconPause, IconPlay, IconRedo, IconText, IconTrash,
  IconTrim, IconUndo, IconZoom,
} from "./icons";
import type { CaptureCtl } from "./useCapture";

type Tool = "trim" | "crop" | "zoom" | "cursor" | "text" | "marker";
type Selection = { type: "zoom" | "callout" | "marker"; id: string } | null;

/* ---------- undo history ---------- */

interface History {
  past: EditRecipe[];
  present: EditRecipe;
  future: EditRecipe[];
}
type HistoryAction =
  | { type: "load"; recipe: EditRecipe }
  | { type: "edit"; recipe: EditRecipe }
  | { type: "live"; recipe: EditRecipe }
  | { type: "commit"; base: EditRecipe }
  | { type: "undo" }
  | { type: "redo" };

function history(state: History, a: HistoryAction): History {
  switch (a.type) {
    case "load":
      return { past: [], present: a.recipe, future: [] };
    case "edit":
      return { past: [...state.past.slice(-99), state.present], present: a.recipe, future: [] };
    case "live":
      return { ...state, present: a.recipe };
    case "commit":
      return a.base === state.present ? state : { past: [...state.past.slice(-99), a.base], present: state.present, future: [] };
    case "undo":
      return state.past.length
        ? { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future] }
        : state;
    case "redo":
      return state.future.length
        ? { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) }
        : state;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const secs = (ms: number) => Math.round(ms / 100) / 10;

/* ---------- pointer drag helper ---------- */

function startDrag(e: RPointerEvent, onMove: (dx: number, dy: number, ev: PointerEvent) => void, onEnd?: () => void) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0, ev);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/* ---------- editor ---------- */

export function Editor({ k, id }: { k: CaptureCtl; id: number }) {
  const [capture, setCapture] = useState<Capture | null | undefined>(undefined);
  const [state, dispatch] = useReducer(history, { past: [], present: createRecipe({ width: 2, height: 2, durationMs: 0, fps: 30, hasAudio: false }), future: [] });
  const recipe = state.present;
  const [tool, setTool] = useState<Tool>("trim");
  const [sel, setSel] = useState<Selection>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const [stageH, setStageH] = useState(300);

  /* load */
  useEffect(() => {
    let alive = true;
    k.refreshCapture(id).then((c) => {
      if (!alive) return;
      setCapture(c);
      if (c) {
        dispatch({ type: "load", recipe: parseRecipe(c.recipeJson, sourceInfoOf(c)) });
        loaded.current = true;
      }
    });
    return () => {
      alive = false;
    };
  }, [id, k.refreshCapture]);

  /* track the rendered stage height so callout text previews at export scale */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [capture]);

  /* autosave */
  useEffect(() => {
    if (!loaded.current || !capture || !k.ports) return;
    const t = setTimeout(() => void updateRecipe(k.ports!.db, capture.id, JSON.stringify(recipe)), 400);
    return () => clearTimeout(t);
  }, [recipe, capture, k.ports]);

  /* keep transcript status fresh while it is being generated */
  useEffect(() => {
    if (capture?.transcriptStatus !== "pending") return;
    const t = setInterval(() => void k.refreshCapture(capture.id).then((c) => c && setCapture(c)), 2500);
    return () => clearInterval(t);
  }, [capture?.transcriptStatus, capture?.id, k.refreshCapture]);

  const source = useMemo(() => (capture ? sourceInfoOf(capture) : null), [capture]);
  const W = source?.width ?? 16;
  const H = source?.height ?? 9;
  const dur = Math.max(1, source?.durationMs ?? 1);
  const validation = useMemo(() => (source ? validateRecipe(recipe, source) : { ok: true, errors: [] }), [recipe, source]);

  const edit = useCallback((r: EditRecipe) => dispatch({ type: "edit", recipe: r }), []);
  const seek = useCallback(
    (ms: number) => {
      const t = clamp(ms, 0, dur);
      setTime(t);
      if (videoRef.current) videoRef.current.currentTime = t / 1000;
    },
    [dur],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (time < recipe.trim.start || time >= recipe.trim.end - 50) seek(recipe.trim.start);
      void v.play();
    } else v.pause();
  }, [recipe.trim, seek, time]);

  // Play only inside the trimmed range.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v && !v.paused) {
        const t = v.currentTime * 1000;
        if (t >= recipe.trim.end) {
          v.pause();
          v.currentTime = recipe.trim.end / 1000;
        }
        setTime(Math.min(t, recipe.trim.end));
        raf = requestAnimationFrame(tick);
      }
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, recipe.trim.end]);

  /* adders */
  const addZoom = () => {
    const frame = recipe.crop ?? { x: 0, y: 0, w: W, h: H };
    const rect = evenRect({ x: frame.x + frame.w / 4, y: frame.y + frame.h / 4, w: frame.w / 2, h: frame.h / 2 }, W, H);
    const start = clamp(time, recipe.trim.start, recipe.trim.end - 600);
    const z = { id: newId("zoom"), start, end: Math.min(start + 3000, recipe.trim.end), rect };
    edit({ ...recipe, zooms: [...recipe.zooms, z] });
    setTool("zoom");
    setSel({ type: "zoom", id: z.id });
  };
  const addCallout = () => {
    const start = clamp(time, recipe.trim.start, recipe.trim.end - 600);
    const c = { id: newId("callout"), start, end: Math.min(start + 3000, recipe.trim.end), text: "Click here", x: Math.round(W * 0.4), y: Math.round(H * 0.2) };
    edit({ ...recipe, callouts: [...recipe.callouts, c] });
    setTool("text");
    setSel({ type: "callout", id: c.id });
  };
  const addMarker = () => {
    const m = { id: newId("marker"), at: Math.round(time), label: `Key moment ${recipe.markers.length + 1}` };
    edit({ ...recipe, markers: [...recipe.markers, m].sort((a, b) => a.at - b.at) });
    setTool("marker");
    setSel({ type: "marker", id: m.id });
  };
  const deleteSelected = () => {
    if (!sel) return;
    if (sel.type === "zoom") edit({ ...recipe, zooms: recipe.zooms.filter((z) => z.id !== sel.id) });
    if (sel.type === "callout") edit({ ...recipe, callouts: recipe.callouts.filter((z) => z.id !== sel.id) });
    if (sel.type === "marker") edit({ ...recipe, markers: recipe.markers.filter((z) => z.id !== sel.id) });
    setSel(null);
  };

  /* keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select") || showExport) return;
      const frame = 1000 / (source?.fps || 30);
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (e.key === "ArrowLeft") seek(time - (e.shiftKey ? 1000 : frame));
      else if (e.key === "ArrowRight") seek(time + (e.shiftKey ? 1000 : frame));
      else if (e.key.toLowerCase() === "m") addMarker();
      else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (capture === undefined) return <div className="state"><div className="spin" /><h2>Opening recording</h2></div>;
  if (capture === null || !source) {
    return (
      <div className="state">
        <h2>Recording not found</h2>
        <p>It may have been deleted from the library.</p>
        <button className="btn" onClick={() => k.setView({ name: "library" })}>Back to library</button>
      </div>
    );
  }

  /* geometry helpers: client px -> source px */
  const stageScale = () => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? W / r.width : 1;
  };
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  /** Moves/resizes a rect in source pixels. corner: "move" | "tl" | "br". */
  const dragRect = (e: RPointerEvent, rect: Rect, corner: "move" | "tl" | "br", apply: (r: Rect) => EditRecipe, aspect?: number) => {
    const base = recipe;
    const s = stageScale();
    startDrag(
      e,
      (dx, dy) => {
        const ddx = dx * s;
        const ddy = dy * s;
        let r = { ...rect };
        if (corner === "move") {
          r.x = clamp(rect.x + ddx, 0, W - rect.w);
          r.y = clamp(rect.y + ddy, 0, H - rect.h);
        } else if (corner === "br") {
          r.w = clamp(rect.w + ddx, 16, W - rect.x);
          r.h = aspect ? r.w / aspect : clamp(rect.h + ddy, 16, H - rect.y);
          if (aspect && rect.y + r.h > H) {
            r.h = H - rect.y;
            r.w = r.h * aspect;
          }
        } else {
          const x2 = rect.x + rect.w;
          const y2 = rect.y + rect.h;
          r.x = clamp(rect.x + ddx, 0, x2 - 16);
          r.w = x2 - r.x;
          r.h = aspect ? r.w / aspect : y2 - clamp(rect.y + ddy, 0, y2 - 16);
          r.y = y2 - r.h;
          if (r.y < 0) {
            r.y = 0;
            r.h = y2;
            if (aspect) {
              r.w = r.h * aspect;
              r.x = x2 - r.w;
            }
          }
        }
        r = evenRect(r, W, H);
        dispatch({ type: "live", recipe: apply(r) });
      },
      () => dispatch({ type: "commit", base }),
    );
  };

  const frame = recipe.crop ?? { x: 0, y: 0, w: W, h: H };
  const activeZoom = recipe.zooms.find((z) => time >= z.start && time <= z.end);
  let videoTransform = "none";
  if (playing && activeZoom) {
    const z = clamp(Math.min(frame.w / activeZoom.rect.w, frame.h / activeZoom.rect.h), 1, MAX_ZOOM);
    const cx = activeZoom.rect.x + activeZoom.rect.w / 2;
    const cy = activeZoom.rect.y + activeZoom.rect.h / 2;
    const x0 = clamp(cx - frame.w / z / 2, frame.x, frame.x + frame.w - frame.w / z);
    const y0 = clamp(cy - frame.h / z / 2, frame.y, frame.y + frame.h - frame.h / z);
    videoTransform = `scale(${z}) translate(${-(x0 / W) * 100}%, ${-(y0 / H) * 100}%)`;
  }

  const ticks = (() => {
    const step = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000].find((s) => dur / s <= 8) ?? 600000;
    const out: number[] = [];
    for (let t = 0; t <= dur; t += step) out.push(t);
    return out;
  })();

  /** Timeline drag in ms. */
  const dragTime = (e: RPointerEvent, onMs: (dms: number) => EditRecipe) => {
    const track = (e.currentTarget as HTMLElement).closest(".timeline")?.querySelector(".track") as HTMLElement | null;
    const width = track?.getBoundingClientRect().width ?? 1;
    const base = recipe;
    startDrag(
      e,
      (dx) => dispatch({ type: "live", recipe: onMs(Math.round((dx / width) * dur)) }),
      () => dispatch({ type: "commit", base }),
    );
  };

  const scrub = (e: RPointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const at = (x: number) => seek(((x - r.left) / r.width) * dur);
    at(e.clientX);
    startDrag(e, (_dx, _dy, ev) => at(ev.clientX));
  };

  const selZoom = sel?.type === "zoom" ? recipe.zooms.find((z) => z.id === sel.id) : undefined;
  const selCallout = sel?.type === "callout" ? recipe.callouts.find((z) => z.id === sel.id) : undefined;
  const selMarker = sel?.type === "marker" ? recipe.markers.find((z) => z.id === sel.id) : undefined;
  const updateZoom = (zid: string, patch: Partial<(typeof recipe.zooms)[number]>) =>
    edit({ ...recipe, zooms: recipe.zooms.map((z) => (z.id === zid ? { ...z, ...patch } : z)) });
  const updateCallout = (cid: string, patch: Partial<(typeof recipe.callouts)[number]>) =>
    edit({ ...recipe, callouts: recipe.callouts.map((z) => (z.id === cid ? { ...z, ...patch } : z)) });
  const updateMarker = (mid: string, patch: Partial<(typeof recipe.markers)[number]>) =>
    edit({ ...recipe, markers: recipe.markers.map((z) => (z.id === mid ? { ...z, ...patch } : z)) });

  const setCropAspect = (ratio: number | null) => {
    if (ratio === null) return edit({ ...recipe, crop: null });
    let w = W;
    let h = Math.round(W / ratio);
    if (h > H) {
      h = H;
      w = Math.round(H * ratio);
    }
    edit({ ...recipe, crop: evenRect({ x: (W - w) / 2, y: (H - h) / 2, w, h }, W, H) });
  };

  const tools: { id: Tool; label: string; icon: ReactNode }[] = [
    { id: "trim", label: "Trim", icon: <IconTrim /> },
    { id: "crop", label: "Crop", icon: <IconCrop /> },
    { id: "zoom", label: "Zoom", icon: <IconZoom /> },
    { id: "cursor", label: "Cursor highlight", icon: <IconCursor /> },
    { id: "text", label: "Text callout", icon: <IconText /> },
    { id: "marker", label: "Key moment", icon: <IconMarker /> },
  ];

  const calloutsNow = recipe.callouts.filter((c) => (tool === "text" && sel?.id === c.id) || (time >= c.start && time <= c.end));

  return (
    <>
      <div className="pagehead">
        <button className="btn icon ghost" aria-label="Back to library" onClick={() => k.setView({ name: "library" })}>
          <IconBack />
        </button>
        <input
          id="editor-title"
          className="title"
          defaultValue={capture.title}
          aria-label="Title"
          onBlur={(e) => {
            const title = e.target.value.trim().slice(0, 120) || capture.title;
            if (title !== capture.title && k.ports) {
              void renameCapture(k.ports.db, capture.id, title).then(() => {
                setCapture({ ...capture, title });
                void k.refresh();
              });
            }
          }}
        />
        <span className="pill grey" title="Edits are saved separately; the original recording is never changed">Original kept</span>
        <button className="btn icon ghost" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })}>
          <IconUndo />
        </button>
        <button className="btn icon ghost" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })}>
          <IconRedo />
        </button>
        <button className="btn" onClick={() => void k.reveal(capture.filePath)}>
          <IconFolder /> Show original
        </button>
        {confirmDelete ? (
          <>
            <button className="btn danger" onClick={() => void k.removeCapture(capture)}>Delete recording</button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : (
          <button className="btn icon ghost" aria-label="Delete recording" onClick={() => setConfirmDelete(true)}>
            <IconTrash />
          </button>
        )}
        <button className="btn primary" onClick={() => setShowExport(true)} disabled={!k.ffmpegOk}>
          <IconExport /> Export
        </button>
      </div>

      <div className="editor">
        <div className="tools" role="toolbar" aria-label="Tools" aria-orientation="vertical">
          {tools.map((t) => (
            <button key={t.id} className="tool" title={t.label} aria-label={t.label} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>
              {t.icon}
            </button>
          ))}
        </div>

        <div className="canvas">
          <div className="stagewrap">
            <div
              ref={stageRef}
              className="stage"
              style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc(52vh * ${W / H}))` }}
              onPointerDown={() => setSel(null)}
            >
              {videoError ? (
                <div className="state" style={{ margin: 0, padding: 24, color: "#fff" }}>
                  <h2>Can't play this recording</h2>
                  <p style={{ color: "#c9cfda" }}>The file may have been moved or deleted. Use Show original to check the folder.</p>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  src={fileUrl(capture.filePath)}
                  style={{ transform: videoTransform }}
                  preload="auto"
                  onLoadedMetadata={() => seek(recipe.trim.start)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onSeeked={(e) => !playing && setTime(e.currentTarget.currentTime * 1000)}
                  onError={() => setVideoError(true)}
                />
              )}

              <div className="ov">
                {/* crop */}
                {recipe.crop && tool !== "crop" && (
                  <div className="cropbox passive" style={{ left: pct(recipe.crop.x, W), top: pct(recipe.crop.y, H), width: pct(recipe.crop.w, W), height: pct(recipe.crop.h, H) }} />
                )}
                {tool === "crop" && (
                  <RectBox
                    className="cropbox"
                    rect={recipe.crop ?? { x: 0, y: 0, w: W, h: H }}
                    W={W}
                    H={H}
                    label={`CROP ${(recipe.crop ?? { w: W }).w}×${(recipe.crop ?? { h: H }).h}`}
                    onDrag={(e, corner) => dragRect(e, recipe.crop ?? { x: 0, y: 0, w: W, h: H }, corner, (r) => ({ ...recipe, crop: r }))}
                  />
                )}
                {/* zoom boxes */}
                {tool === "zoom" &&
                  recipe.zooms
                    .filter((z) => z.id === sel?.id || (time >= z.start && time <= z.end))
                    .map((z) => (
                      <RectBox
                        key={z.id}
                        className="zoombox"
                        rect={z.rect}
                        W={W}
                        H={H}
                        label={`ZOOM ${clamp(Math.min(frame.w / z.rect.w, frame.h / z.rect.h), 1, MAX_ZOOM).toFixed(1)}×`}
                        onDrag={(e, corner) => {
                          setSel({ type: "zoom", id: z.id });
                          dragRect(e, z.rect, corner, (r) => ({ ...recipe, zooms: recipe.zooms.map((x) => (x.id === z.id ? { ...x, rect: r } : x)) }), frame.w / frame.h);
                        }}
                      />
                    ))}
                {/* callouts */}
                {!playing || !activeZoom
                  ? calloutsNow.map((c) => (
                      <div
                        key={c.id}
                        className={`callout-prev ${sel?.id === c.id ? "sel" : ""}`}
                        style={{ left: pct(c.x, W), top: pct(c.y, H), fontSize: `${(Math.max(18, Math.round(H / 26)) / H) * stageH}px` }}
                        onPointerDown={(e) => {
                          setTool("text");
                          setSel({ type: "callout", id: c.id });
                          const base = recipe;
                          const s = stageScale();
                          startDrag(
                            e,
                            (dx, dy) =>
                              dispatch({
                                type: "live",
                                recipe: { ...recipe, callouts: recipe.callouts.map((x) => (x.id === c.id ? { ...x, x: Math.round(clamp(c.x + dx * s, 0, W - 20)), y: Math.round(clamp(c.y + dy * s, 0, H - 20)) } : x)) },
                              }),
                            () => dispatch({ type: "commit", base }),
                          );
                        }}
                      >
                        {c.text || " "}
                      </div>
                    ))
                  : null}
              </div>
            </div>
          </div>

          <div className="transport">
            <button className="btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <IconPause /> : <IconPlay />} {playing ? "Pause" : "Play"}
            </button>
            <span className="mono time">
              {formatTimecode(time)} / {formatTimecode(dur)}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 12 }}>
              Clip {formatTimecode(recipe.trim.end - recipe.trim.start)} · Space play · ←/→ step · M key moment
            </span>
          </div>

          <div className="timeline">
            <div className="tlrow">
              <span className="lbl" />
              <div className="ruler" onPointerDown={scrub}>
                {ticks.map((t) => (
                  <span key={t} style={{ left: pct(t, dur) }}>{formatTimecode(t).replace(/\.\d$/, "")}</span>
                ))}
              </div>
            </div>
            <div className="tlrow">
            <span className="lbl">Video</span>
            <div className="track" onPointerDown={scrub}>
              <div className="clip" style={{ left: pct(recipe.trim.start, dur), width: pct(recipe.trim.end - recipe.trim.start, dur) }}>
                <div
                  className="trimhandle in"
                  aria-label="Trim start"
                  onPointerDown={(e) => {
                    const t0 = recipe.trim;
                    setTool("trim");
                    dragTime(e, (d) => ({ ...recipe, trim: { ...t0, start: clamp(t0.start + d, 0, t0.end - MIN_CLIP_MS) } }));
                  }}
                />
                <div
                  className="trimhandle out"
                  aria-label="Trim end"
                  onPointerDown={(e) => {
                    const t0 = recipe.trim;
                    setTool("trim");
                    dragTime(e, (d) => ({ ...recipe, trim: { ...t0, end: clamp(t0.end + d, t0.start + MIN_CLIP_MS, dur) } }));
                  }}
                />
              </div>
              <div className="playhead" style={{ left: pct(time, dur) }} />
            </div>
            </div>
            <TimedTrack
              label="Zoom"
              kind="zoom"
              items={recipe.zooms.map((z) => ({ id: z.id, start: z.start, end: z.end, text: `${clamp(Math.min(frame.w / z.rect.w, frame.h / z.rect.h), 1, MAX_ZOOM).toFixed(1)}×` }))}
              dur={dur}
              selected={sel?.id}
              onSelect={(zid) => {
                setTool("zoom");
                setSel({ type: "zoom", id: zid });
              }}
              onDrag={(e, zid, mode) => {
                const z0 = recipe.zooms.find((z) => z.id === zid)!;
                dragTime(e, (d) => ({ ...recipe, zooms: recipe.zooms.map((z) => (z.id === zid ? { ...z, ...shiftSpan(z0, d, mode, dur) } : z)) }));
              }}
            />
            <TimedTrack
              label="Text"
              kind="callout"
              items={recipe.callouts.map((c) => ({ id: c.id, start: c.start, end: c.end, text: c.text }))}
              dur={dur}
              selected={sel?.id}
              onSelect={(cid) => {
                setTool("text");
                setSel({ type: "callout", id: cid });
              }}
              onDrag={(e, cid, mode) => {
                const c0 = recipe.callouts.find((c) => c.id === cid)!;
                dragTime(e, (d) => ({ ...recipe, callouts: recipe.callouts.map((c) => (c.id === cid ? { ...c, ...shiftSpan(c0, d, mode, dur) } : c)) }));
              }}
            />
            <div className="tlrow">
            <span className="lbl">Moments</span>
            <div className="track">
              {recipe.markers.map((m) => (
                <div
                  key={m.id}
                  className={`marker ${sel?.id === m.id ? "sel" : ""}`}
                  style={{ left: pct(m.at, dur) }}
                  title={`${formatTimecode(m.at)} ${m.label}`}
                  onPointerDown={(e) => {
                    setTool("marker");
                    setSel({ type: "marker", id: m.id });
                    seek(m.at);
                    const at0 = m.at;
                    dragTime(e, (d) => ({ ...recipe, markers: recipe.markers.map((x) => (x.id === m.id ? { ...x, at: clamp(at0 + d, 0, dur) } : x)) }));
                  }}
                />
              ))}
            </div>
            </div>
          </div>
        </div>

        <aside className="inspector" aria-label="Inspector">
          {tool === "trim" && (
            <section>
              <h5>Trim</h5>
              <div className="row">Start <span className="mono">{formatTimecode(recipe.trim.start)}</span></div>
              <div className="row">End <span className="mono">{formatTimecode(recipe.trim.end)}</span></div>
              <div className="row">Length <span className="mono">{formatTimecode(recipe.trim.end - recipe.trim.start)}</span></div>
              <div className="row">
                <button className="btn" onClick={() => edit({ ...recipe, trim: { ...recipe.trim, start: clamp(time, 0, recipe.trim.end - MIN_CLIP_MS) } })}>
                  Start at playhead
                </button>
                <button className="btn" onClick={() => edit({ ...recipe, trim: { ...recipe.trim, end: clamp(time, recipe.trim.start + MIN_CLIP_MS, dur) } })}>
                  End at playhead
                </button>
              </div>
              <button className="btn" onClick={() => edit({ ...recipe, trim: { start: 0, end: dur } })}>Reset trim</button>
              <p className="hint">Drag the handles on the timeline, or set them from the playhead.</p>
            </section>
          )}

          {tool === "crop" && (
            <section>
              <h5>Crop</h5>
              <div className="row">Size <span className="mono">{recipe.crop ? `${recipe.crop.w}×${recipe.crop.h}` : `${W}×${H} (full)`}</span></div>
              <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
                <button className="btn" onClick={() => setCropAspect(16 / 9)}>16:9</button>
                <button className="btn" onClick={() => setCropAspect(4 / 3)}>4:3</button>
                <button className="btn" onClick={() => setCropAspect(1)}>1:1</button>
                <button className="btn" onClick={() => setCropAspect(9 / 16)}>9:16</button>
              </div>
              <button className="btn" onClick={() => setCropAspect(null)} disabled={!recipe.crop}>Remove crop</button>
              <p className="hint">Drag the box to move it; drag a corner to resize.</p>
            </section>
          )}

          {tool === "zoom" && (
            <section>
              <h5>Zoom</h5>
              <button className="btn" onClick={addZoom}>Add zoom at playhead</button>
              {selZoom ? (
                <>
                  <div className="row">From (s) <input className="field mono" type="number" step="0.1" min={0} value={secs(selZoom.start)} onChange={(e) => updateZoom(selZoom.id, { start: Math.round(Number(e.target.value) * 1000) })} /></div>
                  <div className="row">To (s) <input className="field mono" type="number" step="0.1" min={0} value={secs(selZoom.end)} onChange={(e) => updateZoom(selZoom.id, { end: Math.round(Number(e.target.value) * 1000) })} /></div>
                  <div className="row">Depth <span className="mono">{clamp(Math.min(frame.w / selZoom.rect.w, frame.h / selZoom.rect.h), 1, MAX_ZOOM).toFixed(1)}×</span></div>
                  <button className="btn danger" onClick={deleteSelected}>Delete zoom</button>
                  <p className="hint">Drag the dashed box on the video to choose where to zoom. Zooms ease in and out.</p>
                </>
              ) : (
                <p className="hint">{recipe.zooms.length ? "Select a zoom on the timeline to edit it." : "Zooms push in on a detail, then ease back out."}</p>
              )}
            </section>
          )}

          {tool === "cursor" && (
            <section>
              <h5>Cursor highlight</h5>
              <div className="row">
                <label htmlFor="cursor-on">Show highlight</label>
                <span className="switch">
                  <input
                    id="cursor-on"
                    type="checkbox"
                    disabled={!capture.cursorPath}
                    checked={recipe.cursor.enabled && !!capture.cursorPath}
                    onChange={(e) => edit({ ...recipe, cursor: { ...recipe.cursor, enabled: e.target.checked } })}
                  />
                  <span />
                </span>
              </div>
              <div className="row">
                <label htmlFor="cursor-size">Size</label>
                <input
                  id="cursor-size"
                  type="range"
                  min={16}
                  max={120}
                  step={2}
                  value={recipe.cursor.size}
                  disabled={!capture.cursorPath}
                  onChange={(e) => dispatch({ type: "live", recipe: { ...recipe, cursor: { ...recipe.cursor, size: Number(e.target.value) } } })}
                  onPointerDown={() => {
                    const base = recipe;
                    window.addEventListener("pointerup", () => dispatch({ type: "commit", base }), { once: true });
                  }}
                />
              </div>
              <p className="hint">
                {capture.cursorPath
                  ? "A soft yellow circle follows the pointer in the export."
                  : "This recording has no cursor data, so the highlight isn't available."}
              </p>
            </section>
          )}

          {tool === "text" && (
            <section>
              <h5>Text callouts</h5>
              <button className="btn" onClick={addCallout}>Add callout at playhead</button>
              {selCallout ? (
                <>
                  <label htmlFor="callout-text" className="hint">Text ({selCallout.text.length}/{MAX_CALLOUT_LENGTH})</label>
                  <textarea
                    id="callout-text"
                    className="field"
                    rows={3}
                    maxLength={MAX_CALLOUT_LENGTH}
                    value={selCallout.text}
                    onChange={(e) => updateCallout(selCallout.id, { text: e.target.value })}
                  />
                  <div className="row">From (s) <input className="field mono" type="number" step="0.1" min={0} value={secs(selCallout.start)} onChange={(e) => updateCallout(selCallout.id, { start: Math.round(Number(e.target.value) * 1000) })} /></div>
                  <div className="row">To (s) <input className="field mono" type="number" step="0.1" min={0} value={secs(selCallout.end)} onChange={(e) => updateCallout(selCallout.id, { end: Math.round(Number(e.target.value) * 1000) })} /></div>
                  <button className="btn danger" onClick={deleteSelected}>Delete callout</button>
                  <p className="hint">Drag the callout on the video to place it.</p>
                </>
              ) : (
                <p className="hint">Callouts label what's happening on screen.</p>
              )}
            </section>
          )}

          {tool === "marker" && (
            <section>
              <h5>Key moments</h5>
              <button className="btn" onClick={addMarker}>Add key moment at playhead</button>
              {recipe.markers.length === 0 && <p className="hint">Key moments appear in the Markdown summary and pick the poster frame. Press M while playing.</p>}
              {recipe.markers.map((m) => (
                <div key={m.id} className="row">
                  <button className="btn ghost mono" style={{ padding: "4px 6px" }} onClick={() => { seek(m.at); setSel({ type: "marker", id: m.id }); }}>
                    {formatTimecode(m.at)}
                  </button>
                  <input
                    className="field"
                    style={{ flex: 1, width: "auto", outline: selMarker?.id === m.id ? "2px solid var(--accent)" : undefined }}
                    aria-label="Key moment label"
                    maxLength={MAX_MARKER_LABEL}
                    value={m.label}
                    onChange={(e) => updateMarker(m.id, { label: e.target.value })}
                  />
                  <button className="btn icon ghost" aria-label="Delete key moment" onClick={() => edit({ ...recipe, markers: recipe.markers.filter((x) => x.id !== m.id) })}>
                    <IconTrash />
                  </button>
                </div>
              ))}
            </section>
          )}

          {!validation.ok && (
            <ul className="errors" role="alert">
              {validation.errors.map((err) => <li key={err}>{err}</li>)}
            </ul>
          )}

          <section>
            <h5>Transcript</h5>
            {capture.transcriptStatus === "ready" && <p className="hint" style={{ maxHeight: 160, overflow: "auto" }}>{capture.transcriptText || "(no speech found)"}</p>}
            {capture.transcriptStatus === "pending" && (
              <div className="row" style={{ justifyContent: "flex-start" }}><div className="spin" style={{ width: 16, height: 16 }} /> Transcribing locally…</div>
            )}
            {(capture.transcriptStatus === "unavailable" || capture.transcriptStatus === "failed" || capture.transcriptStatus === "none") && (
              <>
                <p className="hint">{capture.transcriptError ?? "No transcript yet."}</p>
                {capture.hasAudio && (
                  <button className="btn" onClick={() => void k.runTranscript(capture).then(() => k.refreshCapture(capture.id).then((c) => c && setCapture(c)))}>
                    {capture.transcriptStatus === "none" ? "Transcribe" : "Retry"}
                  </button>
                )}
              </>
            )}
          </section>
        </aside>
      </div>

      {showExport && (
        <ExportPanel
          k={k}
          capture={capture}
          recipe={recipe}
          errors={validation.errors}
          onClose={() => setShowExport(false)}
        />
      )}
    </>
  );
}

/* ---------- pieces ---------- */

function shiftSpan(span: { start: number; end: number }, d: number, mode: "move" | "l" | "r", dur: number) {
  if (mode === "l") return { start: clamp(span.start + d, 0, span.end - 200) };
  if (mode === "r") return { end: clamp(span.end + d, span.start + 200, dur) };
  const len = span.end - span.start;
  const start = clamp(span.start + d, 0, dur - len);
  return { start, end: start + len };
}

function RectBox(props: {
  className: string;
  rect: Rect;
  W: number;
  H: number;
  label: string;
  onDrag: (e: RPointerEvent, corner: "move" | "tl" | "br") => void;
}) {
  const { rect, W, H } = props;
  return (
    <div
      className={`rectbox ${props.className}`}
      style={{ left: `${(rect.x / W) * 100}%`, top: `${(rect.y / H) * 100}%`, width: `${(rect.w / W) * 100}%`, height: `${(rect.h / H) * 100}%` }}
      onPointerDown={(e) => props.onDrag(e, "move")}
    >
      <span>{props.label}</span>
      <div className="handle tl" onPointerDown={(e) => props.onDrag(e, "tl")} />
      <div className="handle br" onPointerDown={(e) => props.onDrag(e, "br")} />
    </div>
  );
}

function TimedTrack(props: {
  label: string;
  kind: "zoom" | "callout";
  items: { id: string; start: number; end: number; text: string }[];
  dur: number;
  selected?: string;
  onSelect: (id: string) => void;
  onDrag: (e: RPointerEvent, id: string, mode: "move" | "l" | "r") => void;
}) {
  return (
    <div className="tlrow">
    <span className="lbl">{props.label}</span>
    <div className="track">
      {props.items.map((it) => (
        <div
          key={it.id}
          className={`bar ${props.kind} ${props.selected === it.id ? "sel" : ""}`}
          style={{ left: `${(it.start / props.dur) * 100}%`, width: `${((it.end - it.start) / props.dur) * 100}%` }}
          title={it.text}
          onPointerDown={(e) => {
            props.onSelect(it.id);
            props.onDrag(e, it.id, "move");
          }}
        >
          <span className="edge l" onPointerDown={(e) => { props.onSelect(it.id); props.onDrag(e, it.id, "l"); }} />
          {it.text}
          <span className="edge r" onPointerDown={(e) => { props.onSelect(it.id); props.onDrag(e, it.id, "r"); }} />
        </div>
      ))}
    </div>
    </div>
  );
}
