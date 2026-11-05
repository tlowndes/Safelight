import { Item } from "./api";

export type Sort = "newest" | "oldest" | "name" | "rating" | "added" | "size";
/** Photos in the same folder taken within this many seconds of each other stack together. */
export const STACK_SECONDS = 2;
const fileKey = (i: Item) => i.path.split(/[\\/]/).pop()!.toLowerCase();
const folderOf = (i: Item) => i.path.slice(0, Math.max(i.path.lastIndexOf("/"), i.path.lastIndexOf("\\")));
const seconds = (i: Item) => (i.taken_at ? Date.parse(i.taken_at) / 1000 : NaN);

/** Sort one flat list. Capture-time order keeps the month groups; the others make one group. */
export function sortItems(items: Item[], sort: Sort): Item[] {
  const by = (f: (a: Item, b: Item) => number) => [...items].sort((a, b) => f(a, b) || b.id - a.id);
  switch (sort) {
    case "name": return by((a, b) => fileKey(a).localeCompare(fileKey(b), undefined, { numeric: true }));
    case "rating": return by((a, b) => b.rating - a.rating || b.flag - a.flag);
    case "added": return by((a, b) => b.id - a.id);
    case "size": return by((a, b) => b.size - a.size);
    default: return items;
  }
}

/** Group bursts: neighbours in the same folder taken within a couple of seconds. Returns the top of each stack with its members. */
export function stackItems(items: Item[]): { top: Item; members: Item[] }[] {
  const out: { top: Item; members: Item[] }[] = [];
  for (const i of items) {
    const last = out[out.length - 1];
    const prev = last?.members[last.members.length - 1];
    const t = seconds(i);
    if (prev && !Number.isNaN(t) && Math.abs(seconds(prev) - t) <= STACK_SECONDS && folderOf(prev) === folderOf(i)) last.members.push(i);
    else out.push({ top: i, members: [i] });
  }
  // The best-rated photo goes on top, so picks aren't buried.
  for (const s of out) s.top = s.members.reduce((a, b) => (b.flag > a.flag || (b.flag === a.flag && b.rating > a.rating) ? b : a));
  return out;
}
