/**
 * The capture → library → export pipeline. Pure orchestration: every side
 * effect goes through the ports, so the same code runs in the desktop app
 * and in the end-to-end test.
 */
import {
  buildAudioExtractArgs, buildConcatArgs, buildExportArgs, buildPosterArgs, buildProbeArgs, buildRemuxArgs,
  buildWhisperArgs, concatListLine, parseProbe, parseProgressLine,
} from "../core/ffmpeg";
import { explainToolFailure, CaptureError } from "../core/errors";
import { basename, pathJoin, sanitizeFilename, slugify, uniqueName } from "../core/filenames";
import { buildOverlay, parseCursorFile } from "../core/overlay";
import { PRESETS, type PresetId } from "../core/presets";
import { normaliseRecipe, validateRecipe, type EditRecipe, type SourceInfo } from "../core/recipe";
import { buildSummaryMarkdown } from "../core/summary";
import { timestampName } from "../core/time";
import { cuesToText, parseVtt, retimeCues, serializeVtt, type Cue } from "../core/transcript";
import {
  insertCapture, insertExport, sourceInfoOf, updateTranscript, type Capture, type ExportRecord,
} from "./library";
import type { Ports, RunOptions, Tool } from "./ports";

export const folders = (dataDir: string) => ({
  recordings: pathJoin(dataDir, "Recordings"),
  screenshots: pathJoin(dataDir, "Screenshots"),
  exports: pathJoin(dataDir, "Exports"),
  models: pathJoin(dataDir, "models"),
});

export async function ensureFolders(ports: Ports): Promise<void> {
  for (const dir of Object.values(folders(ports.config.dataDir))) await ports.fs.mkdirp(dir);
}

async function run(ports: Ports, tool: Tool, args: string[], opts?: RunOptions) {
  const res = await ports.runner.run(tool, args, opts);
  if (res.code !== 0) throw new CaptureError(explainToolFailure(tool, res.stderr), res.stderr);
  return res;
}

export async function probe(ports: Ports, file: string): Promise<SourceInfo> {
  const res = await run(ports, "ffprobe", buildProbeArgs(file));
  return parseProbe(res.stdout);
}

/** A new, unique folder for a recording, e.g. Recordings\2026-10-14 16-47-03 */
export async function newRecordingFolder(ports: Ports, now = new Date()): Promise<string> {
  const root = folders(ports.config.dataDir).recordings;
  await ports.fs.mkdirp(root);
  const name = uniqueName(timestampName(now), "", await ports.fs.list(root));
  const dir = pathJoin(root, name);
  await ports.fs.mkdirp(dir);
  return dir;
}

export async function newScreenshotPath(ports: Ports, now = new Date()): Promise<string> {
  const root = folders(ports.config.dataDir).screenshots;
  await ports.fs.mkdirp(root);
  return pathJoin(root, uniqueName(timestampName(now), "png", await ports.fs.list(root)));
}

export interface FinishedRecording {
  folder: string;
  segments: string[];
  cursorFile: string | null;
  createdAt: Date;
  title?: string;
}

/** Joins the recorded segments into source.mp4, makes a poster and adds it to the library. */
export async function finaliseRecording(ports: Ports, rec: FinishedRecording): Promise<Capture> {
  const segments: string[] = [];
  for (const s of rec.segments) if (await ports.fs.exists(s)) segments.push(s);
  if (segments.length === 0) {
    throw new CaptureError({
      code: "FILE_MISSING",
      title: "Nothing was recorded",
      message: "The recording stopped before any video was captured. Check the capture area and try again.",
      recoverable: true,
      action: "retry",
    });
  }
  const source = pathJoin(rec.folder, "source.mp4");
  if (segments.length === 1) {
    await run(ports, "ffmpeg", buildRemuxArgs(segments[0], source));
  } else {
    const list = pathJoin(rec.folder, "segments.txt");
    await ports.fs.writeText(list, segments.map(concatListLine).join("\n") + "\n");
    await run(ports, "ffmpeg", buildConcatArgs(list, source));
    await ports.fs.remove(list);
  }
  for (const s of segments) await ports.fs.remove(s);

  const info = await probe(ports, source);
  const poster = pathJoin(rec.folder, "poster.jpg");
  await run(ports, "ffmpeg", buildPosterArgs(source, Math.min(1000, info.durationMs / 10), poster));

  return insertCapture(ports.db, {
    kind: "video",
    title: rec.title?.trim() || `Recording ${timestampName(rec.createdAt)}`,
    filePath: source,
    folder: rec.folder,
    createdAt: rec.createdAt,
    info,
    posterPath: poster,
    cursorPath: rec.cursorFile && (await ports.fs.exists(rec.cursorFile)) ? rec.cursorFile : null,
  });
}

