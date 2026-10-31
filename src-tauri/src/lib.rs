use safelight_core::{scan_source, Catalogue, MonthGroup, ScanReport, Source, Stats};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct AppState {
    cat: Mutex<Catalogue>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn list_sources(state: State<AppState>) -> CmdResult<Vec<Source>> {
    state.cat.lock().map_err(err)?.sources().map_err(err)
}

#[tauri::command]
fn add_source(state: State<AppState>, name: String, kind: String, root: String) -> CmdResult<i64> {
    state.cat.lock().map_err(err)?.add_source(&name, &kind, &root).map_err(err)
}

#[tauri::command]
fn remove_source(state: State<AppState>, id: i64) -> CmdResult<()> {
    state.cat.lock().map_err(err)?.remove_source(id).map_err(err)
}

#[tauri::command]
fn stats(state: State<AppState>) -> CmdResult<Stats> {
    state.cat.lock().map_err(err)?.stats().map_err(err)
}

#[tauri::command]
fn library(state: State<AppState>, limit: Option<i64>) -> CmdResult<Vec<MonthGroup>> {
    state.cat.lock().map_err(err)?.library(limit.unwrap_or(2000)).map_err(err)
}

/// Scans run on a background thread; progress is sent to the UI as `scan-progress` events.
#[tauri::command]
async fn scan(app: tauri::AppHandle, id: i64) -> CmdResult<ScanReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let cat = state.cat.lock().map_err(err)?;
        scan_source(&cat, id, |p| {
            let _ = handle.emit("scan-progress", p);
        })
        .map_err(err)
    })
    .await
    .map_err(err)?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The catalogue lives in the app's own data folder, never inside a synced folder.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let cat = Catalogue::open(&dir.join("catalogue.sqlite"))?;
            app.manage(AppState { cat: Mutex::new(cat) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![list_sources, add_source, remove_source, stats, library, scan])
        .run(tauri::generate_context!())
        .expect("error while running Safelight");
}
