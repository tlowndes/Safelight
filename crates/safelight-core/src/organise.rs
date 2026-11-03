//! Building the organised library: event suggestions, reference sorting, the copy plan,
//! and copying into the library folder (Proton Drive) with a verified mirror on the backup (NAS).

use crate::{catalogue::Catalogue, hash, plan, Result};
use chrono::{NaiveDate, NaiveDateTime};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
pub struct EventSuggestion {
    /// Saved event id, or None while it's only a suggestion.
    pub id: Option<i64>,
    pub name: String,
    pub start_day: String,
    pub end_day: String,
    pub count: i64,
    pub sample_thumbs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanSummary {
    pub library_root: Option<String>,
    pub backup_root: Option<String>,
    pub to_copy: i64,
    pub to_copy_bytes: i64,
    pub already_copied: i64,
    pub photos: i64,
    pub reference: i64,
    pub undated: i64,
    pub reference_suggestions: i64,
    pub tree: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub path: String,
    pub count: i64,
}

#[derive(Debug, Clone)]
pub struct PlannedFile {
    pub item_id: i64,
    pub sha256: String,
    pub source_path: String,
    pub dest: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopyProgress {
    pub done: u64,
    pub total: u64,
    pub current: String,
    pub stage: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CopyReport {
    pub copied: u64,
    pub backed_up: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

fn parse_dt(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()
}

/// Days with far more photos than usual, joined into trips and occasions.
/// A day counts as busy at 12+ photos and at least 3x the library's typical day.
pub fn suggest_events(cat: &Catalogue) -> Result<Vec<EventSuggestion>> {
    let days: Vec<(String, i64)> = cat
        .conn
        .prepare(
            "SELECT substr(taken_at, 1, 10) d, COUNT(*) FROM items
             WHERE taken_at IS NOT NULL AND COALESCE(is_reference, 0) = 0 AND COALESCE(dup_status, '') <> 'drop' AND hidden = 0 AND COALESCE(copy_status, '') <> 'spare'
             GROUP BY d ORDER BY d",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    // Typical photos-per-day across the whole library (days with at least one photo).
    let mut counts: Vec<i64> = days.iter().map(|d| d.1).collect();
    counts.sort();
    let median = counts.get(counts.len() / 2).copied().unwrap_or(1);
    let busy: Vec<(NaiveDate, i64)> = days
        .iter()
        .filter(|(_, n)| *n >= 12 && *n >= 3 * median)
        .filter_map(|(d, n)| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok().map(|d| (d, *n)))
        .collect();

    // Join busy days with at most one quiet day between them.
    let mut runs: Vec<(NaiveDate, NaiveDate, i64)> = Vec::new();
    for (d, n) in busy {
        match runs.last_mut() {
            Some((_, end, total)) if (d - *end).num_days() <= 2 => {
                *end = d;
                *total += n;
            }
            _ => runs.push((d, d, n)),
        }
    }

    let saved = saved_events(cat)?;
    let mut out: Vec<EventSuggestion> = saved.clone();
    for (start, end, _) in runs.into_iter().filter(|r| r.2 >= 20) {
        let (s, e) = (start.to_string(), end.to_string());
        if saved.iter().any(|ev| ev.start_day <= e && ev.end_day >= s) {
            continue;
        }
        let (count, thumbs) = event_contents(cat, &s, &e)?;
        out.push(EventSuggestion { id: None, name: String::new(), start_day: s, end_day: e, count, sample_thumbs: thumbs });
    }
    out.sort_by(|a, b| b.start_day.cmp(&a.start_day));
    Ok(out)
}

fn event_contents(cat: &Catalogue, start: &str, end: &str) -> Result<(i64, Vec<String>)> {
    let range = params![format!("{start} 00:00:00"), format!("{end} 23:59:59")];
    let count = cat.conn.query_row(
        "SELECT COUNT(*) FROM items WHERE taken_at BETWEEN ?1 AND ?2 AND COALESCE(is_reference,0) = 0 AND COALESCE(dup_status,'') <> 'drop' AND hidden = 0 AND COALESCE(copy_status,'') <> 'spare'",
        range,
        |r| r.get(0),
    )?;
    let thumbs = cat
        .conn
        .prepare(
            "SELECT thumb FROM items WHERE taken_at BETWEEN ?1 AND ?2 AND thumb IS NOT NULL
             GROUP BY sha256 ORDER BY taken_at LIMIT 3",
        )?
        .query_map(params![format!("{start} 00:00:00"), format!("{end} 23:59:59")], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok((count, thumbs))
}

pub fn saved_events(cat: &Catalogue) -> Result<Vec<EventSuggestion>> {
    let rows: Vec<(i64, String, String, String)> = cat
        .conn
        .prepare("SELECT id, name, start_day, end_day FROM events ORDER BY start_day DESC")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<_, _>>()?;
    rows.into_iter()
        .map(|(id, name, s, e)| {
            let (count, thumbs) = event_contents(cat, &s, &e)?;
            Ok(EventSuggestion { id: Some(id), name, start_day: s, end_day: e, count, sample_thumbs: thumbs })
        })
        .collect()
}

pub fn save_event(cat: &Catalogue, name: &str, start_day: &str, end_day: &str) -> Result<i64> {
    cat.conn.execute(
        "INSERT INTO events(name, start_day, end_day) VALUES (?1, ?2, ?3)
         ON CONFLICT(start_day, end_day) DO UPDATE SET name = excluded.name",
        params![name.trim(), start_day, end_day],
    )?;
    Ok(cat.conn.query_row(
        "SELECT id FROM events WHERE start_day = ?1 AND end_day = ?2",
        params![start_day, end_day],
        |r| r.get(0),
    )?)
}

pub fn delete_event(cat: &Catalogue, id: i64) -> Result<()> {
    cat.conn.execute("DELETE FROM events WHERE id = ?1", [id])?;
    Ok(())
}

/// SQL condition for "looks like design reference": a still image with no camera data that is a PNG,
/// a screenshot, or saved from the web. Only for items the user hasn't decided on yet.
const REFERENCE_GUESS: &str = "i.is_reference IS NULL AND i.kind = 'photo' AND i.has_camera = 0 AND (
    lower(i.path) LIKE '%.png' OR lower(i.path) LIKE '%.webp' OR lower(i.path) LIKE '%.gif'
    OR lower(i.path) LIKE '%screenshot%' OR lower(i.path) LIKE '%screen shot%'
    OR lower(i.path) LIKE '%pinterest%' OR lower(i.path) LIKE '%dribbble%' OR lower(i.path) LIKE '%behance%'
    OR lower(i.path) LIKE '%reference%' OR lower(i.path) LIKE '%inspiration%' OR lower(i.path) LIKE '%moodboard%')";

pub fn reference_suggestions(cat: &Catalogue) -> Result<Vec<crate::catalogue::Item>> {
    Ok(cat
        .conn
        .prepare(&format!("{} WHERE {REFERENCE_GUESS} ORDER BY i.taken_at DESC", crate::catalogue::ITEM_SELECT))?
        .query_map([], crate::catalogue::item_from_row)?
        .collect::<std::result::Result<_, _>>()?)
}

/// Whether likely reference images move to Reference by themselves after a scan (on unless
/// switched off).
pub fn auto_reference_enabled(cat: &Catalogue) -> Result<bool> {
    Ok(cat.setting("auto_reference")?.as_deref() != Some("0"))
}

/// Move every likely reference image to Reference › To sort, if the setting is on. Images the
/// user has already sent back as photos are never picked again. Returns how many moved.
pub fn auto_move_reference(cat: &Catalogue) -> Result<u64> {
    if !auto_reference_enabled(cat)? {
        return Ok(0);
    }
    move_reference_now(cat)
}

/// Move every likely reference image now, whatever the setting says ("Check now").
pub fn move_reference_now(cat: &Catalogue) -> Result<u64> {
    let ids: Vec<i64> = reference_suggestions(cat)?.into_iter().map(|i| i.id).collect();
    set_reference(cat, &ids, true)?;
    Ok(ids.len() as u64)
}

/// Mark items as reference (or as normal photos). New reference items go to the "To sort" topic.
pub fn set_reference(cat: &Catalogue, ids: &[i64], is_reference: bool) -> Result<()> {
    let to_sort = crate::reference::ensure_topic(cat, "To sort")?;
    let tx = cat.conn.unchecked_transaction()?;
    for id in ids {
        if is_reference {
            tx.execute("UPDATE items SET is_reference = 1, topic_id = COALESCE(topic_id, ?2) WHERE id = ?1", params![id, to_sort])?;
        } else {
            tx.execute("UPDATE items SET is_reference = 0 WHERE id = ?1", [id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// One file per fingerprint, skipping dropped look-alikes and anything already inside Safelight's folders.
pub fn build_plan(cat: &Catalogue) -> Result<Vec<PlannedFile>> {
    let managed: Vec<String> = cat.managed_roots()?;
    let events: Vec<(String, String, String)> = cat
        .conn
        .prepare("SELECT name, start_day, end_day FROM events")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let topics: HashMap<i64, String> = cat
        .conn
        .prepare("SELECT id, name FROM topics")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;

    // Per fingerprint, copy from the preferred source (Proton Drive first, Google last), and use
    // the most trustworthy date found on any copy. Spare copies the user chose not to keep are skipped.
    struct Row {
        id: i64,
        path: String,
        size: i64,
        rank: (u8, u8),
        taken: Option<String>,
        dsrc: Option<String>,
        is_ref: bool,
        topic: Option<i64>,
    }
    let rows: Vec<(String, Row)> = cat
        .conn
        .prepare(
            "SELECT i.id, i.sha256, i.path, i.size, i.taken_at, i.date_source, i.is_reference, i.topic_id, s.kind,
                    COALESCE(i.copy_status, '') = 'keep'
             FROM items i JOIN sources s ON s.id = i.source_id
             WHERE COALESCE(i.dup_status, '') <> 'drop' AND i.hidden = 0 AND COALESCE(i.copy_status, '') <> 'spare'
             ORDER BY i.sha256, i.id",
        )?
        .query_map([], |r| {
            let kind: String = r.get(8)?;
            let kept: bool = r.get(9)?;
            Ok((
                r.get(1)?,
                Row {
                    id: r.get(0)?,
                    path: r.get(2)?,
                    size: r.get(3)?,
                    rank: (kept as u8, crate::exact::source_rank(&kind)),
                    taken: r.get(4)?,
                    dsrc: r.get(5)?,
                    is_ref: r.get::<_, Option<bool>>(6)?.unwrap_or(false),
                    topic: r.get(7)?,
                },
            ))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut best: BTreeMap<String, (i64, String, i64, Option<String>, Option<String>, bool, Option<i64>)> = BTreeMap::new();
    let mut best_rank: HashMap<String, (u8, u8)> = HashMap::new();
    for (sha, r) in rows {
        if managed.iter().any(|m| Path::new(&r.path).starts_with(m)) {
            continue;
        }
        match best.get_mut(&sha) {
            None => {
                best_rank.insert(sha.clone(), r.rank);
                best.insert(sha, (r.id, r.path, r.size, r.taken, r.dsrc, r.is_ref, r.topic));
            }
            Some(b) => {
                // Reference status sticks if any copy was marked.
                b.5 |= r.is_ref;
                b.6 = b.6.or(r.topic);
                if crate::dupes::date_rank(r.dsrc.as_deref()) > crate::dupes::date_rank(b.4.as_deref()) {
                    b.3 = r.taken;
                    b.4 = r.dsrc;
                }
                if r.rank > best_rank[&sha] {
                    best_rank.insert(sha.clone(), r.rank);
                    b.0 = r.id;
                    b.1 = r.path;
                    b.2 = r.size;
                }
            }
        }
    }

    let mut used: HashSet<String> = HashSet::new();
    let mut plan = Vec::with_capacity(best.len());
    for (sha, (id, path, size, taken, _, is_ref, topic)) in best {
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest = if is_ref {
            let t = topic.and_then(|t| topics.get(&t).cloned()).unwrap_or_else(|| "To sort".into());
            format!("Reference/{}/{}", plan::clean(&t), name)
        } else {
            let t = taken.as_deref().and_then(parse_dt);
            let event = t.and_then(|t| {
                let day = t.date().to_string();
                events.iter().find(|(_, s, e)| day >= *s && day <= *e).map(|(n, s, _)| (n.clone(), s.clone()))
            });
            let folder_month = event.as_ref().and_then(|(_, s)| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());
            plan::planned_path_in(t, folder_month, event.as_ref().map(|e| e.0.as_str()), &name)
        };
        let dest = unique(&mut used, dest);
        plan.push(PlannedFile { item_id: id, sha256: sha, source_path: path, dest, size });
    }
    Ok(plan)
}

/// Two different files can want the same name (same second, or same file name in Reference).
fn unique(used: &mut HashSet<String>, dest: String) -> String {
    if used.insert(dest.to_lowercase()) {
        return dest;
    }
    let (stem, ext) = match dest.rsplit_once('.') {
        Some((s, e)) if !s.ends_with('/') => (s.to_string(), format!(".{e}")),
        _ => (dest.clone(), String::new()),
    };
    for n in 2.. {
        let candidate = format!("{stem} ({n}){ext}");
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

pub fn plan_summary(cat: &Catalogue) -> Result<PlanSummary> {
    let plan = build_plan(cat)?;
    let copied: HashSet<String> = cat
        .conn
        .prepare("SELECT sha256 FROM copies WHERE lib_verified = 1")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let mut tree: BTreeMap<String, i64> = BTreeMap::new();
    let mut s = PlanSummary {
        library_root: cat.setting("library_root")?,
        backup_root: cat.setting("backup_root")?,
        to_copy: 0,
        to_copy_bytes: 0,
        already_copied: 0,
        photos: 0,
        reference: 0,
        undated: 0,
        reference_suggestions: cat.conn.query_row(
            &format!("SELECT COUNT(*) FROM items i WHERE {REFERENCE_GUESS}"),
            [],
            |r| r.get(0),
        )?,
        tree: vec![],
    };
    for p in &plan {
        if copied.contains(&p.sha256) {
            s.already_copied += 1;
        } else {
            s.to_copy += 1;
            s.to_copy_bytes += p.size;
        }
        if p.dest.starts_with("Reference/") {
            s.reference += 1;
        } else if p.dest.starts_with("Photos/Undated/") {
            s.undated += 1;
        } else {
            s.photos += 1;
        }
        // Folder tree two or three levels deep: Photos/2024/2024-06 Barcelona, Reference/UI
        let parts: Vec<&str> = p.dest.split('/').collect();
        let depth = if parts[0] == "Photos" && parts.len() > 3 { 3 } else { parts.len() - 1 };
        for d in 1..=depth {
            *tree.entry(parts[..d].join("/")).or_default() += 1;
        }
    }
    s.tree = tree.into_iter().map(|(path, count)| TreeNode { path, count }).collect();
    Ok(s)
}

/// Copy to `dest` safely: write to a temporary name, check the fingerprint, then rename into place.
fn copy_verified(src: &Path, dest: &Path, sha: &str) -> Result<()> {
    if dest.exists() {
        if hash::sha256_file(dest)? == sha {
            return Ok(());
        }
        return Err(crate::Error::Other(format!("{} already exists with different content", dest.display())));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = dest.with_extension(format!(
        "{}.safelight-part",
        dest.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    fs::copy(src, &tmp)?;
    if hash::sha256_file(&tmp)? != sha {
        let _ = fs::remove_file(&tmp);
        return Err(crate::Error::Other(format!("copy of {} didn't match the original", src.display())));
    }
    fs::rename(&tmp, dest)?;
    // Keep the original's modified time so other apps sort it sensibly.
    if let Ok(m) = fs::metadata(src).and_then(|m| m.modified()) {
        if let Ok(f) = fs::OpenOptions::new().write(true).open(dest) {
            let _ = f.set_modified(m);
        }
    }
    Ok(())
}

/// Copy everything not yet in the library, then mirror each file to the backup folder.
pub fn run_copy(cat: &Catalogue, mut progress: impl FnMut(&CopyProgress)) -> Result<CopyReport> {
    let lib = cat
        .setting("library_root")?
        .ok_or_else(|| crate::Error::Other("choose a library folder first".into()))?;
    let backup = cat.setting("backup_root")?;
    let plan = build_plan(cat)?;
    let total = plan.len() as u64;
    let mut report = CopyReport::default();
    for (n, p) in plan.iter().enumerate() {
        progress(&CopyProgress { done: n as u64, total, current: p.dest.clone(), stage: "copy".into() });
        let existing: Option<(i64, Option<String>, i64)> = cat
            .conn
            .query_row(
                "SELECT lib_verified, backup_path, backup_verified FROM copies WHERE sha256 = ?1",
                [&p.sha256],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let lib_done = existing.as_ref().map(|e| e.0 == 1).unwrap_or(false);
        let backup_done = existing.as_ref().map(|e| e.2 == 1).unwrap_or(false);
        if lib_done && (backup.is_none() || backup_done) {
            report.skipped += 1;
            continue;
        }
        let dest = PathBuf::from(&lib).join(&p.dest);
        if !lib_done {
            if let Err(e) = copy_verified(Path::new(&p.source_path), &dest, &p.sha256) {
                report.errors.push(format!("{}: {e}", p.source_path));
                continue;
            }
            cat.conn.execute(
                "INSERT INTO copies(sha256, item_id, lib_path, lib_verified, copied_at) VALUES (?1, ?2, ?3, 1, datetime('now'))
                 ON CONFLICT(sha256) DO UPDATE SET lib_path = excluded.lib_path, lib_verified = 1, item_id = excluded.item_id",
                params![p.sha256, p.item_id, dest.to_string_lossy()],
            )?;
            report.copied += 1;
        }
        if let Some(b) = &backup {
            let lib_path: String = cat.conn.query_row("SELECT lib_path FROM copies WHERE sha256 = ?1", [&p.sha256], |r| r.get(0))?;
            let bdest = PathBuf::from(b).join(&p.dest);
            match copy_verified(Path::new(&lib_path), &bdest, &p.sha256) {
                Ok(()) => {
                    cat.conn.execute(
                        "UPDATE copies SET backup_path = ?2, backup_verified = 1 WHERE sha256 = ?1",
                        params![p.sha256, bdest.to_string_lossy()],
                    )?;
                    report.backed_up += 1;
                }
                Err(e) => report.errors.push(format!("backup of {}: {e}", p.dest)),
            }
        }
    }
    progress(&CopyProgress { done: total, total, current: String::new(), stage: "done".into() });
    Ok(report)
}
