/**
 * Builds an ASS subtitle file that ffmpeg (libass) burns into the video:
 * text callouts and the cursor highlight. Drawing in ASS keeps rendering in a
 * single ffmpeg pass and avoids huge filter expressions.
 */
import type { EditRecipe, SourceInfo } from "./recipe";
import { assTime } from "./time";

export interface CursorSample {
  /** ms on the source timeline */
  t: number;
  /** pixels relative to the capture origin */
  x: number;
  y: number;
}

/** ASS colours are &HAABBGGRR with inverted alpha (00 = opaque). */
export function assColour(hex: string, alpha = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const rgb = m ? m[1] : "ffffff";
  const [r, g, b] = [rgb.slice(0, 2), rgb.slice(2, 4), rgb.slice(4, 6)];
  const a = Math.round((1 - Math.min(1, Math.max(0, alpha))) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Makes user text safe inside an ASS Dialogue line (no override blocks, real line breaks). */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "∖")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

/** Reduces cursor samples to roughly `hz` per second and drops samples where the cursor did not move. */
export function simplifyCursor(samples: CursorSample[], hz = 15): CursorSample[] {
  const step = 1000 / hz;
  const out: CursorSample[] = [];
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (!last || (s.t - last.t >= step && (s.x !== last.x || s.y !== last.y))) out.push(s);
  }
  return out;
}

const circle = (r: number) =>
  // A circle drawn with four Bézier curves around (0,0).
  `m ${-r} 0 b ${-r} ${-r * 0.55} ${-r * 0.55} ${-r} 0 ${-r} b ${r * 0.55} ${-r} ${r} ${-r * 0.55} ${r} 0 ` +
  `b ${r} ${r * 0.55} ${r * 0.55} ${r} 0 ${r} b ${-r * 0.55} ${r} ${-r} ${r * 0.55} ${-r} 0`;

export interface OverlayOptions {
  cursor?: CursorSample[] | null;
}

/**
 * Returns the ASS document for the recipe, or null when there is nothing to
 * draw. Times are shifted onto the trimmed timeline (export seeks the input,
 * so the first exported frame is t=0).
 */
export function buildOverlay(recipe: EditRecipe, source: SourceInfo, opts: OverlayOptions = {}): string | null {
  const { start: t0, end: t1 } = recipe.trim;
  const lines: string[] = [];
  const shift = (t: number) => Math.min(Math.max(t, t0), t1) - t0;
  const fontSize = Math.max(18, Math.round(source.height / 26));

  for (const c of recipe.callouts) {
    if (c.end <= t0 || c.start >= t1 || !c.text.trim()) continue;
    lines.push(
      `Dialogue: 2,${assTime(shift(c.start))},${assTime(shift(c.end))},Callout,,0,0,0,,` +
        `{\\pos(${Math.round(c.x)},${Math.round(c.y)})\\fad(120,120)}${escapeAssText(c.text.trim())}`,
    );
  }

  const samples = recipe.cursor.enabled && opts.cursor?.length ? simplifyCursor(opts.cursor) : [];
  const r = Math.round(recipe.cursor.size / 2);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const end = b ? b.t : a.t + 1000;
    if (end <= t0 || a.t >= t1) continue;
    const pos = b
      ? `\\move(${a.x},${a.y},${b.x},${b.y})`
      : `\\pos(${a.x},${a.y})`;
    lines.push(`Dialogue: 1,${assTime(shift(a.t))},${assTime(shift(end))},Cursor,,0,0,0,,{${pos}\\p1}${circle(r)}{\\p0}`);
  }

  if (lines.length === 0) return null;

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${source.width}`,
    `PlayResY: ${source.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // BorderStyle 3 draws an opaque box behind the text: a speech-bubble style callout.
    `Style: Callout,Segoe UI,${fontSize},${assColour("#1b1f26")},${assColour("#1b1f26")},${assColour("#ffffff")},${assColour("#000000", 0.35)},1,0,0,0,100,100,0,0,3,${Math.round(fontSize / 2.6)},2,7,0,0,0,1`,
    `Style: Cursor,Arial,10,${assColour("#ffd60a", 0.35)},${assColour("#ffd60a", 0.35)},${assColour("#ffd60a", 0.9)},${assColour("#000000", 0)},0,0,0,0,100,100,0,0,1,3,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}

/** Parses the cursor.json written by the recorder. Bad data is ignored rather than failing an export. */
export function parseCursorFile(json: string | null): CursorSample[] {
  if (!json) return [];
  try {
    const data = JSON.parse(json) as { samples?: unknown };
    const raw = Array.isArray(data) ? data : Array.isArray(data.samples) ? data.samples : [];
    return (raw as unknown[])
      .map((s) => (Array.isArray(s) ? { t: s[0], x: s[1], y: s[2] } : s) as CursorSample)
      .filter((s) => [s?.t, s?.x, s?.y].every((n) => typeof n === "number" && Number.isFinite(n)));
  } catch {
    return [];
  }
}
