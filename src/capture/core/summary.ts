/**
 * A Markdown summary written beside each exported video. Everything is
 * computed locally: key moments and callouts from the edit, plus a few
 * highlight sentences picked from the transcript by word frequency.
 */
import type { EditRecipe } from "./recipe";
import type { Cue } from "./transcript";
import { formatDuration } from "./time";

const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by can could did do does doing for from had has have here how i if in into is it its " +
    "just like me my no not of on or our so some that the their them then there these they this to up us was we were what " +
    "when where which who will with would you your yeah okay ok um uh so gonna going go get got really very also now one"
  ).split(" "),
);

export interface Highlight {
  at: number;
  text: string;
}

/** Splits cues into sentences that keep the timestamp of the cue they start in. */
function sentences(cues: Cue[]): Highlight[] {
  const out: Highlight[] = [];
  let current = "";
  let at = 0;
  for (const cue of cues) {
    for (const part of cue.text.split(/(?<=[.!?])\s+/)) {
      if (!current) at = cue.start;
      current = current ? `${current} ${part}` : part;
      if (/[.!?]$/.test(part)) {
        out.push({ at, text: current.trim() });
        current = "";
      }
    }
  }
  if (current.trim()) out.push({ at, text: current.trim() });
  return out;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Picks up to `count` informative sentences, returned in the order they were said. */
export function pickHighlights(cues: Cue[], count = 3): Highlight[] {
  const all = sentences(cues).filter((s) => words(s.text).length >= 4);
  if (all.length <= count) return all;
  const freq = new Map<string, number>();
  for (const s of all) for (const w of words(s.text)) if (!STOP_WORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = all.map((s, i) => {
    const ws = words(s.text).filter((w) => !STOP_WORDS.has(w));
    const score = ws.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / Math.max(4, Math.sqrt(ws.length) * 3);
    return { s, i, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

export interface SummaryInput {
  title: string;
  createdAt: Date;
  recipe: EditRecipe;
  files: { label: string; name: string }[];
  /** Cues already re-timed to the export (0 = first exported frame). */
  cues: Cue[] | null;
  /** Why there is no transcript, when there isn't one. */
  transcriptNote?: string;
}

const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>|#])/g, "\\$1");

export function buildSummaryMarkdown(input: SummaryInput): string {
  const { recipe } = input;
  const t0 = recipe.trim.start;
  const length = recipe.trim.end - recipe.trim.start;
  const inRange = (t: number) => t >= recipe.trim.start && t <= recipe.trim.end;
  const out: string[] = [];

  out.push(`# ${escapeMd(input.title)}`, "");
  out.push(
    `- **Recorded:** ${input.createdAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`,
    `- **Length:** ${formatDuration(length)}`,
  );
  if (recipe.crop) out.push(`- **Cropped to:** ${recipe.crop.w}×${recipe.crop.h}`);
  out.push("");

  const moments = recipe.markers.filter((m) => inRange(m.at));
  out.push("## Key moments", "");
  if (moments.length) {
    for (const m of moments) out.push(`- **${formatDuration(m.at - t0)}** ${escapeMd(m.label || "Key moment")}`);
  } else {
    out.push("_No key moments marked._");
  }
  out.push("");

  const callouts = recipe.callouts.filter((c) => c.end > recipe.trim.start && c.start < recipe.trim.end);
  if (callouts.length) {
    out.push("## Callouts", "");
    for (const c of callouts) out.push(`- **${formatDuration(Math.max(0, c.start - t0))}** ${escapeMd(c.text)}`);
    out.push("");
  }

  out.push("## Highlights", "");
  if (input.cues && input.cues.length) {
    for (const h of pickHighlights(input.cues)) out.push(`- **${formatDuration(h.at)}** ${escapeMd(h.text)}`);
  } else {
    out.push(`_${escapeMd(input.transcriptNote ?? "No transcript for this video.")}_`);
  }
  out.push("");

  out.push("## Files", "");
  for (const f of input.files) out.push(`- ${f.label}: \`${f.name}\``);
  out.push("", "_Generated locally by Safelight._", "");
  return out.join("\n");
}
