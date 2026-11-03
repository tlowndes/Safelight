/** Export presets. Sensible defaults for sharing screen recordings. */

export type PresetId = "mp4-h264" | "webm-vp9" | "mp4-small";

export interface ExportPreset {
  id: PresetId;
  label: string;
  description: string;
  ext: "mp4" | "webm";
  maxHeight: number;
  maxFps: number;
  video: string[];
  audio: string[];
  container: string[];
}

export const PRESETS: Record<PresetId, ExportPreset> = {
  "mp4-h264": {
    id: "mp4-h264",
    label: "MP4 · H.264",
    description: "1080p max · 30 fps · CRF 23 · AAC 128k. Plays everywhere.",
    ext: "mp4",
    maxHeight: 1080,
    maxFps: 30,
    video: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high"],
    audio: ["-c:a", "aac", "-b:a", "128k", "-ac", "2"],
    container: ["-movflags", "+faststart"],
  },
  "webm-vp9": {
    id: "webm-vp9",
    label: "WebM · VP9",
    description: "1080p max · 30 fps · CRF 32 · Opus 96k. Smaller files for the web.",
    ext: "webm",
    maxHeight: 1080,
    maxFps: 30,
    video: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p"],
    audio: ["-c:a", "libopus", "-b:a", "96k"],
    container: [],
  },
  "mp4-small": {
    id: "mp4-small",
    label: "MP4 · Small",
    description: "720p max · 30 fps · CRF 28. For chat apps with upload limits.",
    ext: "mp4",
    maxHeight: 720,
    maxFps: 30,
    video: ["-c:v", "libx264", "-preset", "medium", "-crf", "28", "-pix_fmt", "yuv420p"],
    audio: ["-c:a", "aac", "-b:a", "96k", "-ac", "2"],
    container: ["-movflags", "+faststart"],
  },
};

export const DEFAULT_PRESET: PresetId = "mp4-h264";

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && value in PRESETS;
}
