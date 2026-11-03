import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Source = { id: number; name: string; kind: string; root: string; item_count: number; last_scanned: string | null };
export type Item = {
  id: number; source_id: number; path: string; kind: "photo" | "video"; size: number; sha256: string;
  taken_at: string | null; date_source: string | null; width: number | null; height: number | null;
  has_camera: boolean; thumb: string | null; dup_status: string | null; is_reference: boolean | null;
  topic_id: number | null; edited: boolean; has_exact_duplicate: boolean;
  /** 0 = unrated, 1-5 stars */ rating: number; /** 1 pick, -1 reject, 0 none */ flag: number; hidden: boolean;
};
export type MonthGroup = { month: string; items: Item[] };
export type Stats = {
  photos: number; videos: number; total_bytes: number; exact_duplicate_files: number;
  exact_duplicate_groups: number; needing_thumbnails: number; reference: number; hidden: number;
};
export type Progress = { done: number; total: number; current?: string; stage?: string; source_id?: number };
export type ScanReport = { found: number; added: number; updated: number; unchanged: number; removed: number; errors: string[] };
export type DupMember = { item: Item; source_name: string; copies: number };
export type DupGroup = { key: string; members: DupMember[]; best: number; similarity: number };
export type EventSuggestion = { id: number | null; name: string; start_day: string; end_day: string; count: number; sample_thumbs: string[] };
export type PlanSummary = {
  library_root: string | null; backup_root: string | null; to_copy: number; to_copy_bytes: number; already_copied: number;
  photos: number; reference: number; undated: number; reference_suggestions: number; tree: { path: string; count: number }[];
};
export type CopyReport = { copied: number; backed_up: number; skipped: number; errors: string[] };
export type SourceCleanup = { source_id: number; name: string; kind: string; files: number; bytes: number; destination: string };
export type CleanupSummary = { copied: number; backed_up: number; failed: number; sources: SourceCleanup[] };
export type CleanupReport = { binned: number; freed_bytes: number; skipped: number; errors: string[] };
export type DeleteReport = { photos: number; files: number; freed_bytes: number; errors: string[] };
export type UpdateInfo = { current: string; version: string; notes: string; url: string; size: number; page: string };
export type Topic = { id: number; name: string; count: number };
export type Tag = { id: number; name: string; count: number };
export type RefItem = { item: Item; tags: string[] };
export type Edits = {
  exposure: number; contrast: number; highlights: number; shadows: number; temperature: number; tint: number;
  vibrance: number; saturation: number; curve: [number, number][]; hsl: [number, number, number][];
  crop: [number, number, number, number] | null; rotate: number;
};
export type Preset = { id: number; name: string; edits: Edits };
export type Rendered = { image: string; histogram: number[]; width: number; height: number };
export type BackupReport = { backed_up: number; skipped: number; errors: string[]; finished_at: string; automatic: boolean };
export type BackupStatus = {
  backup_root: string | null; weekly: boolean; reachable: boolean; last_run: string | null; next_due: string | null;
  due: boolean; waiting: number; waiting_bytes: number; last_report: BackupReport | null;
};
export type Settings = { library_root: string | null; backup_root: string | null; auto_reference: boolean };

export const defaultEdits = (): Edits => ({
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0,
  curve: [], hsl: Array.from({ length: 8 }, () => [0, 0, 0] as [number, number, number]), crop: null, rotate: 0,
});

const on = <T,>(name: string, cb: (p: T) => void) => listen<T>(name, (e) => cb(e.payload));