/** Adds a freshly written screenshot to the library. */
export async function addScreenshot(ports: Ports, filePath: string, createdAt = new Date()): Promise<Capture> {
  const info = await probe(ports, filePath);
  return insertCapture(ports.db, {
    kind: "screenshot",
    title: `Screenshot ${timestampName(createdAt)}`,
    filePath,
    folder: folders(ports.config.dataDir).screenshots,
    createdAt,
    info: { ...info, durationMs: 0, hasAudio: false },
    posterPath: filePath,
  });
}

/** Whether local transcription is set up. Returns the reason when it isn't. */
export async function transcriptionStatus(ports: Ports): Promise<{ ready: boolean; reason?: string }> {
  const model = ports.config.whisperModel;
  if (!(await ports.runner.available("whisper"))) {
    return { ready: false, reason: "Transcripts aren't set up. Run `npm run setup:whisper` once, then press Retry." };
  }
  if (!model || !(await ports.fs.exists(model))) {
    return { ready: false, reason: "The transcription model is missing. Run `npm run setup:whisper`, then press Retry." };
  }
  return { ready: true };
}

/** Transcribes a recording with whisper.cpp and stores transcript.vtt beside it. Never throws. */
export async function transcribe(ports: Ports, capture: Capture): Promise<Capture["transcriptStatus"]> {
  if (capture.kind !== "video") return "none";
  if (!capture.hasAudio) {
    await updateTranscript(ports.db, capture.id, { status: "unavailable", error: "This recording has no audio." });
    return "unavailable";
  }
  const status = await transcriptionStatus(ports);
  if (!status.ready) {
    await updateTranscript(ports.db, capture.id, { status: "unavailable", error: status.reason });
    return "unavailable";
  }
  await updateTranscript(ports.db, capture.id, { status: "pending" });
  const wav = pathJoin(capture.folder, "audio-16k.wav");
  const base = pathJoin(capture.folder, "transcript");
  try {
    await run(ports, "ffmpeg", buildAudioExtractArgs(capture.filePath, wav));
    await run(ports, "whisper", buildWhisperArgs(ports.config.whisperModel!, wav, base));
    const vttPath = `${base}.vtt`;
    const cues = parseVtt(await ports.fs.readText(vttPath));
    await updateTranscript(ports.db, capture.id, { status: "ready", text: cuesToText(cues), path: vttPath });
    return "ready";
  } catch (err) {
    const message = err instanceof CaptureError ? err.friendly.message : String(err);
    await updateTranscript(ports.db, capture.id, { status: "failed", error: message });
    return "failed";
  } finally {
    await ports.fs.remove(wav).catch(() => undefined);
  }
}

export interface ExportOptions {
  capture: Capture;
  recipe: EditRecipe;
  presetId: PresetId;
  includeSidecars: boolean;
  burnAnnotations: boolean;
  onProgress?: (fraction: number) => void;
}

export interface ExportedFile {
  label: string;
  path: string;
  sizeBytes: number;
}

export interface ExportResult {
  record: ExportRecord;
  files: ExportedFile[];
}

