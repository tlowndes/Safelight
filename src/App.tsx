import { useCallback, useEffect, useState } from "react";
import { api, MonthGroup, ScanProgress, Source, Stats } from "./api";
import Sidebar, { View } from "./components/Sidebar";
import Library from "./views/Library";
import Sources from "./views/Sources";
import ComingSoon from "./views/ComingSoon";

export default function App() {
  const [view, setView] = useState<View>("library");
  const [sources, setSources] = useState<Source[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [groups, setGroups] = useState<MonthGroup[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, st, g] = await Promise.all([api.sources(), api.stats(), api.library()]);
      setSources(s);
      setStats(st);
      setGroups(g);
      if (s.length === 0) setView("sources");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const un = api.onScanProgress(setProgress);
    return () => { un.then((f) => f()); };
  }, [refresh]);

  const scan = async (id: number) => {
    setError(null);
    try {
      await api.scan(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setProgress(null);
      refresh();
    }
  };

  return (
    <div className="app">
      <Sidebar view={view} onView={setView} sources={sources} stats={stats} />
      <main className="main">
        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
        {view === "library" && <Library groups={groups} stats={stats} sourceCount={sources.length} onAddSources={() => setView("sources")} />}
        {view === "sources" && <Sources sources={sources} progress={progress} onScan={scan} onChanged={refresh} onDone={() => setView("library")} />}
        {view === "duplicates" && <ComingSoon title="Duplicates" phase="Phase 3" text={`${stats?.exact_duplicate_files ?? 0} exact copies found so far. The side-by-side review screen comes next.`} />}
        {view === "organise" && <ComingSoon title="Organise" phase="Phase 4" text="Preview the Year / Month - Event folders, then copy to Proton Drive and the NAS." />}
        {view === "reference" && <ComingSoon title="Reference" phase="Phase 4" text="Design reference images, sorted into topics and tagged." />}
        {view === "edit" && <ComingSoon title="Edit" phase="Phase 6" text="Basics, tone curve, HSL and presets. Originals never change." />}
      </main>
    </div>
  );
}
