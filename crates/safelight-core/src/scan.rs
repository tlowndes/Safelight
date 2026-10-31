//! Read-only scan of one source folder. Nothing on disk is changed.

use crate::{catalogue::Catalogue, dates, hash, media, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{path::{Path, PathBuf}, time::UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub source_id: i64,
    pub done: u64,
    pub total: u64,
    pub current: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ScanReport {
    pub found: u64,
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub removed: u64,
    pub errors: Vec<String>,
}

/// Commit in batches so other parts of the app can still write while a big scan runs.
const BATCH: usize = 300;

/// Walk `source_id`'s folder, add new or changed media to the catalogue and drop entries
/// for files that have gone. Unchanged files (same size and modified time) are not re-hashed,
/// so re-scans are quick. Safelight's own library and backup folders are skipped.
pub fn scan_source(cat: &Catalogue, source_id: i64, mut progress: impl FnMut(&ScanProgress)) -> Result<ScanReport> {
    let root = cat
        .source_root(source_id)?
        .ok_or_else(|| crate::Error::Other(format!("no source with id {source_id}")))?;
    let managed: Vec<PathBuf> = cat.managed_roots()?.into_iter().map(PathBuf::from).collect();
    let mut report = ScanReport::default();

    // First pass: list media files so we can show real progress.
    let files: Vec<_> = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !managed.iter().any(|m| e.path().starts_with(m)))
        .filter_map(|e| match e {
            Ok(e) => Some(e),
            Err(err) => {
                report.errors.push(err.to_string());
                None
            }
        })
        .filter(|e| e.file_type().is_file())
        .filter(|e| !media::is_ignored(e.path().strip_prefix(&root).unwrap_or(e.path())))
        .filter_map(|e| media::classify(e.path()).map(|k| (e.into_path(), k)))
        .collect();
    report.found = files.len() as u64;

    let scan_id: i64 = cat
        .conn
        .query_row("SELECT COALESCE(MAX(seen_scan), 0) + 1 FROM items", [], |r| r.get(0))?;
    let total = files.len() as u64;
    for (b, chunk) in files.chunks(BATCH).enumerate() {
        let tx = cat.conn.unchecked_transaction()?;
        for (k, (path, kind)) in chunk.iter().enumerate() {
            let n = b * BATCH + k;
            let path_str = path.to_string_lossy().to_string();
            if n % 25 == 0 {
                progress(&ScanProgress { source_id, done: n as u64, total, current: path_str.clone() });
            }
            if let Err(e) = index_file(&tx, source_id, scan_id, path, &path_str, *kind, &mut report) {
                report.errors.push(format!("{path_str}: {e}"));
            }
        }
        tx.commit()?;
    }
    report.removed = cat.conn.execute(
        "DELETE FROM items WHERE source_id = ?1 AND seen_scan <> ?2",
        params![source_id, scan_id],
    )? as u64;
    cat.conn.execute("UPDATE sources SET last_scanned = datetime('now') WHERE id = ?1", [source_id])?;
    progress(&ScanProgress { source_id, done: total, total, current: String::new() });
    Ok(report)
}

fn index_file(
    conn: &rusqlite::Connection,
    source_id: i64,
    scan_id: i64,
    path: &Path,
    path_str: &str,
    kind: media::Kind,
    report: &mut ScanReport,
) -> Result<()> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len() as i64;
    let modified = meta.modified().ok();
    let mtime = modified
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let existing: Option<(i64, i64)> = conn
        .query_row("SELECT size, mtime FROM items WHERE path = ?1", [path_str], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if existing == Some((size, mtime)) {
        conn.execute("UPDATE items SET seen_scan = ?1 WHERE path = ?2", params![scan_id, path_str])?;
        report.unchanged += 1;
        return Ok(());
    }

    let sha = hash::sha256_file(path)?;
    let exif = if kind == media::Kind::Photo { dates::read_exif(path) } else { None };
    let date = match exif.as_ref().and_then(|e| e.taken) {
        Some(d) => Some((d, dates::DateSource::Exif)),
        None => dates::fallback_date(path, modified),
    };
    let (taken, date_src) = match date {
        Some((d, s)) => (Some(d.format("%Y-%m-%d %H:%M:%S").to_string()), Some(s.as_str())),
        None => (None, None),
    };
    let ex = exif.unwrap_or_default();
    conn.execute(
        "INSERT INTO items(source_id, path, kind, size, mtime, sha256, taken_at, date_source, seen_scan, has_camera, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256,
           taken_at = excluded.taken_at, date_source = excluded.date_source, seen_scan = excluded.seen_scan,
           has_camera = excluded.has_camera, width = excluded.width, height = excluded.height,
           thumb = NULL, thumb_tried = 0, phash = NULL",
        params![source_id, path_str, kind.as_str(), size, mtime, sha, taken, date_src, scan_id, ex.has_camera, ex.width, ex.height],
    )?;
    if existing.is_some() {
        report.updated += 1;
    } else {
        report.added += 1;
    }
    Ok(())
}
