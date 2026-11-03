import { useEffect, useState } from "react";
import { api, n, RefItem, Tag, Topic } from "../api";
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

  const ids = [...selected];
  const total = topics.reduce((a, t) => a + t.count, 0);
  const shown = query ? items.filter((i) => i.item.path.toLowerCase().includes(query.toLowerCase()) || i.tags.some((t) => t.toLowerCase().includes(query.toLowerCase()))) : items;
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
        <input className="search" style={{ marginLeft: 0 }} placeholder="Search names and tags…" value={query} onChange={(e) => setQuery(e.target.value)} />
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
            <span className="muted">{n(shown.length)} images{tag && ` · tagged ${tag}`}</span>
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
                      <button className="link" onClick={() => onOpen(r.item.id)}>Edit</button>
                    </div>
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
