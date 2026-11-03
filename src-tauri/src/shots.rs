//! Screenshot import (from Snapsort): watching `Pictures\Screenshots`, reading each new
//! screenshot, and filing it or putting it on the review list. The rules live in
//! `safelight_core::screenshots`; this file runs them in the background and talks to Claude.

use base64::Engine;
use safelight_core::{
    ocr,
    screenshots::{self, FileEdits, Move, ShotSettings, Suggestion},
    secret, Catalogue,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, State};

use crate::{blocking, err, AppState, CmdResult};

/// Screenshots the watcher has already seen (lower-cased paths), so each is handled once.
pub type Known = Arc<Mutex<HashSet<String>>>;

fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

/// Asks Claude what the screenshot shows.
fn ask_claude(cat: &Catalogue, settings: &ShotSettings, path: &Path, ocr_text: &str) -> Result<screenshots::Classified, String> {
    let stored = screenshots::stored_api_key(cat).map_err(err)?.ok_or("Add a Claude API key in Settings first.")?;
    let api_key = secret::unprotect(&stored).map_err(|_| "The saved Claude API key couldn't be read. Add it again in Settings.".to_string())?;
    let (media, bytes) = screenshots::claude_image(path).map_err(err)?;
    let model = screenshots::claude_model(&settings.claude_model);
    let body = screenshots::claude_request(model, media, &base64::engine::general_purpose::STANDARD.encode(bytes), ocr_text);
    let mut req = ureq::post("https://api.anthropic.com/v1/messages")
        .timeout(Duration::from_secs(90))
        .set("x-api-key", &api_key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json");
    if let Some(beta) = screenshots::claude_beta(model) {
        req = req.set("anthropic-beta", beta);
    }
    match req.send_json(body) {
        Ok(resp) => screenshots::parse_claude_response(&resp.into_json().map_err(err)?),
        Err(ureq::Error::Status(code, _)) => Err(screenshots::explain_claude_status(code)),
        Err(_) => Err("Couldn't reach Claude. It was read on the PC instead.".into()),
    }
}

/// Reads one screenshot. On the PC first; then Claude, if switched on (or asked for), gets the
/// final say. If Claude can't help, the on-device answer stands and the card says why.
fn analyse(cat: &Catalogue, settings: &ShotSettings, path: &Path, engine: Option<&str>) -> CmdResult<Suggestion> {
    let mut note = None;
    let lines = ocr::read_text(path).unwrap_or_else(|e| {
        note = Some(e);
        Vec::new()
    });
    let want_claude = match engine {
        Some("claude") => true,
        Some(_) => false,
        None => settings.use_claude(),
    };
    let claude = if want_claude {
        match ask_claude(cat, settings, path, &lines.join("\n")) {
            Ok(c) => Some(c),
            Err(e) => {
                note = Some(e);
                None
            }
        }
    } else {
        None
    };
    screenshots::suggest(path, &lines, claude, note, settings.date_prefix).map_err(err)
}

/// Files a new screenshot if Safelight is sure, otherwise puts it on the review list.
fn handle_new(app: &tauri::AppHandle, cat: &Catalogue, settings: &ShotSettings, path: &Path) {
    let Ok(s) = analyse(cat, settings, path, None) else { return };
    if settings.auto_file && s.confidence >= settings.threshold() {
        match screenshots::file_shot(cat, &s, &FileEdits::default(), &settings.destination, settings.date_prefix, true) {
            Ok(m) => {
                let _ = app.emit("shot-filed", &m);
                return;
            }
            Err(e) => {
                let s = Suggestion { note: Some(e.to_string()), ..s };
                let _ = screenshots::queue_put(cat, &s);
                let _ = app.emit("shot-queued", &s);
                return;
            }
        }
    }
    let _ = screenshots::queue_put(cat, &s);
    let _ = app.emit("shot-queued", &s);
}

/// Checks the screenshot folder every couple of seconds. Screenshots already there when the
/// watcher starts are left for "Sort existing", so nothing old moves without a look. A new file
/// is only read once its size has stopped changing (Windows has finished saving it).
pub fn start_watcher(app: tauri::AppHandle, db: PathBuf, default_folder: String, known: Known) {
    std::thread::spawn(move || {
        let mut primed: Option<String> = None;
        let mut pending: HashMap<String, u64> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let Ok(cat) = Catalogue::open(&db) else { continue };
            let Ok(settings) = ShotSettings::load(&cat, &default_folder) else { continue };
            if !settings.watch {
                primed = None;
                continue;
            }
            let folder = Path::new(&settings.folder);
            let files = screenshots::unsorted(folder);
            if primed.as_deref() != Some(settings.folder.as_str()) {
                known.lock().unwrap().extend(files.iter().map(|p| key(p)));
                primed = Some(settings.folder.clone());
                continue;
            }
            for p in files {
                let k = key(&p);
                if known.lock().unwrap().contains(&k) {
                    continue;
                }
                if screenshots::queue_has(&cat, &p.to_string_lossy()).unwrap_or(false) {
                    known.lock().unwrap().insert(k);
                    continue;
                }
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                if size > 0 && pending.get(&k) == Some(&size) {
                    pending.remove(&k);
                    known.lock().unwrap().insert(k);
                    handle_new(&app, &cat, &settings, &p);
                } else {
                    pending.insert(k, size);
                }
            }
        }
    });
}

