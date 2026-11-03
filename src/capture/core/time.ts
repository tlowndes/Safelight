/** Time helpers. All internal times are integer milliseconds. */

const pad = (n: number, width = 2) => String(Math.floor(n)).padStart(width, "0");

/** 134600 -> "02:14.6" (used in the HUD, timeline and inspector). */
export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const tenths = Math.floor((safe % 1000) / 100);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    return `${pad(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds)}.${tenths}`;
  }
  return `${pad(minutes)}:${pad(seconds)}.${tenths}`;
}

/** 134600 -> "02:14" (cards, summaries). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** ASS subtitle timestamps use centiseconds: "0:02:14.60". */
export function assTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms / 10) * 10);
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const cs = Math.floor((safe % 1000) / 10);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** WebVTT timestamps: "00:02:14.600". */
export function vttTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(safe % 1000, 3)}`;
}

/** Seconds string for ffmpeg arguments, e.g. 1500 -> "1.500". */
export function ffSeconds(ms: number): string {
  return (Math.max(0, Math.round(ms)) / 1000).toFixed(3);
}

/** "2026-10-14 16-47-03" — sortable and valid on Windows. */
export function timestampName(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** 2_516_582_400 -> "2.3 GB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
