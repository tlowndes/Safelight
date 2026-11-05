import { useEffect, useMemo, useRef, useState } from "react";
import { api, dateTimeLabel, defaultEdits, Edits, fileName, Item, Mask, MonthGroup, Preset, Rendered, Spot, Version } from "../api";
import EditOverlay from "../components/EditOverlay";
import Thumb from "../components/Thumb";
import DeleteDialog from "../components/DeleteDialog";
import ExportDialog from "../components/ExportDialog";
import { copyEdits, useCopiedEdits } from "../editClipboard";
import { isTyping } from "../shortcuts";

type Props = { itemId: number | null; groups: MonthGroup[]; onPick: (id: number) => void; onError: (e: string) => void; onChanged: () => void };

const BANDS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
const BAND_COLOURS = ["#e5533d", "#f08c35", "#f2c94c", "#6fbf5e", "#3fb0c9", "#4a72d8", "#9a5bd1", "#d659a8"];
const CROPS: [string, number | null][] = [["Original", null], ["1:1", 1], ["4:5", 4 / 5], ["3:2", 3 / 2], ["16:9", 16 / 9]];

/** One step in a photo's edit history. Slider drags merge into one step per slider. */
type Step = { key: string; label: string; edits: Edits; at: number };
type History = { steps: Step[]; pos: number };
/** Kept for the whole session, so going back to a photo keeps its history. */
const histories = new Map<number, History>();
const MERGE_MS = 900;
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

