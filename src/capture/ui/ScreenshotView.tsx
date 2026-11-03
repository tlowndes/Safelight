import { useEffect, useState } from "react";
import { copyImage, fileUrl } from "../platform/desktop";
import { renameCapture, type Capture } from "../services/library";
import { IconBack, IconCopy, IconFolder, IconTrash } from "./icons";
import type { CaptureCtl } from "./useCapture";

export function ScreenshotView({ k, id }: { k: CaptureCtl; id: number }) {
  const [c, setC] = useState<Capture | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void k.refreshCapture(id).then(setC);
  }, [id, k.refreshCapture]);

  if (c === undefined) return <div className="state"><div className="spin" /></div>;
  if (c === null) {
    return (
      <div className="state">
        <h2>Screenshot not found</h2>
        <p>It may have been deleted.</p>
        <button className="btn" onClick={() => k.setView({ name: "library" })}>Back to library</button>
      </div>
    );
  }

  return (
    <>
      <div className="pagehead">
        <button className="btn icon ghost" aria-label="Back to library" onClick={() => k.setView({ name: "library" })}>
          <IconBack />
        </button>
        <input
          id="shot-title"
          className="title"
          defaultValue={c.title}
          aria-label="Title"
          onBlur={(e) => {
            const title = e.target.value.trim().slice(0, 120) || c.title;
            if (title !== c.title && k.ports) void renameCapture(k.ports.db, c.id, title).then(() => k.refresh());
          }}
        />
        <span className="muted">{c.width}×{c.height}</span>
        <button
          className="btn"
          onClick={() =>
            copyImage(c.filePath).then(
              () => k.toast({ kind: "success", title: "Image copied" }),
              (e) => k.toastError(e),
            )
          }
        >
          <IconCopy /> Copy image
        </button>
        <button className="btn" onClick={() => void k.copyPath(c.filePath)}>Copy path</button>
        <button className="btn" onClick={() => void k.reveal(c.filePath)}>
          <IconFolder /> Show in Explorer
        </button>
        {confirmDelete ? (
          <>
            <button className="btn danger" onClick={() => void k.removeCapture(c)}>Delete file</button>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : (
          <button className="btn icon ghost" aria-label="Delete" onClick={() => setConfirmDelete(true)}>
            <IconTrash />
          </button>
        )}
      </div>
      <div className="viewer">
        <img src={fileUrl(c.filePath)} alt={c.title} />
      </div>
    </>
  );
}
