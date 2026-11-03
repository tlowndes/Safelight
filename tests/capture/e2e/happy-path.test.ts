/**
 * End-to-end happy path through the real pipeline with real ffmpeg:
 * recorded segments (as the recorder writes them after a pause/resume)
 * → library → trim, crop, zoom, cursor highlight, callout, key moment
 * → MP4 and WebM exports with poster, transcript and Markdown summary.
 *
 * Screen capture itself needs Windows (gdigrab), so the segments are made
 * with ffmpeg's test source. Everything after capture is the production code.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecipe, type EditRecipe } from "../../../src/capture/core/recipe";
import { parseProbe } from "../../../src/capture/core/ffmpeg";
import { getCapture, listCaptures, listExports, migrate, updateTranscript } from "../../../src/capture/services/library";
import { ensureFolders, exportCapture, finaliseRecording, newRecordingFolder, transcribe } from "../../../src/capture/services/pipeline";
import { nodeDb, nodePorts } from "./nodePorts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;

function ffmpeg(args: string[]) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (res.status !== 0) throw new Error(res.stderr.toString());
}

function probe(file: string) {
  const res = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  return parseProbe(res.stdout.toString());
}

describe.skipIf(!hasFfmpeg)("capture → trim → annotate → export", () => {
  const root = mkdtempSync(join(tmpdir(), "safelight-capture-e2e-"));
  const dataDir = join(root, "Safelight");
  const db = nodeDb(join(root, "library.db"));
  const ports = nodePorts(dataDir, db);

  beforeAll(async () => {
    await migrate(db);
    await ensureFolders(ports);
  });
  afterAll(() => {
    db.close();
    if (!process.env.KEEP_E2E_OUTPUT) rmSync(root, { recursive: true, force: true });
    else console.log(`E2E output kept in ${root}`);
  });

  it("runs the whole loop and writes shareable files", async () => {
    // 1. "Record": two segments, as if the user paused once, plus cursor samples.
    const folder = await newRecordingFolder(ports, new Date("2026-10-14T16:47:03"));
    const segments = [join(folder, "segment-001.mkv"), join(folder, "segment-002.mkv")];
    segments.forEach((seg, i) =>
      ffmpeg([
        "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=3`,
        "-f", "lavfi", "-i", `sine=frequency=${440 + i * 220}:duration=3`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", seg,
      ]),
    );
    const cursorFile = join(folder, "cursor.json");
    const samples = Array.from({ length: 180 }, (_, i) => [i * 33, 300 + i * 2, 200 + i]);
    writeFileSync(cursorFile, JSON.stringify({ samples }));

    // 2. Stop → library.
    const capture = await finaliseRecording(ports, {
      folder, segments, cursorFile, createdAt: new Date("2026-10-14T16:47:03"), title: "Onboarding flow: walkthrough",
    });
    expect(capture.kind).toBe("video");
    expect(capture.width).toBe(1280);
    expect(capture.height).toBe(720);
    expect(capture.durationMs).toBeGreaterThan(5800);
    expect(capture.durationMs).toBeLessThan(6300);
    expect(capture.hasAudio).toBe(true);
    expect(existsSync(capture.filePath)).toBe(true);
    expect(existsSync(capture.posterPath!)).toBe(true);
    segments.forEach((s) => expect(existsSync(s)).toBe(false));

    // 3. Transcript: without whisper installed this is a recoverable "unavailable" state, not a crash.
    const status = await transcribe(ports, capture);
    if (status !== "ready") {
      expect(status).toBe("unavailable");
      expect((await getCapture(db, capture.id))!.transcriptError).toMatch(/setup:whisper/);
      // Stand in for whisper's output so the rest of the transcript path is exercised.
      const vtt = join(folder, "transcript.vtt");
      writeFileSync(
        vtt,
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nWelcome to the onboarding flow.\n\n" +
          "00:00:01.500 --> 00:00:03.000\nFirst we open the sign-up screen and enter an email address.\n\n" +
          "00:00:03.000 --> 00:00:04.500\nThen the permissions prompt asks for microphone access.\n\n" +
          "00:00:04.500 --> 00:00:06.000\nFinally the home screen shows the onboarding checklist.\n",
      );
      await updateTranscript(db, capture.id, {
        status: "ready", path: vtt,
        text: "Welcome to the onboarding flow. First we open the sign-up screen and enter an email address. Then the permissions prompt asks for microphone access. Finally the home screen shows the onboarding checklist.",
      });
    }
    const found = await listCaptures(db, { search: "permissions prompt" });
    expect(found.map((c) => c.id)).toContain(capture.id);

    // 4. Edit: trim to 1.0–5.0s, crop, zoom, cursor highlight, callout, key moment.
    const recipe: EditRecipe = {
      ...createRecipe({ width: 1280, height: 720, durationMs: capture.durationMs, fps: 30, hasAudio: true }),
      trim: { start: 1000, end: 5000 },
      crop: { x: 40, y: 30, w: 1200, h: 660 },
      zooms: [{ id: "z1", start: 2000, end: 3500, rect: { x: 400, y: 200, w: 600, h: 330 } }],
      callouts: [{ id: "c1", start: 1500, end: 4000, text: 'Tap "Continue" here', x: 700, y: 150 }],
      markers: [{ id: "m1", at: 3200, label: "Permissions prompt" }],
      cursor: { enabled: true, size: 44 },
    };
    const fresh = (await getCapture(db, capture.id))!;

    // 5. Export MP4 with sidecars.
    const progress: number[] = [];
    const mp4 = await exportCapture(ports, {
      capture: fresh, recipe, presetId: "mp4-h264", includeSidecars: true, burnAnnotations: true,
      onProgress: (p) => progress.push(p),
    });
    const [video, poster, transcript, summary] = mp4.files;
    expect(mp4.files.map((f) => f.label)).toEqual(["Video", "Poster frame", "Transcript", "Summary"]);
    expect(video.path).toMatch(/Exports[\\/]onboarding-flow-walkthrough[\\/]onboarding-flow-walkthrough\.mp4$/);
    const info = probe(video.path);
    expect(info.width).toBe(1200);
    expect(info.height).toBe(660);
    expect(Math.abs(info.durationMs - 4000)).toBeLessThan(150);
    expect(info.hasAudio).toBe(true);
    expect(poster.path).toMatch(/\.poster\.jpg$/);
    expect(poster.sizeBytes).toBeGreaterThan(1000);
    expect(progress.at(-1)).toBe(1);

    const vtt = readFileSync(transcript.path, "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:00.500"); // first cue re-timed from 1.0s
    expect(vtt).toContain("00:00:03.500 --> 00:00:04.000"); // last cue clipped at the trim end
    const md = readFileSync(summary.path, "utf8");
    expect(md).toContain("# Onboarding flow: walkthrough");
    expect(md).toContain("**00:02** Permissions prompt");
    expect(md).toContain('Tap "Continue" here');
    expect(md).toContain("onboarding-flow-walkthrough.mp4");

    // 6. Export WebM: a second export lands beside the first without overwriting it.
    const webm = await exportCapture(ports, {
      capture: fresh, recipe, presetId: "webm-vp9", includeSidecars: false, burnAnnotations: true,
    });
    expect(webm.files).toHaveLength(1);
    expect(webm.files[0].path).toMatch(/onboarding-flow-walkthrough\.webm$/);
    const winfo = probe(webm.files[0].path);
    expect(winfo.width).toBe(1200);
    expect(Math.abs(winfo.durationMs - 4000)).toBeLessThan(150);

    expect((await listExports(db, capture.id)).length).toBe(2);
  });
});
