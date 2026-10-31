import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, dateTimeLabel, defaultEdits, Edits, fileName, Item, MonthGroup, Preset, Rendered } from "../api";
import Thumb from "../components/Thumb";

type Props = { itemId: number | null; groups: MonthGroup[]; onPick: (id: number) => void; onError: (e: string) => void; onChanged: () => void };

const BANDS = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];
const BAND_COLOURS = ["#e5533d", "#f08c35", "#f2c94c", "#6fbf5e", "#3fb0c9", "#4a72d8", "#9a5bd1", "#d659a8"];
const CROPS: [string, number | null][] = [["Original", null], ["1:1", 1], ["4:5", 4 / 5], ["3:2", 3 / 2], ["16:9", 16 / 9]];

let clipboard: Edits | null = null;

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
  const [status, setStatus] = useState("");
  const inflight = useRef(false);
  const pending = useRef<Edits | null>(null);
  const loaded = useRef<number | null>(null);

  useEffect(() => { api.presets().then(setPresets).catch((e) => onError(String(e))); }, []);

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

  const update = (patch: Partial<Edits>) => {
    const next = { ...edits, ...patch };
    setEdits(next);
    render(next);
  };

  const toggleBefore = async (on: boolean) => {
    setShowBefore(on);
    if (on && !before && itemId !== null) setBefore(await api.renderPreview(itemId, { ...defaultEdits(), rotate: edits.rotate, crop: edits.crop }));
  };

  const setCrop = (label: string, ratio: number | null) => {
    setAspect(label);
    if (!ratio || !item?.width || !item?.height) return update({ crop: null });
    const turned = edits.rotate % 2 === 1;
    const w = turned ? item.height : item.width;
    const h = turned ? item.width : item.height;
    const current = w / h;
    // Largest centred rectangle with the chosen shape.
    const crop: [number, number, number, number] = ratio > current ? [0, (1 - current / ratio) / 2, 1, current / ratio] : [(1 - ratio / current) / 2, 0, ratio / current, 1];
    update({ crop });
  };

  const doExport = async (maxEdge: number | null) => {
    if (!item || itemId === null) return;
    const base = fileName(item.path).replace(/\.[^.]+$/, "");
    const path = await save({ defaultPath: `${base} edited.jpg`, filters: [{ name: "JPEG", extensions: ["jpg"] }] });
    if (!path) return;
    setExporting(true);
    try {
      await api.exportImage(itemId, edits, path, maxEdge);
      setStatus(`Exported to ${path}`);
    } catch (e) {
      onError(String(e));
    } finally {
      setExporting(false);
    }
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

  const slider = (label: string, key: keyof Edits, min: number, max: number, step = 1, fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`)) => {
    const v = edits[key] as number;
    return (
      <label className="slider">
        <div className="row"><span>{label}</span><span className="val" onDoubleClick={() => update({ [key]: 0 } as Partial<Edits>)}>{fmt(Math.round(v * 100) / 100)}</span></div>
        <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => update({ [key]: Number(e.target.value) } as Partial<Edits>)} onDoubleClick={() => update({ [key]: 0 } as Partial<Edits>)} />
      </label>
    );
  };
  const hsl = (k: 0 | 1 | 2, label: string) => (
    <label className="slider">
      <div className="row"><span>{label}</span><span className="val">{edits.hsl[band][k]}</span></div>
      <input type="range" min={-100} max={100} value={edits.hsl[band][k]} onChange={(e) => {
        const h = edits.hsl.map((b) => [...b] as [number, number, number]);
        h[band][k] = Number(e.target.value);
        update({ hsl: h });
      }} onDoubleClick={() => {
        const h = edits.hsl.map((b) => [...b] as [number, number, number]);
        h[band][k] = 0;
        update({ hsl: h });
      }} />
    </label>
  );

  return (
    <>
      <div className="top slim">
        <span className="muted">{item?.taken_at ? dateTimeLabel(item.taken_at) : ""} ›</span>
        <b>{item ? fileName(item.path) : ""}</b>
        <div className="row" style={{ marginLeft: "auto" }}>
          <button className="btn" onMouseDown={() => toggleBefore(true)} onMouseUp={() => toggleBefore(false)} onMouseLeave={() => showBefore && toggleBefore(false)}>Hold for before</button>
          <button className="btn" onClick={() => { clipboard = edits; setStatus("Settings copied"); }}>Copy settings</button>
          <button className="btn" disabled={!clipboard} onClick={() => clipboard && update({ ...clipboard, crop: edits.crop, rotate: edits.rotate })}>Paste</button>
          <button className="btn" onClick={() => { setAspect("Original"); update(defaultEdits()); }}>Reset</button>
          <button className="btn" disabled={exporting} onClick={() => doExport(2048)}>Export for web</button>
          <button className="btn pri" disabled={exporting} onClick={() => doExport(null)}>{exporting ? "Exporting…" : "Export"}</button>
        </div>
      </div>
      <div className="editor">
        <div className="presets">
          <div className="label">Presets</div>
          {presets.map((p) => (
            <div key={p.id} className="preset-row">
              <button className="preset" onClick={() => update({ ...p.edits, crop: edits.crop, rotate: edits.rotate })}>{p.name}</button>
              <button className="x" title="Delete preset" onClick={async () => { await api.deletePreset(p.id); setPresets(await api.presets()); }}>×</button>
            </div>
          ))}
          <button className="preset dim" onClick={async () => {
            const name = prompt("Name this preset");
            if (name && name.trim()) { await api.savePreset(name, edits); setPresets(await api.presets()); }
          }}>+ Save current as preset</button>
          <div className="label">Crop and rotate</div>
          <div className="row wrap">
            <button className="btn small" onClick={() => update({ rotate: (edits.rotate + 3) % 4, crop: null })}>⟲</button>
            <button className="btn small" onClick={() => update({ rotate: (edits.rotate + 1) % 4, crop: null })}>⟳</button>
          </div>
          <div className="row wrap">
            {CROPS.map(([label, r]) => (
              <button key={label} className={`chip small ${aspect === label ? "on" : ""}`} onClick={() => setCrop(label, r)}>{label}</button>
            ))}
          </div>
          {status && <p className="muted small status">{status}</p>}
        </div>
        <div className="stage">
          <div className="canvas">
            {shown ? <img src={shown.image} alt="" /> : <p className="muted">Opening…</p>}
            {showBefore && <span className="before-tag">Before</span>}
          </div>
          <div className="filmstrip">
            {strip.map((p) => <Thumb key={p.id} item={p} className={`film ${p.id === itemId ? "sel" : ""}`} onClick={() => onPick(p.id)} />)}
          </div>
        </div>
        <div className="panel">
          <Histogram data={rendered?.histogram ?? []} />
          <div className="group-title">Light</div>
          {slider("Exposure", "exposure", -3, 3, 0.05)}
          {slider("Contrast", "contrast", -100, 100)}
          {slider("Highlights", "highlights", -100, 100)}
          {slider("Shadows", "shadows", -100, 100)}
          <div className="group-title">Colour</div>
          {slider("Temperature", "temperature", -100, 100)}
          {slider("Tint", "tint", -100, 100)}
          {slider("Vibrance", "vibrance", -100, 100)}
          {slider("Saturation", "saturation", -100, 100)}
          <div className="group-title">Tone curve <button className="link" onClick={() => update({ curve: [] })}>Reset</button></div>
          <Curve points={edits.curve} onChange={(curve) => update({ curve })} />
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
