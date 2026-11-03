/** User settings, stored in the library database. */
import { DEFAULT_PRESET, isPresetId, type PresetId } from "../core/presets";
import { getSetting, setSetting } from "./library";
import type { Db } from "./ports";

export type HotkeyAction = "screenshot-region" | "screenshot-screen" | "record" | "stop" | "pause";
export type CaptureMode = "screen" | "window" | "region";

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  "screenshot-region": "Screenshot a region",
  "screenshot-screen": "Screenshot the full screen",
  record: "Start recording",
  stop: "Stop recording",
  pause: "Pause or resume",
};

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  "screenshot-region": "Ctrl+Shift+4",
  "screenshot-screen": "Ctrl+Shift+3",
  record: "Ctrl+Shift+5",
  stop: "Ctrl+Shift+2",
  pause: "Ctrl+Shift+P",
};

export interface Settings {
  copyScreenshots: boolean;
  hotkeys: Record<HotkeyAction, string>;
  fps: 15 | 30 | 60;
  defaultPreset: PresetId;
  mic: string | null;
  captureMode: CaptureMode;
  minimiseOnRecord: boolean;
  /** Closing the window keeps Safelight in the tray, so capture shortcuts keep working. */
  closeToTray: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  copyScreenshots: true,
  hotkeys: DEFAULT_HOTKEYS,
  fps: 30,
  defaultPreset: DEFAULT_PRESET,
  mic: null,
  captureMode: "region",
  minimiseOnRecord: true,
  closeToTray: true,
};

/** Checks a shortcut string such as "Ctrl+Shift+4". Returns an error message or null. */
export function validateAccelerator(value: string): string | null {
  const parts = value.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null; // empty = disabled
  const mods = new Set(["ctrl", "control", "shift", "alt", "super", "win", "commandorcontrol"]);
  const key = parts[parts.length - 1];
  if (mods.has(key.toLowerCase())) return "Finish the shortcut with a key, like Ctrl+Shift+4.";
  if (!parts.slice(0, -1).some((p) => mods.has(p.toLowerCase()))) return "Use at least one of Ctrl, Alt or Shift.";
  if (!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|PrintScreen)$/i.test(key)) return `"${key}" can't be used as a shortcut key.`;
  return null;
}

export async function loadSettings(db: Db): Promise<Settings> {
  const stored = await getSetting<Partial<Settings>>(db, "settings", {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    hotkeys: { ...DEFAULT_HOTKEYS, ...(stored.hotkeys ?? {}) },
    defaultPreset: isPresetId(stored.defaultPreset) ? stored.defaultPreset : DEFAULT_PRESET,
    fps: [15, 30, 60].includes(Number(stored.fps)) ? (Number(stored.fps) as Settings["fps"]) : 30,
  };
}

export const saveSettings = (db: Db, s: Settings) => setSetting(db, "settings", s);
