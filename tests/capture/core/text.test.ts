import { describe, expect, it } from "vitest";
import { parseDshowAudioDevices } from "../../../src/capture/core/devices";
import { explainToolFailure } from "../../../src/capture/core/errors";
import { isInside, pathJoin, sanitizeFilename, slugify, uniqueName } from "../../../src/capture/core/filenames";
import { assColour, buildOverlay, escapeAssText, parseCursorFile, simplifyCursor } from "../../../src/capture/core/overlay";
import { createRecipe } from "../../../src/capture/core/recipe";
import { buildSummaryMarkdown, pickHighlights } from "../../../src/capture/core/summary";
import { assTime, formatDuration, formatTimecode, timestampName, vttTime } from "../../../src/capture/core/time";
import { parseVtt, retimeCues, serializeVtt } from "../../../src/capture/core/transcript";

describe("safe filenames", () => {
  it("removes characters Windows forbids", () => {
    expect(sanitizeFilename('Bug: modal "won\'t" close? <v2>|final*')).toBe("Bug- modal -won't- close- -v2-final-");
    expect(sanitizeFilename("  report. . ")).toBe("report");
    expect(sanitizeFilename("con")).toBe("con_");
    expect(sanitizeFilename("LPT1.txt")).toBe("LPT1.txt_");
    expect(sanitizeFilename("???")).toBe("untitled");
    expect(sanitizeFilename("a".repeat(300)).length).toBe(120);
  });

  it("makes readable slugs and unique names", () => {
    expect(slugify("Onboarding flow: walkthrough!")).toBe("onboarding-flow-walkthrough");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("capture");
    expect(uniqueName("clip", "mp4", ["clip.mp4", "CLIP (2).mp4"])).toBe("clip (3).mp4");
  });

  it("joins Windows and POSIX paths and checks containment", () => {
    expect(pathJoin("C:\\Users\\tom\\Videos\\Safelight", "Exports", "a.mp4")).toBe("C:\\Users\\tom\\Videos\\Safelight\\Exports\\a.mp4");
    expect(pathJoin("/home/tom/Safelight/", "Exports")).toBe("/home/tom/Safelight/Exports");
    expect(isInside("C:\\Safelight", "c:\\safelight\\Exports\\a.mp4")).toBe(true);
    expect(isInside("C:\\Safelight", "C:\\Safelight\\..\\Windows\\x")).toBe(false);
    expect(isInside("C:\\Safelight", "C:\\SafelightOther\\x")).toBe(false);
  });
});

describe("time formats", () => {
  it("formats every clock the app shows", () => {
    expect(formatTimecode(134_600)).toBe("02:14.6");
    expect(formatTimecode(3_725_000)).toBe("01:02:05.0");
    expect(formatDuration(134_999)).toBe("02:14");
    expect(assTime(134_604)).toBe("0:02:14.60");
    expect(vttTime(134_604)).toBe("00:02:14.604");
    expect(timestampName(new Date(2026, 9, 14, 16, 47, 3))).toBe("2026-10-14 16-47-03");
  });
});

describe("overlay (callouts and cursor highlight)", () => {
  const source = { width: 1280, height: 720, durationMs: 10_000, fps: 30, hasAudio: false };

  it("returns null when there is nothing to draw", () => {
    expect(buildOverlay(createRecipe(source), source)).toBeNull();
  });

  it("shifts callouts onto the trimmed timeline and escapes text", () => {
    const recipe = {
      ...createRecipe(source),
      trim: { start: 2000, end: 8000 },
      callouts: [
        { id: "a", start: 1000, end: 3000, text: "Click {here}\nthen wait", x: 100, y: 50 },
        { id: "b", start: 9000, end: 9500, text: "after trim", x: 0, y: 0 },
      ],
    };
    const ass = buildOverlay(recipe, source)!;
    expect(ass).toContain("PlayResX: 1280");
    expect(ass).toContain("Dialogue: 2,0:00:00.00,0:00:01.00,Callout,,0,0,0,,{\\pos(100,50)\\fad(120,120)}Click (here)\\Nthen wait");
    expect(ass).not.toContain("after trim");
  });

  it("follows the cursor with moving circles only when enabled", () => {
    const samples = [{ t: 0, x: 10, y: 10 }, { t: 100, x: 20, y: 10 }, { t: 200, x: 30, y: 10 }];
    const off = buildOverlay(createRecipe(source), source, { cursor: samples });
    expect(off).toBeNull();
    const on = buildOverlay({ ...createRecipe(source), cursor: { enabled: true, size: 40 } }, source, { cursor: samples })!;
    expect(on).toContain("{\\move(10,10,20,10)\\p1}m -20 0");
    expect(on.match(/Style: Cursor/g)).toHaveLength(1);
  });

  it("thins cursor samples and tolerates bad cursor files", () => {
    const dense = Array.from({ length: 100 }, (_, i) => ({ t: i * 10, x: i, y: 0 }));
    expect(simplifyCursor(dense, 10).length).toBe(10);
    expect(parseCursorFile('{"samples":[[0,1,2],[33,"x",2]]}')).toEqual([{ t: 0, x: 1, y: 2 }]);
    expect(parseCursorFile("garbage")).toEqual([]);
  });

  it("encodes colours and text for ASS", () => {
    expect(assColour("#ffd60a", 1)).toBe("&H000AD6FF");
    expect(assColour("#000000", 0)).toBe("&HFF000000");
    expect(escapeAssText("a\\b")).toBe("a∖b");
  });
});

