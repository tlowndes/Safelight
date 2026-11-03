//! Duplicates. Exact copies (same fingerprint) are merged automatically: only one goes into
//! the library. Look-alikes (resized or recompressed copies) are grouped for the user to confirm.

use crate::{
    catalogue::{item_from_row, Catalogue, Item, ITEM_SELECT},
    imaging::hamming,
    Result,
};
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;

/// Max differing bits (of 64) for two pictures to count as look-alikes.
pub const LOOKALIKE_THRESHOLD: u32 = 6;

#[derive(Debug, Clone, Serialize)]
pub struct Member {
    pub item: Item,
    pub source_name: String,
    /// "proton", "gdrive", "takeout", "nas" or "local".
    pub source_kind: String,
    /// How many byte-identical copies of this file exist across sources.
    pub copies: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Group {
    /// Stable key: the smallest fingerprint in the group.
    pub key: String,
    pub members: Vec<Member>,
    /// Index into `members` of the suggested copy to keep.
    pub best: usize,
    /// 0-100, how alike the pictures are (100 = identical fingerprints).
    pub similarity: u32,
}

pub fn date_rank(src: Option<&str>) -> u8 {
    match src {
        Some("exif") => 4,
        Some("takeout") => 3,
        Some("filename") => 2,
        Some("modified") => 1,
        _ => 0,
    }
}

fn format_rank(path: &str) -> u8 {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "dng" | "cr2" | "cr3" | "nef" | "arw" | "raf" | "orf" | "rw2" => 5,
        "heic" | "heif" | "tif" | "tiff" => 4,
        "jpg" | "jpeg" | "mov" | "mp4" => 3,
        "png" | "webp" => 2,
        _ => 1,
    }
}

/// Higher is better: most pixels, then original format, then most trustworthy date, then file size.
pub fn quality_score(i: &Item) -> (i64, u8, u8, i64) {
    (
        i.width.unwrap_or(0) * i.height.unwrap_or(0),
        format_rank(&i.path),
        date_rank(i.date_source.as_deref()),
        i.size,
    )
}

/// Look-alike groups still waiting for a decision.
pub fn lookalike_groups(cat: &Catalogue) -> Result<Vec<Group>> {
    // One representative per fingerprint; byte-identical copies are already handled.
    let items: Vec<Item> = cat
        .conn
        .prepare(&format!(
            "{ITEM_SELECT} WHERE i.phash IS NOT NULL AND i.hidden = 0 AND i.id IN (SELECT MIN(id) FROM items WHERE COALESCE(copy_status, '') <> 'spare' GROUP BY sha256)"
        ))?
        .query_map([], item_from_row)?
        .collect::<std::result::Result<_, _>>()?;
    let hashes: Vec<(u64, bool)> = {
        let mut st = cat.conn.prepare("SELECT phash, kind = 'video' FROM items WHERE id = ?1")?;
        items
            .iter()
            .map(|i| st.query_row([i.id], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, bool>(1)?))))
            .collect::<std::result::Result<_, _>>()?
    };

    // Union-find over close pairs. Blank/flat images hash to 0 or all-ones; skip those.
    let n = items.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut c = x;
        while p[c] != r {
            let next = p[c];
            p[c] = r;
            c = next;
        }
        r
    }
    let usable = |h: u64| h.count_ones() > 4 && h.count_ones() < 60;
    for a in 0..n {
        if !usable(hashes[a].0) {
            continue;
        }
        for b in (a + 1)..n {
            if hashes[a].1 == hashes[b].1 && usable(hashes[b].0) && hamming(hashes[a].0, hashes[b].0) <= LOOKALIKE_THRESHOLD {
                let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                if ra != rb {
                    parent[rb] = ra;
                }
            }
        }
    }
    let mut buckets: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        buckets.entry(r).or_default().push(i);
    }

    let sources: HashMap<i64, (String, String)> = cat.sources()?.into_iter().map(|s| (s.id, (s.name, s.kind))).collect();
    let mut copies_st = cat.conn.prepare("SELECT COUNT(*) FROM items WHERE sha256 = ?1")?;
    let mut groups = Vec::new();
    for idxs in buckets.into_values().filter(|v| v.len() > 1) {
        // Skip groups already decided (every member has a status).
        if idxs.iter().all(|&i| items[i].dup_status.is_some()) {
            continue;
        }
        let worst = idxs
            .iter()
            .flat_map(|&a| idxs.iter().map(move |&b| (a, b)))
            .map(|(a, b)| hamming(hashes[a].0, hashes[b].0))
            .max()
            .unwrap_or(0);
        let mut members: Vec<Member> = idxs
            .iter()
            .map(|&i| {
                Ok(Member {
                    item: items[i].clone(),
                    source_name: sources.get(&items[i].source_id).map(|s| s.0.clone()).unwrap_or_default(),
                    source_kind: sources.get(&items[i].source_id).map(|s| s.1.clone()).unwrap_or_default(),
                    copies: copies_st.query_row([&items[i].sha256], |r| r.get(0))?,
                })
            })
            .collect::<Result<_>>()?;
        // Best quality first; when two are equally good, the Proton Drive copy wins over Google.
        let rank = |m: &Member| (quality_score(&m.item), crate::exact::source_rank(&m.source_kind));
        members.sort_by(|a, b| rank(b).cmp(&rank(a)));
        let key = members.iter().map(|m| m.item.sha256.clone()).min().unwrap_or_default();
        groups.push(Group { key, members, best: 0, similarity: 100 - worst * 100 / 64 });
    }
    groups.sort_by(|a, b| {
        b.members[0].item.taken_at.cmp(&a.members[0].item.taken_at).then(a.key.cmp(&b.key))
    });
    Ok(groups)
}

/// Record a decision on a look-alike group. Dropped copies hand their better date to the keeper,
/// and remember which fingerprint replaced them so clean-up can bin them safely later.
pub fn resolve(cat: &Catalogue, keep_ids: &[i64], drop_ids: &[i64]) -> Result<()> {
    let tx = cat.conn.unchecked_transaction()?;
    let get = |id: i64| -> Result<Option<Item>> { cat.item(id) };
    let keepers: Vec<Item> = keep_ids.iter().filter_map(|&id| get(id).transpose()).collect::<Result<_>>()?;
    let dropped: Vec<Item> = drop_ids.iter().filter_map(|&id| get(id).transpose()).collect::<Result<_>>()?;
    let Some(main) = keepers.iter().max_by_key(|k| quality_score(k)) else {
        return Err(crate::Error::Other("keep at least one copy".into()));
    };
    // Best date across the whole group goes onto every kept copy.
    let best_date = keepers
        .iter()
        .chain(dropped.iter())
        .filter(|i| i.taken_at.is_some())
        .max_by_key(|i| date_rank(i.date_source.as_deref()));
    for k in &keepers {
        tx.execute("UPDATE items SET dup_status = 'keep' WHERE sha256 = ?1", [&k.sha256])?;
        if let Some(b) = best_date {
            if date_rank(b.date_source.as_deref()) > date_rank(k.date_source.as_deref()) {
                tx.execute(
                    "UPDATE items SET taken_at = ?2, date_source = ?3 WHERE sha256 = ?1",
                    params![k.sha256, b.taken_at, b.date_source],
                )?;
            }
        }
    }
    for d in &dropped {
        tx.execute(
            "UPDATE items SET dup_status = 'drop', dup_keeper = ?2 WHERE sha256 = ?1",
            params![d.sha256, main.sha256],
        )?;
    }
    tx.commit()?;
    Ok(())
}
