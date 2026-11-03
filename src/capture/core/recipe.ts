/**
 * The edit recipe: a non-destructive description of how to turn a source
 * recording into an export. The source file is never modified; the recipe is
 * stored as JSON in the library and applied by ffmpeg at export time.
 *
 * All times are milliseconds on the SOURCE timeline. All rectangles are in
 * SOURCE pixels.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SourceInfo {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasAudio: boolean;
}

export interface ZoomSegment {
  id: string;
  start: number;
  end: number;
  /** The area to zoom into, in source pixels. */
  rect: Rect;
}

export interface Callout {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Top-left anchor of the callout bubble, in source pixels. */
  x: number;
  y: number;
}

export interface Marker {
  id: string;
  at: number;
  label: string;
}

export interface EditRecipe {
  version: 1;
  trim: { start: number; end: number };
  crop: Rect | null;
  zooms: ZoomSegment[];
  callouts: Callout[];
  markers: Marker[];
  cursor: { enabled: boolean; size: number };
}

export const MIN_CLIP_MS = 500;
export const MAX_ZOOM = 4;
export const MAX_CALLOUT_LENGTH = 140;
export const MAX_MARKER_LABEL = 80;

export function createRecipe(source: SourceInfo): EditRecipe {
  return {
    version: 1,
    trim: { start: 0, end: Math.max(0, Math.round(source.durationMs)) },
    crop: null,
    zooms: [],
    callouts: [],
    markers: [],
    cursor: { enabled: false, size: 44 },
  };
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function rectInside(r: Rect, w: number, h: number): boolean {
  return (
    isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) &&
    r.w >= 2 && r.h >= 2 && r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h
  );
}

/**
 * Checks a recipe against its source. Messages are written for the person
 * using the editor: they say what is wrong and how to fix it.
 */
export function validateRecipe(recipe: EditRecipe, source: SourceInfo): ValidationResult {
  const errors: string[] = [];
  if (!recipe || recipe.version !== 1) {
    return { ok: false, errors: ["This edit was made by a newer version of Safelight. Reset the edit to continue."] };
  }
  const { start, end } = recipe.trim;
  if (!isNum(start) || !isNum(end) || start < 0 || end > source.durationMs + 1) {
    errors.push("Trim points must sit inside the recording. Drag the handles back onto the clip.");
  } else if (end - start < MIN_CLIP_MS) {
    errors.push(`The trimmed clip is shorter than ${MIN_CLIP_MS / 1000}s. Widen the trim handles.`);
  }

  const frameW = recipe.crop ? recipe.crop.w : source.width;
  const frameH = recipe.crop ? recipe.crop.h : source.height;
  if (recipe.crop && !rectInside(recipe.crop, source.width, source.height)) {
    errors.push("The crop area goes outside the video. Drag it back inside the frame.");
  }

  const zooms = [...recipe.zooms].sort((a, b) => a.start - b.start);
  zooms.forEach((z, i) => {
    if (!isNum(z.start) || !isNum(z.end) || z.end <= z.start) {
      errors.push(`Zoom ${i + 1} ends before it starts. Drag its end point later.`);
    }
    const origin = recipe.crop ?? { x: 0, y: 0, w: source.width, h: source.height };
    const inside =
      z.rect.x >= origin.x && z.rect.y >= origin.y &&
      z.rect.x + z.rect.w <= origin.x + origin.w && z.rect.y + z.rect.h <= origin.y + origin.h;
    if (!rectInside(z.rect, source.width, source.height) || !inside) {
      errors.push(`Zoom ${i + 1} targets an area outside the frame. Move the zoom box inside the crop.`);
    } else if (frameW / z.rect.w > MAX_ZOOM + 0.001 && frameH / z.rect.h > MAX_ZOOM + 0.001) {
      errors.push(`Zoom ${i + 1} is deeper than ${MAX_ZOOM}×. Make the zoom box bigger.`);
    }
    const next = zooms[i + 1];
    if (next && next.start < z.end) {
      errors.push(`Zooms ${i + 1} and ${i + 2} overlap. Move one so they play one after the other.`);
    }
  });

  recipe.callouts.forEach((c, i) => {
    const text = (c.text ?? "").trim();
    if (!text) errors.push(`Callout ${i + 1} is empty. Type some text or delete it.`);
    if (text.length > MAX_CALLOUT_LENGTH) {
      errors.push(`Callout ${i + 1} is over ${MAX_CALLOUT_LENGTH} characters. Shorten it.`);
    }
    if (!isNum(c.start) || !isNum(c.end) || c.end <= c.start) {
      errors.push(`Callout ${i + 1} ends before it starts. Drag its end point later.`);
    }
    if (!isNum(c.x) || !isNum(c.y) || c.x < 0 || c.y < 0 || c.x > source.width || c.y > source.height) {
      errors.push(`Callout ${i + 1} sits outside the frame. Drag it back onto the video.`);
    }
  });

  recipe.markers.forEach((m, i) => {
    if (!isNum(m.at) || m.at < 0 || m.at > source.durationMs) {
      errors.push(`Key moment ${i + 1} is outside the recording.`);
    }
    if ((m.label ?? "").length > MAX_MARKER_LABEL) {
      errors.push(`Key moment ${i + 1} has a label over ${MAX_MARKER_LABEL} characters.`);
    }
  });

  if (!isNum(recipe.cursor.size) || recipe.cursor.size < 12 || recipe.cursor.size > 160) {
    errors.push("Cursor highlight size must be between 12 and 160 pixels.");
  }

  return { ok: errors.length === 0, errors };
}