/** Renders the edit through ffmpeg and writes poster, transcript and summary beside the video. */
export async function exportCapture(ports: Ports, opts: ExportOptions): Promise<ExportResult> {
  const { capture } = opts;
  if (capture.kind !== "video") throw new Error("Only recordings can be exported as video.");
  const source = sourceInfoOf(capture);
  const recipe = normaliseRecipe(opts.recipe, source);
  const check = validateRecipe(recipe, source);
  if (!check.ok) {
    throw new CaptureError({
      code: "INVALID_EDIT",
      title: "Fix the edit before exporting",
      message: check.errors.join("\n"),
      recoverable: true,
    });
  }
  if (!(await ports.fs.exists(capture.filePath))) {
    throw new CaptureError(explainToolFailure("ffmpeg", "No such file or directory"));
  }

  const preset = PRESETS[opts.presetId];
  const slug = slugify(capture.title);
  const dir = pathJoin(folders(ports.config.dataDir).exports, slug);
  await ports.fs.mkdirp(dir);
  const existing = await ports.fs.list(dir);
  const fileName = uniqueName(sanitizeFilename(slug), preset.ext, existing);
  const stem = fileName.slice(0, -(preset.ext.length + 1));
  const output = pathJoin(dir, fileName);

  let overlayName: string | null = null;
  if (opts.burnAnnotations) {
    const cursor = capture.cursorPath && (await ports.fs.exists(capture.cursorPath))
      ? parseCursorFile(await ports.fs.readText(capture.cursorPath))
      : null;
    const ass = buildOverlay(recipe, source, { cursor });
    if (ass) {
      overlayName = `overlay-${Date.now().toString(36)}.ass`;
      await ports.fs.writeText(pathJoin(dir, overlayName), ass);
    }
  }

  const plan = buildExportArgs(recipe, source, preset, { input: capture.filePath, output, overlayFile: overlayName });
  try {
    await run(ports, "ffmpeg", plan.args, {
      cwd: dir,
      onLine: (line) => {
        const ms = parseProgressLine(line);
        if (ms !== null) opts.onProgress?.(Math.min(0.99, ms / plan.durationMs));
      },
    });
  } catch (err) {
    await ports.fs.remove(output).catch(() => undefined);
    throw err;
  } finally {
    if (overlayName) await ports.fs.remove(pathJoin(dir, overlayName)).catch(() => undefined);
  }

  const files: ExportedFile[] = [{ label: "Video", path: output, sizeBytes: await ports.fs.size(output) }];
  let posterPath: string | null = null;
  let transcriptPath: string | null = null;
  let summaryPath: string | null = null;

  if (opts.includeSidecars) {
    const firstMarker = recipe.markers.find((m) => m.at >= recipe.trim.start && m.at <= recipe.trim.end);
    const posterAt = firstMarker ? firstMarker.at - recipe.trim.start : Math.min(1000, plan.durationMs / 10);
    posterPath = pathJoin(dir, `${stem}.poster.jpg`);
    await run(ports, "ffmpeg", buildPosterArgs(output, posterAt, posterPath));
    files.push({ label: "Poster frame", path: posterPath, sizeBytes: await ports.fs.size(posterPath) });

    let cues: Cue[] | null = null;
    let transcriptNote = capture.transcriptError ?? "No transcript for this video.";
    if (capture.transcriptStatus === "ready" && capture.transcriptPath && (await ports.fs.exists(capture.transcriptPath))) {
      cues = retimeCues(parseVtt(await ports.fs.readText(capture.transcriptPath)), recipe.trim.start, recipe.trim.end);
      transcriptPath = pathJoin(dir, `${stem}.transcript.vtt`);
      await ports.fs.writeText(transcriptPath, serializeVtt(cues));
      files.push({ label: "Transcript", path: transcriptPath, sizeBytes: await ports.fs.size(transcriptPath) });
    } else if (capture.transcriptStatus === "pending") {
      transcriptNote = "The transcript was still being generated when this was exported.";
    }

    summaryPath = pathJoin(dir, `${stem}.summary.md`);
    const names = [...files.map((f) => ({ label: f.label, name: basename(f.path) })), { label: "Summary", name: basename(summaryPath) }];
    await ports.fs.writeText(
      summaryPath,
      buildSummaryMarkdown({ title: capture.title, createdAt: new Date(capture.createdAt), recipe, files: names, cues, transcriptNote }),
    );
    files.push({ label: "Summary", path: summaryPath, sizeBytes: await ports.fs.size(summaryPath) });
  }

  opts.onProgress?.(1);
  const record = await insertExport(ports.db, {
    captureId: capture.id,
    preset: preset.id,
    filePath: output,
    posterPath,
    transcriptPath,
    summaryPath,
    sizeBytes: files[0].sizeBytes,
  });
  return { record, files };
}
