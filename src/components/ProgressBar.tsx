import { n, Progress } from "../api";

export default function ProgressBar({ label, p }: { label: string; p: Progress }) {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className="progress">
      <div className="row"><b>{label}</b><span className="muted">{n(p.done)} of {n(p.total)}</span></div>
      <div className="bar"><b style={{ width: `${pct}%` }} /></div>
      {p.current && <div className="muted small ellipsis">{p.current}</div>}
    </div>
  );
}
