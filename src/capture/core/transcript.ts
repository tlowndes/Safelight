/** WebVTT parsing and re-timing for transcripts produced by whisper.cpp. */
import { vttTime } from "./time";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function parseTimestamp(ts: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(ts.trim());
  if (!m) return null;
  const [, h = "0", min, s, frac] = m;
  return Number(h) * 3_600_000 + Number(min) * 60_000 + Number(s) * 1000 + Number(frac.padEnd(3, "0"));
}

export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx < 0) continue;
    const [a, b] = lines[timingIdx].split("-->");
    const start = parseTimestamp(a);
    const end = parseTimestamp((b ?? "").trim().split(/\s+/)[0] ?? "");
    const body = lines
      .slice(timingIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (start === null || end === null || !body) continue;
    // whisper marks silence/music with [BLANK_AUDIO] etc.
    if (/^\[[^\]]+\]$/.test(body) || /^\([^)]+\)$/.test(body)) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

export function serializeVtt(cues: Cue[]): string {
  const body = cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join("\n\n");
  return `WEBVTT\n\n${body}${cues.length ? "\n" : ""}`;
}

/** Keeps cues inside [start, end] and shifts them so `start` becomes 0. */
export function retimeCues(cues: Cue[], start: number, end: number): Cue[] {
  return cues
    .filter((c) => c.end > start && c.start < end)
    .map((c) => ({ text: c.text, start: Math.max(c.start, start) - start, end: Math.min(c.end, end) - start }));
}

export function cuesToText(cues: Cue[]): string {
  return cues.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
}
