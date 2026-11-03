import { describe, expect, it } from "vitest";
import {
  buildExportArgs, buildScreenshotArgs, buildSegmentArgs, concatListLine, outputSize, parseProbe, parseProgressLine,
  zoomExpressions,
} from "../../../src/capture/core/ffmpeg";
import { PRESETS } from "../../../src/capture/core/presets";
import { createRecipe, type EditRecipe, type SourceInfo } from "../../../src/capture/core/recipe";

const source: SourceInfo = { width: 2560, height: 1440, durationMs: 134_600, fps: 30, hasAudio: true };
const base = (): EditRecipe => createRecipe(source);
const opts = { input: "C:\\Users\\tom\\Videos\\Safelight\\Recordings\\a\\source.mp4", output: "C:\\out\\clip.mp4", overlayFile: null };

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("buildExportArgs (the core transformation)", () => {
  it("passes an untouched recipe straight through, scaled to the preset height", () => {
    const plan = buildExportArgs(base(), source, PRESETS["mp4-h264"], opts);
    expect(argAfter(plan.args, "-ss")).toBe("0.000");
    expect(argAfter(plan.args, "-t")).toBe("134.600");
    expect(plan.filtergraph).toBe("[0:v]scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[v]");
    expect(plan.size).toEqual({ width: 1920, height: 1080 });
    expect(plan.args).toContain("libx264");
    expect(plan.args).toContain("+faststart");
    expect(plan.args.at(-1)).toBe("C:\\out\\clip.mp4");
  });

  it("turns trim into input seeking so output starts at zero", () => {
    const r = { ...base(), trim: { start: 12_340, end: 45_000 } };
    const plan = buildExportArgs(r, source, PRESETS["mp4-h264"], opts);
    expect(argAfter(plan.args, "-ss")).toBe("12.340");
    expect(argAfter(plan.args, "-t")).toBe("32.660");
    expect(plan.durationMs).toBe(32_660);
    // -ss must come before -i to seek the input, not the output
    expect(plan.args.indexOf("-ss")).toBeLessThan(plan.args.indexOf("-i"));
  });

  it("applies crop in source pixels and sizes output from the crop", () => {
    const r = { ...base(), crop: { x: 100, y: 50, w: 1280, h: 720 } };
    const plan = buildExportArgs(r, source, PRESETS["mp4-h264"], opts);
    expect(plan.filtergraph).toContain("crop=1280:720:100:50");
    expect(plan.size).toEqual({ width: 1280, height: 720 });
  });

  it("draws overlays before crop so callouts follow the crop and zoom", () => {
    const r = { ...base(), crop: { x: 0, y: 0, w: 1280, h: 720 } };
    const plan = buildExportArgs(r, source, PRESETS["mp4-h264"], { ...opts, overlayFile: "overlay-x.ass" });
    expect(plan.filtergraph.indexOf("subtitles=filename=overlay-x.ass")).toBeLessThan(plan.filtergraph.indexOf("crop="));
  });

  it("adds an eased zoompan only when there are zooms inside the trim", () => {
    const r: EditRecipe = {
      ...base(),
      trim: { start: 10_000, end: 60_000 },
      zooms: [
        { id: "a", start: 20_000, end: 25_000, rect: { x: 640, y: 360, w: 1280, h: 720 } },
        { id: "b", start: 70_000, end: 80_000, rect: { x: 0, y: 0, w: 1280, h: 720 } }, // outside trim
      ],
    };
    const plan = buildExportArgs(r, source, PRESETS["mp4-h264"], opts);
    expect(plan.filtergraph).toMatch(/zoompan=z='1\+1\*st\(0,clip\(min\(\(it-10\)\/0\.4,\(15-it\)\/0\.4\),0,1\)\)/);
    expect(plan.filtergraph).toContain(":d=1:s=2560x1440:fps=30");
    // Only one segment survives (segment b is outside the trim).
    expect(plan.filtergraph.match(/st\(0/g)?.length).toBe(3); // z, x and y expressions
  });

  it("clamps zoom depth to 4×", () => {
    const r: EditRecipe = { ...base(), zooms: [{ id: "a", start: 0, end: 5000, rect: { x: 0, y: 0, w: 100, h: 50 } }] };
    const z = zoomExpressions(r, { x: 0, y: 0, w: 2560, h: 1440 });
    expect(z?.z.startsWith("1+3*")).toBe(true);
  });

  it("skips audio mapping for silent sources and uses VP9/Opus for WebM", () => {
    const plan = buildExportArgs(base(), { ...source, hasAudio: false }, PRESETS["webm-vp9"], { ...opts, output: "c.webm" });
    expect(plan.args).not.toContain("0:a:0");
    expect(plan.args).toContain("libvpx-vp9");
    expect(plan.args).not.toContain("libopus");
    const withAudio = buildExportArgs(base(), source, PRESETS["webm-vp9"], { ...opts, output: "c.webm" });
    expect(withAudio.args).toContain("libopus");
  });

  it("caps frame rate and height for the small preset", () => {
    const plan = buildExportArgs(base(), { ...source, fps: 60 }, PRESETS["mp4-small"], opts);
    expect(plan.size).toEqual({ width: 1280, height: 720 });
    expect(plan.filtergraph).toContain("fps=30");
    expect(argAfter(plan.args, "-r")).toBe("30");
  });

  it("refuses an empty clip", () => {
    expect(() => buildExportArgs({ ...base(), trim: { start: 5000, end: 5000 } }, source, PRESETS["mp4-h264"], opts)).toThrow(/empty/);
  });
});

describe("capture arguments", () => {
  it("captures a region with even dimensions and negative monitor offsets", () => {
    const args = buildScreenshotArgs({ target: { kind: "region", rect: { x: -1920, y: 10, w: 801, h: 451 } }, output: "a.png" });
    expect(args).toEqual(expect.arrayContaining(["-offset_x", "-1920", "-video_size", "800x450", "-frames:v", "1"]));
    expect(argAfter(args, "-draw_mouse")).toBe("0");
  });

  it("captures a window by title and records the mic through DirectShow", () => {
    const args = buildSegmentArgs({
      target: { kind: "window", title: "Figma - Onboarding" }, fps: 30, mic: "Microphone (Realtek(R) Audio)", output: "s.mkv",
    });
    expect(args).toContain("title=Figma - Onboarding");
    expect(args).toContain("audio=Microphone (Realtek(R) Audio)");
    expect(argAfter(args, "-draw_mouse")).toBe("1");
    expect(args).toContain("1:a");
  });

  it("records video only when no mic is chosen", () => {
    const args = buildSegmentArgs({ target: { kind: "screen", rect: { x: 0, y: 0, w: 1920, h: 1080 } }, fps: 30, mic: null, output: "s.mkv" });
    expect(args).not.toContain("dshow");
    expect(args).not.toContain("1:a");
  });

  it("rejects an empty window title and a tiny region", () => {
    expect(() => buildSegmentArgs({ target: { kind: "window", title: " " }, fps: 30, mic: null, output: "s" })).toThrow(/window/);
    expect(() => buildScreenshotArgs({ target: { kind: "region", rect: { x: 0, y: 0, w: 1, h: 400 } }, output: "a" })).toThrow(/small/);
  });
});

describe("helpers", () => {
  it("escapes concat list paths", () => {
    expect(concatListLine("C:\\Rec\\Tom's clip\\a.mkv")).toBe("file 'C:/Rec/Tom'\\''s clip/a.mkv'");
  });

  it("parses ffprobe output", () => {
    const info = parseProbe(JSON.stringify({
      streams: [{ codec_type: "video", width: 1280, height: 720, avg_frame_rate: "30000/1001" }, { codec_type: "audio" }],
      format: { duration: "6.016" },
    }));
    expect(info).toEqual({ width: 1280, height: 720, durationMs: 6016, fps: 29.97, hasAudio: true });
    expect(() => parseProbe(JSON.stringify({ streams: [{ codec_type: "audio" }] }))).toThrow(/no video/);
    expect(() => parseProbe("not json")).toThrow(/damaged/);
  });

  it("reads progress lines", () => {
    expect(parseProgressLine("out_time_us=1500000")).toBe(1500);
    expect(parseProgressLine("out_time_ms=2500000")).toBe(2500);
    expect(parseProgressLine("progress=continue")).toBeNull();
  });

  it("keeps output sizes even", () => {
    expect(outputSize(1201, 677, 1080)).toEqual({ width: 1200, height: 676 });
    expect(outputSize(3840, 2160, 720)).toEqual({ width: 1280, height: 720 });
  });
});
