import { useState } from "react";
import { api, dateTimeLabel, fileName, fileUrl, Item, n } from "../api";

type Layout = "one" | "two" | "four" | "contact" | "book";
type Props = { items: Item[]; onClose: () => void; onError: (e: string) => void };

const LAYOUTS: { key: Layout; name: string; note: string }[] = [
  { key: "one", name: "One per page", note: "Full page, with a small margin" },
  { key: "two", name: "Two per page", note: "Stacked or side by side" },
  { key: "four", name: "Four per page", note: "A 2 × 2 grid" },
  { key: "contact", name: "Contact sheet", note: "Small prints with file names" },
  { key: "book", name: "Book", note: "Title page, then one photo a page with its caption" },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Print photos with their edits, or lay them out as a simple book (print to PDF to keep one). */
export default function PrintDialog({ items, onClose, onError }: Props) {
  const photos = items.filter((i) => i.kind === "photo");
  const [layout, setLayout] = useState<Layout>(photos.length === 1 ? "one" : "four");
  const [paper, setPaper] = useState<"A4" | "Letter">("A4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [title, setTitle] = useState("");
  const [captions, setCaptions] = useState(true);
  const [busy, setBusy] = useState(false);

  const print = async () => {
    setBusy(true);
    try {
      const edge = layout === "contact" ? 800 : layout === "one" || layout === "book" ? 3000 : 1800;
      const paths = await api.renderForPrint(photos.map((p) => p.id), edge);
      const caps = await Promise.all(photos.map(async (p) => {
        if (!captions) return "";
        const d = await api.photoDetails(p.id).catch(() => null);
        return d?.details.caption || (layout === "book" ? dateTimeLabel(p.taken_at) : fileName(p.path));
      }));
      const per = layout === "one" || layout === "book" ? 1 : layout === "two" ? 2 : layout === "four" ? 4 : 20;
      const cols = layout === "four" || (layout === "two" && orientation === "landscape") ? 2 : layout === "contact" ? (orientation === "landscape" ? 5 : 4) : 1;
      const cells = paths.map((p, i) => `<figure><img src="${fileUrl(p)}">${caps[i] ? `<figcaption>${esc(caps[i])}</figcaption>` : ""}</figure>`);
      const pages: string[] = [];
      if (layout === "book") pages.push(`<section class="page title"><h1>${esc(title || "Photos")}</h1><p>${n(photos.length)} photographs</p></section>`);
      for (let i = 0; i < cells.length; i += per) pages.push(`<section class="page" style="grid-template-columns:repeat(${cols},1fr)">${cells.slice(i, i + per).join("")}</section>`);
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || "Safelight print")}</title><style>
        @page { size: ${paper} ${orientation}; margin: ${layout === "book" ? "18mm" : "10mm"}; }
        * { box-sizing: border-box; } body { margin: 0; font: 10pt "Inter", system-ui, sans-serif; color: #111; }
        .page { height: calc(100vh - 1px); display: grid; gap: ${layout === "contact" ? "4mm" : "6mm"}; align-content: ${layout === "contact" ? "start" : "stretch"}; page-break-after: always; break-after: page; }
        .page:last-child { page-break-after: auto; break-after: auto; }
        figure { margin: 0; display: flex; flex-direction: column; min-height: 0; ${layout === "contact" ? "" : "height: 100%;"} }
        img { flex: 1; min-height: 0; width: 100%; object-fit: contain; ${layout === "contact" ? "height: 40mm;" : ""} }
        figcaption { padding-top: 2mm; text-align: center; font-size: ${layout === "contact" ? "7pt" : "9pt"}; color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .title { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
        .title h1 { font-size: 32pt; font-weight: 500; margin: 0 0 4mm; } .title p { color: #666; }
      </style></head><body>${pages.join("")}</body></html>`;
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
      document.body.appendChild(frame);
      const doc = frame.contentDocument!;
      doc.open(); doc.write(html); doc.close();
      const imgs = [...doc.images];
      await Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; }))));
      frame.contentWindow!.focus();
      frame.contentWindow!.print();
      setTimeout(() => frame.remove(), 60_000);
      onClose();
    } catch (e) { onError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal export" role="dialog" aria-label="Print" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="eyebrow">Print and book</div>
        <h2>Print {n(photos.length)} photo{photos.length === 1 ? "" : "s"}</h2>
        <div className="ex-field">
          <div className="label">Layout</div>
          <div className="layout-pick">
            {LAYOUTS.map((l) => (
              <button key={l.key} className={`layout-opt ${layout === l.key ? "on" : ""}`} aria-pressed={layout === l.key} onClick={() => setLayout(l.key)}>
                <i className={`lay ${l.key}`}><b /><b /><b /><b /></i>
                <span><b>{l.name}</b><small>{l.note}</small></span>
              </button>
            ))}
          </div>
        </div>
        {layout === "book" && (
          <label className="ex-field"><div className="label">Book title</div>
            <input className="text-input" value={title} placeholder="Summer 2026" onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        <div className="ex-row">
          <label className="ex-field"><div className="label">Paper</div>
            <select value={paper} onChange={(e) => setPaper(e.target.value as "A4" | "Letter")}><option>A4</option><option>Letter</option></select>
          </label>
          <label className="ex-field"><div className="label">Orientation</div>
            <select value={orientation} onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")}>
              <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
            </select>
          </label>
        </div>
        <label className="ex-check"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} /> Captions under photos (yours, or the file name)</label>
        <p className="muted small">Choose "Microsoft Print to PDF" in the print window to save a PDF instead.</p>
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" onClick={print} disabled={busy || !photos.length}>{busy ? "Preparing…" : "Print…"}</button>
        </div>
      </div>
    </div>
  );
}
