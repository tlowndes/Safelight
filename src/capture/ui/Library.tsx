import { formatDuration } from "../core/time";
import { fileUrl } from "../platform/desktop";
import type { Capture } from "../services/library";
import type { CaptureCtl } from "./useCapture";

function TranscriptPill({ c }: { c: Capture }) {
  if (c.kind !== "video") return null;
  switch (c.transcriptStatus) {
    case "ready":
      return <span className="pill ok">Transcript</span>;
    case "pending":
      return <span className="pill warn">Transcribing…</span>;
    case "failed":
      return <span className="pill rec">Transcript failed</span>;
    case "unavailable":
      return <span className="pill grey">No transcript</span>;
    default:
      return null;
  }
}

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

export function Library({ k }: { k: CaptureCtl }) {
  const searching = k.search.trim().length > 0;

  return (
    <>
      <div className="libtop">
        <input
          id="capture-search"
          className="field"
          type="search"
          placeholder="Search titles and transcripts…"
          value={k.search}
          onChange={(e) => k.setSearch(e.target.value)}
          aria-label="Search captures"
        />
      </div>

      {k.listLoading ? (
        <div className="grid" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="card skeleton">
              <div className="thumb" />
              <div className="meta">
                <div className="skel" style={{ width: "80%" }} />
                <div className="skel" style={{ width: "50%" }} />
              </div>
            </div>
          ))}
        </div>
      ) : k.captures.length === 0 ? (
        searching ? (
          <div className="state">
            <h2>Nothing matches “{k.search.trim()}”</h2>
            <p>Search looks at titles and transcripts. Try fewer words.</p>
            <div className="acts">
              <button className="btn" onClick={() => k.setSearch("")}>Clear search</button>
            </div>
          </div>
        ) : (
          <div className="state">
            <h2>No captures yet</h2>
            <p>
              Press <span className="kbd">Ctrl+Shift+5</span> to record, or <span className="kbd">Ctrl+Shift+4</span> for a
              screenshot. Everything is saved to {k.config?.dataDir}.
            </p>
            <div className="acts">
              <button className="btn primary" disabled={!k.ffmpegOk} onClick={() => void k.startRecording()}>Start recording</button>
              <button className="btn" disabled={!k.ffmpegOk} onClick={() => void k.takeScreenshot("region")}>Take a screenshot</button>
            </div>
          </div>
        )
      ) : (
        <div className="grid">
          {k.captures.map((c) => (
            <button
              key={c.id}
              className="card"
              onClick={() => k.setView(c.kind === "video" ? { name: "editor", id: c.id } : { name: "screenshot", id: c.id })}
            >
              <div className="thumb">
                {c.posterPath && <img src={fileUrl(c.posterPath)} alt="" loading="lazy" />}
                {c.kind === "video" ? <span className="len">{formatDuration(c.durationMs)}</span> : null}
              </div>
              <div className="meta">
                <b title={c.title}>{c.title}</b>
                <small>
                  {when(c.createdAt)}
                  {c.kind === "screenshot" ? ` · PNG ${c.width}×${c.height}` : null}
                  <TranscriptPill c={c} />
                </small>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
