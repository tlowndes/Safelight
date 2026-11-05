import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import { api, Item, MapPoint, MonthGroup, n, thumbUrl } from "../api";
import Thumb from "../components/Thumb";

type Props = { groups: MonthGroup[]; onShow: (title: string, ids: number[]) => void; onOpenTagging: () => void; onError: (e: string) => void };
type Cam = { k: number; x: number; y: number };
type Cluster = { lon: number; lat: number; ids: number[]; place: string | null };

/** Land outline as an SVG path in degrees: x = longitude + 180, y = 90 - latitude. */
function landPath(topo: Topology): string {
  const land = feature(topo, topo.objects.land) as unknown as { features?: { geometry: { type: string; coordinates: number[][][][] | number[][][] } }[]; geometry?: { type: string; coordinates: number[][][][] | number[][][] } };
  const geoms = land.features ? land.features.map((f) => f.geometry) : land.geometry ? [land.geometry] : [];
  const out: string[] = [];
  for (const g of geoms) {
    const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
    for (const poly of polys) for (const ring of poly) {
      // A ring that wraps the date line jumps across the map: lift the pen there instead of drawing a band.
      out.push(ring.map(([lon, lat], i) => `${i && Math.abs(lon - ring[i - 1][0]) < 180 ? "L" : "M"}${(lon + 180).toFixed(2)} ${(90 - lat).toFixed(2)}`).join("") + "Z");
    }
  }
  return out.join("");
}

/** Photos on a world map, from the GPS in each photo. Works offline: the outline ships with the app. */
export default function MapView({ groups, onShow, onOpenTagging, onError }: Props) {
  const [points, setPoints] = useState<MapPoint[] | null>(null);
  const [land, setLand] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [cam, setCam] = useState<Cam | null>(null);
  const [chosen, setChosen] = useState<Cluster | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => { api.mapPoints().then(setPoints).catch((e) => { onError(String(e)); setPoints([]); }); }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    import("world-atlas/land-50m.json").then((m) => setLand(landPath((m.default ?? m) as unknown as Topology))).catch(() => {});
  }, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const base = Math.max(size.w / 360, size.h / 180);
  // Until the user pans or zooms, keep the photos framed (and re-frame when the window resizes).
  const fit = useMemo((): Cam => {
    if (!points?.length) return { k: 1, x: (size.w - 360 * base) / 2, y: (size.h - 180 * base) / 2 };
    const xs = points.map((p) => p.lon + 180), ys = points.map((p) => 90 - p.lat);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min(60, Math.max(1, Math.min(size.w / ((x1 - x0 + 4) * base), size.h / ((y1 - y0 + 4) * base)) * 0.8));
    return { k, x: size.w / 2 - ((x0 + x1) / 2) * base * k, y: size.h / 2 - ((y0 + y1) / 2) * base * k };
  }, [points, size.w, size.h, base]);
  const c = cam ?? fit;
  const sx = (lon: number) => (lon + 180) * base * c.k + c.x;
  const sy = (lat: number) => (90 - lat) * base * c.k + c.y;

  // Group nearby photos into one bubble, by a grid in screen space that follows the zoom.
  const clusters = useMemo(() => {
    if (!points) return [];
    const cell = 46 / (base * c.k);
    const m = new Map<string, Cluster & { sl: number; sa: number }>();
    for (const p of points) {
      const key = `${Math.floor((p.lon + 180) / cell)}:${Math.floor((90 - p.lat) / cell)}`;
      const cl = m.get(key);
      if (cl) { cl.ids.push(p.id); cl.sl += p.lon; cl.sa += p.lat; cl.place ??= p.place; }
      else m.set(key, { lon: 0, lat: 0, ids: [p.id], place: p.place, sl: p.lon, sa: p.lat });
    }
    return [...m.values()].map((cl) => ({ ids: cl.ids, place: cl.place, lon: cl.sl / cl.ids.length, lat: cl.sa / cl.ids.length }));
  }, [points, c.k, base]);

  const zoomAt = (mx: number, my: number, f: number) => {
    const k = Math.min(400, Math.max(1, c.k * f));
    const r = k / c.k;
    setCam({ k, x: mx - (mx - c.x) * r, y: my - (my - c.y) * r });
  };
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0018));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const byId = useMemo(() => new Map(groups.flatMap((g) => g.items).map((i) => [i.id, i])), [groups]);
  const chosenItems = (chosen?.ids.map((id) => byId.get(id)).filter(Boolean) ?? []) as Item[];
  const title = (cl: Cluster) => cl.place?.split(",")[0] ?? `${cl.lat.toFixed(2)}, ${cl.lon.toFixed(2)}`;

  return (
    <>
      <div className="top">
        <h1>Map</h1>
        <span className="sub">{points ? `${n(points.length)} photos with a location` : "Loading…"}</span>
        <div className="row" style={{ marginLeft: "auto", gap: 6 }}>
          <button className="btn small" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.6)} aria-label="Zoom in">+</button>
          <button className="btn small" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.6)} aria-label="Zoom out">−</button>
          <button className="btn small" onClick={() => setCam(null)}>Fit</button>
        </div>
      </div>
      <div className={`map-body ${chosen ? "with-side" : ""}`}>
        <div ref={wrap} className="map" onPointerDown={(e) => { drag.current = { px: e.clientX, py: e.clientY, x: c.x, y: c.y, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) d.moved = true;
            if (d.moved) setCam({ k: c.k, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py });
          }}
          onPointerUp={() => setTimeout(() => { drag.current = null; })}>
          <svg width={size.w} height={size.h}>
            <rect className="sea" width={size.w} height={size.h} />
            <g transform={`translate(${c.x} ${c.y}) scale(${base * c.k})`}>
              <path className="land" d={land} />
            </g>
            {clusters.map((cl) => {
              const r = Math.min(26, 9 + Math.sqrt(cl.ids.length) * 2.2);
              const on = chosen && chosen.ids[0] === cl.ids[0];
              return (
                <g key={`${cl.ids[0]}-${cl.ids.length}`} className={`pin ${on ? "on" : ""}`} transform={`translate(${sx(cl.lon)} ${sy(cl.lat)})`}
                  onClick={() => { if (!drag.current?.moved) setChosen(cl); }}>
                  <title>{`${title(cl)} · ${cl.ids.length} photo${cl.ids.length === 1 ? "" : "s"}`}</title>
                  <circle r={r} />
                  <text dy="0.35em">{cl.ids.length > 999 ? `${Math.round(cl.ids.length / 1000)}k` : cl.ids.length}</text>
                </g>
              );
            })}
          </svg>
          {points && points.length === 0 && (
            <div className="map-empty card">
              <b>No photos on the map yet</b>
              <p className="muted small">Safelight reads locations from the GPS in your photos while smart tagging runs. Nothing is looked up online.</p>
              <button className="btn pri" onClick={onOpenTagging}>Go to People & places</button>
            </div>
          )}
        </div>
        {chosen && (
          <aside className="map-side">
            <div className="row">
              <b className="ellipsis">{title(chosen)}</b>
              <button className="icon-btn" aria-label="Close" onClick={() => setChosen(null)}>×</button>
            </div>
            <span className="muted small">{chosen.place ?? "Unnamed place"} · {n(chosen.ids.length)} photo{chosen.ids.length === 1 ? "" : "s"}</span>
            <button className="btn pri" onClick={() => onShow(title(chosen), chosen.ids)}>Show in library</button>
            <div className="map-thumbs">
              {chosenItems.slice(0, 120).map((i) => thumbUrl(i) && <Thumb key={i.id} item={i} onClick={() => onShow(title(chosen), chosen.ids)} />)}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