export const api = {
  sources: () => invoke<Source[]>("list_sources"),
  addSource: (name: string, kind: string, root: string) => invoke<number>("add_source", { name, kind, root }),
  removeSource: (id: number) => invoke<void>("remove_source", { id }),
  stats: () => invoke<Stats>("stats"),
  library: (limit = 3000) => invoke<MonthGroup[]>("library", { limit }),
  item: (id: number) => invoke<Item | null>("item", { id }),
  scan: (id: number) => invoke<ScanReport>("scan", { id }),
  processThumbnails: () => invoke<number>("process_thumbnails"),
  settings: () => invoke<Settings>("get_settings"),
  setSetting: (key: "library_root" | "backup_root" | "auto_reference" | "auto_backup", value: string) => invoke<void>("set_setting", { key, value }),

  dupGroups: () => invoke<DupGroup[]>("dup_groups"),
  dupResolve: (keep: number[], drop: number[]) => invoke<void>("dup_resolve", { keep, drop }),

  suggestEvents: () => invoke<EventSuggestion[]>("suggest_events"),
  saveEvent: (name: string, startDay: string, endDay: string) => invoke<number>("save_event", { name, startDay, endDay }),
  deleteEvent: (id: number) => invoke<void>("delete_event", { id }),
  referenceSuggestions: () => invoke<Item[]>("reference_suggestions"),
  setReference: (ids: number[], isReference: boolean) => invoke<void>("set_reference", { ids, isReference }),
  planSummary: () => invoke<PlanSummary>("plan_summary"),
  runCopy: () => invoke<CopyReport>("run_copy"),
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  runBackup: () => invoke<BackupReport>("run_backup"),

  cleanupSummary: () => invoke<CleanupSummary>("cleanup_summary"),
  cleanupFiles: (sourceIds: number[]) => invoke<string[]>("cleanup_files", { sourceIds }),
  cleanupRun: (sourceIds: number[]) => invoke<CleanupReport>("cleanup_run", { sourceIds }),
  checkReference: () => invoke<number>("check_reference"),
  appVersion: () => invoke<string>("app_version"),
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  installUpdate: (url: string) => invoke<void>("install_update", { url }),
  onUpdateProgress: (cb: (p: Progress) => void) => on("update-progress", cb),
  deleteItems: (ids: number[]) => invoke<DeleteReport>("delete_items", { ids }),

  topics: () => invoke<Topic[]>("topics"),
  createTopic: (name: string) => invoke<number>("create_topic", { name }),
  renameTopic: (id: number, name: string) => invoke<void>("rename_topic", { id, name }),
  deleteTopic: (id: number) => invoke<void>("delete_topic", { id }),
  setTopic: (ids: number[], topicId: number) => invoke<void>("set_topic", { ids, topicId }),
  tags: () => invoke<Tag[]>("tags"),
  addTag: (ids: number[], name: string) => invoke<void>("add_tag", { ids, name }),
  removeTag: (id: number, name: string) => invoke<void>("remove_tag", { id, name }),
  referenceItems: (topicId: number | null, tag: string | null) => invoke<RefItem[]>("reference_items", { topicId, tag }),

  loadEdits: (id: number) => invoke<Edits>("load_edits", { id }),
  saveEdits: (id: number, edits: Edits) => invoke<void>("save_edits", { id, edits }),
  renderPreview: (id: number, edits: Edits) => invoke<Rendered>("render_preview", { id, edits }),
  exportImage: (id: number, edits: Edits, path: string, maxEdge: number | null) => invoke<string>("export_image", { id, edits, path, maxEdge }),
  presets: () => invoke<Preset[]>("presets"),
  savePreset: (name: string, edits: Edits) => invoke<number>("save_preset", { name, edits }),
  deletePreset: (id: number) => invoke<void>("delete_preset", { id }),

  setRating: (ids: number[], rating: number) => invoke<void>("set_rating", { ids, rating }),
  setFlag: (ids: number[], flag: number) => invoke<void>("set_flag", { ids, flag }),
  setHidden: (ids: number[], hidden: boolean) => invoke<void>("set_hidden", { ids, hidden }),
  hiddenItems: () => invoke<Item[]>("hidden_items"),
  viewImage: (id: number) => invoke<string>("view_image", { id }),

  onScanProgress: (cb: (p: Progress) => void) => on("scan-progress", cb),
  onThumbProgress: (cb: (p: Progress) => void) => on("thumb-progress", cb),
  onCopyProgress: (cb: (p: Progress) => void) => on("copy-progress", cb),
  onBackupProgress: (cb: (p: Progress) => void) => on("backup-progress", cb),
  /** Fires after every backup, including the weekly one: `{ Ok: report }` or `{ Err: message }`. */
  onBackupFinished: (cb: (r: { Ok?: BackupReport; Err?: string }) => void) => on("backup-finished", cb),
  onCleanupProgress: (cb: (p: Progress) => void) => on("cleanup-progress", cb),
  onReferenceMoved: (cb: (n: number) => void) => on("reference-moved", cb),
  onDeleteProgress: (cb: (p: Progress) => void) => on("delete-progress", cb),
};

/** Formats the webview can show straight from disk. */
const VIEWABLE = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
export function thumbUrl(item: Item): string | null {
  if (item.thumb) return convertFileSrc(item.thumb);
  const ext = item.path.split(".").pop()?.toLowerCase() ?? "";
  return item.kind === "photo" && VIEWABLE.includes(ext) ? convertFileSrc(item.path) : null;
}
export const fileUrl = (p: string) => convertFileSrc(p);
/** True when the webview can show the original file at full size. */
export const isViewable = (item: Item) => item.kind === "photo" && VIEWABLE.includes(item.path.split(".").pop()?.toLowerCase() ?? "");

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const fileExt = (path: string) => (path.split(".").pop() ?? "").toUpperCase();

export function monthLabel(month: string) {
  if (month === "undated") return "Undated";
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export function dayLabel(day: string) {
  return new Date(day + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function dateTimeLabel(t: string | null) {
  if (!t) return "No date";
  const d = new Date(t.replace(" ", "T"));
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "3 days ago", "in 2 days", "today" for a UTC "YYYY-MM-DD HH:MM:SS" time. */
export function relDay(utc: string) {
  const t = new Date(utc.replace(" ", "T") + "Z").getTime();
  const days = Math.round((t - Date.now()) / 86400000);
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  if (days === 1) return "tomorrow";
  return days < 0 ? `${-days} days ago` : `in ${days} days`;
}

export function formatBytes(n: number) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}

export const n = (v: number) => v.toLocaleString("en-GB");
