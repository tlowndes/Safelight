/**
 * Full-desktop overlay: drag to select a region, Enter or release to confirm,
 * Esc to cancel. Reports the rectangle in physical screen pixels.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { sendRegion } from "../platform/desktop";

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const norm = (d: Drag) => ({
  x: Math.min(d.x0, d.x1),
  y: Math.min(d.y0, d.y1),
  w: Math.abs(d.x1 - d.x0),
  h: Math.abs(d.y1 - d.y0),
});

export function RegionPicker({ purpose }: { purpose: string }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const done = useRef(false);

  async function finish(d: Drag | null) {
    if (done.current) return;
    done.current = true;
    const win = getCurrentWindow();
    if (!d) {
      await sendRegion(purpose, null);
    } else {
      const r = norm(d);
      if (r.w < 8 || r.h < 8) {
        done.current = false;
        setDrag(null);
        return;
      }
      const [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
      await sendRegion(purpose, {
        x: Math.round(origin.x + r.x * scale),
        y: Math.round(origin.y + r.y * scale),
        w: Math.round(r.w * scale),
        h: Math.round(r.h * scale),
      });
    }
    await win.close();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void finish(null);
      if (e.key === "Enter" && drag) void finish(drag);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const r = drag ? norm(drag) : null;
  const scale = window.devicePixelRatio || 1;
  return (
    <div
      className="region"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onPointerMove={(e) => drag && e.buttons === 1 && setDrag({ ...drag, x1: e.clientX, y1: e.clientY })}
      onPointerUp={() => drag && void finish(drag)}
      onContextMenu={(e) => {
        e.preventDefault();
        void finish(null);
      }}
    >
      <div className="help">
        Drag to select {purpose === "record" ? "the area to record" : "an area"} · Esc to cancel
      </div>
      {r && (
        <>
          <div className="sel" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
          <div className="dims" style={{ left: r.x, top: Math.max(4, r.y - 26) }}>
            {Math.round(r.w * scale)} × {Math.round(r.h * scale)}
          </div>
        </>
      )}
    </div>
  );
}