describe("transcripts and summaries", () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello and welcome.

00:00:02.000 --> 00:00:04.500
[BLANK_AUDIO]

00:00:04.500 --> 00:00:07.000
Now we export the <b>video</b> locally.
`;

  it("parses, cleans and re-times VTT", () => {
    const cues = parseVtt(vtt);
    expect(cues).toEqual([
      { start: 0, end: 2000, text: "Hello and welcome." },
      { start: 4500, end: 7000, text: "Now we export the video locally." },
    ]);
    const shifted = retimeCues(cues, 1000, 6000);
    expect(shifted).toEqual([
      { start: 0, end: 1000, text: "Hello and welcome." },
      { start: 3500, end: 5000, text: "Now we export the video locally." },
    ]);
    expect(serializeVtt(shifted)).toBe(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHello and welcome.\n\n2\n00:00:03.500 --> 00:00:05.000\nNow we export the video locally.\n",
    );
  });

  it("picks informative highlight sentences in spoken order", () => {
    const cues = [
      { start: 0, end: 1000, text: "Okay so um yeah." },
      { start: 1000, end: 4000, text: "The export button renders the video locally with ffmpeg." },
      { start: 4000, end: 6000, text: "It is nice weather today in town." },
      { start: 6000, end: 9000, text: "Each export writes the video, a poster and a summary." },
      { start: 9000, end: 11000, text: "The export folder opens in Explorer for the video." },
    ];
    const picks = pickHighlights(cues, 2);
    expect(picks.map((p) => p.at)).toEqual([1000, 6000]);
  });

  it("writes a Markdown summary with key moments relative to the trim", () => {
    const source = { width: 1280, height: 720, durationMs: 60_000, fps: 30, hasAudio: true };
    const md = buildSummaryMarkdown({
      title: "Bug: modal *won't* close",
      createdAt: new Date(2026, 9, 14, 16, 47),
      recipe: {
        ...createRecipe(source),
        trim: { start: 10_000, end: 40_000 },
        markers: [{ id: "a", at: 5000, label: "before trim" }, { id: "b", at: 22_000, label: "Modal opens" }],
      },
      files: [{ label: "Video", name: "bug.mp4" }],
      cues: null,
      transcriptNote: "This recording has no audio.",
    });
    expect(md).toContain("# Bug: modal \\*won't\\* close");
    expect(md).toContain("- **Length:** 00:30");
    expect(md).toContain("- **00:12** Modal opens");
    expect(md).not.toContain("before trim");
    expect(md).toContain("_This recording has no audio._");
    expect(md).toContain("- Video: `bug.mp4`");
  });
});

describe("devices and errors", () => {
  it("reads microphones from both ffmpeg dshow output styles", () => {
    const modern = `[dshow @ 0000] "Integrated Camera" (video)
[dshow @ 0000]   Alternative name "@device_pnp_\\\\?\\usb"
[dshow @ 0000] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 0000]   Alternative name "@device_cm_{33D9A762}"
[dshow @ 0000] "Headset Microphone (Jabra)" (audio)`;
    expect(parseDshowAudioDevices(modern)).toEqual(["Microphone (Realtek(R) Audio)", "Headset Microphone (Jabra)"]);
    const legacy = `[dshow @ 01] DirectShow video devices
[dshow @ 01]  "Integrated Camera"
[dshow @ 01] DirectShow audio devices
[dshow @ 01]  "Microphone Array (Intel)"`;
    expect(parseDshowAudioDevices(legacy)).toEqual(["Microphone Array (Intel)"]);
  });

  it("maps tool failures to recoverable, actionable messages", () => {
    expect(explainToolFailure("ffmpeg", "program not found: ffmpeg").code).toBe("FFMPEG_MISSING");
    expect(explainToolFailure("whisper", "program not found: whisper").action).toBe("setup-whisper");
    expect(explainToolFailure("ffmpeg", "[dshow] Could not find audio only device with name").code).toBe("MIC_UNAVAILABLE");
    expect(explainToolFailure("ffmpeg", "[dshow] Access is denied. audio").action).toBe("open-mic-settings");
    expect(explainToolFailure("ffmpeg", "[gdigrab] Can't find window 'Figma', aborting.").code).toBe("WINDOW_GONE");
    const generic = explainToolFailure("ffmpeg", "line1\nline2\nConversion failed!");
    expect(generic.recoverable).toBe(true);
    expect(generic.message).toContain("Conversion failed!");
  });
});