export default function Editor({ itemId, groups, onPick, onError, onChanged }: Props) {
  const photos = useMemo(() => groups.flatMap((g) => g.items).filter((i) => i.kind === "photo"), [groups]);
  const [item, setItem] = useState<Item | null>(null);
  const [edits, setEdits] = useState<Edits>(defaultEdits());
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [before, setBefore] = useState<Rendered | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [band, setBand] = useState(1);
  const [aspect, setAspect] = useState<string>("Original");
  const [exporting, setExporting] = useState(false);
  const [hist, setHist] = useState<History>({ steps: [], pos: -1 });
  const clipboard = useCopiedEdits();
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState(false);
  const inflight = useRef(false);
  const pending = useRef<Edits | null>(null);
  const loaded = useRef<number | null>(null);
  /** Spot healing or masks: what clicks on the picture do. */
  const [tool, setTool] = useState<"none" | "heal" | "mask">("none");
  const [picked, setPicked] = useState<number | null>(null);
  const [brush, setBrush] = useState(0.02);
  const [versions, setVersions] = useState<Version[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const measure = () => {
    const im = imgRef.current;
    if (im) setBox({ left: im.offsetLeft, top: im.offsetTop, width: im.offsetWidth, height: im.offsetHeight });
  };
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  const loadVersions = () => { if (itemId !== null) api.versions(itemId).then(setVersions).catch(() => setVersions([])); };
  useEffect(() => { setPicked(null); loadVersions(); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPicked(null), [tool]);

  useEffect(() => { api.presets().then(setPresets).catch((e) => onError(String(e))); }, []);

  // D bins the photo being edited, same as in the grid and loupe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || deleting || exporting || itemId === null || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "d" || e.key === "D") { e.preventDefault(); setDeleting(true); }
      else if (e.key === "q" || e.key === "Q") setTool((t) => (t === "heal" ? "none" : "heal"));
      else if (e.key === "m" || e.key === "M") setTool((t) => (t === "mask" ? "none" : "mask"));
      else if (e.key === "Escape" && tool !== "none") setTool("none");
      else if ((e.key === "Delete" || e.key === "Backspace") && picked !== null) { e.preventDefault(); removePicked(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Load the photo and its saved edits.
  useEffect(() => {
    if (itemId === null) return;
    loaded.current = null;
    setRendered(null);
    setBefore(null);
    (async () => {
      try {
        const [it, e] = await Promise.all([api.item(itemId), api.loadEdits(itemId)]);
        setItem(it);
        setEdits(e);
        setHist(histories.get(itemId) ?? { steps: [{ key: "open", label: "Opened", edits: e, at: 0 }], pos: 0 });
        setAspect(e.crop ? "Custom" : "Original");
        loaded.current = itemId;
        render(e);
      } catch (x) {
        onError(String(x));
      }
    })();
  }, [itemId]);

  // Render without piling up requests: only the newest edits are drawn.
  const render = async (e: Edits) => {
    if (itemId === null) return;
    if (inflight.current) {
      pending.current = e;
      return;
    }
    inflight.current = true;
    try {
      setRendered(await api.renderPreview(itemId, e));
    } catch (x) {
      onError(String(x));
    } finally {
      inflight.current = false;
      if (pending.current) {
        const next = pending.current;
        pending.current = null;
        render(next);
      }
    }
  };

  // Save shortly after the last change.
  useEffect(() => {
    if (itemId === null || loaded.current !== itemId) return;
    const t = setTimeout(() => { api.saveEdits(itemId, edits).then(onChanged).catch(() => {}); }, 600);
    return () => clearTimeout(t);
  }, [edits]);

  useEffect(() => { if (itemId !== null && hist.steps.length) histories.set(itemId, hist); }, [hist]);

  /** Change the edits and record it in the history. Changes with the same key in quick
   * succession (a slider drag) become one step. */
  const update = (patch: Partial<Edits>, label = "Edit", key = label) => {
    const next = { ...edits, ...patch };
    setEdits(next);
    render(next);
    const now = Date.now();
    setHist((h) => {
      const cur = h.steps[h.pos];
      const steps = h.steps.slice(0, h.pos + 1);
      if (cur && cur.key === key && h.pos > 0 && now - cur.at < MERGE_MS) {
        steps[h.pos] = { key, label, edits: next, at: now };
        return { steps, pos: h.pos };
      }
      steps.push({ key, label, edits: next, at: now });
      const trimmed = steps.slice(-200);
      return { steps: trimmed, pos: trimmed.length - 1 };
    });
  };
  /** Jump to a step without adding one. */
  const goTo = (pos: number) => {
    const step = hist.steps[pos];
    if (!step) return;
    setHist({ ...hist, pos, steps: hist.steps.map((s, i) => (i === pos ? { ...s, at: 0 } : s)) });
    setEdits(step.edits);
    setAspect(step.edits.crop ? "Custom" : "Original");
    render(step.edits);
  };
  const undo = () => goTo(hist.pos - 1);
  const redo = () => goTo(hist.pos + 1);
  const paste = () => clipboard && update({ ...defaultEdits(), ...clipboard, crop: edits.crop, rotate: edits.rotate, straighten: edits.straighten, spots: edits.spots }, "Paste settings");
  const copy = () => { copyEdits(edits); setStatus("Settings copied. Paste them here or onto a selection in the library."); };

  useEffect(() => {
    if (itemId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || !(e.ctrlKey || e.metaKey) || deleting || exporting) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if ((k === "z" && e.shiftKey) || k === "y") redo();
      else if (k === "c" && e.shiftKey) copy();
      else if (k === "v" && e.shiftKey) paste();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleBefore = async (on: boolean) => {
    setShowBefore(on);
    if (on && !before && itemId !== null) setBefore(await api.renderPreview(itemId, { ...defaultEdits(), rotate: edits.rotate, straighten: edits.straighten, crop: edits.crop }));
  };

  const setCrop = (label: string, ratio: number | null) => {
    setAspect(label);
    if (!ratio || !item?.width || !item?.height) return update({ crop: null }, `Crop ${label}`);
    const turned = edits.rotate % 2 === 1;
    const w = turned ? item.height : item.width;
    const h = turned ? item.width : item.height;
    const current = w / h;
    // Largest centred rectangle with the chosen shape.
    const crop: [number, number, number, number] = ratio > current ? [0, (1 - current / ratio) / 2, 1, current / ratio] : [(1 - ratio / current) / 2, 0, ratio / current, 1];
    update({ crop }, `Crop ${label}`);
  };

  const addSpot = async (x: number, y: number) => {
    if (itemId === null) return;
    const r = brush;
    try {
      const [sx, sy] = await api.spotSource(itemId, edits, x, y, r);
      const spots = [...edits.spots, { x, y, r, sx, sy }];
      update({ spots }, "Spot removal");
      setPicked(spots.length - 1);
    } catch (e) { onError(String(e)); }
  };
  const setSpot = (i: number, sp: Spot) => update({ spots: edits.spots.map((s, k) => (k === i ? sp : s)) }, "Move spot", `spot-${i}`);
  const addMask = (kind: "radial" | "linear") => {
    const [cx, cy, cw, ch] = edits.crop ?? [0, 0, 1, 1];
    const m: Mask = {
      kind, feather: 50, invert: false, exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0,
      ...(kind === "radial"
        ? { x1: cx + cw / 2, y1: cy + ch / 2, x2: cw / 4, y2: ch / 4 }
        : { x1: cx + cw / 2, y1: cy + ch * 0.15, x2: cx + cw / 2, y2: cy + ch * 0.55 }),
    };
    const masks = [...edits.masks, m];
    update({ masks }, kind === "radial" ? "Radial mask" : "Linear mask");
    setTool("mask");
    setPicked(masks.length - 1);
  };
  const setMask = (i: number, m: Mask, label = "Move mask", key = `mask-${i}`) => update({ masks: edits.masks.map((x, k) => (k === i ? m : x)) }, label, key);
  const removePicked = () => {
    if (picked === null) return;
    if (tool === "heal") update({ spots: edits.spots.filter((_, k) => k !== picked) }, "Remove spot");
    else if (tool === "mask") update({ masks: edits.masks.filter((_, k) => k !== picked) }, "Remove mask");
    setPicked(null);
  };

  /** Switch to another virtual copy, saving the one being edited first. */
  const switchTo = async (v: Version) => {
    if (itemId === null || v.active || v.id === null) return;
    try {
      await api.saveEdits(itemId, edits);
      const e = await api.switchVersion(itemId, v.id);
      setEdits(e);
      render(e);
      setAspect(e.crop ? "Custom" : "Original");
      const h = { steps: [{ key: "open", label: `Switched to ${v.name}`, edits: e, at: 0 }], pos: 0 };
      setHist(h);
      histories.set(itemId, h);
      loadVersions();
      onChanged();
    } catch (x) { onError(String(x)); }
  };
  const newCopy = async () => {
    if (itemId === null) return;
    try {
      await api.saveEdits(itemId, edits);
      const name = await api.newVersion(itemId);
      setStatus(`Made a virtual copy, ${name}. Edit it freely: the other versions stay as they are.`);
      loadVersions();
      onChanged();
    } catch (x) { onError(String(x)); }
  };

  if (itemId === null) {
    return (
      <>
        <div className="top"><h1>Edit</h1><span className="sub">Pick a photo to edit. Originals are never changed.</span></div>
        <div className="grid"><div className="tiles">{photos.slice(0, 400).map((p) => <Thumb key={p.id} item={p} onClick={() => onPick(p.id)} />)}</div></div>
      </>
    );
  }

  const idx = photos.findIndex((p) => p.id === itemId);
  const strip = photos.slice(Math.max(0, idx - 8), idx + 12);
  const shown = showBefore && before ? before : rendered;

  const slider = (label: string, key: keyof Edits, min: number, max: number, step = 1, fmt = signed) => {
    const v = edits[key] as number;
    return (
      <label className="slider">
        <div className="row"><span>{label}</span><span className="val" onDoubleClick={() => update({ [key]: 0 } as Partial<Edits>, `${label} reset`)}>{fmt(Math.round(v * 100) / 100)}</span></div>
        <input type="range" min={min} max={max} step={step} value={v}
          onChange={(e) => { const x = Number(e.target.value); update({ [key]: x } as Partial<Edits>, `${label} ${fmt(Math.round(x * 100) / 100)}`, key); }}
          onDoubleClick={() => update({ [key]: 0 } as Partial<Edits>, `${label} reset`)} />
      </label>
    );
  };
  const hsl = (k: 0 | 1 | 2, label: string) => (
    <label className="slider">
      <div className="row"><span>{label}</span><span className="val">{edits.hsl[band][k]}</span></div>
      <input type="range" min={-100} max={100} value={edits.hsl[band][k]} onChange={(e) => {
        const h = edits.hsl.map((b) => [...b] as [number, number, number]);
        h[band][k] = Number(e.target.value);
        update({ hsl: h }, `${BANDS[band]} ${label.toLowerCase()} ${signed(h[band][k])}`, `hsl-${band}-${k}`);
      }} onDoubleClick={() => {
        const h = edits.hsl.map((b) => [...b] as [number, number, number]);
        h[band][k] = 0;
        update({ hsl: h }, `${BANDS[band]} ${label.toLowerCase()} reset`);
      }} />
    </label>
  );

  return (
    <>
      <div className="top slim">
        <span className="muted">{item?.taken_at ? dateTimeLabel(item.taken_at) : ""} ›</span>
        <b>{item ? fileName(item.path) : ""}</b>
        <div className="row" style={{ marginLeft: "auto" }}>
          <div className="seg text" role="group" aria-label="Tools">
            <button className={tool === "none" ? "on" : ""} onClick={() => setTool("none")}>Adjust</button>
            <button className={tool === "heal" ? "on" : ""} title="Spot removal (Q)" onClick={() => setTool(tool === "heal" ? "none" : "heal")}>Heal · Q</button>
            <button className={tool === "mask" ? "on" : ""} title="Masks (M)" onClick={() => setTool(tool === "mask" ? "none" : "mask")}>Masks · M</button>
          </div>
          <button className="btn" onMouseDown={() => toggleBefore(true)} onMouseUp={() => toggleBefore(false)} onMouseLeave={() => showBefore && toggleBefore(false)}>Hold for before</button>
          <div className="seg" role="group" aria-label="Undo and redo">
            <button aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={hist.pos <= 0} onClick={undo}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
            </button>
            <button aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled={hist.pos >= hist.steps.length - 1} onClick={redo}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
            </button>
          </div>
          <button className="btn" title="Copy settings (Ctrl+Shift+C)" onClick={copy}>Copy settings</button>
          <button className="btn" title="Paste settings (Ctrl+Shift+V)" disabled={!clipboard} onClick={paste}>Paste</button>
          <button className="btn" onClick={() => { setAspect("Original"); update(defaultEdits(), "Reset"); }}>Reset</button>
          <button className="btn danger-ghost" onClick={() => setDeleting(true)} title="Delete (D)">Delete</button>
          <button className="btn pri" onClick={() => setExporting(true)}>Export…</button>
        </div>
      </div>
      {exporting && (
        <ExportDialog ids={[itemId]} onClose={() => setExporting(false)} onError={onError}
          beforeExport={() => api.saveEdits(itemId, edits)} />
      )}
      {deleting && (
        <DeleteDialog
          ids={[itemId]}
          onClose={() => setDeleting(false)}
          onError={onError}
          onDone={() => {
            const next = photos[idx + 1] ?? photos[idx - 1];
            onChanged();
            if (next) onPick(next.id);
          }}
        />
      )}
      <div className="editor">
        <div className="presets">
          <div className="label">Presets</div>
          {presets.map((p) => (
            <div key={p.id} className="preset-row">
              <button className="preset" onClick={() => update({ ...defaultEdits(), ...p.edits, crop: edits.crop, rotate: edits.rotate, straighten: edits.straighten, spots: edits.spots, masks: edits.masks }, `Preset: ${p.name}`)}>{p.name}</button>
              <button className="x" title="Delete preset" onClick={async () => { await api.deletePreset(p.id); setPresets(await api.presets()); }}>×</button>
            </div>
          ))}
          <button className="preset dim" onClick={async () => {
            const name = prompt("Name this preset");
            if (name && name.trim()) { await api.savePreset(name, edits); setPresets(await api.presets()); }
          }}>+ Save current as preset</button>
          <div className="label">Crop and rotate</div>
          <div className="row wrap">
            <button className="btn small" onClick={() => update({ rotate: (edits.rotate + 3) % 4, crop: null }, "Rotate left")}>⟲</button>
            <button className="btn small" onClick={() => update({ rotate: (edits.rotate + 1) % 4, crop: null }, "Rotate right")}>⟳</button>
          </div>
          <div className="row wrap">
            {CROPS.map(([label, r]) => (
              <button key={label} className={`chip small ${aspect === label ? "on" : ""}`} onClick={() => setCrop(label, r)}>{label}</button>
            ))}
          </div>
          {slider("Straighten", "straighten", -45, 45, 0.1, (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}°`)}
          <div className="label">Spot removal</div>
          {tool === "heal" ? (
            <>
              <label className="slider">
                <div className="row"><span>Brush size</span><span className="val">{Math.round(brush * 1000) / 10}%</span></div>
                <input type="range" min={0.005} max={0.12} step={0.001} value={brush}
                  onChange={(e) => { const r = Number(e.target.value); setBrush(r); if (picked !== null && edits.spots[picked]) setSpot(picked, { ...edits.spots[picked], r }); }} />
              </label>
              <p className="muted small">Click a blemish to heal it. Drag the dotted circle to choose where it copies from. Delete removes the chosen spot.</p>
            </>
          ) : (
            <button className="preset dim" onClick={() => setTool("heal")}>{edits.spots.length ? `${edits.spots.length} spot${edits.spots.length === 1 ? "" : "s"} healed · edit` : "Heal spots and dust · Q"}</button>
          )}
          {tool === "heal" && edits.spots.length > 0 && <button className="link" onClick={() => update({ spots: [] }, "Clear spots")}>Clear all {edits.spots.length} spots</button>}
          <div className="label">Masks</div>
          <div className="row wrap">
            <button className="btn small" onClick={() => addMask("radial")}>+ Radial</button>
            <button className="btn small" onClick={() => addMask("linear")}>+ Linear</button>
          </div>
          {edits.masks.map((m, i) => (
            <div key={i} className="preset-row">
              <button className={`preset ${tool === "mask" && picked === i ? "on" : ""}`} onClick={() => { setTool("mask"); setTimeout(() => setPicked(i)); }}>
                {m.kind === "radial" ? "Radial" : "Linear"} {i + 1}{m.invert ? " · inverted" : ""}
              </button>
              <button className="x" title="Remove mask" onClick={() => { update({ masks: edits.masks.filter((_, k) => k !== i) }, "Remove mask"); setPicked(null); }}>×</button>
            </div>
          ))}
          <div className="label">Versions</div>
          {versions.map((v) => (
            <div key={`${v.id}-${v.name}`} className="preset-row">
              <button className={`preset ${v.active ? "on" : ""}`} aria-current={v.active} onClick={() => switchTo(v)}
                onDoubleClick={async () => {
                  const name = prompt("Name this version", v.name);
                  if (name?.trim() && itemId !== null) { await api.renameVersion(itemId, v.active ? null : v.id, name.trim()).catch((e) => onError(String(e))); loadVersions(); }
                }} title="Click to switch, double-click to rename">{v.name}</button>
              {!v.active && v.id !== null && (
                <button className="x" title="Delete this version" onClick={async () => { if (itemId !== null) { await api.deleteVersion(itemId, v.id!).catch((e) => onError(String(e))); loadVersions(); onChanged(); } }}>×</button>
              )}
            </div>
          ))}
          <button className="preset dim" onClick={newCopy}>+ Make a virtual copy</button>
          {status && <p className="muted small status">{status}</p>}
          <div className="label">History</div>
          <ol className="history" aria-label="Edit history">
            {hist.steps.map((st, i) => ({ st, i })).reverse().map(({ st, i }) => (
              <li key={i}>
                <button className={`${i === hist.pos ? "on" : ""} ${i > hist.pos ? "undone" : ""}`} aria-current={i === hist.pos} onClick={() => goTo(i)}>{st.label}</button>
              </li>
            ))}
          </ol>
        </div>
        <div className="stage">
          <div className={`canvas ${tool !== "none" ? "tooling" : ""}`} ref={canvasRef}>
            {shown ? <img ref={imgRef} src={shown.image} alt="" onLoad={measure} /> : <p className="muted">Opening…</p>}
            {shown && box && tool !== "none" && !showBefore && (
              <EditOverlay box={box} crop={edits.crop ?? [0, 0, 1, 1]} tool={tool} spots={edits.spots} masks={edits.masks} selected={picked} brush={brush}
                onSelect={setPicked} onAddSpot={addSpot} onSpot={(i, sp) => setSpot(i, sp)} onMask={(i, m) => setMask(i, m)} />
            )}
            {showBefore && <span className="before-tag">Before</span>}
          </div>
          <div className="filmstrip">
            {strip.map((p) => <Thumb key={p.id} item={p} className={`film ${p.id === itemId ? "sel" : ""}`} onClick={() => onPick(p.id)} />)}
          </div>
        </div>
        <div className="panel">
          <Histogram data={rendered?.histogram ?? []} />
          {tool === "mask" && picked !== null && edits.masks[picked] && (() => {
            const m = edits.masks[picked];
            const ms = (label: string, key: "exposure" | "contrast" | "highlights" | "shadows" | "saturation" | "temperature" | "feather", min: number, max: number, step = 1) => (
              <label className="slider">
                <div className="row"><span>{label}</span><span className="val">{signed(Math.round(m[key] * 100) / 100)}</span></div>
                <input type="range" min={min} max={max} step={step} value={m[key]}
                  onChange={(e) => setMask(picked, { ...m, [key]: Number(e.target.value) }, `Mask ${label.toLowerCase()}`, `mask-${picked}-${key}`)}
                  onDoubleClick={() => setMask(picked, { ...m, [key]: key === "feather" ? 50 : 0 }, `Mask ${label.toLowerCase()} reset`)} />
              </label>
            );
            return (
              <div className="mask-panel">
                <div className="group-title">{m.kind === "radial" ? "Radial" : "Linear"} mask {picked + 1}
                  <button className="link" onClick={removePicked}>Remove</button>
                </div>
                {ms("Exposure", "exposure", -3, 3, 0.05)}
                {ms("Contrast", "contrast", -100, 100)}
                {ms("Highlights", "highlights", -100, 100)}
                {ms("Shadows", "shadows", -100, 100)}
                {ms("Saturation", "saturation", -100, 100)}
                {ms("Temperature", "temperature", -100, 100)}
                {m.kind === "radial" && ms("Feather", "feather", 0, 100)}
                <label className="ex-check"><input type="checkbox" checked={m.invert} onChange={(e) => setMask(picked, { ...m, invert: e.target.checked }, e.target.checked ? "Invert mask" : "Un-invert mask")} /> Invert (change everything outside)</label>
              </div>
            );
          })()}
          <div className="group-title">Light</div>
          {slider("Exposure", "exposure", -3, 3, 0.05)}
          {slider("Contrast", "contrast", -100, 100)}
          {slider("Highlights", "highlights", -100, 100)}
          {slider("Shadows", "shadows", -100, 100)}
          {slider("Whites", "whites", -100, 100)}
          {slider("Blacks", "blacks", -100, 100)}
          <div className="group-title">Colour</div>
          {slider("Temperature", "temperature", -100, 100)}
          {slider("Tint", "tint", -100, 100)}
          {slider("Vibrance", "vibrance", -100, 100)}
          {slider("Saturation", "saturation", -100, 100)}
          <div className="group-title">Presence</div>
          {slider("Clarity", "clarity", -100, 100)}
          {slider("Dehaze", "dehaze", -100, 100)}
          <div className="group-title">Detail</div>
          {slider("Sharpening", "sharpening", 0, 150, 1, String)}
          {slider("Noise reduction", "noise", 0, 100, 1, String)}
          <div className="group-title">Effects</div>
          {slider("Vignette", "vignette", -100, 100)}
          <div className="group-title">Lens corrections</div>
          {slider("Distortion", "distortion", -100, 100)}
          {slider("Chromatic aberration", "fringing", 0, 100, 1, String)}
          {slider("Lens vignetting", "lens_vignette", -100, 100)}
          <div className="group-title">Tone curve <button className="link" onClick={() => update({ curve: [] }, "Tone curve reset")}>Reset</button></div>
          <Curve points={edits.curve} onChange={(curve) => update({ curve }, "Tone curve")} />
          <div className="group-title">HSL</div>
          <div className="row swatches">
            {BAND_COLOURS.map((c, i) => (
              <button key={c} className={`swatch ${band === i ? "on" : ""}`} style={{ background: c }} title={BANDS[i]} onClick={() => setBand(i)} />
            ))}
          </div>
          <div className="muted small">{BANDS[band]}</div>
          {hsl(0, "Hue")}
          {hsl(1, "Saturation")}
          {hsl(2, "Luminance")}
        </div>
      </div>
    </>
  );
}

function Histogram({ data }: { data: number[] }) {
  return (
    <div className="histogram">
      {data.map((v, i) => <div key={i} style={{ height: `${Math.max(2, v * 100)}%` }} />)}
    </div>
  );
}

/** Click to add a point, drag to move, double-click a point to remove it. */
function Curve({ points, onChange }: { points: [number, number][]; onChange: (p: [number, number][]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const W = 260, H = 160;
  const pts: [number, number][] = points.length ? points : [];
  const all: [number, number][] = [[0, 0], ...pts, [1, 1]].sort((a, b) => a[0] - b[0]) as [number, number][];
  const toXY = (p: [number, number]) => [p[0] * W, H - p[1] * H];
  const fromEvent = (e: React.MouseEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const path = all.map((p, i) => `${i ? "L" : "M"}${toXY(p).join(" ")}`).join("");
  return (
    <svg
      ref={ref}
      className="curve"
      viewBox={`0 0 ${W} ${H}`}
      onMouseDown={(e) => {
        const p = fromEvent(e);
        const hit = pts.findIndex((q) => Math.abs(q[0] - p[0]) < 0.04 && Math.abs(q[1] - p[1]) < 0.06);
        if (hit >= 0) return setDrag(hit);
        const next = [...pts, p].sort((a, b) => a[0] - b[0]) as [number, number][];
        onChange(next);
        setDrag(next.findIndex((q) => q === p));
      }}
      onMouseMove={(e) => {
        if (drag === null) return;
        const next = pts.map((q, i) => (i === drag ? fromEvent(e) : q)) as [number, number][];
        onChange(next);
      }}
      onMouseUp={() => setDrag(null)}
      onMouseLeave={() => setDrag(null)}
      onDoubleClick={(e) => {
        const p = fromEvent(e);
        onChange(pts.filter((q) => !(Math.abs(q[0] - p[0]) < 0.04 && Math.abs(q[1] - p[1]) < 0.06)));
      }}
    >
      <path d={`M0 ${H}L${W} 0`} className="diag" />
      {[1, 2, 3].map((k) => <path key={k} d={`M${(W * k) / 4} 0V${H}M0 ${(H * k) / 4}H${W}`} className="grid-line" />)}
      <path d={path} className="line" />
      {pts.map((p, i) => <circle key={i} cx={toXY(p)[0]} cy={toXY(p)[1]} r={5} className="pt" />)}
    </svg>
  );
}
