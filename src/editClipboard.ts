import { useSyncExternalStore } from "react";
import { defaultEdits, Edits } from "./api";

/** Copied edit settings, shared by the editor and the library so a look can be pasted onto many photos. */
const KEY = "safelight.copied-edits";
let copied: Edits | null = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaultEdits(), ...JSON.parse(raw) } : null;
  } catch { return null; }
})();
const subs = new Set<() => void>();

export function copyEdits(e: Edits) {
  copied = e;
  try { localStorage.setItem(KEY, JSON.stringify(e)); } catch { /* private window */ }
  subs.forEach((f) => f());
}
export const copiedEdits = () => copied;
export function useCopiedEdits() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => copied);
}
