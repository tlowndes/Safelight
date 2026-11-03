//! Exact copies: byte-identical files (same fingerprint) found in more than one place.
//!
//! Safelight suggests which copy to keep, preferring Proton Drive over the NAS, local folders
//! and, last, Google. The user confirms (or changes) the choice. Copies they don't keep become
//! "spare": hidden from the library at once, but still on disk. Only when the user asks are
//! spares moved into a "Safelight bin" folder at the root of their source. Every move is logged
//! and can be undone; nothing is deleted.

use crate::{
    catalogue::{item_from_row, Catalogue, Item, ITEM_SELECT},
    dupes::date_rank,
    Result,
};
use rusqlite::params;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

/// Which source's copy to keep when the same file is in several. Higher wins.
pub fn source_rank(kind: &str) -> u8 {
    match kind {
        "proton" => 5,
        "nas" => 4,
        "gdrive" => 2,
        "takeout" => 1,
        _ => 3, // any other local folder
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ExactCopy {
    pub item: Item,
    pub source_name: String,
    pub source_kind: String,
    /// Kept (decided, or suggested while undecided).
    pub keep: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExactGroup {
    pub sha256: String,
    /// Preferred copy first.
    pub copies: Vec<ExactCopy>,
    /// True once every copy has a keep/spare decision.
    pub decided: bool,
}

/// Every set of byte-identical files (hidden photos left out), undecided first, newest first.
pub fn exact_groups(cat: &Catalogue) -> Result<Vec<ExactGroup>> {
    let sources: HashMap<i64, (String, String)> = cat.sources()?.into_iter().map(|s| (s.id, (s.name, s.kind))).collect();
    let items: Vec<Item> = cat
        .conn
        .prepare(&format!(
            "{ITEM_SELECT} WHERE i.hidden = 0 AND i.sha256 IN (SELECT sha256 FROM items GROUP BY sha256 HAVING COUNT(*) > 1)
             ORDER BY i.sha256, i.id"
        ))?
        .query_map([], item_from_row)?
        .collect::<std::result::Result<_, _>>()?;

    let mut groups: Vec<ExactGroup> = Vec::new();
    let mut i = 0;
    while i < items.len() {
        let sha = items[i].sha256.clone();
        let mut j = i;
        while j < items.len() && items[j].sha256 == sha {
            j += 1;
        }
        let mut copies: Vec<ExactCopy> = items[i..j]
            .iter()
            .map(|it| {
                let (name, kind) = sources.get(&it.source_id).cloned().unwrap_or_default();
                ExactCopy { item: it.clone(), source_name: name, source_kind: kind, keep: false }
            })
            .collect();
        i = j;
        if copies.len() < 2 {
            continue;
        }
        sort_preferred(&mut copies);
        let any_kept = copies.iter().any(|c| c.item.copy_status.as_deref() == Some("keep"));
        for (k, c) in copies.iter_mut().enumerate() {
            c.keep = if any_kept { c.item.copy_status.as_deref() == Some("keep") } else { k == 0 };
        }
        let decided = copies.iter().all(|c| c.item.copy_status.is_some());
        groups.push(ExactGroup { sha256: sha, copies, decided });
    }
    groups.sort_by(|a, b| {
        a.decided
            .cmp(&b.decided)
            .then(b.copies[0].item.taken_at.cmp(&a.copies[0].item.taken_at))
            .then(a.sha256.cmp(&b.sha256))
    });
    Ok(groups)
}

/// Preferred source first, then the most trustworthy date, then the shortest path.
fn sort_preferred(copies: &mut [ExactCopy]) {
    copies.sort_by(|a, b| {
        source_rank(&b.source_kind)
            .cmp(&source_rank(&a.source_kind))
            .then(date_rank(b.item.date_source.as_deref()).cmp(&date_rank(a.item.date_source.as_deref())))
            .then(a.item.path.len().cmp(&b.item.path.len()))
            .then(a.item.id.cmp(&b.item.id))
    });
}

/// Keep `keep_ids`; every other copy with the same fingerprint becomes spare. Only the catalogue
/// changes. The kept copies take the best date found on any copy.
pub fn resolve(cat: &Catalogue, sha256: &str, keep_ids: &[i64]) -> Result<()> {
    let ids: Vec<i64> = cat
        .conn
        .prepare("SELECT id FROM items WHERE sha256 = ?1")?
        .query_map([sha256], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    if !keep_ids.iter().any(|k| ids.contains(k)) {
        return Err(crate::Error::Other("keep at least one copy".into()));
    }
    let tx = cat.conn.unchecked_transaction()?;
    for id in &ids {
        let status = if keep_ids.contains(id) { "keep" } else { "spare" };
        tx.execute("UPDATE items SET copy_status = ?2 WHERE id = ?1", params![id, status])?;
    }
    // Carry the best date onto the kept copies.
    let best: Option<(Option<String>, Option<String>)> = tx
        .prepare("SELECT taken_at, date_source FROM items WHERE sha256 = ?1 AND taken_at IS NOT NULL")?
        .query_map([sha256], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .max_by_key(|(_, d): &(Option<String>, Option<String>)| date_rank(d.as_deref()));
    if let Some((taken, dsrc)) = best {
        let mut st = tx.prepare("SELECT date_source FROM items WHERE id = ?1")?;
        for id in keep_ids.iter().filter(|k| ids.contains(k)) {
            let mine: Option<String> = st.query_row([id], |r| r.get(0))?;
            if date_rank(dsrc.as_deref()) > date_rank(mine.as_deref()) {
                tx.execute("UPDATE items SET taken_at = ?2, date_source = ?3 WHERE id = ?1", params![id, taken, dsrc])?;
            }
        }
        drop(st);
    }
    tx.commit()?;
    Ok(())
}

/// Accept the suggestion (preferred copy kept) for every group not decided yet. Returns how many groups.
pub fn keep_preferred_all(cat: &Catalogue) -> Result<u64> {
    let mut n = 0;
    for g in exact_groups(cat)?.into_iter().filter(|g| !g.decided) {
        let keep: Vec<i64> = g.copies.iter().filter(|c| c.keep).map(|c| c.item.id).collect();
        resolve(cat, &g.sha256, &keep)?;
        n += 1;
    }
    Ok(n)
}

/// Forget the decision for one group, so it can be reviewed again.
pub fn reset(cat: &Catalogue, sha256: &str) -> Result<()> {
    cat.conn.execute("UPDATE items SET copy_status = NULL WHERE sha256 = ?1", [sha256])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SpareSource {
    pub source_id: i64,
    pub name: String,
    pub kind: String,
    pub files: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SpareSummary {
    pub files: i64,
    pub bytes: i64,
    pub sources: Vec<SpareSource>,
}

/// Spare copies still on disk, per source.
pub fn spare_summary(cat: &Catalogue) -> Result<SpareSummary> {
    let mut s = SpareSummary::default();
    let mut st = cat.conn.prepare(
        "SELECT s.id, s.name, s.kind, COUNT(*), SUM(i.size) FROM items i JOIN sources s ON s.id = i.source_id
         WHERE i.copy_status = 'spare' GROUP BY s.id ORDER BY s.id",
    )?;
    for r in st.query_map([], |r| {
        Ok(SpareSource { source_id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, files: r.get(3)?, bytes: r.get(4)? })
    })? {
        let r = r?;
        s.files += r.files;
        s.bytes += r.bytes;
        s.sources.push(r);
    }
    Ok(s)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MoveReport {
    /// The log entry these moves were recorded under, for Undo.
    pub batch: i64,
    pub moved: u64,
    pub bytes: i64,
    /// Left alone: the file or its kept copy changed or went missing, or the spare has edits.
    pub skipped: u64,
    pub errors: Vec<String>,
}

fn mtime(m: &fs::Metadata) -> i64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// True when the file on disk still matches what the catalogue fingerprinted.
fn unchanged(path: &str, size: i64, mt: i64) -> bool {
    matches!(fs::metadata(path), Ok(m) if m.len() as i64 == size && mtime(&m) == mt)
}

fn free_name(dest: PathBuf) -> PathBuf {
    if !dest.exists() {
        return dest;
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| dest.with_file_name(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

/// Move every spare copy into "Safelight bin/<date>/" at the root of its own source (so it
/// never leaves that drive or cloud folder). Before each move Safelight checks the spare and at
/// least one kept copy are still exactly as scanned.
pub fn move_spares(cat: &Catalogue, mut progress: impl FnMut(u64, u64)) -> Result<MoveReport> {
    let spares: Vec<(i64, i64, String, String, i64, i64, bool)> = cat
        .conn
        .prepare(
            "SELECT i.id, i.source_id, i.path, i.sha256, i.size, i.mtime, EXISTS(SELECT 1 FROM edits e WHERE e.item_id = i.id)
             FROM items i WHERE i.copy_status = 'spare' ORDER BY i.id",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let roots: HashMap<i64, String> = cat.sources()?.into_iter().map(|s| (s.id, s.root)).collect();
    let batch: i64 = cat.conn.query_row("SELECT COALESCE(MAX(batch), 0) + 1 FROM moves", [], |r| r.get(0))?;
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut report = MoveReport { batch, ..Default::default() };
    let total = spares.len() as u64;
    let mut keepers = cat.conn.prepare("SELECT path, size, mtime FROM items WHERE sha256 = ?1 AND copy_status = 'keep'")?;

    for (n, (id, source_id, path, sha, size, mt, edited)) in spares.into_iter().enumerate() {
        progress(n as u64, total);
        let kept: Vec<(String, i64, i64)> =
            keepers.query_map([&sha], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<std::result::Result<_, _>>()?;
        if edited || !unchanged(&path, size, mt) || !kept.iter().any(|(p, s, m)| unchanged(p, *s, *m)) {
            report.skipped += 1;
            continue;
        }
        let Some(root) = roots.get(&source_id).map(PathBuf::from) else {
            report.skipped += 1;
            continue;
        };
        let p = Path::new(&path);
        let rel = p.strip_prefix(&root).unwrap_or_else(|_| Path::new(p.file_name().unwrap_or_default()));
        let dest = free_name(root.join("Safelight bin").join(&day).join(rel));
        let moved = dest
            .parent()
            .map(fs::create_dir_all)
            .transpose()
            .and_then(|_| fs::rename(p, &dest));
        match moved {
            Ok(()) => {
                let tx = cat.conn.unchecked_transaction()?;
                tx.execute(
                    "INSERT INTO moves(batch, source_id, sha256, size, from_path, to_path, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
                    params![batch, source_id, sha, size, path, dest.to_string_lossy()],
                )?;
                for sql in ["DELETE FROM item_tags WHERE item_id = ?1", "DELETE FROM items WHERE id = ?1"] {
                    tx.execute(sql, [id])?;
                }
                tx.commit()?;
                report.moved += 1;
                report.bytes += size;
            }
            Err(e) => report.errors.push(format!("{path}: {e}")),
        }
    }
    progress(total, total);
    Ok(report)
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveBatch {
    pub batch: i64,
    pub at: String,
    pub files: i64,
    pub bytes: i64,
    /// Files in this batch already put back.
    pub undone: i64,
}

/// The move log, newest first.
pub fn move_batches(cat: &Catalogue) -> Result<Vec<MoveBatch>> {
    Ok(cat
        .conn
        .prepare(
            "SELECT batch, MIN(at), COUNT(*), SUM(size), SUM(undone) FROM moves GROUP BY batch ORDER BY batch DESC",
        )?
        .query_map([], |r| Ok(MoveBatch { batch: r.get(0)?, at: r.get(1)?, files: r.get(2)?, bytes: r.get(3)?, undone: r.get(4)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UndoReport {
    pub restored: u64,
    pub errors: Vec<String>,
    /// Sources to re-scan so the restored files come back into the catalogue.
    pub source_ids: Vec<i64>,
}

/// Put every file in `batch` back where it was. A file is never overwritten: if something now
/// sits at the original path, that file stays in the bin and is reported.
pub fn undo_batch(cat: &Catalogue, batch: i64) -> Result<UndoReport> {
    let rows: Vec<(i64, i64, String, String)> = cat
        .conn
        .prepare("SELECT id, source_id, from_path, to_path FROM moves WHERE batch = ?1 AND undone = 0")?
        .query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut report = UndoReport::default();
    for (id, source_id, from, to) in rows {
        let back = Path::new(&from);
        let res = if back.exists() {
            Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "a file is already there"))
        } else {
            back.parent().map(fs::create_dir_all).transpose().and_then(|_| fs::rename(&to, back))
        };
        match res {
            Ok(()) => {
                cat.conn.execute("UPDATE moves SET undone = 1 WHERE id = ?1", [id])?;
                report.restored += 1;
                if !report.source_ids.contains(&source_id) {
                    report.source_ids.push(source_id);
                }
                // Tidy the bin folders this left empty (remove_dir never removes a folder with files in it).
                let mut dir = Path::new(&to).parent();
                while let Some(d) = dir {
                    if fs::remove_dir(d).is_err() || d.file_name().map_or(true, |n| n.eq_ignore_ascii_case("Safelight bin")) {
                        break;
                    }
                    dir = d.parent();
                }
            }
            Err(e) => report.errors.push(format!("{from}: {e}")),
        }
    }
    Ok(report)
}
