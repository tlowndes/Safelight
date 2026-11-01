//! Deleting photos the user doesn't want. A photo is binned everywhere Safelight knows it:
//! the original, every exact copy in other sources, look-alikes already dropped in its
//! favour, and the copies Safelight made in the library and on the backup. Files go to the
//! Recycle Bin (or a "Safelight bin" folder on network drives), so they can still be restored.

use crate::{catalogue::Catalogue, cleanup::bin_file, Result};
use rusqlite::params;
use serde::Serialize;
use std::{collections::{BTreeSet, HashMap}, path::{Path, PathBuf}};

#[derive(Debug, Clone, Serialize, Default)]
pub struct DeleteReport {
    /// Photos the user picked (after merging exact copies).
    pub photos: u64,
    /// Files moved to a bin, counting copies.
    pub files: u64,
    pub freed_bytes: i64,
    pub errors: Vec<String>,
}

fn root_for(path: &Path, roots: &[PathBuf]) -> PathBuf {
    roots
        .iter()
        .filter(|r| path.starts_with(r))
        .max_by_key(|r| r.as_os_str().len())
        .cloned()
        .unwrap_or_else(|| path.parent().map(Path::to_path_buf).unwrap_or_default())
}

pub fn delete_items(cat: &Catalogue, ids: &[i64], mut progress: impl FnMut(u64, u64)) -> Result<DeleteReport> {
    let mut report = DeleteReport::default();
    // Fingerprints of the chosen photos.
    let mut shas = BTreeSet::new();
    for id in ids {
        if let Some(sha) = cat
            .conn
            .query_row("SELECT sha256 FROM items WHERE id = ?1", [id], |r| r.get::<_, String>(0))
            .ok()
        {
            shas.insert(sha);
        }
    }
    report.photos = shas.len() as u64;

    let mut roots: Vec<PathBuf> = cat.sources()?.into_iter().map(|s| PathBuf::from(s.root)).collect();
    for key in ["library_root", "backup_root"] {
        if let Some(r) = cat.setting(key)? {
            roots.push(PathBuf::from(r));
        }
    }

    // Every file that holds one of these pictures.
    let mut files: Vec<(Option<i64>, String, String)> = Vec::new(); // (item id, path, sha)
    let mut seen = std::collections::HashSet::new();
    for sha in &shas {
        let items: Vec<(i64, String)> = cat
            .conn
            .prepare("SELECT id, path FROM items WHERE sha256 = ?1 OR (dup_status = 'drop' AND dup_keeper = ?1)")?
            .query_map([sha], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        for (id, path) in items {
            if seen.insert(path.clone()) {
                files.push((Some(id), path, sha.clone()));
            }
        }
        let copies: Option<(String, Option<String>)> =
            cat.conn.query_row("SELECT lib_path, backup_path FROM copies WHERE sha256 = ?1", [sha], |r| Ok((r.get(0)?, r.get(1)?))).ok();
        if let Some((lib, backup)) = copies {
            for p in std::iter::once(lib).chain(backup) {
                if seen.insert(p.clone()) {
                    files.push((None, p, sha.clone()));
                }
            }
        }
    }

    let total = files.len() as u64;
    let mut failed_shas: HashMap<String, ()> = HashMap::new();
    for (n, (id, path, sha)) in files.into_iter().enumerate() {
        progress(n as u64, total);
        let p = Path::new(&path);
        let size = std::fs::metadata(p).map(|m| m.len() as i64).ok();
        if size.is_some() {
            match bin_file(&root_for(p, &roots), p) {
                Ok(to) => {
                    cat.conn.execute(
                        "INSERT INTO binned(path, sha256, moved_to, at) VALUES (?1, ?2, ?3, datetime('now'))",
                        params![path, sha, to],
                    )?;
                    report.files += 1;
                    report.freed_bytes += size.unwrap_or(0);
                }
                Err(e) => {
                    report.errors.push(format!("{path}: {e}"));
                    failed_shas.insert(sha.clone(), ());
                    continue;
                }
            }
        }
        // Gone (or never there): forget it.
        if let Some(id) = id {
            for sql in ["DELETE FROM edits WHERE item_id = ?1", "DELETE FROM item_tags WHERE item_id = ?1", "DELETE FROM items WHERE id = ?1"] {
                cat.conn.execute(sql, [id])?;
            }
        }
    }
    for sha in &shas {
        if !failed_shas.contains_key(sha) {
            cat.conn.execute("DELETE FROM copies WHERE sha256 = ?1", [sha])?;
        }
    }
    progress(total, total);
    Ok(report)
}
