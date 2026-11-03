/** The local library: one SQLite database in the Safelight data folder. */
import type { Db, SqlValue } from "./ports";
import type { SourceInfo } from "../core/recipe";

export type CaptureKind = "video" | "screenshot";
export type TranscriptStatus = "none" | "pending" | "ready" | "unavailable" | "failed";

export interface Capture {
  id: number;
  kind: CaptureKind;
  title: string;
  filePath: string;
  folder: string;
  createdAt: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  posterPath: string | null;
  cursorPath: string | null;
  recipeJson: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptText: string | null;
  transcriptPath: string | null;
  transcriptError: string | null;
}

export interface ExportRecord {
  id: number;
  captureId: number;
  preset: string;
  filePath: string;
  posterPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  sizeBytes: number;
  createdAt: string;
}

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('video','screenshot')),
      title TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      folder TEXT NOT NULL,
      created_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      fps REAL NOT NULL DEFAULT 30,
      has_audio INTEGER NOT NULL DEFAULT 0,
      poster_path TEXT,
      cursor_path TEXT,
      recipe_json TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'none',
      transcript_text TEXT,
      transcript_path TEXT,
      transcript_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS captures_created ON captures (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
      preset TEXT NOT NULL,
      file_path TEXT NOT NULL,
      poster_path TEXT,
      transcript_path TEXT,
      summary_path TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ],
];

export async function migrate(db: Db): Promise<void> {
  const [row] = await db.select<{ user_version: number }>("PRAGMA user_version");
  const current = Number(row?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    for (const sql of MIGRATIONS[v]) await db.execute(sql);
    await db.execute(`PRAGMA user_version = ${v + 1}`);
  }
  await db.execute("PRAGMA foreign_keys = ON");
}

type Row = Record<string, SqlValue>;

function toCapture(r: Row): Capture {
  return {
    id: Number(r.id),
    kind: r.kind as CaptureKind,
    title: String(r.title),
    filePath: String(r.file_path),
    folder: String(r.folder),
    createdAt: String(r.created_at),
    durationMs: Number(r.duration_ms),
    width: Number(r.width),
    height: Number(r.height),
    fps: Number(r.fps),
    hasAudio: Number(r.has_audio) === 1,
    posterPath: (r.poster_path as string) ?? null,
    cursorPath: (r.cursor_path as string) ?? null,
    recipeJson: (r.recipe_json as string) ?? null,
    transcriptStatus: (r.transcript_status as TranscriptStatus) ?? "none",
    transcriptText: (r.transcript_text as string) ?? null,
    transcriptPath: (r.transcript_path as string) ?? null,
    transcriptError: (r.transcript_error as string) ?? null,
  };
}

function toExport(r: Row): ExportRecord {
  return {
    id: Number(r.id),
    captureId: Number(r.capture_id),
    preset: String(r.preset),
    filePath: String(r.file_path),
    posterPath: (r.poster_path as string) ?? null,
    transcriptPath: (r.transcript_path as string) ?? null,
    summaryPath: (r.summary_path as string) ?? null,
    sizeBytes: Number(r.size_bytes),
    createdAt: String(r.created_at),
  };
}

export function sourceInfoOf(c: Capture): SourceInfo {
  return { width: c.width, height: c.height, durationMs: c.durationMs, fps: c.fps, hasAudio: c.hasAudio };
}

export interface NewCapture {
  kind: CaptureKind;
  title: string;
  filePath: string;
  folder: string;
  createdAt: Date;
  info: SourceInfo;
  posterPath?: string | null;
  cursorPath?: string | null;
}

export async function insertCapture(db: Db, c: NewCapture): Promise<Capture> {
  await db.execute(
    `INSERT INTO captures (kind, title, file_path, folder, created_at, duration_ms, width, height, fps, has_audio, poster_path, cursor_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.kind, c.title, c.filePath, c.folder, c.createdAt.toISOString(), c.info.durationMs, c.info.width, c.info.height,
      c.info.fps, c.info.hasAudio ? 1 : 0, c.posterPath ?? null, c.cursorPath ?? null,
    ],
  );
  const [row] = await db.select<Row>("SELECT * FROM captures WHERE file_path = ?", [c.filePath]);
  return toCapture(row);
}

export type KindFilter = "all" | CaptureKind;

export async function listCaptures(db: Db, opts: { search?: string; kind?: KindFilter } = {}): Promise<Capture[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (opts.kind && opts.kind !== "all") {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  const q = opts.search?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR transcript_text LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const sql = `SELECT * FROM captures ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`;
  return (await db.select<Row>(sql, params)).map(toCapture);
}

export async function getCapture(db: Db, id: number): Promise<Capture | null> {
  const [row] = await db.select<Row>("SELECT * FROM captures WHERE id = ?", [id]);
  return row ? toCapture(row) : null;
}

export async function countCaptures(db: Db): Promise<Record<KindFilter, number>> {
  const rows = await db.select<{ kind: CaptureKind; n: number }>("SELECT kind, COUNT(*) AS n FROM captures GROUP BY kind");
  const out: Record<KindFilter, number> = { all: 0, video: 0, screenshot: 0 };
  for (const r of rows) {
    out[r.kind] = Number(r.n);
    out.all += Number(r.n);
  }
  return out;
}

export async function updateRecipe(db: Db, id: number, recipeJson: string): Promise<void> {
  await db.execute("UPDATE captures SET recipe_json = ? WHERE id = ?", [recipeJson, id]);
}

export async function renameCapture(db: Db, id: number, title: string): Promise<void> {
  await db.execute("UPDATE captures SET title = ? WHERE id = ?", [title, id]);
}

export async function updateTranscript(
  db: Db,
  id: number,
  t: { status: TranscriptStatus; text?: string | null; path?: string | null; error?: string | null },
): Promise<void> {
  await db.execute(
    "UPDATE captures SET transcript_status = ?, transcript_text = ?, transcript_path = ?, transcript_error = ? WHERE id = ?",
    [t.status, t.text ?? null, t.path ?? null, t.error ?? null, id],
  );
}

export async function deleteCapture(db: Db, id: number): Promise<void> {
  await db.execute("DELETE FROM exports WHERE capture_id = ?", [id]);
  await db.execute("DELETE FROM captures WHERE id = ?", [id]);
}

export async function insertExport(db: Db, e: Omit<ExportRecord, "id" | "createdAt">): Promise<ExportRecord> {
  const createdAt = new Date().toISOString();
  await db.execute(
    `INSERT INTO exports (capture_id, preset, file_path, poster_path, transcript_path, summary_path, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.captureId, e.preset, e.filePath, e.posterPath, e.transcriptPath, e.summaryPath, e.sizeBytes, createdAt],
  );
  const [row] = await db.select<Row>("SELECT * FROM exports WHERE file_path = ? ORDER BY id DESC LIMIT 1", [e.filePath]);
  return toExport(row);
}

export async function listExports(db: Db, captureId?: number): Promise<ExportRecord[]> {
  const rows = captureId
    ? await db.select<Row>("SELECT * FROM exports WHERE capture_id = ? ORDER BY id DESC", [captureId])
    : await db.select<Row>("SELECT * FROM exports ORDER BY id DESC");
  return rows.map(toExport);
}

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const [row] = await db.select<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}
