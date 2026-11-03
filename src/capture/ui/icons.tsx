/** Small inline icon set (stroke icons, 24px grid). */
import type { SVGProps } from "react";

const make = (d: string) => (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d={d} />
  </svg>
);

export const IconCamera = make("M4 8h3l2-3h6l2 3h3v11H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z");
export const IconRecord = make("M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z");
export const IconStop = make("M7 7h10v10H7z");
export const IconPause = make("M9 6v12 M15 6v12");
export const IconPlay = make("M8 5l11 7-11 7z");
export const IconBack = make("M15 18l-6-6 6-6");
export const IconTrim = make("M6 4v16 M18 4v16 M6 12h12");
export const IconCrop = make("M6 2v16h16 M2 6h16v16");
export const IconZoom = make("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5 M11 8v6 M8 11h6");
export const IconCursor = make("M5 3l14 8-6 2-2 6z");
export const IconText = make("M4 5h16v11H9l-4 4z M8 9h8 M8 12h5");
export const IconMarker = make("M6 3v18 M6 4h11l-3 4 3 4H6");
export const IconExport = make("M12 3v12 M7 10l5 5 5-5 M4 19h16");
export const IconFolder = make("M3 6h6l2 2h10v11H3z");
export const IconCopy = make("M8 8h12v12H8z M4 16V4h12");
export const IconTrash = make("M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13");
export const IconSettings = make("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19 12l2-1-1-3-2 .2-1.5-1.5L16.7 4l-3-1-1 2h-1.4l-1-2-3 1 .2 2.3L6 7.8 4 8 3 11l2 1v1.4L3 15l1 3 2.2-.2L7.7 19l-.2 2.2 3 1 1-2h1.4l1 2 3-1-.2-2.2 1.5-1.5 2.2.2 1-3-2-1z");
export const IconRefresh = make("M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7");
export const IconClose = make("M6 6l12 12 M18 6L6 18");
export const IconUndo = make("M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3");
export const IconRedo = make("M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3");
export const IconMic = make("M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z M6 11a6 6 0 0 0 12 0 M12 17v4");
