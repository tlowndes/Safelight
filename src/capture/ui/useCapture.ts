/**
 * Capture controller: boot, the capture list, screenshot and recording flows, toasts.
 * Mounted once at the top of Safelight so global shortcuts and the tray work from any
 * screen. Components stay presentational; everything with side effects lives here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildScreenshotArgs, buildSegmentArgs, LIST_AUDIO_DEVICES_ARGS, type CaptureTarget } from "../core/ffmpeg";
import { parseDshowAudioDevices } from "../core/devices";
import { explainToolFailure, CaptureError, toFriendly, type FriendlyError } from "../core/errors";
import type { Rect } from "../core/recipe";
import {
  countCaptures, deleteCapture as dbDeleteCapture, getCapture, listCaptures, migrate, type Capture, type KindFilter,
} from "../services/library";
import {
  addScreenshot, ensureFolders, finaliseRecording, newRecordingFolder, newScreenshotPath, transcribe, transcriptionStatus,
} from "../services/pipeline";
import type { Ports } from "../services/ports";
import { loadSettings, saveSettings, type Settings } from "../services/settings";
import * as native from "../platform/desktop";
import { playShutterSound } from "./sound";

export type View =
  | { name: "library" }
  | { name: "editor"; id: number }
  | { name: "screenshot"; id: number }
  | { name: "settings" };

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "info" | "warn";
  title: string;
  message?: string;
  actions?: ToastAction[];
  sticky?: boolean;
}

export type Boot =
  | { state: "loading" }
  | { state: "browser" }
  | { state: "error"; error: FriendlyError }
  | { state: "ready" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CaptureHooks {
  /** Called after captures were scanned into the library. */
  onImported: () => void;
  /** Bring the Capture screen forward (e.g. when a recording has just been saved). */
  onShow: () => void;
}

