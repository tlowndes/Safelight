import { useCallback, useEffect, useState } from "react";
import { api, FaceRow, fileUrl, Item, n, Person, PlaceCount, Progress, SmartState, TagCount } from "../api";
import Thumb from "../components/Thumb";

type Tab = "people" | "places" | "things";
type Props = {
  status: SmartState | null;
  progress: Progress | null;
  onRun: () => void;
  onStatus: () => void;
  /** Show the library filtered by these words. */
  onSearch: (q: string) => void;
  onError: (e: string) => void;
};

/** Smart tagging: set-up, then people to name, places and things found in your photos. */
export default function People({ status, progress, onRun, onStatus, onSearch, onError }: Props) {
  const [tab, setTab] = useState<Tab>("people");
  const [people, setPeople] = useState<Person[]>([]);
  const [places, setPlaces] = useState<PlaceCount[]>([]);
  const [things, setThings] = useState<TagCount[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [download, setDownload] = useState<Progress | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, pl, t] = await Promise.all([api.people(), api.places(), api.smartTags("scene")]);
      setPeople(p);
      setPlaces(pl);
      setThings(t);
    } catch (e) { onError(String(e)); }
  }, [onError]);
  useEffect(() => { load(); }, [load, status?.analysed]);
  useEffect(() => {
    const un = api.onModelProgress(setDownload);
    return () => { un.then((f) => f()); };
  }, []);

  const setUp = async () => {
    setDownload({ done: 0, total: 1 });
    try {
      await api.downloadModels();
      await api.setSetting("smart_tagging", "1");
      onStatus();
      onRun();
    } catch (e) { onError(String(e)); }
    finally { setDownload(null); }
  };

  const person = people.find((p) => p.id === open);
  const left = status ? Math.max(0, status.total - status.analysed) : 0;

  return (
    <>
      <div className="top">
        <h1>People &amp; places</h1>
        <span className="sub">Found on this PC. Nothing is uploaded.</span>
        <div className="seg tabs" role="tablist" style={{ marginLeft: "auto" }}>
          {(["people", "places", "things"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setOpen(null); }}>
              {t === "people" ? "People" : t === "places" ? "Places" : "Things"}
            </button>
          ))}
        </div>
      </div>

      <div className="detail">
        {status && !status.models_ready && (
          <div className="card smart-card">
            <div className="card-head"><b>Turn on smart tagging</b></div>
            <p className="muted">
              Safelight can find faces, group the same person together, tag what's in each photo (beach, dog, birthday…)
              and let you search by words. It needs a one-off download of {status.missing.length} small AI models,
              about {n(status.download_mb)} MB. After that it all runs on this PC: no photo, face or search ever leaves it.
            </p>
            <ul className="muted small model-list">
              {status.missing.map((m) => <li key={m.file}>{m.purpose} · {m.size_mb} MB</li>)}
            </ul>
            {download ? (
              <>
                <div className="bar"><b style={{ width: `${(download.done / Math.max(1, download.total)) * 100}%` }} /></div>
                <span className="muted small">{download.current ? `Downloading: ${download.current.toLowerCase()}` : "Starting download…"}</span>
              </>
            ) : (
              <div className="row start"><button className="btn pri" onClick={setUp}>Download and start · {n(status.download_mb)} MB</button></div>
            )}
            <p className="muted small">Places from your photos' GPS work already, without the download.</p>
          </div>
        )}

        {status?.models_ready && (progress || left > 0 || !status.enabled) && (
          <div className="card smart-card slim">
            {progress && progress.total > 0 ? (
              <>
                <div className="row"><b>Looking at your photos</b><span className="muted">{n(progress.done)} of {n(progress.total)}</span></div>
                <div className="bar"><b style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
                <div className="row start">
                  <span className="muted small">Runs in the background. You can keep using Safelight.</span>
                  <button className="btn small" onClick={() => api.stopSmart()}>Pause</button>
                </div>
              </>
            ) : (
              <div className="row">
                <span>{left > 0 ? `${n(left)} photo${left === 1 ? "" : "s"} not tagged yet` : "All photos tagged"}</span>
                <div className="row">
                  <label className="muted small toggle-label">
                    <input type="checkbox" checked={status.enabled} onChange={async (e) => { await api.setSetting("smart_tagging", e.target.checked ? "1" : "0"); onStatus(); }} />
                    Tag new photos automatically
                  </label>
                  {left > 0 && <button className="btn" onClick={onRun}>Tag now</button>}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "people" && !person && (
          people.length === 0 ? (
            <p className="muted">{status?.models_ready ? "No one yet. People appear here once they're in two or more photos." : "People appear here once smart tagging is on."}</p>
          ) : (
            <>
              {people.some((p) => !p.name) && <p className="muted small">Name someone once and Safelight tags every photo they're in. Give two groups the same name to join them.</p>}
              <div className="people">
                {people.map((p) => (
                  <PersonCard key={p.id} person={p} onOpen={() => setOpen(p.id)} onNamed={load} onError={onError} />
                ))}
              </div>
            </>
          )
        )}

        {tab === "people" && person && (
          <PersonDetail person={person} onBack={() => setOpen(null)} onChanged={load} onSearch={onSearch} onError={onError} />
        )}

        {tab === "places" && (
          places.length === 0 ? (
            <p className="muted">No places yet. Photos taken on phones usually carry GPS; Safelight names the town and country from it, offline.</p>
          ) : (
            <div className="places">
              {groupByCountry(places).map(([country, rows]) => (
                <section key={country}>
                  <button className="place-country" onClick={() => onSearch(country)}>
                    <b>{country}</b><span>{n(rows.reduce((a, r) => a + r.count, 0))}</span>
                  </button>
                  <div className="tag-cloud">
                    {rows.filter((r) => r.town).map((r) => (
                      <button key={r.town} className="tag" onClick={() => onSearch(r.town!)}>{r.town} <span className="count">{n(r.count)}</span></button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        )}

        {tab === "things" && (
          things.length === 0 ? (
            <p className="muted">{status?.models_ready ? "Nothing tagged yet." : "Things appear here once smart tagging is on."}</p>
          ) : (
            <div className="tag-cloud big">
              {things.map((t) => (
                <button key={t.name} className="tag" onClick={() => onSearch(t.name)}>{t.name} <span className="count">{n(t.count)}</span></button>
              ))}
            </div>
          )
        )}
      </div>
    </>
  );
}

function groupByCountry(rows: PlaceCount[]): [string, PlaceCount[]][] {
  const map = new Map<string, PlaceCount[]>();
  rows.forEach((r) => map.set(r.country, [...(map.get(r.country) ?? []), r]));
  return [...map.entries()].sort((a, b) => b[1].reduce((x, r) => x + r.count, 0) - a[1].reduce((x, r) => x + r.count, 0));
}

function Avatar({ src, size = 96 }: { src: string | null; size?: number }) {
  return <span className="avatar" style={{ width: size, height: size }}>{src && <img src={fileUrl(src)} alt="" loading="lazy" />}</span>;
}

function PersonCard({ person, onOpen, onNamed, onError }: { person: Person; onOpen: () => void; onNamed: () => void; onError: (e: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="person">
      <button className="person-face" onClick={onOpen} aria-label={person.name ?? "Unnamed person"}><Avatar src={person.cover} /></button>
      {person.name ? (
        <button className="person-name" onClick={onOpen}><b>{person.name}</b></button>
      ) : (
        <input className="inline-input" placeholder="Add a name" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && name.trim()) {
              try { await api.namePerson(person.id, name); setName(""); onNamed(); } catch (err) { onError(String(err)); }
            }
          }} />
      )}
      <span className="muted small">{n(person.photos)} photos</span>
    </div>
  );
}

function PersonDetail({ person, onBack, onChanged, onSearch, onError }: {
  person: Person; onBack: () => void; onChanged: () => void; onSearch: (q: string) => void; onError: (e: string) => void;
}) {
  const [faces, setFaces] = useState<FaceRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState(person.name ?? "");
  const load = useCallback(async () => {
    try {
      const [f, i] = await Promise.all([api.personFaces(person.id), api.personItems(person.id)]);
      setFaces(f);
      setItems(i);
    } catch (e) { onError(String(e)); }
  }, [person.id, onError]);
  useEffect(() => { load(); setName(person.name ?? ""); }, [load, person.name]);

  const save = async () => {
    try { await api.namePerson(person.id, name); onChanged(); } catch (e) { onError(String(e)); }
  };

  return (
    <>
      <div className="row start">
        <button className="btn ghost" onClick={onBack}>‹ Everyone</button>
        <Avatar src={person.cover} size={44} />
        <input className="inline-input name-input" placeholder="Add a name" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()} onBlur={() => name.trim() !== (person.name ?? "") && save()} />
        <span className="muted">{n(items.length)} photos</span>
        <div className="row" style={{ marginLeft: "auto" }}>
          {person.name && <button className="btn" onClick={() => onSearch(person.name!)}>Show in library</button>}
          <button className="btn ghost" title="Stop showing this group here" onClick={async () => { await api.hidePerson(person.id); onBack(); onChanged(); }}>Not a person I know</button>
        </div>
      </div>
      <div className="label">Faces · click one that isn't {person.name ?? "them"} to take it out</div>
      <div className="faces">
        {faces.map((f) => (
          <button key={f.id} className="face" title="Not them" onClick={async () => { await api.removeFace(f.id); load(); onChanged(); }}>
            <Avatar src={f.crop} size={72} /><span className="x" aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <div className="label">Photos</div>
      <div className="tiles">
        {items.map((i) => <Thumb key={i.id} item={i} />)}
      </div>
    </>
  );
}
