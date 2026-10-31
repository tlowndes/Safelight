import { useCallback, useEffect, useState } from "react";
import { api, MonthGroup, Progress, Source, Stats } from "./api";
import Sidebar, { View } from "./components/Sidebar";
import Library from "./views/Library";
import Sources from "./views/Sources";
import Duplicates from "./views/Duplicates";
import Organise from "./views/Organise";
import Cleanup from "./views/Cleanup";
import Reference from "./views/Reference";
import Editor from "./views/Editor";

export default function App() {
  const [view, setView] = useState<View>("library");
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [groups, setGroups] = useState<MonthGroup[]>([]);
  const [scanProgress, setScanProgress] = useState<Progress | null>(null);
  const [thumbProgress, setThumbProgress] = useState<Progress | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, st, g] = await Promise.all([api.sources(), api.stats(), api.library()]);
      setSources(s);
      setStats(st);
      setGroups(g);
      return { sources: s, stats: st };
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh().then((r) => {
      if (r && r.sources.length === 0) setView("sources");
      // Finish thumbnails left over from last time.
      else if (r && r.stats.needing_thumbnails > 0) api.processThumbnails().then(() => { setThumbProgress(null); refresh(); });
    });
    const uns = [
      api.onScanProgress(setScanProgress),
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
    }
  };

  const openEditor = (id: number) => {
    setEditing(id);
    setView("edit");
  };

  const busy = thumbProgress && thumbProgress.total > 0 && thumbProgress.done < thumbProgress.total ? thumbProgress : null;

  return (
    <div className="app">
      <Sidebar view={view} onView={setView} sources={sources} stats={stats} thumbs={busy} />
      <main className="main">
        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
        {view === "library" && <Library groups={groups} stats={stats} sourceCount={sources.length} onAddSources={() => setView("sources")} onOpen={openEditor} />}
        {view === "sources" && <Sources sources={sources} scanProgress={scanProgress} thumbProgress={thumbProgress} onScan={scan} onChanged={refresh} onDone={() => setView("duplicates")} />}
        {view === "duplicates" && <Duplicates stats={stats} onChanged={refresh} onError={setError} onNext={() => setView("organise")} />}
        {view === "organise" && <Organise onChanged={refresh} onError={setError} onNext={() => setView("cleanup")} />}
        {view === "cleanup" && <Cleanup onChanged={refresh} onError={setError} />}
        {view === "reference" && <Reference onError={setError} onOpen={openEditor} />}
        {view === "edit" && <Editor itemId={editing} groups={groups} onPick={setEditing} onError={setError} onChanged={refresh} />}
      </main>
    </div>
  );
}
