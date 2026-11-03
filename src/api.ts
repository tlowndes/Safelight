import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Source = { id: number; name: string; kind: string; root: string; item_count: number; last_scanned: string | null };
export type Item = {
  id: number; source_id: number; path: string; kind: "photo" | "video"; size: number; sha256: string;
  taken_at: string | null; date_source: string | null; width: number | null; height: number | null;
  has_camera: boolean; thumb: string | null; dup_status: string | null; is_reference: boolean | null;
  topic_id: number | null; edited: boolean; has_exact_duplicate: boolean;
  /** 0 = unrated, 1-5 stars */ rating: number; /** 1 pick, -1 reject, 0 none */ flag: number; hidden: boolean;
  /** Exact-copy decision: null = not reviewed */ copy_status: "keep" | "spare" | null;
};
export type MonthGroup = { month: string; items: Item[] };
export type Stats = {
  photos: number; videos: number; total_bytes: number; exact_duplicate_files: number;
  exact_duplicate_groups: number; needing_thumbnails: number; reference: number; hidden: number;
  /** Exact-copy groups still waiting for a keep decision */ exact_to_review: number;
};
export type Progress = { done: number; total: number; current?: string; stage?: string; source_id?: number };
export type ScanReport = { found: number; added: number; updated: number; unchanged: number; removed: number; errors: string[] };
export type DupMember = { item: Item; source_name: string; source_kind: string; copies: number };
export type ExactCopy = { item: Item; source_name: string; source_kind: string; keep: boolean };
export type ExactGroup = { sha256: string; copies: ExactCopy[]; decided: boolean };
export type SpareSummary = { files: number; bytes: number; sources: { source_id: number; name: string; kind: string; files: number; bytes: number }[] };
export type MoveReport = { batch: number; moved: number; bytes: number; skipped: number; errors: string[] };
export type MoveBatch = { batch: number; at: string; files: number; bytes: number; undone: number };
export type UndoReport = { restored: number; errors: string[]; source_ids: number[] };
/** A folder inside a source; path is relative to the source root with "/" between parts, "" for the root. */
export type FolderRef = { source_id: number; path: string };
export type FolderNode = FolderRef & { name: string; depth: number; count: number };
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
export type RefItem = { item: Item; tags: string[]; /** suggested by smart tagging */ smart_tags: string[] };
export type Edits = {
  exposure: number; contrast: number; highlights: number; shadows: number; temperature: number; tint: number;
  vibrance: number; saturation: number; curve: [number, number][]; hsl: [number, number, number][];
  crop: [number, number, number, number] | null; rotate: number;
};
export type Preset = { id: number; name: string; edits: Edits };
export type Rendered = { image: string; histogram: number[]; width: number; height: number };
export type Settings = { library_root: string | null; backup_root: string | null; auto_reference: boolean; smart_tagging: boolean };
export type ModelFile = { file: string; purpose: string; url: string; size_mb: number };
export type SmartState = {
  models_ready: boolean; missing: ModelFile[]; download_mb: number; total: number; analysed: number; located: number;
  faces: number; people: number; named: number; running: boolean; enabled: boolean;
};
export type Person = { id: number; name: string | null; photos: number; cover: string | null };
export type FaceRow = { id: number; crop: string | null; item_id: number };
export type PlaceCount = { country: string; town: string | null; count: number };
export type TagCount = { name: string; count: number };
export type ItemSmart = { people: string[]; faces: number; place: string | null; tags: string[] };
export type TopicSuggestion = { item_id: number; topic_id: number; topic: string };
export type BackupReport = { backed_up: number; skipped: number; errors: string[]; finished_at: string; automatic: boolean };
export type BackupStatus = {
  backup_root: string | null; weekly: boolean; reachable: boolean; last_run: string | null; next_due: string | null;
  due: boolean; waiting: number; waiting_bytes: number; last_report: BackupReport | null;
};
export type ShotSuggestion = {
  path: string; category: string; app: string | null; title: string; confidence: number; engine: "device" | "claude";
  date: string; description: string; new_name: string; note: string | null; text: string; found: string;
};
export type ShotMove = { id: number; at: string; from: string; to: string; category: string; name: string; engine: string; confidence: number; auto: boolean; undone: boolean };
export type ShotSettings = {
  folder: string; destination: string; watch: boolean; reader: "device" | "claude"; claude_model: "best" | "cheapest";
  has_api_key: boolean; auto_file: boolean; sureness: "careful" | "balanced" | "relaxed"; date_prefix: boolean;
};
export type ShotCategory = { id: string; label: string; folder: string };
export type ShotInfo = { settings: ShotSettings; categories: ShotCategory[]; ocr: boolean; waiting: number };
export type ShotSettingKey = "folder" | "destination" | "watch" | "reader" | "claude_model" | "auto_file" | "sureness" | "date_prefix";

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
  library: (limit = 3000, folder: FolderRef | null = null) => invoke<MonthGroup[]>("library", { limit, folder }),
  folderTree: () => invoke<FolderNode[]>("folder_tree"),
  item: (id: number) => invoke<Item | null>("item", { id }),
  scan: (id: number) => invoke<ScanReport>("scan", { id }),
  processThumbnails: () => invoke<number>("process_thumbnails"),
  settings: () => invoke<Settings>("get_settings"),
  setSetting: (key: "library_root" | "backup_root" | "auto_reference" | "auto_backup" | "smart_tagging", value: string) => invoke<void>("set_setting", { key, value }),

  dupGroups: () => invoke<DupGroup[]>("dup_groups"),
  dupResolve: (keep: number[], drop: number[]) => invoke<void>("dup_resolve", { keep, drop }),
  exactGroups: () => invoke<ExactGroup[]>("exact_groups"),
  exactResolve: (sha256: string, keep: number[]) => invoke<void>("exact_resolve", { sha256, keep }),
  exactKeepPreferredAll: () => invoke<number>("exact_keep_preferred_all"),
  exactReset: (sha256: string) => invoke<void>("exact_reset", { sha256 }),
  spareSummary: () => invoke<SpareSummary>("spare_summary"),
  moveSpares: () => invoke<MoveReport>("move_spares"),
  moveBatches: () => invoke<MoveBatch[]>("move_batches"),
  undoMoves: (batch: number) => invoke<UndoReport>("undo_moves", { batch }),
  onMoveProgress: (cb: (p: Progress) => void) => on("move-progress", cb),

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

  smartStatus: () => invoke<SmartState>("smart_status"),
  downloadModels: () => invoke<void>("download_models"),
  runSmart: () => invoke<number>("run_smart"),
  stopSmart: () => invoke<void>("stop_smart"),
  smartSearch: (query: string) => invoke<number[]>("smart_search", { query }),
  similar: (id: number) => invoke<Item[]>("similar", { id }),
  people: () => invoke<Person[]>("people"),
  personFaces: (id: number) => invoke<FaceRow[]>("person_faces", { id }),
  personItems: (id: number) => invoke<Item[]>("person_items", { id }),
  namePerson: (id: number, name: string) => invoke<number>("name_person", { id, name }),
  mergePeople: (from: number, into: number) => invoke<void>("merge_people", { from, into }),
  removeFace: (id: number) => invoke<void>("remove_face", { id }),
  hidePerson: (id: number) => invoke<void>("hide_person", { id }),
  places: () => invoke<PlaceCount[]>("places"),
  smartTags: (kind: "scene" | "design") => invoke<TagCount[]>("smart_tags", { kind }),
  itemSmart: (id: number) => invoke<ItemSmart>("item_smart", { id }),
  topicSuggestions: () => invoke<TopicSuggestion[]>("topic_suggestions"),
  onModelProgress: (cb: (p: Progress) => void) => on("model-progress", cb),
  onSmartProgress: (cb: (p: Progress) => void) => on("smart-progress", cb),
  shotInfo: () => invoke<ShotInfo>("shot_info"),
  shotSet: (key: ShotSettingKey, value: string) => invoke<void>("shot_set", { key, value }),
  shotSetApiKey: (apiKey: string) => invoke<void>("shot_set_api_key", { apiKey }),
  shotQueue: () => invoke<ShotSuggestion[]>("shot_queue"),
  shotFile: (path: string, edits: { category?: string; description?: string }) => invoke<ShotMove>("shot_file", { path, edits }),
  shotLeave: (path: string) => invoke<void>("shot_leave", { path }),
  shotUndo: (id: number) => invoke<string>("shot_undo", { id }),
  shotMoves: (query: string | null, limit = 300) => invoke<ShotMove[]>("shot_moves", { query, limit }),
  shotSortExisting: () => invoke<number>("shot_sort_existing"),
  shotReread: (path: string, engine: "device" | "claude") => invoke<ShotSuggestion>("shot_reread", { path, engine }),
  onShotFiled: (cb: (m: ShotMove) => void) => on("shot-filed", cb),
  onShotQueued: (cb: (s: ShotSuggestion) => void) => on("shot-queued", cb),
  onShotsProgress: (cb: (p: Progress) => void) => on("shots-progress", cb),

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

/** Plain names for source kinds, as the Sources screen shows them. */
export const KIND_NAMES: Record<string, string> = { proton: "Proton Drive", gdrive: "Google Drive", takeout: "Google Photos", nas: "NAS", local: "Folder" };
