import { describe, expect, it } from "vitest";
import { createRecipe, evenRect, normaliseRecipe, parseRecipe, validateRecipe, type EditRecipe } from "../../../src/capture/core/recipe";

const source = { width: 1920, height: 1080, durationMs: 60_000, fps: 30, hasAudio: true };

describe("recipe validation", () => {
  it("accepts a fresh recipe", () => {
    expect(validateRecipe(createRecipe(source), source)).toEqual({ ok: true, errors: [] });
  });

  it("explains each problem in plain words", () => {
    const bad: EditRecipe = {
      ...createRecipe(source),
      trim: { start: 1000, end: 1200 },
      crop: { x: 1800, y: 0, w: 400, h: 400 },
      zooms: [
        { id: "a", start: 1000, end: 3000, rect: { x: 0, y: 0, w: 400, h: 400 } },
        { id: "b", start: 2000, end: 4000, rect: { x: 0, y: 0, w: 400, h: 400 } },
      ],
      callouts: [{ id: "c", start: 0, end: 1000, text: "  ", x: 10, y: 10 }],
      markers: [{ id: "m", at: 90_000, label: "late" }],
    };
    const { ok, errors } = validateRecipe(bad, source);
    expect(ok).toBe(false);
    expect(errors.join("\n")).toMatch(/shorter than 0.5s/);
    expect(errors.join("\n")).toMatch(/crop area goes outside/);
    expect(errors.join("\n")).toMatch(/Zooms 1 and 2 overlap/);
    expect(errors.join("\n")).toMatch(/Callout 1 is empty/);
    expect(errors.join("\n")).toMatch(/Key moment 1 is outside/);
  });

  it("rejects zooms deeper than 4× and callouts that are too long", () => {
    const r: EditRecipe = {
      ...createRecipe(source),
      zooms: [{ id: "a", start: 0, end: 1000, rect: { x: 0, y: 0, w: 100, h: 100 } }],
      callouts: [{ id: "c", start: 0, end: 1000, text: "x".repeat(200), x: 10, y: 10 }],
    };
    const errors = validateRecipe(r, source).errors.join("\n");
    expect(errors).toMatch(/deeper than 4×/);
    expect(errors).toMatch(/over 140 characters/);
  });

  it("rejects recipes from an unknown version", () => {
    expect(validateRecipe({ ...createRecipe(source), version: 2 as 1 }, source).ok).toBe(false);
  });
});

describe("normalising", () => {
  it("rounds crops to even pixels inside the frame", () => {
    expect(evenRect({ x: 101, y: 51, w: 1281, h: 721 }, 1920, 1080)).toEqual({ x: 100, y: 50, w: 1280, h: 720 });
    expect(evenRect({ x: 1900, y: 0, w: 400, h: 400 }, 1920, 1080)).toEqual({ x: 1900, y: 0, w: 20, h: 400 });
  });

  it("clamps the trim and sorts timed items", () => {
    const r = normaliseRecipe(
      {
        ...createRecipe(source),
        trim: { start: -50, end: 99_999 },
        markers: [{ id: "b", at: 5000, label: "b" }, { id: "a", at: 1000, label: "a" }],
      },
      source,
    );
    expect(r.trim).toEqual({ start: 0, end: 60_000 });
    expect(r.markers.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("falls back to a fresh recipe when stored JSON is unreadable", () => {
    expect(parseRecipe("{oops", source)).toEqual(createRecipe(source));
    expect(parseRecipe(null, source).trim.end).toBe(60_000);
    const stored = JSON.stringify({ ...createRecipe(source), trim: { start: 5, end: 10_000 } });
    expect(parseRecipe(stored, source).trim).toEqual({ start: 5, end: 10_000 });
  });
});
