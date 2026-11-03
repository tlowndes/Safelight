#!/usr/bin/env node
// Sets up local transcription: downloads whisper.cpp for Windows and the
// multilingual "base" model (~148 MB) into Safelight's app data folder, then
// records both paths in .env. Run once: `npm run setup:whisper`.
// Override the download locations with WHISPER_ZIP_URL / WHISPER_MODEL_URL.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const WHISPER_VERSION = "v1.7.6";
const ZIP_URL = process.env.WHISPER_ZIP_URL ||
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const MODEL_URL = process.env.WHISPER_MODEL_URL ||
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

function readEnv() {
  if (!existsSync(".env")) return {};
  return Object.fromEntries(
    readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => /^\s*[A-Z_]+=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

function writeEnv(updates) {
  const text = existsSync(".env") ? readFileSync(".env", "utf8") : readFileSync(".env.example", "utf8");
  let out = text;
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(".env", out);
}

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 1_000_000) {
    console.log(`✓ Already downloaded: ${dest}`);
    return;
  }
  console.log(`→ Downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    if (pct >= last + 10) {
      last = pct;
      process.stdout.write(`  ${pct}%\n`);
    }
  });
  await pipeline(body, createWriteStream(dest));
}

function findFile(dir, names) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, names);
      if (hit) return hit;
    } else if (names.includes(entry.name.toLowerCase())) return p;
  }
  return null;
}

try {
  if (process.platform !== "win32") console.warn("⚠ This downloads Windows binaries; run it on the Windows PC that runs Safelight.");
  const env = readEnv();
  // Safelight's app data folder, where it looks for whisper\ and models\ (never the Captures folder).
  const dataDir = env.SAFELIGHT_TOOLS_DIR || join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "uk.co.tomlowndes.safelight");
  const whisperDir = join(dataDir, "whisper");
  const modelsDir = join(dataDir, "models");
  mkdirSync(whisperDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });

  const zip = join(whisperDir, "whisper-bin-x64.zip");
  await download(ZIP_URL, zip);
  // Windows 10+ ships bsdtar, which extracts zip files.
  const tar = spawnSync("tar", ["-xf", zip, "-C", whisperDir], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("Couldn't extract the whisper.cpp zip. Extract it into the whisper folder by hand.");
  const bin = findFile(whisperDir, ["whisper-cli.exe", "main.exe"]);
  if (!bin) throw new Error(`whisper-cli.exe wasn't found in ${whisperDir}.`);

  const model = join(modelsDir, "ggml-base.bin");
  await download(MODEL_URL, model);

  writeEnv({ SAFELIGHT_WHISPER_BIN: bin, SAFELIGHT_WHISPER_MODEL: model });
  console.log(`\n✓ Transcripts are set up.\n  whisper: ${bin}\n  model:   ${model}\nRestart Safelight, then press Retry on any recording's transcript.`);
} catch (err) {
  console.error(`\n✖ ${err.message}\n\nManual set-up: download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases,\n` +
    "extract it, download ggml-base.bin from https://huggingface.co/ggerganov/whisper.cpp, and set\n" +
    "SAFELIGHT_WHISPER_BIN and SAFELIGHT_WHISPER_MODEL in .env to their full paths.");
  process.exit(1);
}
