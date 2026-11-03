/** Safe, Windows-compatible file and folder names. */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Windows forbids < > : " / \ | ? * and control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const MAX_LENGTH = 120;

/**
 * Turns any user text into a name Windows will accept: forbidden characters
 * become "-", trailing dots/spaces are removed, reserved device names are
 * suffixed, and the result is never empty.
 */
export function sanitizeFilename(input: string, fallback = "untitled"): string {
  let name = (input ?? "")
    .normalize("NFC")
    .replace(FORBIDDEN, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/^[. ]+/g, "");
  if (name.length > MAX_LENGTH) name = name.slice(0, MAX_LENGTH).replace(/[. ]+$/g, "");
  if (!name || /^-+$/.test(name)) name = fallback;
  const stem = name.split(".")[0];
  if (RESERVED.test(stem)) name = `${name}_`;
  return name;
}

/** "Onboarding flow: walkthrough!" -> "onboarding-flow-walkthrough" */
export function slugify(input: string, fallback = "capture"): string {
  const slug = (input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Adds " (2)", " (3)"… until the name is not in `taken`. Case-insensitive like NTFS. */
export function uniqueName(stem: string, ext: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const dotExt = ext ? (ext.startsWith(".") ? ext : `.${ext}`) : "";
  let candidate = `${stem}${dotExt}`;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${dotExt}`;
  return candidate;
}

/** Joins path parts using the separator already present in `base` (Windows or POSIX). */
export function pathJoin(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : base.includes("\\") ? "\\" : "/";
  let out = base.replace(/[\\/]+$/, "");
  for (const part of parts) {
    const clean = part.replace(/^[\\/]+|[\\/]+$/g, "");
    if (clean) out = `${out}${sep}${clean.replace(/[\\/]+/g, sep)}`;
  }
  return out;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? path : path.slice(0, idx);
}

/** True when `child` is inside `parent` (after normalising separators and case). */
export function isInside(parent: string, child: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const a = norm(parent);
  const b = norm(child);
  if (b.split("/").includes("..")) return false;
  return b === a || b.startsWith(`${a}/`);
}
