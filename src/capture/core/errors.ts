/**
 * Turns low-level failures into messages that say what happened and what to
 * do next. Every error shown in the UI goes through here.
 */

export type ErrorCode =
  | "FFMPEG_MISSING"
  | "MIC_UNAVAILABLE"
  | "MIC_BLOCKED"
  | "WINDOW_GONE"
  | "DISK_FULL"
  | "FILE_MISSING"
  | "INVALID_EDIT"
  | "RENDER_FAILED"
  | "TRANSCRIBE_UNAVAILABLE"
  | "DESKTOP_ONLY"
  | "UNKNOWN";

export interface FriendlyError {
  code: ErrorCode;
  title: string;
  message: string;
  /** Whether trying again (possibly after the suggested fix) can work. */
  recoverable: boolean;
  /** Optional action the UI can offer. */
  action?: "open-mic-settings" | "open-settings" | "retry" | "setup-whisper";
}

export class CaptureError extends Error {
  constructor(public readonly friendly: FriendlyError, public readonly detail?: string) {
    super(friendly.message);
    this.name = "CaptureError";
  }
}

const lastLines = (s: string, n = 6) => s.trim().split(/\r?\n/).slice(-n).join("\n");

export function explainToolFailure(tool: string, stderr: string): FriendlyError {
  const s = stderr ?? "";
  if (/not found|No such file or directory.*ffmpeg|program not found|cannot find the file specified/i.test(s) && /spawn|program|ffmpeg|whisper/i.test(s)) {
    return {
      code: tool === "whisper" ? "TRANSCRIBE_UNAVAILABLE" : "FFMPEG_MISSING",
      title: tool === "whisper" ? "Transcripts aren't set up" : "ffmpeg isn't installed",
      message:
        tool === "whisper"
          ? "Run `npm run setup:whisper` once to download the local transcription model, then retry."
          : "Safelight needs ffmpeg. Install it with `winget install Gyan.FFmpeg`, restart Safelight and try again.",
      recoverable: true,
      action: tool === "whisper" ? "setup-whisper" : "retry",
    };
  }
  if (/Could not (find|enumerate) audio|audio device.*not found|Could not set audio/i.test(s)) {
    return {
      code: "MIC_UNAVAILABLE",
      title: "Microphone unavailable",
      message: "The selected microphone wasn't found. Plug it in or pick another in the capture bar. Recording continues without audio.",
      recoverable: true,
      action: "retry",
    };
  }
  if (/Access is denied|Permission denied|0x80070005|E_ACCESSDENIED/i.test(s) && /dshow|audio/i.test(s)) {
    return {
      code: "MIC_BLOCKED",
      title: "Microphone access is off",
      message: 'Windows is blocking the mic. Turn on "Let desktop apps access your microphone" in Settings, then try again.',
      recoverable: true,
      action: "open-mic-settings",
    };
  }
  if (/Can't find window/i.test(s)) {
    return {
      code: "WINDOW_GONE",
      title: "Window not found",
      message: "That window was closed or renamed. Pick it again from the window list.",
      recoverable: true,
      action: "retry",
    };
  }
  if (/No space left|There is not enough space/i.test(s)) {
    return {
      code: "DISK_FULL",
      title: "Disk is full",
      message: "Free up some space or move the Captures folder to a bigger drive in Settings, then try again.",
      recoverable: true,
      action: "open-settings",
    };
  }
  if (/No such file or directory|does not exist/i.test(s)) {
    return {
      code: "FILE_MISSING",
      title: "File missing",
      message: "The source file was moved or deleted. Check the Captures folder, or remove this item from the library.",
      recoverable: false,
    };
  }
  return {
    code: tool === "whisper" ? "TRANSCRIBE_UNAVAILABLE" : "RENDER_FAILED",
    title: tool === "whisper" ? "Transcription failed" : "ffmpeg stopped with an error",
    message: `${lastLines(s, 3) || "No details were reported."}\nTry again; if it keeps failing, check the log in Settings.`,
    recoverable: true,
    action: "retry",
  };
}

export function toFriendly(err: unknown): FriendlyError {
  if (err instanceof CaptureError) return err.friendly;
  const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
  return { code: "UNKNOWN", title: "Something went wrong", message, recoverable: true, action: "retry" };
}
