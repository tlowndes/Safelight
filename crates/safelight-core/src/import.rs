//! Import from a camera card or any folder: copy new photos and videos into a folder of your
//! choice, sorted into dated folders and renamed if you like, checking every copy. Files
//! already in the catalogue (same fingerprint) are skipped. The card is never changed.

use crate::{catalogue::Catalogue, dates, hash, media, organise, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Folders {
    /// 2025/2025-07-12
    ByDate,
    /// Everything in the destination folder itself.
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Rename {
    Original,
    /// 2025-07-12 14.22.05.jpg
    DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOptions {
    pub from: String,
    pub to: String,
    pub folders: Folders,
    pub rename: Rename,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub found: usize,
    pub new: usize,
    pub already: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ImportReport {
    pub copied: usize,
    pub skipped: usize,
    pub bytes: u64,
    pub errors: Vec<String>,
    /// The library source the files went into, ready to scan.
    pub source_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

fn media_files(root: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && media::classify(e.path()).is_some())
        .map(|e| e.into_path())
        .collect()
}

fn known(cat: &Catalogue, sha: &str) -> Result<bool> {
    Ok(cat.conn.query_row("SELECT EXISTS(SELECT 1 FROM items WHERE sha256 = ?1)", [sha], |r| r.get(0))?)
}

/// How many files are on the card and how many are new.
pub fn preview(cat: &Catalogue, from: &Path) -> Result<ImportPreview> {
    let files = media_files(from);
    let (mut new, mut bytes) = (0, 0);
    for f in &files {
        let sha = hash::sha256_file(f)?;
        if !known(cat, &sha)? {
            new += 1;
            bytes += f.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(ImportPreview { found: files.len(), new, already: files.len() - new, bytes })
}

/// Where one file goes.
pub fn destination(file: &Path, opts: &ImportOptions) -> PathBuf {
    let modified = file.metadata().and_then(|m| m.modified()).ok();
    let when = dates::taken_at(file, modified).map(|(t, _)| t);
    let mut dir = PathBuf::from(&opts.to);
    if opts.folders == Folders::ByDate {
        match when {
            Some(t) => {
                dir.push(t.format("%Y").to_string());
                dir.push(t.format("%Y-%m-%d").to_string());
            }
            None => dir.push("Undated"),
        }
    }
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let name = match (opts.rename, when) {
        (Rename::DateTime, Some(t)) => format!("{}.{ext}", t.format("%Y-%m-%d %H.%M.%S")),
        _ => file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
    };
    dir.join(name)
}

/// Copy the new files, then make sure the destination is a library source.
pub fn run(cat: &Catalogue, opts: &ImportOptions, mut progress: impl FnMut(&ImportProgress)) -> Result<ImportReport> {
    let to = PathBuf::from(&opts.to);
    for managed in cat.managed_roots()? {
        if to.starts_with(&managed) {
            return Err(crate::Error::Other("Pick a folder outside Safelight's own library and backup folders".into()));
        }
    }
    let files = media_files(Path::new(&opts.from));
    let mut r = ImportReport::default();
    for (k, f) in files.iter().enumerate() {
        progress(&ImportProgress { done: k, total: files.len(), current: f.to_string_lossy().to_string() });
        let sha = match hash::sha256_file(f) {
            Ok(s) => s,
            Err(e) => {
                r.errors.push(format!("{}: {e}", f.display()));
                continue;
            }
        };
        if known(cat, &sha)? {
            r.skipped += 1;
            continue;
        }
        let mut dest = destination(f, opts);
        // Two shots in the same second, or a name already used: add a number.
        let mut n = 2;
        while dest.exists() && hash::sha256_file(&dest).map(|h| h != sha).unwrap_or(true) {
            let stem = destination(f, opts).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ext = dest.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
            dest = dest.with_file_name(format!("{stem} ({n}).{ext}"));
            n += 1;
        }
        match organise::copy_verified(f, &dest, &sha) {
            Ok(()) => {
                r.copied += 1;
                r.bytes += f.metadata().map(|m| m.len()).unwrap_or(0);
            }
            Err(e) => r.errors.push(format!("{}: {e}", f.display())),
        }
    }
    progress(&ImportProgress { done: files.len(), total: files.len(), current: String::new() });
    // Reuse a source that already covers the folder, or add one.
    let existing = cat.sources()?.into_iter().find(|s| to.starts_with(&s.root));
    r.source_id = Some(match existing {
        Some(s) => s.id,
        None => {
            std::fs::create_dir_all(&to)?;
            cat.add_source("Imports", "local", &opts.to)?
        }
    });
    Ok(r)
}
