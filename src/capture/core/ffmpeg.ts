/**
 * Pure builders for every ffmpeg/ffprobe/whisper command Safelight runs.
 * Nothing here touches the file system or spawns processes, so it is easy to
 * test; the services layer runs the commands through a Runner.
 */
import { MAX_ZOOM, type EditRecipe, type Rect, type SourceInfo } from "./recipe";
import type { ExportPreset } from "./presets";
import { ffSeconds } from "./time";

export type CaptureTarget =
  | { kind: "screen"; rect: Rect; label?: string }
  | { kind: "region"; rect: Rect }
  | { kind: "window"; title: string; rect?: Rect };

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** gdigrab input arguments for a capture target. Offsets may be negative on multi-monitor set-ups. */
export function gdigrabInput(target: CaptureTarget, fps: number, drawMouse: boolean): string[] {
  const base = ["-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", drawMouse ? "1" : "0"];
  if (target.kind === "window") {
    const title = target.title.trim();
    if (!title) throw new Error("Pick a window to capture.");
    return [...base, "-i", `title=${title}`];
  }
  const { x, y, w, h } = target.rect;
  if (![x, y, w, h].every(Number.isFinite) || w < 2 || h < 2) {
    throw new Error("The capture area is too small. Drag a bigger region.");
  }
  return [
    ...base,
    "-offset_x", String(Math.round(x)),
    "-offset_y", String(Math.round(y)),
    "-video_size", `${even(w)}x${even(h)}`,
    "-i", "desktop",
  ];
}

export interface ScreenshotOptions {
  target: CaptureTarget;
  output: string;
}

export function buildScreenshotArgs({ target, output }: ScreenshotOptions): string[] {
  return ["-hide_banner", "-nostdin", "-y", ...gdigrabInput(target, 1, false), "-frames:v", "1", "-update", "1", output];
}

export interface SegmentOptions {
  target: CaptureTarget;
  fps: number;
  /** DirectShow microphone name, or null for no audio. */
  mic: string | null;
  output: string;
}

/**
 * One recording segment. Pausing stops the current segment and resuming starts
 * a new one; segments are joined when recording stops. Segments are written as
 * Matroska so an interrupted recording is still playable.
 */