export function useCapture(hooks: CaptureHooks) {
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const [ports, setPorts] = useState<Ports | null>(null);
  const [config, setConfig] = useState<native.NativeConfig | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [transcriptReady, setTranscriptReady] = useState<{ ready: boolean; reason?: string }>({ ready: false });
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [counts, setCounts] = useState<Record<KindFilter, number>>({ all: 0, video: 0, screenshot: 0 });
  const [listLoading, setListLoading] = useState(true);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ name: "library" });
  const [rec, setRec] = useState<native.RecState>({ status: "idle", elapsedMs: 0 });
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [screens, setScreens] = useState<native.Screen[]>([]);
  const [windows, setWindows] = useState<native.WindowInfo[]>([]);
  const [mics, setMics] = useState<string[]>([]);
  const [hotkeyFailures, setHotkeyFailures] = useState<native.HotkeyFailure[]>([]);
  const [storageBytes, setStorageBytes] = useState(0);
  const [target, setTarget] = useState<{ screen: number; window: string }>({ screen: -1, window: "" }); // -1 = primary screen

  const portsRef = useRef<Ports | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const toastId = useRef(0);
  portsRef.current = ports;
  settingsRef.current = settings;

  /* ---------- toasts ---------- */

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++toastId.current;
      setToasts((all) => [...all.slice(-3), { ...t, id }]);
      if (!t.sticky) setTimeout(() => dismiss(id), t.kind === "error" ? 9000 : 5000);
      return id;
    },
    [dismiss],
  );
  const toastError = useCallback(
    (err: unknown, retry?: () => void) => {
      const f = toFriendly(err);
      const actions: ToastAction[] = [];
      if (f.action === "open-mic-settings") actions.push({ label: "Open privacy settings", run: () => void native.openMicSettings() });
      if (f.action === "open-settings") actions.push({ label: "Settings", run: () => setView({ name: "settings" }) });
      if (f.recoverable && retry) actions.push({ label: "Try again", run: retry });
      toast({ kind: "error", title: f.title, message: f.message, actions });
    },
    [toast],
  );

  /** Scans the Captures folder so the new file shows up in the main library. Never throws. */
  const landInLibrary = useCallback(async () => {
    try {
      await native.importCaptures();
      hooksRef.current.onImported();
    } catch {
      // The capture is safe on disk; the next scan of the Captures source will pick it up.
    }
  }, []);

  /* ---------- library ---------- */

  const refresh = useCallback(async () => {
    const p = portsRef.current;
    if (!p) return;
    const [list, c] = await Promise.all([listCaptures(p.db, { search, kind: filter }), countCaptures(p.db)]);
    setCaptures(list);
    setCounts(c);
    setListLoading(false);
    native.dataSize().then(setStorageBytes);
  }, [search, filter, ports]); // ports: re-run once the library has opened

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 150);
    return () => clearTimeout(t);
  }, [refresh]);

  const refreshCapture = useCallback(async (id: number) => {
    const p = portsRef.current;
    if (!p) return null;
    const c = await getCapture(p.db, id);
    if (c) setCaptures((all) => all.map((x) => (x.id === id ? c : x)));
    return c;
  }, []);

  const runTranscript = useCallback(
    async (capture: Capture) => {
      const p = portsRef.current;
      if (!p) return;
      setCaptures((all) => all.map((x) => (x.id === capture.id ? { ...x, transcriptStatus: "pending" } : x)));
      await transcribe(p, capture);
      await refreshCapture(capture.id);
    },
    [refreshCapture],
  );

  /* ---------- boot ---------- */

  useEffect(() => {
    if (!native.isDesktop()) {
      setBoot({ state: "browser" });
      setListLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cfg = await native.getConfig();
        const p = await native.createPorts(cfg);
        await migrate(p.db);
        await ensureFolders(p);
        const s = await loadSettings(p.db);
        if (cancelled) return;
        portsRef.current = p;
        setConfig(cfg);
        setPorts(p);
        setSettings(s);
        setBoot({ state: "ready" });
        const [hasFfmpeg, hasProbe] = await Promise.all([p.runner.available("ffmpeg"), p.runner.available("ffprobe")]);
        setFfmpegOk(hasFfmpeg && hasProbe);
        setTranscriptReady(await transcriptionStatus(p));
        setHotkeyFailures(await native.setHotkeys(s.hotkeys));
        void native.setCloseToTray(s.closeToTray);
        setRec(await native.recStatus());
      } catch (err) {
        if (!cancelled) setBoot({ state: "error", error: toFriendly(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- capture sources ---------- */

  const refreshSources = useCallback(async () => {
    const p = portsRef.current;
    if (!p) return;
    const [scr, wins, devices] = await Promise.all([
      native.listScreens().catch(() => []),
      native.listWindows(),
      p.runner.run("ffmpeg", LIST_AUDIO_DEVICES_ARGS).then((r) => parseDshowAudioDevices(r.stderr)).catch(() => []),
    ]);
    setScreens(scr);
    setWindows(wins);
    setMics(devices);
    setTarget((t) => ({
      screen: t.screen < scr.length ? t.screen : -1,
      window: wins.some((w) => w.title === t.window) ? t.window : wins[0]?.title ?? "",
    }));
  }, []);

  useEffect(() => {
    if (boot.state === "ready") void refreshSources();
  }, [boot.state, refreshSources]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const p = portsRef.current;
      const current = settingsRef.current;
      if (!p || !current) return;
      const next = { ...current, ...patch };
      setSettings(next);
      await saveSettings(p.db, next);
      if (patch.hotkeys) setHotkeyFailures(await native.setHotkeys(next.hotkeys));
      if (patch.closeToTray !== undefined) void native.setCloseToTray(next.closeToTray);
    },
    [],
  );

  /* ---------- screenshots ---------- */

  const takeScreenshot = useCallback(
    async (kind: "region" | "screen" | "window") => {
      const p = portsRef.current;
      const s = settingsRef.current;
      if (!p || !s) return;
      try {
        let rect: Rect | null;
        if (kind === "region") {
          rect = await native.pickRegion("screenshot");
          if (!rect) return;
          await sleep(150); // let the overlay disappear before capturing
        } else if (kind === "window") {
          const win = windows.find((w) => w.title === target.window);
          if (!win) throw new Error("Pick a window from the list first.");
          rect = win;
        } else {
          rect = await native.screenUnderCursor();
          if (!rect) throw new Error("No screen found to capture.");
        }
        const output = await newScreenshotPath(p);
        const res = await p.runner.run("ffmpeg", buildScreenshotArgs({ target: { kind: "region", rect }, output }));
        if (res.code !== 0) throw new CaptureError(explainToolFailure("ffmpeg", res.stderr), res.stderr);
        const capture = await addScreenshot(p, output);
        let copied = false;
        if (s.copyScreenshots) {
          copied = await native.copyImage(output).then(() => true, () => false);
        }
        // Feedback for the capture, since the window may be minimised or closed to the tray.
        void native.flashScreen();
        playShutterSound();
        void native.notify(copied ? "Screenshot saved and copied" : "Screenshot saved", `${capture.width}×${capture.height} · Screenshots folder`);
        toast({
          kind: "success",
          title: copied ? "Screenshot saved and copied" : "Screenshot saved",
          message: `${capture.width}×${capture.height} · Screenshots folder`,
          actions: [
            { label: "Copy path", run: () => void native.copyText(output) },
            { label: "Show in Explorer", run: () => void native.revealInFolder(output) },
          ],
        });
        void refresh();
        void landInLibrary();
      } catch (err) {
        toastError(err, () => void takeScreenshot(kind));
      }
    },
    [refresh, toast, toastError, windows, target, landInLibrary],
  );

  /* ---------- recording ---------- */

  const resolveTarget = useCallback(
    async (mode: Settings["captureMode"]): Promise<{ target: CaptureTarget; origin: { x: number; y: number } } | null> => {
      if (mode === "region") {
        const rect = await native.pickRegion("record");
        if (!rect) return null;
        await sleep(150);
        return { target: { kind: "region", rect }, origin: rect };
      }
      if (mode === "window") {
        const win = windows.find((w) => w.title === target.window);
        if (!win) throw new Error("Pick a window to record from the list first.");
        return { target: { kind: "window", title: win.title, rect: win }, origin: win };
      }
      const scr = screens[target.screen] ?? screens.find((x) => x.primary) ?? screens[0];
      const rect = scr?.rect ?? (await native.screenUnderCursor());
      if (!rect) throw new Error("No screen found to record.");
      return { target: { kind: "screen", rect }, origin: rect };
    },
    [screens, windows, target],
  );

  const startRecording = useCallback(async () => {
    const p = portsRef.current;
    const s = settingsRef.current;
    if (!p || !s || rec.status !== "idle") return;
    try {
      const resolved = await resolveTarget(s.captureMode);
      if (!resolved) return;
      const folder = await newRecordingFolder(p);
      const attempt = (mic: string | null) =>
        native.recStart(buildSegmentArgs({ target: resolved.target, fps: s.fps, mic, output: "{segment}" }), folder, resolved.origin);
      try {
        await attempt(s.mic);
      } catch (err) {
        const friendly = explainToolFailure("ffmpeg", String(err));
        if (s.mic && (friendly.code === "MIC_UNAVAILABLE" || friendly.code === "MIC_BLOCKED")) {
          await attempt(null);
          toast({
            kind: "warn",
            title: "Recording without audio",
            message: friendly.message,
            actions: friendly.action === "open-mic-settings" ? [{ label: "Open privacy settings", run: () => void native.openMicSettings() }] : [],
          });
        } else {
          throw new CaptureError(friendly, String(err));
        }
      }
      setRec({ status: "recording", elapsedMs: 0 });
      if (s.minimiseOnRecord) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().minimize();
      }
    } catch (err) {
      toastError(err, () => void startRecording());
    }
  }, [rec.status, resolveTarget, toast, toastError]);

  const stopRecording = useCallback(() => native.recStop().catch((e) => toastError(e)), [toastError]);
  const togglePause = useCallback(() => native.recTogglePause().catch((e) => toastError(e)), [toastError]);

  // Recording events can come from the HUD, the tray or a hotkey, not just this window.
  useEffect(() => {
    if (boot.state !== "ready") return;
    const subs = [
      native.onRecState(setRec),
      native.onRecFinished(async (done) => {
        setRec({ status: "idle", elapsedMs: 0 });
        const p = portsRef.current;
        if (!p) return;
        setSaving(true);
        await native.showMainWindow();
        try {
          const capture = await finaliseRecording(p, {
            folder: done.folder,
            segments: done.segments,
            cursorFile: done.cursorFile,
            createdAt: new Date(done.startedAtMs),
          });
          await refresh();
          hooksRef.current.onShow();
          setView({ name: "editor", id: capture.id });
          void landInLibrary();
          toast({ kind: "success", title: "Recording saved", message: "Trim it, add callouts, then export." });
          void runTranscript(capture);
        } catch (err) {
          toastError(err);
        } finally {
          setSaving(false);
        }
      }),
    ];
    return () => subs.forEach((u) => u.then((f) => f()));
  }, [boot.state, refresh, runTranscript, toast, toastError, landInLibrary]);

  // Global shortcuts and tray actions.
  const hotkeyHandler = useRef<(a: string) => void>(() => undefined);
  hotkeyHandler.current = (action: string) => {
    if (action === "screenshot-region") void takeScreenshot("region");
    else if (action === "screenshot-screen") void takeScreenshot("screen");
    else if (action === "record") {
      if (rec.status === "idle") void startRecording();
      else void stopRecording();
    }
  };
  useEffect(() => {
    if (boot.state !== "ready") return;
    const sub = native.onHotkey((a) => hotkeyHandler.current(a));
    return () => void sub.then((f) => f());
  }, [boot.state]);

  /* ---------- library actions ---------- */

  const removeCapture = useCallback(
    async (c: Capture) => {
      const p = portsRef.current;
      if (!p) return;
      try {
        await native.trash(c.kind === "video" ? c.folder : c.filePath);
        await dbDeleteCapture(p.db, c.id);
        setView({ name: "library" });
        toast({ kind: "info", title: "Moved to the Recycle Bin", message: `${c.title} was removed from Safelight. You can restore it from the Recycle Bin.` });
        void refresh();
        void landInLibrary();
      } catch (err) {
        toastError(err);
      }
    },
    [refresh, toast, toastError, landInLibrary],
  );

  const copyPath = useCallback(
    (path: string) =>
      native.copyText(path).then(
        () => toast({ kind: "success", title: "Path copied", message: path }),
        (e) => toastError(e),
      ),
    [toast, toastError],
  );
  const reveal = useCallback((path: string) => native.revealInFolder(path).catch((e) => toastError(e)), [toastError]);

  return useMemo(
    () => ({
      boot, ports, config, settings, ffmpegOk, transcriptReady, captures, counts, listLoading, filter, search, view, rec,
      saving, toasts, screens, windows, mics, hotkeyFailures, storageBytes, target,
      setFilter, setSearch, setView, setTarget, dismiss, toast, toastError, refresh, refreshCapture, refreshSources,
      updateSettings, takeScreenshot, startRecording, stopRecording, togglePause, removeCapture, copyPath, reveal,
      runTranscript, landInLibrary,
    }),
    [
      boot, ports, config, settings, ffmpegOk, transcriptReady, captures, counts, listLoading, filter, search, view, rec,
      saving, toasts, screens, windows, mics, hotkeyFailures, storageBytes, target, dismiss, toast, toastError, refresh,
      refreshCapture, refreshSources, updateSettings, takeScreenshot, startRecording, stopRecording, togglePause,
      removeCapture, copyPath, reveal, runTranscript, landInLibrary,
    ],
  );
}

export type CaptureCtl = ReturnType<typeof useCapture>;
