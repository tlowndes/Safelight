//! Clean-up: once a file is safely in the library AND on the backup, its originals in the
//! sources can go. Nothing is deleted outright: files go to the Recycle Bin, or, on network
//! drives (which have no Recycle Bin), into a "Safelight bin" folder at the source's root.

use crate::{catalogue::Catalogue, Result};
use rusqlite::params;
use serde::Serialize;
use std::{fs, path::{Path, PathBuf}};

#[derive(Debug, Clone, Serialize)]
pub struct SourceCleanup {
    pub source_id: i64,
    pub name: String,
    pub kind: String,
    pub files: i64,
    pub bytes: i64,
    /// Plain-English description of where the files will go.
    pub destination: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CleanupSummary {
    pub copied: i64,
    pub backed_up: i64,
    pub failed: i64,
    pub sources: Vec<SourceCleanup>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CleanupReport {
    pub binned: u64,
    pub freed_bytes: i64,
    pub skipped: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupProgress {
    pub done: u64,
    pub total: u64,
}

/// Originals that are safe to bin: their content (or, for dropped look-alikes, the copy that
/// replaced them) is verified in the library and, when a backup is set, on the backup too.
const SAFE: &str = "
  SELECT i.id, i.source_id, i.path, i.size, i.sha256 FROM items i
  JOIN copies c ON c.sha256 = CASE WHEN i.dup_status = 'drop' THEN i.dup_keeper ELSE i.sha256 END
  WHERE c.lib_verified = 1 AND (c.backup_verified = 1 OR ?1 = 0)";

fn backup_required(cat: &Catalogue) -> Result<i64> {
    Ok(cat.setting("backup_root")?.is_some() as i64)
}

fn is_managed(cat: &Catalogue, path: &str) -> Result<bool> {
    Ok(cat.managed_roots()?.iter().any(|m| Path::new(path).starts_with(m)))
}

fn candidates(cat: &Catalogue, source_ids: Option<&[i64]>) -> Result<Vec<(i64, i64, String, i64, String)>> {
    let rows: Vec<(i64, i64, String, i64, String)> = cat
        .conn
        .prepare(SAFE)?
        .query_map([backup_required(cat)?], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    for r in rows {
        if is_managed(cat, &r.2)? {
            continue;
        }
        if let Some(ids) = source_ids {
            if !ids.contains(&r.1) {
                continue;
            }
        }
        out.push(r);
    }
    Ok(out)
}

pub fn is_network_path(path: &Path) -> bool {
    #[cfg(windows)]
    {
        crate::winshell::is_network_path(path)
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().starts_with("//")
    }
}

pub fn summary(cat: &Catalogue) -> Result<CleanupSummary> {
    let mut s = CleanupSummary::default();
    cat.conn.query_row(
        "SELECT COALESCE(SUM(lib_verified),0), COALESCE(SUM(backup_verified),0) FROM copies",
        [],
        |r| {
            s.copied = r.get(0)?;
            s.backed_up = r.get(1)?;
            Ok(())
        },
    )?;
    let plan = crate::organise::build_plan(cat)?.len() as i64;
    s.failed = (plan - s.copied).max(0);
    let cands = candidates(cat, None)?;
    for src in cat.sources()? {
        let mine: Vec<_> = cands.iter().filter(|c| c.1 == src.id).collect();
        if mine.is_empty() {
            continue;
        }
        let destination = if is_network_path(Path::new(&src.root)) {
            "Moves to a \"Safelight bin\" folder on the drive (network drives have no Recycle Bin)".to_string()
        } else {
            match src.kind.as_str() {
                "gdrive" => "Recycle Bin on this PC; Google Drive then moves it to its own bin".into(),
                "proton" => "Recycle Bin on this PC; Proton Drive then moves it to its trash".into(),
                _ => "Recycle Bin on this PC".into(),
            }
        };
        s.sources.push(SourceCleanup {
            source_id: src.id,
            name: src.name,
            kind: src.kind,
            files: mine.len() as i64,
            bytes: mine.iter().map(|c| c.3).sum(),
            destination,
        });
    }
    Ok(s)
}

pub fn file_list(cat: &Catalogue, source_ids: &[i64]) -> Result<Vec<String>> {
    Ok(candidates(cat, Some(source_ids))?.into_iter().map(|c| c.2).collect())
}

fn move_to_safelight_bin(root: &Path, path: &Path) -> Result<PathBuf> {
    let rel = path.strip_prefix(root).unwrap_or(path.file_name().map(Path::new).unwrap_or(path));
    let dest = root
        .join("Safelight bin")
        .join(chrono::Local::now().format("%Y-%m-%d").to_string())
        .join(rel);
    if let Some(p) = dest.parent() {
        fs::create_dir_all(p)?;
    }
    fs::rename(path, &dest)?;
    Ok(dest)
}

/// Bin the originals for the chosen sources. Each file is re-checked (still there, same size)
/// first; anything that changed since it was copied is left alone.
pub fn run(cat: &Catalogue, source_ids: &[i64], mut progress: impl FnMut(&CleanupProgress)) -> Result<CleanupReport> {
    let cands = candidates(cat, Some(source_ids))?;
    let roots: std::collections::HashMap<i64, String> = cat.sources()?.into_iter().map(|s| (s.id, s.root)).collect();
    let mut report = CleanupReport::default();
    let total = cands.len() as u64;
    for (n, (id, source_id, path, size, sha)) in cands.into_iter().enumerate() {
        if n % 20 == 0 {
            progress(&CleanupProgress { done: n as u64, total });
        }
        let p = Path::new(&path);
        match fs::metadata(p) {
            Ok(m) if m.len() as i64 == size => {}
            _ => {
                report.skipped += 1;
                continue;
            }
        }
        let root = PathBuf::from(roots.get(&source_id).cloned().unwrap_or_default());
        let moved_to = if is_network_path(p) {
            move_to_safelight_bin(&root, p).map(|d| d.to_string_lossy().to_string())
        } else {
            trash::delete(p).map(|_| "Recycle Bin".to_string()).map_err(|e| crate::Error::Other(e.to_string()))
        };
        match moved_to {
            Ok(to) => {
                cat.conn.execute(
                    "INSERT INTO binned(path, sha256, moved_to, at) VALUES (?1, ?2, ?3, datetime('now'))",
                    params![path, sha, to],
                )?;
                cat.conn.execute("DELETE FROM items WHERE id = ?1", [id])?;
                report.binned += 1;
                report.freed_bytes += size;
            }
            Err(e) => report.errors.push(format!("{path}: {e}")),
        }
    }
    progress(&CleanupProgress { done: total, total });
    Ok(report)
}
