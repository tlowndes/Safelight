import { useCallback, useEffect, useState } from "react";
import { api, Item, MonthGroup, Progress, ShotMove, SmartState, Source, Stats } from "./api";
import Sidebar, { View } from "./components/Sidebar";
import Library from "./views/Library";
import Sources from "./views/Sources";
import Duplicates from "./views/Duplicates";
import Organise from "./views/Organise";
import Cleanup from "./views/Cleanup";
import Reference from "./views/Reference";
import Editor from "./views/Editor";
import Hidden from "./views/Hidden";
import People from "./views/People";
import Screenshots from "./views/Screenshots";
import ShortcutsDialog from "./components/ShortcutsDialog";
import { CaptureView } from "./capture/ui/CaptureView";
import { Toasts as CaptureToasts } from "./capture/ui/Toasts";
import { useCapture } from "./capture/ui/useCapture";
import { isTyping } from "./shortcuts";

export default function App() {
  const [view, setView] = useState<View>("library");
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [groups, setGroups] = useState<MonthGroup[]>([]);
  const [scanProgress, setScanProgress] = useState<Progress | null>(null);
  const [thumbProgress, setThumbProgress] = useState<Progress | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [smart, setSmart] = useState<SmartState | null>(null);
  const [smartProgress, setSmartProgress] = useState<Progress | null>(null);
  const [query, setQuery] = useState("");
  const [shotsWaiting, setShotsWaiting] = useState(0);
  const [shotTick, setShotTick] = useState(0);
  const [filed, setFiled] = useState<ShotMove | null>(null);

  /** Update items in place (ratings, flags) without reloading the whole library. */
  const patchItems = useCallback((ids: number[], patch: Partial<Item>) => {
    const set = new Set(ids);
    setGroups((gs) => gs.map((g) => ({ ...g, items: g.items.map((i) => (set.has(i.id) ? { ...i, ...patch } : i)) })));
  }, []);

  // Keys that work on every screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !isTyping(e)) { e.preventDefault(); setKeysOpen(true); return; }
      if (keysOpen) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setView("library");
        setTimeout(() => document.getElementById("library-search")?.focus(), 0);
        return;
      }
      if (!isTyping(e) && !e.ctrlKey && !e.metaKey && (e.key === "g" || e.key === "G") && view !== "library") setView("library");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysOpen, view]);

  const refresh = useCallback(async () => {
    try {
      const [s, st, g, shots] = await Promise.all([api.sources(), api.stats(), api.library(), api.shotInfo()]);
      setShotsWaiting(shots.waiting);
      setSources(s);
      setStats(st);
      setGroups(g);
      return { sources: s, stats: st };
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshSmart = useCallback(() => api.smartStatus().then((s) => { setSmart(s); return s; }).catch(() => null), []);

  /** Smart tagging in the background: places straight away, then pictures if the models are in. */
  const runSmart = useCallback(async () => {
    try {
      await api.runSmart();
    } catch (e) {
      setError(String(e));
    } finally {
      setSmartProgress(null);
      refreshSmart();
    }
  }, [refreshSmart]);
  const autoSmart = useCallback(() => refreshSmart().then((s) => { if (s && s.enabled && !s.running) runSmart(); }), [refreshSmart, runSmart]);

  useEffect(() => {
    autoSmart();
    const un = api.onSmartProgress((p) => {
      setSmartProgress(p);
      if (p.done % 50 === 0) refreshSmart();
    });
    return () => { un.then((f) => f()); };
  }, [autoSmart, refreshSmart]);
  // Capture lives at the top so its global shortcuts and the tray work from every screen.
  const cap = useCapture({ onImported: () => void refresh(), onShow: () => setView("capture") });

  useEffect(() => {
    refresh().then((r) => {
      if (r && r.sources.length === 0) setView("sources");
      // Finish thumbnails left over from last time.
      else if (r && r.stats.needing_thumbnails > 0) api.processThumbnails().then(() => { setThumbProgress(null); refresh(); });
    });
    const uns = [
      api.onScanProgress(setScanProgress),
      api.onReferenceMoved((count) => setToast(`Moved ${count} likely reference image${count === 1 ? "" : "s"} to Reference › To sort`)),
      // Screenshots filed (or queued) by the watcher in the background.
      api.onShotFiled((m) => { setFiled(m); setShotTick((t) => t + 1); }),
      api.onShotQueued(() => { setShotTick((t) => t + 1); api.shotInfo().then((i) => setShotsWaiting(i.waiting)).catch(() => {}); }),
      api.onThumbProgress((p) => {
        setThumbProgress(p);
        if (p.done % 200 === 0) refresh();
      }),
    ];
    return () => { uns.forEach((u) => u.then((f) => f())); };
  }, [refresh]);

  const scan = async (id: number) => {
    setError(null);
    try {
      await api.scan(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanProgress(null);
      setThumbProgress(null);
      refresh();
      autoSmart();
    }
  };

  /** Jump to the library with a search filled in (from People & places, or the viewer). */
  const searchLibrary = (q: string) => {
    setQuery(q);
    setView("library");
  };

  const openEditor = (id: number) => {
    setEditing(id);
    setView("edit");
  };

  const busy = thumbProgress && thumbProgress.total > 0 && thumbProgress.done < thumbProgress.total ? thumbProgress : null;

  return (
    <div className="app">
      <Sidebar view={view} onView={setView} sources={sources} stats={stats} thumbs={busy} smart={smartProgress} people={smart?.people ?? 0} shotsWaiting={shotsWaiting} recording={cap.rec.status} onShortcuts={() => setKeysOpen(true)} />
      <main className="main">
        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
        {toast && <div className="toast" onClick={() => { setToast(null); setView("reference"); }}>{toast} · <u>View</u> <button onClick={(e) => { e.stopPropagation(); setToast(null); }}>×</button></div>}
        {view === "library" && <Library groups={groups} stats={stats} sources={sources} query={query} onQuery={setQuery} smartReady={!!smart?.models_ready} onAddSources={() => setView("sources")} onEdit={openEditor} onPatch={patchItems} onChanged={refresh} onError={setError} />}
        {view === "people" && <People status={smart} progress={smartProgress} onRun={runSmart} onStatus={refreshSmart} onSearch={searchLibrary} onError={setError} />}
        {filed && view !== "screenshots" && (
          <div className="toast" onClick={() => { setFiled(null); setView("screenshots"); }}>
            Screenshot filed as {filed.name} · <u onClick={async (e) => {
              e.stopPropagation();
              try { await api.shotUndo(filed.id); setShotTick((t) => t + 1); } catch (err) { setError(String(err)); }
              setFiled(null);
            }}>Undo</u>
            <button onClick={(e) => { e.stopPropagation(); setFiled(null); }} aria-label="Dismiss">×</button>
          </div>
        )}
        {view === "screenshots" && <Screenshots sources={sources} tick={shotTick} onChanged={refresh} onError={setError} />}
        {view === "hidden" && <Hidden onChanged={refresh} onError={setError} />}
        {view === "sources" && <Sources sources={sources} scanProgress={scanProgress} thumbProgress={thumbProgress} onScan={scan} onChanged={refresh} onDone={() => setView("duplicates")} />}
        {view === "duplicates" && <Duplicates stats={stats} onChanged={refresh} onError={setError} onNext={() => setView("organise")} />}
        {view === "organise" && <Organise onChanged={refresh} onError={setError} onNext={() => setView("cleanup")} />}
        {view === "cleanup" && <Cleanup onChanged={refresh} onError={setError} />}
        {view === "reference" && <Reference onError={setError} onOpen={openEditor} />}
        {view === "capture" && <CaptureView k={cap} />}
        {view === "edit" && <Editor itemId={editing} groups={groups} onPick={setEditing} onError={setError} onChanged={refresh} />}
      </main>
      {keysOpen && <ShortcutsDialog onClose={() => setKeysOpen(false)} />}
      <CaptureToasts toasts={cap.toasts} dismiss={cap.dismiss} />
    </div>
  );
}