// ---------- commands ----------

#[derive(Serialize)]
pub struct ShotInfo {
    settings: ShotSettings,
    categories: Vec<screenshots::CategoryInfo>,
    /// Windows OCR is there (false only when not running on Windows).
    ocr: bool,
    waiting: i64,
}

#[tauri::command]
pub async fn shot_info(state: State<'_, AppState>) -> CmdResult<ShotInfo> {
    let (db, default) = (state.db_path.clone(), state.shots_default.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        Ok(ShotInfo {
            settings: ShotSettings::load(&cat, &default).map_err(err)?,
            categories: screenshots::category_list(),
            ocr: ocr::is_available(),
            waiting: screenshots::queue_count(&cat).map_err(err)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn shot_set(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    let db = state.db_path.clone();
    blocking(move || screenshots::set_setting(&Catalogue::open(&db).map_err(err)?, &key, &value).map_err(err)).await
}

/// Saves the Claude API key, encrypted for this Windows account. An empty key removes it.
#[tauri::command]
pub async fn shot_set_api_key(state: State<'_, AppState>, api_key: String) -> CmdResult<()> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let k = api_key.trim();
        let stored = if k.is_empty() { String::new() } else { secret::protect(k)? };
        screenshots::store_api_key(&cat, &stored).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn shot_queue(state: State<'_, AppState>) -> CmdResult<Vec<Suggestion>> {
    let db = state.db_path.clone();
    blocking(move || screenshots::queue(&Catalogue::open(&db).map_err(err)?).map_err(err)).await
}

#[tauri::command]
pub async fn shot_file(state: State<'_, AppState>, path: String, edits: FileEdits) -> CmdResult<Move> {
    let (db, default) = (state.db_path.clone(), state.shots_default.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let settings = ShotSettings::load(&cat, &default).map_err(err)?;
        let s = screenshots::queue_get(&cat, &path).map_err(err)?.ok_or("That screenshot isn't waiting any more")?;
        screenshots::file_shot(&cat, &s, &edits, &settings.destination, settings.date_prefix, false).map_err(err)
    })
    .await
}

/// Takes a screenshot off the review list and leaves the file where it is.
#[tauri::command]
pub async fn shot_leave(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let db = state.db_path.clone();
    blocking(move || screenshots::queue_remove(&Catalogue::open(&db).map_err(err)?, &path).map_err(err)).await
}

#[tauri::command]
pub async fn shot_undo(state: State<'_, AppState>, id: i64) -> CmdResult<String> {
    let (db, known) = (state.db_path.clone(), state.shots_known.clone());
    blocking(move || {
        let back = screenshots::undo(&Catalogue::open(&db).map_err(err)?, id).map_err(err)?;
        // Put back by hand, so the watcher shouldn't file it again.
        known.lock().unwrap().insert(back.to_lowercase());
        Ok(back)
    })
    .await
}

#[tauri::command]
pub async fn shot_moves(state: State<'_, AppState>, query: Option<String>, limit: Option<i64>) -> CmdResult<Vec<Move>> {
    let db = state.db_path.clone();
    blocking(move || screenshots::moves(&Catalogue::open(&db).map_err(err)?, query.as_deref(), limit.unwrap_or(300)).map_err(err)).await
}

/// Reads every screenshot already in the folder and puts them all on the review list (never
/// files them straight away). Returns how many were added.
#[tauri::command]
pub async fn shot_sort_existing(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<u64> {
    let (db, default, known) = (state.db_path.clone(), state.shots_default.clone(), state.shots_known.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let settings = ShotSettings::load(&cat, &default).map_err(err)?;
        let todo: Vec<PathBuf> = screenshots::unsorted(Path::new(&settings.folder))
            .into_iter()
            .filter(|p| !screenshots::queue_has(&cat, &p.to_string_lossy()).unwrap_or(true))
            .collect();
        let total = todo.len() as u64;
        for (i, p) in todo.iter().enumerate() {
            let _ = app.emit("shots-progress", serde_json::json!({ "done": i, "total": total, "current": p.to_string_lossy() }));
            known.lock().unwrap().insert(key(p));
            if let Ok(s) = analyse(&cat, &settings, p, None) {
                screenshots::queue_put(&cat, &s).map_err(err)?;
            }
        }
        let _ = app.emit("shots-progress", serde_json::json!({ "done": total, "total": total }));
        Ok(total)
    })
    .await
}

/// Reads one waiting screenshot again, on the PC ("device") or with Claude ("claude").
#[tauri::command]
pub async fn shot_reread(state: State<'_, AppState>, path: String, engine: String) -> CmdResult<Suggestion> {
    let (db, default) = (state.db_path.clone(), state.shots_default.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let settings = ShotSettings::load(&cat, &default).map_err(err)?;
        let s = analyse(&cat, &settings, Path::new(&path), Some(&engine))?;
        screenshots::queue_put(&cat, &s).map_err(err)?;
        Ok(s)
    })
    .await
}
