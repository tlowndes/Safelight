import { useEffect, useState } from "react";
import { api, fileName, n, RefItem, Tag, Topic, TopicSuggestion } from "../api";
import Thumb from "../components/Thumb";

type Props = { onError: (e: string) => void; onOpen: (id: number) => void };

export default function Reference({ onError, onOpen }: Props) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [items, setItems] = useState<RefItem[]>([]);
  const [topic, setTopic] = useState<number | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [newTopic, setNewTopic] = useState("");
  const [newTag, setNewTag] = useState("");
  const [query, setQuery] = useState("");
  const [smartIds, setSmartIds] = useState<Set<number> | null>(null);
  const [suggestions, setSuggestions] = useState<Map<number, TopicSuggestion>>(new Map());
  const [similar, setSimilar] = useState<{ of: RefItem; shas: Set<string> } | null>(null);

  const load = async () => {
    try {
      const [t, g, i] = await Promise.all([api.topics(), api.tags(), api.referenceItems(topic, tag)]);
      setTopics(t);
      setTags(g);
      setItems(i);
    } catch (e) {
      onError(String(e));
    }
  };
  useEffect(() => { load(); }, [topic, tag]);

  // Topic guesses for images still in To sort (needs smart tagging).
  const loadSuggestions = () => api.topicSuggestions().then((s) => setSuggestions(new Map(s.map((x) => [x.item_id, x])))).catch(() => {});
  useEffect(() => { loadSuggestions(); }, [items.length]);

  // Search by words: names and tags here, plus smart search (what the image looks like).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSmartIds(null); return; }
    let live = true;
    const t = setTimeout(() => api.smartSearch(q).then((ids) => live && setSmartIds(new Set(ids))).catch(() => {}), 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const accept = async (list: TopicSuggestion[]) => {
    try {
      for (const t of new Set(list.map((s) => s.topic_id))) await api.setTopic(list.filter((s) => s.topic_id === t).map((s) => s.item_id), t);
      await load();
      loadSuggestions();
    } catch (e) { onError(String(e)); }
  };

  const ids = [...selected];
  const total = topics.reduce((a, t) => a + t.count, 0);
  const ql = query.trim().toLowerCase();
  const shown = similar
    ? items.filter((i) => i.item.id === similar.of.item.id || similar.shas.has(i.item.sha256))
    : ql
      ? items.filter((i) => i.item.path.toLowerCase().includes(ql) || [...i.tags, ...i.smart_tags].some((t) => t.toLowerCase().includes(ql)) || !!smartIds?.has(i.item.id))
      : items;
  const pending = shown.map((r) => suggestions.get(r.item.id)).filter((s): s is TopicSuggestion => !!s);
  const title = topic === null ? "All reference" : topics.find((t) => t.id === topic)?.name ?? "";

  return (
    <>
      <div className="top">
        <h1>Reference</h1>
        <span className="sub">{n(total)} design images, kept apart from your photos</span>
        <button className="btn" style={{ marginLeft: "auto" }} title="Find screenshots and saved images in your library and move them here" onClick={async () => {
          try {
            const moved = await api.checkReference();
            alert(moved ? `Moved ${moved} likely reference image${moved === 1 ? "" : "s"} to To sort.` : "Nothing new found.");
            load();
          } catch (e) { onError(String(e)); }
        }}>Check now</button>
        <input className="search" style={{ marginLeft: 0 }} placeholder="Search tags, or describe it: “warm serif poster”" value={query} onChange={(e) => { setQuery(e.target.value); setSimilar(null); }} />
      </div>
      <div className="split">
        <div className="list">
          <div className="label">Topics</div>
          <button className={`topic ${topic === null ? "on" : ""}`} onClick={() => setTopic(null)}><span>All</span><span>{n(total)}</span></button>
          {topics.map((t) => (
            <button
              key={t.id}
              className={`topic ${topic === t.id ? "on" : ""} ${selected.size ? "drop-target" : ""}`}
              onClick={async () => {
                if (selected.size) {
                  await api.setTopic(ids, t.id);
                  setSelected(new Set());
                  load();
                } else setTopic(t.id);
              }}
              onDoubleClick={async () => {
                const name = prompt("Rename topic", t.name);
                if (name && name.trim()) { await api.renameTopic(t.id, name); load(); }
              }}
              title={selected.size ? `Move ${selected.size} selected here` : "Double-click to rename"}
            >
              <span>{t.name}</span><span>{n(t.count)}</span>
            </button>
          ))}
          <input className="inline-input" placeholder="+ New topic" value={newTopic} onChange={(e) => setNewTopic(e.target.value)}
            onKeyDown={async (e) => { if (e.key === "Enter" && newTopic.trim()) { await api.createTopic(newTopic); setNewTopic(""); load(); } }} />
          {topic !== null && topics.find((t) => t.id === topic)?.name !== "To sort" && (
            <button className="link" onClick={async () => { await api.deleteTopic(topic); setTopic(null); load(); }}>Delete this topic</button>
          )}
          <div className="label">Tags</div>
          <div className="tag-cloud">
            {tags.map((t) => (
              <button key={t.id} className={`tag ${tag === t.name ? "on" : ""}`} onClick={() => setTag(tag === t.name ? null : t.name)}>{t.name}</button>
            ))}
            {tags.length === 0 && <span className="muted small">Select images, then add tags like "Serif" or "Dark UI".</span>}
          </div>
        </div>
        <div className="detail">
          <div className="row start">
            <b className="h3">{title}</b>
            <span className="muted">{n(shown.length)} images{tag && ` · tagged ${tag}`}{similar && ` that look like ${fileName(similar.of.item.path)}`}</span>
            {similar && <button className="btn small" onClick={() => setSimilar(null)}>Show all</button>}
            {!selected.size && pending.length > 0 && (
              <button className="btn small" style={{ marginLeft: "auto" }} title="Move each image to the topic Safelight suggests" onClick={() => accept(pending)}>
                Sort {n(pending.length)} into suggested topics
              </button>
            )}
            {selected.size > 0 && (
              <div className="row" style={{ marginLeft: "auto" }}>
                <span className="amber">{selected.size} selected · click a topic to move them</span>
                <input className="inline-input" placeholder="Add tag…" value={newTag} onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={async (e) => { if (e.key === "Enter" && newTag.trim()) { await api.addTag(ids, newTag); setNewTag(""); load(); } }} />
                <button className="btn" onClick={async () => { await api.setReference(ids, false); setSelected(new Set()); load(); }}>Not reference</button>
                <button className="btn" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="muted">Nothing here yet. Organise suggests screenshots and saved images as reference, or move images here from the Library.</p>
          ) : (
            <div className="masonry">
              {shown.map((r) => {
                const on = selected.has(r.item.id);
                return (
                  <div key={r.item.id} className={`mtile ${on ? "on" : ""}`}>
                    <Thumb
                      item={r.item}
                      className="free"
                      onClick={() => {
                        const next = new Set(selected);
                        on ? next.delete(r.item.id) : next.add(r.item.id);
                        setSelected(next);
                      }}
                    />
                    <div className="mtags">
                      {r.tags.map((t) => (
                        <span key={t} className="tag small" onClick={async () => { await api.removeTag(r.item.id, t); load(); }} title="Click to remove">{t} ×</span>
                      ))}
                      {r.smart_tags.map((t) => (
                        <span key={t} className="tag small smart" onClick={async () => { await api.addTag([r.item.id], t); load(); }} title="Suggested · click to keep this tag">+ {t}</span>
                      ))}
                      <button className="link" title="Show reference that looks like this" onClick={async () => {
                        try {
                          const like = await api.similar(r.item.id);
                          setSimilar({ of: r, shas: new Set(like.map((i) => i.sha256)) });
                        } catch (e) { onError(String(e)); }
                      }}>Similar</button>
                      <button className="link" onClick={() => onOpen(r.item.id)}>Edit</button>
                    </div>
                    {suggestions.get(r.item.id) && (
                      <div className="suggest">
                        <span>Looks like {suggestions.get(r.item.id)!.topic}</span>
                        <button className="btn small" onClick={() => accept([suggestions.get(r.item.id)!])}>Move</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
