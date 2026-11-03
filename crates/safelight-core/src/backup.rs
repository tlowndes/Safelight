//! Automatic backup to the NAS: once a week, copy anything new or changed to the backup folder.
//!
//! Copy only. Nothing on the NAS is ever deleted or overwritten, and originals are never touched.
//! Every copy is checked against its SHA-256 fingerprint before it counts as backed up.

use crate::{catalogue::Catalogue, hash, organise, Result};
use chrono::{Duration, NaiveDateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long between automatic backups.
pub const INTERVAL_DAYS: i64 = 7;
const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BackupReport {
    pub backed_up: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
    /// UTC, "YYYY-MM-DD HH:MM:SS".
    pub finished_at: String,
    /// True when the run was started by the weekly schedule rather than the button.
    pub automatic: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupStatus {
    pub backup_root: Option<String>,
    /// Weekly automatic backup switched on.
    pub weekly: bool,
    /// Whether the backup folder can be reached right now (NAS switched on, network up).
    pub reachable: bool,
    /// Last finished backup, UTC.
    pub last_run: Option<String>,
    /// When the next automatic backup is due, UTC. None when there's nothing to schedule.
    pub next_due: Option<String>,
    pub due: bool,
    /// Files in the library plan that aren't on the NAS yet.
    pub waiting: i64,
    pub waiting_bytes: i64,
    pub last_report: Option<BackupReport>,
}

pub fn weekly_enabled(cat: &Catalogue) -> Result<bool> {
    // On by default once a backup folder is chosen.
    Ok(cat.setting("auto_backup")?.map(|v| v != "0").unwrap_or(true))
}

fn last_run(cat: &Catalogue) -> Result<Option<NaiveDateTime>> {
    Ok(cat.setting("last_backup_at")?.and_then(|s| NaiveDateTime::parse_from_str(&s, TIME_FMT).ok()))
}

/// A network share or drive that's offline looks like a missing folder.
pub fn reachable(root: &str) -> bool {
    Path::new(root).is_dir()
}

/// Is the weekly backup due at `now` (UTC)? Doesn't check whether the NAS is reachable.
pub fn is_due(cat: &Catalogue, now: NaiveDateTime) -> Result<bool> {
    if cat.setting("backup_root")?.is_none() || !weekly_enabled(cat)? {
        return Ok(false);
    }
    Ok(match last_run(cat)? {
        None => true,
        Some(last) => now - last >= Duration::days(INTERVAL_DAYS),
    })
}

pub fn is_due_now(cat: &Catalogue) -> Result<bool> {
    is_due(cat, Utc::now().naive_utc())
}

pub fn status(cat: &Catalogue) -> Result<BackupStatus> {
    let root = cat.setting("backup_root")?;
    let weekly = weekly_enabled(cat)?;
    let last = last_run(cat)?;
    let (mut waiting, mut waiting_bytes) = (0, 0);
    for p in organise::build_plan(cat)? {
        if !is_backed_up(cat, &p.sha256)? {
            waiting += 1;
            waiting_bytes += p.size;
        }
    }
    let next_due = match (&root, weekly) {
        (Some(_), true) => Some(match last {
            Some(l) => (l + Duration::days(INTERVAL_DAYS)).format(TIME_FMT).to_string(),
            None => Utc::now().naive_utc().format(TIME_FMT).to_string(),
        }),
        _ => None,
    };
    Ok(BackupStatus {
        reachable: root.as_deref().map(reachable).unwrap_or(false),
        backup_root: root,
        weekly,
        last_run: last.map(|l| l.format(TIME_FMT).to_string()),
        next_due,
        due: is_due_now(cat)?,
        waiting,
        waiting_bytes,
        last_report: cat.setting("last_backup_report")?.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

fn is_backed_up(cat: &Catalogue, sha: &str) -> Result<bool> {
    let row: Option<(i64, Option<String>)> = cat
        .conn
        .query_row("SELECT backup_verified, backup_path FROM copies WHERE sha256 = ?1", [sha], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(matches!(row, Some((1, Some(_)))))
}

/// Where a file goes on the NAS. If that name is already taken by different content (the
/// original was edited since the last backup), keep the old one and use "name (2).jpg".
pub(crate) fn free_dest(root: &Path, rel: &str, sha: &str) -> Result<PathBuf> {
    let first = root.join(rel);
    let (stem, ext) = match rel.rsplit_once('.') {
        Some((s, e)) if !s.ends_with('/') => (s.to_string(), format!(".{e}")),
        _ => (rel.to_string(), String::new()),
    };
    let mut candidate = first;
    for n in 2.. {
        if !candidate.exists() || hash::sha256_file(&candidate)? == sha {
            return Ok(candidate);
        }
        candidate = root.join(format!("{stem} ({n}){ext}"));
    }
    unreachable!()
}

/// Copy everything new or changed to the backup folder. Files already there are skipped
/// without re-reading them; ones that have gone missing from the NAS are copied again.
pub fn run_backup(cat: &Catalogue, automatic: bool, mut progress: impl FnMut(&organise::CopyProgress)) -> Result<BackupReport> {
    let root = cat
        .setting("backup_root")?
        .ok_or_else(|| crate::Error::Other("choose a backup folder on the NAS first".into()))?;
    if !reachable(&root) {
        return Err(crate::Error::Other(format!("can't reach {root}. Is the NAS switched on?")));
    }
    let root = PathBuf::from(root);
    let plan = organise::build_plan(cat)?;
    let total = plan.len() as u64;
    let mut report = BackupReport { automatic, ..Default::default() };
    for (n, p) in plan.iter().enumerate() {
        progress(&organise::CopyProgress { done: n as u64, total, current: p.dest.clone(), stage: "backup".into() });
        let existing: Option<(String, i64, Option<String>, i64)> = cat
            .conn
            .query_row(
                "SELECT lib_path, lib_verified, backup_path, backup_verified FROM copies WHERE sha256 = ?1",
                [&p.sha256],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((_, _, Some(bp), 1)) = &existing {
            if Path::new(bp).exists() {
                report.skipped += 1;
                continue;
            }
        }
        // Prefer the checked library copy; fall back to the original.
        let src = match &existing {
            Some((lib, 1, _, _)) if Path::new(lib).exists() => lib.clone(),
            _ => p.source_path.clone(),
        };
        let result = free_dest(&root, &p.dest, &p.sha256)
            .and_then(|dest| organise::copy_verified(Path::new(&src), &dest, &p.sha256).map(|_| dest));
        match result {
            Ok(dest) => {
                let dest = dest.to_string_lossy().to_string();
                if existing.is_some() {
                    cat.conn.execute(
                        "UPDATE copies SET backup_path = ?2, backup_verified = 1 WHERE sha256 = ?1",
                        params![p.sha256, dest],
                    )?;
                } else {
                    // Not in the library yet: the library copy step will fill lib_path in later.
                    cat.conn.execute(
                        "INSERT INTO copies(sha256, item_id, lib_path, lib_verified, backup_path, backup_verified, copied_at)
                         VALUES (?1, ?2, '', 0, ?3, 1, datetime('now'))",
                        params![p.sha256, p.item_id, dest],
                    )?;
                }
                report.backed_up += 1;
            }
            Err(e) => report.errors.push(format!("{}: {e}", p.dest)),
        }
    }
    report.finished_at = Utc::now().naive_utc().format(TIME_FMT).to_string();
    cat.set_setting("last_backup_at", &report.finished_at)?;
    cat.set_setting("last_backup_report", &serde_json::to_string(&report).unwrap_or_default())?;
    progress(&organise::CopyProgress { done: total, total, current: String::new(), stage: "done".into() });
    Ok(report)
}
