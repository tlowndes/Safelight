import { useRef, useState } from "react";
import { Mask, Spot } from "../api";

type Rect = { left: number; top: number; width: number; height: number };
type Props = {
  /** Where the picture sits inside the canvas, in pixels. */
  box: Rect;
  /** The crop, [x, y, w, h] in the uncropped frame, or the whole frame. */
  crop: [number, number, number, number];
  tool: "heal" | "mask";
  spots: Spot[];
  masks: Mask[];
  selected: number | null;
  brush: number;
  /** The selected sky or subject mask, as a greyscale picture over the uncropped frame. */
  overlay?: string | null;
  onSelect: (i: number | null) => void;
  /** Heal: a click on the picture, in frame coordinates. */
  onAddSpot: (x: number, y: number) => void;
  onSpot: (i: number, s: Spot, done: boolean) => void;
  onMask: (i: number, m: Mask, done: boolean) => void;
};

type Drag = { kind: "spot" | "source" | "c" | "p2" | "rx" | "ry"; index: number; start: { x: number; y: number }; orig: Spot | Mask };

/** Handles drawn on top of the editor preview for spot healing and masks. Everything is
 * stored in the uncropped frame (0..1 across and down), so it survives changing the crop. */
export default function EditOverlay({ box, crop, tool, spots, masks, selected, brush, overlay, onSelect, onAddSpot, onSpot, onMask }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cx, cy, cw, ch] = crop;
  const W = box.width, H = box.height;
  // Frame coordinates <-> pixels on screen.
  const px = (fx: number) => ((fx - cx) / cw) * W;
  const py = (fy: number) => ((fy - cy) / ch) * H;
  const frame = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: cx + ((e.clientX - r.left) / r.width) * cw, y: cy + ((e.clientY - r.top) / r.height) * ch };
  };
  const begin = (e: React.PointerEvent, d: Omit<Drag, "start">) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    onSelect(d.index);
    setDrag({ ...d, start: frame(e) });
  };
  const move = (e: React.PointerEvent, done = false) => {
    if (!drag) return;
    const p = frame(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (drag.kind === "spot" || drag.kind === "source") {
      const s = drag.orig as Spot;
      onSpot(drag.index, drag.kind === "spot" ? { ...s, x: s.x + dx, y: s.y + dy } : { ...s, sx: s.sx + dx, sy: s.sy + dy }, done);
    } else {
      const m = drag.orig as Mask;
      const next =
        drag.kind === "c" ? { ...m, x1: m.x1 + dx, y1: m.y1 + dy, ...(m.kind === "linear" ? { x2: m.x2 + dx, y2: m.y2 + dy } : {}) }
        : drag.kind === "p2" ? { ...m, x2: m.x2 + dx, y2: m.y2 + dy }
        : drag.kind === "rx" ? { ...m, x2: Math.max(0.01, Math.abs(p.x - m.x1)) }
        : { ...m, y2: Math.max(0.01, Math.abs(p.y - m.y1)) };
      onMask(drag.index, next, done);
    }
    if (done) setDrag(null);
  };

  return (
    <svg ref={ref} className={`edit-overlay ${tool}`} style={{ left: box.left, top: box.top, width: W, height: H }}
      onPointerDown={(e) => { if (tool === "heal") { const p = frame(e); onAddSpot(p.x, p.y); } else onSelect(null); }}
      onPointerMove={(e) => move(e)} onPointerUp={(e) => move(e, true)} onPointerCancel={() => setDrag(null)}>
      {tool === "mask" && overlay && (
        <>
          <defs>
            <mask id="smart-mask" maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
              <image href={overlay} x={(-cx / cw) * W} y={(-cy / ch) * H} width={W / cw} height={H / ch} preserveAspectRatio="none" />
            </mask>
          </defs>
          <rect className="smart-tint" width={W} height={H} mask="url(#smart-mask)" />
        </>
      )}
      {tool === "heal" && spots.map((s, i) => {
        const r = (s.r / cw) * W;
        const on = selected === i;
        return (
          <g key={i} className={`spot ${on ? "on" : ""}`}>
            <line x1={px(s.x)} y1={py(s.y)} x2={px(s.sx)} y2={py(s.sy)} />
            <circle className="src" cx={px(s.sx)} cy={py(s.sy)} r={r} onPointerDown={(e) => begin(e, { kind: "source", index: i, orig: s })} />
            <circle className="dst" cx={px(s.x)} cy={py(s.y)} r={r} onPointerDown={(e) => begin(e, { kind: "spot", index: i, orig: s })} />
          </g>
        );
      })}
      {tool === "heal" && <circle className="brush-hint" cx={W - 20 - (brush / cw) * W} cy={20 + (brush / cw) * W} r={(brush / cw) * W} />}
      {tool === "mask" && masks.map((m, i) => {
        const on = selected === i;
        if (m.kind === "sky" || m.kind === "subject") return null;
        if (m.kind === "linear") {
          const [ax, ay, bx, by] = [px(m.x1), py(m.y1), px(m.x2), py(m.y2)];
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const [nx, ny] = [(-(by - ay) / len) * 2000, ((bx - ax) / len) * 2000];
          return (
            <g key={i} className={`mask ${on ? "on" : ""}`}>
              <line x1={ax - nx} y1={ay - ny} x2={ax + nx} y2={ay + ny} />
              <line className="dash" x1={(ax + bx) / 2 - nx} y1={(ay + by) / 2 - ny} x2={(ax + bx) / 2 + nx} y2={(ay + by) / 2 + ny} />
              <line x1={bx - nx} y1={by - ny} x2={bx + nx} y2={by + ny} />
              <line className="axis" x1={ax} y1={ay} x2={bx} y2={by} />
              <circle className="handle" cx={ax} cy={ay} r={7} onPointerDown={(e) => begin(e, { kind: "c", index: i, orig: m })} />
              <circle className="handle small" cx={bx} cy={by} r={5} onPointerDown={(e) => begin(e, { kind: "p2", index: i, orig: m })} />
            </g>
          );
        }
        const [ex, ey, rx, ry] = [px(m.x1), py(m.y1), (m.x2 / cw) * W, (m.y2 / ch) * H];
        const f = Math.max(0.01, m.feather / 100);
        return (
          <g key={i} className={`mask ${on ? "on" : ""}`}>
            <ellipse cx={ex} cy={ey} rx={rx} ry={ry} />
            <ellipse className="dash" cx={ex} cy={ey} rx={rx * (1 - f)} ry={ry * (1 - f)} />
            <circle className="handle" cx={ex} cy={ey} r={7} onPointerDown={(e) => begin(e, { kind: "c", index: i, orig: m })} />
            <circle className="handle small" cx={ex + rx} cy={ey} r={5} onPointerDown={(e) => begin(e, { kind: "rx", index: i, orig: m })} />
            <circle className="handle small" cx={ex} cy={ey + ry} r={5} onPointerDown={(e) => begin(e, { kind: "ry", index: i, orig: m })} />
          </g>
        );
      })}
    </svg>
  );
}
