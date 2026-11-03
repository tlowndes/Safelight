/** Every keyboard and mouse shortcut in Safelight, in one place. The keyboard-help screen (?)
 * is built from this list, so add new shortcuts here when you add them to a screen. */
export type Shortcut = { does: string; keys: string[]; where?: string };
export type ShortcutGroup = { name: string; items: Shortcut[] };

export const SHORTCUTS: ShortcutGroup[] = [
  {
    name: "Move around",
    items: [
      { does: "Next / previous photo", keys: ["→", "/", "←"] },
      { does: "Next / previous photo", keys: ["Wheel"], where: "Loupe" },
      { does: "Move the focus", keys: ["↑", "↓", "←", "→"], where: "Grid" },
      { does: "Grid", keys: ["G"] },
      { does: "Show or hide the folder tree", keys: ["F"], where: "Grid" },
      { does: "Loupe (full screen)", keys: ["E"] },
      { does: "Open in the editor", keys: ["D"] },
      { does: "First / last", keys: ["Home", "/", "End"] },
      { does: "Play or pause a video", keys: ["Space"], where: "Loupe" },
      { does: "Show or hide photo details", keys: ["I"], where: "Loupe" },
      { does: "Hide the overlays", keys: ["Tab"], where: "Loupe" },
    ],
  },
  {
    name: "Zoom",
    items: [
      { does: "Zoom at the cursor", keys: ["Ctrl", "Wheel"] },
      { does: "Fit / 100%", keys: ["Double-click"] },
      { does: "Fit / 100%", keys: ["Z"] },
      { does: "Zoom in / out", keys: ["Ctrl", "+", "/", "−"] },
      { does: "Back to fit", keys: ["Ctrl", "0"] },
      { does: "Pan when zoomed", keys: ["Drag"] },
    ],
  },
  {
    name: "Rate and flag",
    items: [
      { does: "Rate 1 to 5 stars", keys: ["1–5"] },
      { does: "Clear rating", keys: ["0"] },
      { does: "Pick", keys: ["P"] },
      { does: "Reject", keys: ["X"] },
      { does: "Clear flag", keys: ["U"] },
      { does: "Hide from the library", keys: ["H"] },
    ],
  },
  {
    name: "Select",
    items: [
      { does: "Add to selection", keys: ["Ctrl", "Click"], where: "Grid" },
      { does: "Select a range", keys: ["Shift", "Click"], where: "Grid" },
      { does: "Select all", keys: ["Ctrl", "A"], where: "Grid" },
      { does: "Clear selection", keys: ["Esc"], where: "Grid" },
      { does: "Delete selected", keys: ["Delete"], where: "Grid" },
    ],
  },
  {
    name: "Duplicates",
    items: [
      { does: "Keep the chosen copies", keys: ["Enter"] },
      { does: "Next / previous set", keys: ["↓", "/", "↑"] },
      { does: "Not duplicates", keys: ["N"], where: "Look-alikes" },
    ],
  },
  {
    name: "Screenshots",
    items: [
      { does: "File it", keys: ["Enter"], where: "To review" },
      { does: "Leave it where it is", keys: ["Delete"], where: "To review" },
      { does: "Rename", keys: ["F2"], where: "To review" },
      { does: "Choose a folder", keys: ["1–7"], where: "To review" },
      { does: "Next / previous screenshot", keys: ["↓", "/", "↑"], where: "To review" },
      { does: "Preview", keys: ["Space"], where: "To review" },
      { does: "Put back the last one filed", keys: ["Ctrl", "Z"], where: "Screenshots" },
    ],
  },
  {
    name: "General",
    items: [
      { does: "Search", keys: ["Ctrl", "K"] },
      { does: "Keyboard shortcuts", keys: ["?"] },
      { does: "Close or go back", keys: ["Esc"] },
    ],
  },
];

/** True when a key press belongs to a text box, so screens should leave it alone. */
export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}