export function buildSegmentArgs({ target, fps, mic, output }: SegmentOptions): string[] {
  const args = ["-hide_banner", "-y", "-thread_queue_size", "512", ...gdigrabInput(target, fps, true)];
  if (mic) {
    args.push("-thread_queue_size", "1024", "-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${mic}`);
  }
  // Window sizes can be odd; yuv420p needs even dimensions.
  args.push("-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2", "-map", "0:v");
  if (mic) args.push("-map", "1:a", "-c:a", "aac", "-b:a", "160k");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", output);
  return args;
}

/** Escapes a path for an ffmpeg concat list file. */
export function concatListLine(path: string): string {
  return `file '${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

export function buildConcatArgs(listFile: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", output];
}

export function buildRemuxArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output];
}

export function buildPosterArgs(input: string, atMs: number, output: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-ss", ffSeconds(atMs), "-i", input,
    "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", output,
  ];
}

export function buildAudioExtractArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];
}

export function buildProbeArgs(input: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", input];
}

export function buildWhisperArgs(model: string, wav: string, outputBase: string): string[] {
  return ["-m", model, "-f", wav, "-l", "auto", "-ovtt", "-of", outputBase, "-np"];
}

export const LIST_AUDIO_DEVICES_ARGS = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];

/** Reads ffprobe JSON into SourceInfo. Throws a readable error for files without video. */
export function parseProbe(json: string): SourceInfo {
  let data: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Couldn't read this file's details. It may be damaged or still being written.");
  }
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error("This file has no video track.");
  const rate = String(video.avg_frame_rate && video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate ?? "30/1");
  const [num, den] = rate.split("/").map(Number);
  const fps = den ? num / den : num;
  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  return {
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 30,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** Reads a line of `-progress pipe:1` output. Returns the encoded position in ms, or null. */
export function parseProgressLine(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
  return m ? Math.round(Number(m[1]) / 1000) : null;
}

export interface OutputSize {
  width: number;
  height: number;
}

export function outputSize(frameW: number, frameH: number, maxHeight: number): OutputSize {
  const f = Math.min(1, maxHeight / frameH);
  return { width: even(Math.round(frameW * f)), height: even(Math.round(frameH * f)) };
}

const n3 = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * zoompan expressions for the recipe's zoom segments. Each segment eases in
 * and out (smoothstep) and pans towards the centre of its target box.
 * `it` is the input timestamp in seconds on the trimmed timeline.
 */
export function zoomExpressions(recipe: EditRecipe, frame: Rect): { z: string; x: string; y: string } | null {
  const { start: trimStart, end: trimEnd } = recipe.trim;
  const parts: Array<{ s: number; e: number; r: number; zoom: number; cx: number; cy: number }> = [];
  for (const seg of recipe.zooms) {
    const s = Math.max(seg.start, trimStart) - trimStart;
    const e = Math.min(seg.end, trimEnd) - trimStart;
    if (e - s < 100) continue;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, Math.min(frame.w / seg.rect.w, frame.h / seg.rect.h)));
    if (zoom <= 1.001) continue;
    parts.push({
      s: s / 1000,
      e: e / 1000,
      r: Math.min(0.4, (e - s) / 3000),
      zoom,
      cx: seg.rect.x + seg.rect.w / 2 - frame.x,
      cy: seg.rect.y + seg.rect.h / 2 - frame.y,
    });
  }
  if (parts.length === 0) return null;
  // st/ld keep the eased weight in a register so each term stays short.
  const weight = (p: (typeof parts)[number]) =>
    `st(0,clip(min((it-${n3(p.s)})/${n3(p.r)},(${n3(p.e)}-it)/${n3(p.r)}),0,1))*ld(0)*(3-2*ld(0))`;
  const z = `1+${parts.map((p) => `${n3(p.zoom - 1)}*${weight(p)}`).join("+")}`;
  const cx = `iw/2+${parts.map((p) => `(${n3(p.cx)}-iw/2)*${weight(p)}`).join("+")}`;
  const cy = `ih/2+${parts.map((p) => `(${n3(p.cy)}-ih/2)*${weight(p)}`).join("+")}`;
  return {
    z,
    x: `clip(${cx}-iw/zoom/2,0,iw-iw/zoom)`,
    y: `clip(${cy}-ih/zoom/2,0,ih-ih/zoom)`,
  };
}

export interface ExportArgsOptions {
  input: string;
  output: string;
  /** Overlay subtitle file, relative to the ffmpeg working directory (avoids Windows path escaping). */
  overlayFile: string | null;
}

export interface ExportPlan {
  args: string[];
  durationMs: number;
  size: OutputSize;
  filtergraph: string;
}

/** The core transformation: recipe + source + preset -> one ffmpeg command. */
export function buildExportArgs(
  recipe: EditRecipe,
  source: SourceInfo,
  preset: ExportPreset,
  { input, output, overlayFile }: ExportArgsOptions,
): ExportPlan {
  const durationMs = recipe.trim.end - recipe.trim.start;
  if (durationMs <= 0) throw new Error("Nothing to export: the trimmed clip is empty.");
  const frame: Rect = recipe.crop ?? { x: 0, y: 0, w: source.width, h: source.height };
  const fw = even(frame.w);
  const fh = even(frame.h);
  const fps = Math.min(preset.maxFps, Math.max(1, Math.round(source.fps)));
  const size = outputSize(fw, fh, preset.maxHeight);

  const filters: string[] = [];
  // Overlays are drawn first, in source pixels, so they follow crop and zoom.
  if (overlayFile) filters.push(`subtitles=filename=${overlayFile}`);
  if (recipe.crop) filters.push(`crop=${fw}:${fh}:${frame.x}:${frame.y}`);
  const zoom = zoomExpressions(recipe, { ...frame, w: fw, h: fh });
  if (zoom) {
    filters.push(`zoompan=z='${zoom.z}':x='${zoom.x}':y='${zoom.y}':d=1:s=${fw}x${fh}:fps=${fps}`);
  }
  filters.push(`scale=${size.width}:${size.height}:flags=lanczos`);
  if (!zoom && source.fps > preset.maxFps + 0.5) filters.push(`fps=${fps}`);
  filters.push("setsar=1", "format=yuv420p");
  const filtergraph = `[0:v]${filters.join(",")}[v]`;

  const args = [
    "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
    "-ss", ffSeconds(recipe.trim.start), "-t", ffSeconds(durationMs), "-i", input,
    "-filter_complex", filtergraph, "-map", "[v]",
  ];
  if (source.hasAudio) args.push("-map", "0:a:0", ...preset.audio);
  args.push(...preset.video, "-r", String(fps), ...preset.container, output);
  return { args, durationMs, size, filtergraph };
}
