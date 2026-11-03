/** Node implementations of the service ports, used by the end-to-end test. */
import { spawn, spawnSync } from "node:child_process";
import { promises as fsp, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db, FileStore, Ports, Runner, SqlValue, Tool } from "../../../src/capture/services/ports";

const BINARIES: Record<Tool, string | undefined> = {
  ffmpeg: process.env.SAFELIGHT_FFMPEG || "ffmpeg",
  ffprobe: process.env.SAFELIGHT_FFPROBE || "ffprobe",
  whisper: process.env.SAFELIGHT_WHISPER_BIN || undefined,
};

export const nodeRunner: Runner = {
  async available(tool) {
    const bin = BINARIES[tool];
    if (!bin) return false;
    const res = spawnSync(bin, tool === "whisper" ? ["--help"] : ["-version"], { stdio: "ignore" });
    return !res.error;
  },
  run(tool, args, opts = {}) {
    const bin = BINARIES[tool];
    if (!bin) return Promise.resolve({ code: 127, stdout: "", stderr: `program not found: ${tool}` });
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let buffered = "";
      child.stdout.on("data", (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        buffered += text;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        lines.forEach((l) => opts.onLine?.(l));
      });
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (e) => resolve({ code: 127, stdout, stderr: `program not found: ${e.message}` }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};

export const nodeFs: FileStore = {
  exists: async (p) => existsSync(p),
  mkdirp: async (p) => void (await fsp.mkdir(p, { recursive: true })),
  readText: (p) => fsp.readFile(p, "utf8"),
  writeText: (p, t) => fsp.writeFile(p, t, "utf8"),
  remove: async (p) => fsp.rm(p, { force: true }),
  removeDir: async (p) => fsp.rm(p, { recursive: true, force: true }),
  size: async (p) => (await fsp.stat(p)).size,
  list: async (d) => (existsSync(d) ? fsp.readdir(d) : []),
};

export function nodeDb(file: string): Db & { close(): void } {
  const db = new DatabaseSync(file);
  return {
    async execute(sql: string, params: SqlValue[] = []) {
      if (params.length) db.prepare(sql).run(...params);
      else db.exec(sql);
    },
    async select<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    close: () => db.close(),
  };
}

export function nodePorts(dataDir: string, db: Db): Ports {
  return {
    runner: nodeRunner,
    fs: nodeFs,
    db,
    config: { dataDir, whisperModel: process.env.SAFELIGHT_WHISPER_MODEL || null },
  };
}
