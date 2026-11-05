import { describe, expect, it } from "vitest";
import { sortItems, stackItems } from "../../src/libraryView";
import type { Item } from "../../src/api";

const item = (id: number, p: Partial<Item>): Item => ({
  id, source_id: 1, path: `C:/Photos/IMG_${id}.jpg`, kind: "photo", size: 100, sha256: "", taken_at: null, date_source: null,
  width: null, height: null, has_camera: true, thumb: null, dup_status: null, is_reference: null, topic_id: null, edited: false,
  has_exact_duplicate: false, rating: 0, flag: 0, hidden: false, copy_status: null, label: null, versions: 0, ...p,
});

describe("stacking bursts", () => {
  it("stacks photos in the same folder a second or two apart, with the best one on top", () => {
    const items = [
      item(1, { taken_at: "2025-07-12T14:03:22" }),
      item(2, { taken_at: "2025-07-12T14:03:21", rating: 4 }),
      item(3, { taken_at: "2025-07-12T14:03:20" }),
      item(4, { taken_at: "2025-07-12T14:00:00" }),
      item(5, { taken_at: "2025-07-12T13:59:59", path: "C:/Other/IMG_5.jpg" }),
    ];
    const s = stackItems(items);
    expect(s.map((x) => x.members.map((m) => m.id))).toEqual([[1, 2, 3], [4], [5]]);
    expect(s[0].top.id).toBe(2);
  });
  it("never stacks photos without a capture time", () => {
    expect(stackItems([item(1, {}), item(2, {})]).length).toBe(2);
  });
});

describe("sorting", () => {
  it("sorts file names the way people count", () => {
    const items = [item(10, {}), item(9, {}), item(100, {})];
    expect(sortItems(items, "name").map((i) => i.id)).toEqual([9, 10, 100]);
  });
  it("puts the best rated first and newest added first", () => {
    const items = [item(1, { rating: 2 }), item(2, { rating: 5 }), item(3, { rating: 5 })];
    expect(sortItems(items, "rating").map((i) => i.id)).toEqual([3, 2, 1]);
    expect(sortItems(items, "added").map((i) => i.id)).toEqual([3, 2, 1]);
  });
});
