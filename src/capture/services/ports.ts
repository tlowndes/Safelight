/**
 * The services layer talks to the outside world only through these ports.
 * The desktop app implements them with Tauri commands; the end-to-end test
 * implements them with Node (child_process, fs, node:sqlite), so the same
 * pipeline code runs in both.
 */

export type Tool = "ffmpeg" | "ffprobe" | "whisper";

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Called with each stdout line (ffmpeg `-progress pipe:1`). */
  onLine?: (line: string) => void;
}

export interface Runner {
  run(tool: Tool, args: string[], opts?: RunOptions): Promise<ToolResult>;
  /** Whether a tool can be found. Never throws. */
  available(tool: Tool): Promise<boolean>;
}

export interface FileStore {
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  size(path: string): Promise<number>;
  list(dir: string): Promise<string[]>;
}

export type SqlValue = string | number | null;

export interface Db {
  execute(sql: string, params?: SqlValue[]): Promise<void>;
  select<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export interface Config {
  dataDir: string;
  whisperModel: string | null;
}

export interface Ports {
  runner: Runner;
  fs: FileStore;
  db: Db;
  config: Config;
}
