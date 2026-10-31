import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Source = { id: number; name: string; kind: string; root: string; item_count: number; last_scanned: string | null };
export type Item = {
  id: number; source_id: number; path: string; kind: "photo" | "video"; size: number; sha256: string;
  taken_at: string | null; date_source: string | null; has_exact_duplicate: boolean;
};
export type MonthGroup = { month: string; items: Item[] };
export type Stats = { photos: number; videos: number; total_bytes: number; exact_duplicate_files: number; exact_duplicate_groups: number };
export type ScanProgress = { source_id: number; done: number; total: number; current: string };
export type ScanReport = { found: number; added: number; updated: number; unchanged: number; removed: number; errors: string[] };

export const api = {
  sources: () => invoke<Source[]>("list_sources"),
  addSource: (name: string, kind: string, root: string) => invoke<number>("add_source", { name, kind, root }),
  removeSource: (id: number) => invoke<void>("remove_source", { id }),
  stats: () => invoke<Stats>("stats"),
  library: (limit = 2000) => invoke<MonthGroup[]>("library", { limit }),
  scan: (id: number) => invoke<ScanReport>("scan", { id }),
  onScanProgress: (cb: (p: ScanProgress) => void) => listen<ScanProgress>("scan-progress", (e) => cb(e.payload)),
};

/** Formats the webview can show directly. HEIC, RAW and video get a placeholder until thumbnails land. */
const VIEWABLE = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
export function previewUrl(item: Item): string | null {
  const ext = item.path.split(".").pop()?.toLowerCase() ?? "";
  return item.kind === "photo" && VIEWABLE.includes(ext) ? convertFileSrc(item.path) : null;
}

export function fileExt(path: string) {
  return (path.split(".").pop() ?? "").toUpperCase();
}

export function monthLabel(month: string) {
  if (month === "undated") return "Undated";
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function formatBytes(n: number) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