/** Rounds a rectangle to even pixel values (required by yuv420p) and clamps it to the frame. */
export function evenRect(r: Rect, width: number, height: number): Rect {
  const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
  const x = Math.min(even(r.x), Math.max(0, even(width) - 2));
  const y = Math.min(even(r.y), Math.max(0, even(height) - 2));
  const w = Math.max(2, Math.min(even(r.w), even(width - x)));
  const h = Math.max(2, Math.min(even(r.h), even(height - y)));
  return { x, y, w, h };
}

/**
 * Brings a possibly-stale recipe into a usable shape: clamps the trim, rounds
 * the crop to even pixels and sorts timed items. Items outside the trimmed
 * range are kept (the editor still shows them); the export builders skip them.
 */
export function normaliseRecipe(recipe: EditRecipe, source: SourceInfo): EditRecipe {
  const dur = Math.round(source.durationMs);
  const start = Math.min(Math.max(0, Math.round(recipe.trim.start)), dur);
  const end = Math.min(Math.max(start, Math.round(recipe.trim.end)), dur);
  return {
    ...recipe,
    trim: { start, end },
    crop: recipe.crop ? evenRect(recipe.crop, source.width, source.height) : null,
    zooms: [...recipe.zooms].sort((a, b) => a.start - b.start),
    callouts: recipe.callouts
      .map((c) => ({ ...c, text: c.text.trim().slice(0, MAX_CALLOUT_LENGTH) }))
      .sort((a, b) => a.start - b.start),
    markers: [...recipe.markers].sort((a, b) => a.at - b.at),
  };
}

/** Parses recipe JSON from the database, falling back to a fresh recipe if it is unreadable. */
export function parseRecipe(json: string | null | undefined, source: SourceInfo): EditRecipe {
  if (!json) return createRecipe(source);
  try {
    const parsed = JSON.parse(json) as EditRecipe;
    if (parsed?.version !== 1 || !parsed.trim) return createRecipe(source);
    return {
      ...createRecipe(source),
      ...parsed,
      zooms: parsed.zooms ?? [],
      callouts: parsed.callouts ?? [],
      markers: parsed.markers ?? [],
      cursor: parsed.cursor ?? { enabled: false, size: 44 },
    };
  } catch {
    return createRecipe(source);
  }
}
