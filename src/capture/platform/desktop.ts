/**
 * Desktop implementation of the service ports and native actions, via Tauri.
 * In a plain browser (`npm run dev`) none of this exists; `isDesktop()` is
 * false and the Capture screen shows a friendly notice instead.
 */
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { availableMonitors, cursorPosition, monitorFromPoint, primaryMonitor } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Rect } from "../core/recipe";
import type { Db, FileStore, Ports, Runner } from "../services/ports";

export const isDesktop = (): boolean => {
  try {
    return isTauri();
  } catch {
    return false;
  }
};

export interface NativeConfig {
  dataDir: string;
  ffmpeg: string;
  ffprobe: string;
  whisperBin: string | null;
  whisperModel: string | null;
  platform: "windows" | "other";
  version: string;
}

export const getConfig = () => invoke<NativeConfig>("capture_config");

const runner: Runner = {
  async run(tool, args, opts = {}) {
    const jobId = `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let unlisten: UnlistenFn | null = null;
    if (opts.onLine) {
      const onLine = opts.onLine;
      unlisten = await listen<{ jobId: string; line: string }>("tool-line", (e) => {
        if (e.payload.jobId === jobId) onLine(e.payload.line);
      });
    }
    try {
      return await invoke("run_tool", { tool, args, cwd: opts.cwd ?? null, jobId: opts.onLine ? jobId : null });
    } finally {
      unlisten?.();
    }
  },
  available: (tool) => invoke<boolean>("tool_available", { tool }).catch(() => false),
};

const files: FileStore = {
  exists: (path) => invoke("fs_exists", { path }),
  mkdirp: (path) => invoke("fs_mkdirp", { path }),
  readText: (path) => invoke("fs_read_text", { path }),
  writeText: (path, text) => invoke("fs_write_text", { path, text }),
  remove: (path) => invoke("fs_remove", { path }),
  removeDir: (path) => invoke("fs_remove_dir", { path }),
  size: (path) => invoke("fs_size", { path }),
  list: (path) => invoke("fs_list", { path }),
};

/** The capture store: captures.sqlite in the app data folder, run through Rust. */
const db: Db = {
  execute: (sql, params = []) => invoke<void>("capture_db_execute", { sql, params }),
  select: (sql, params = []) => invoke("capture_db_select", { sql, params }),
};

export async function createPorts(config: NativeConfig): Promise<Ports> {
  return {
    runner,
    fs: files,
    db,
    config: { dataDir: config.dataDir, whisperModel: config.whisperModel },
  };
}

/* ---------- native actions ---------- */

let resolveFileUrl: (path: string) => string = (path) => convertFileSrc(path);
/** Dev preview only: lets the mock backend serve sample media. */
export const setFileUrlResolver = (fn: (path: string) => string) => (resolveFileUrl = fn);
export const fileUrl = (path: string) => (isDesktop() ? resolveFileUrl(path) : path);
export const copyText = (text: string) => invoke<void>("copy_text", { text });
export const copyImage = (path: string) => invoke<void>("copy_image", { path });
export const revealInFolder = (path: string) => invoke<void>("reveal_in_folder", { path });
/** Moves a capture to the Recycle Bin (only inside the Captures folder). */
export const trash = (path: string) => invoke<void>("fs_trash", { path });
export const openDataFolder = () => invoke<void>("open_capture_folder");
export const setCloseToTray = (enabled: boolean) => invoke<void>("set_close_to_tray", { enabled }).catch(() => undefined);
/** Scans the Captures folder into the library. */
export const importCaptures = () => invoke<unknown>("import_captures");
export const openMicSettings = () => invoke<void>("open_mic_settings");
export const showMainWindow = () => invoke<void>("show_main_window");
export const dataSize = () => invoke<number>("data_size").catch(() => 0);

/** A brief white screen flash, feedback for a capture even when Safelight is hidden. */
export const flashScreen = () => invoke<void>("flash_screen").catch(() => undefined);

let notifyPermission: Promise<boolean> | null = null;
/** A Windows notification. Never throws: a missed notification shouldn't break a capture. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    notifyPermission ??= isPermissionGranted().then((granted) => granted || requestPermission().then((p) => p === "granted"));
    if (await notifyPermission) sendNotification({ title, body });
  } catch {
    // Best-effort.
  }
}

export interface WindowInfo extends Rect {
  title: string;
}
export const listWindows = () => invoke<WindowInfo[]>("list_windows").catch(() => [] as WindowInfo[]);

export interface Screen {
  name: string;
  rect: Rect;
  primary: boolean;
}

export async function listScreens(): Promise<Screen[]> {
  const [all, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
  return all.map((m, i) => ({
    name: m.name ? `${m.name.replace(/^\\\\\.\\/, "")} (${m.size.width}×${m.size.height})` : `Screen ${i + 1}`,
    rect: { x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height },
    primary: !!primary && primary.position.x === m.position.x && primary.position.y === m.position.y,
  }));
}

/** The screen under the mouse pointer (for the full-screen screenshot hotkey). */
export async function screenUnderCursor(): Promise<Rect | null> {
  try {
    const p = await cursorPosition();
    const m = (await monitorFromPoint(p.x, p.y)) ?? (await primaryMonitor());
    return m ? { x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height } : null;
  } catch {
    const m = await primaryMonitor();
    return m ? { x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height } : null;
  }
}

/** Opens the region overlay and resolves with the chosen rectangle (physical pixels), or null if cancelled. */
export async function pickRegion(purpose: "screenshot" | "record"): Promise<Rect | null> {
  return new Promise((resolve, reject) => {
    const unlisteners: Promise<UnlistenFn>[] = [];
    const done = (value: Rect | null) => {
      unlisteners.forEach((u) => u.then((f) => f()));
      resolve(value);
    };
    unlisteners.push(listen<{ purpose: string; rect: Rect }>("region-selected", (e) => done(e.payload.rect)));
    unlisteners.push(listen("region-cancelled", () => done(null)));
    invoke("open_region_picker", { purpose }).catch((err) => {
      unlisteners.forEach((u) => u.then((f) => f()));
      reject(err);
    });
  });
}

export const sendRegion = (purpose: string, rect: Rect | null) =>
  rect ? emitTo("main", "region-selected", { purpose, rect }) : emitTo("main", "region-cancelled", {});

/* ---------- recording ---------- */

export interface RecState {
  status: "idle" | "recording" | "paused";
  elapsedMs: number;
}

export interface RecFinished {
  folder: string;
  segments: string[];
  cursorFile: string | null;
  startedAtMs: number;
  durationMs: number;
}

export const recStart = (template: string[], folder: string, origin: { x: number; y: number }) =>
  invoke<void>("rec_start", { template, folder, originX: Math.round(origin.x), originY: Math.round(origin.y) });
export const recTogglePause = () => invoke<"paused" | "recording">("rec_toggle_pause");
export const recStop = () => invoke<RecFinished | null>("rec_stop");
export const recStatus = () => invoke<RecState>("rec_status");
export const onRecState = (fn: (s: RecState) => void) => listen<RecState>("rec-state", (e) => fn(e.payload));
export const onRecFinished = (fn: (r: RecFinished) => void) => listen<RecFinished>("rec-finished", (e) => fn(e.payload));
export const onHotkey = (fn: (action: string) => void) => listen<string>("hotkey", (e) => fn(e.payload));

export interface HotkeyFailure {
  action: string;
  accelerator: string;
  reason: string;
}
export const setHotkeys = (bindings: Record<string, string>) => invoke<HotkeyFailure[]>("set_hotkeys", { bindings });
