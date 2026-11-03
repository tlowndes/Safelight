//! Capture (from Keepshot): screenshots and screen recordings of a screen, window or region,
//! with optional microphone. The media logic (ffmpeg commands, edit recipes, export) lives in
//! TypeScript under src/capture; this side owns what only native code can do: processes, the
//! tray, global shortcuts, the HUD and region windows, and the clipboard.
//!
//! Captures are written to the Captures folder (Pictures\Safelight Captures by default), which
//! is a library source, so every capture lands in the library like any other import.
pub mod config;
pub mod db;
pub mod files;
pub mod hotkeys;
pub mod platform;
pub mod recorder;
pub mod tools;
pub mod tray;
pub mod windows;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

pub struct CaptureState {
    pub config: Mutex<config::AppConfig>,
    pub recording: Mutex<Option<recorder::Recording>>,
    pub hotkeys: Mutex<HashMap<u32, String>>,
    pub db: Mutex<rusqlite::Connection>,
    /// Closing the main window hides it to the tray, so capture shortcuts keep working.
    pub close_to_tray: AtomicBool,
}

/// Sets up the Captures folder, the capture store and the tray. Returns the Captures folder.
pub fn init(app: &AppHandle) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    config::load_env();
    let cfg = config::resolve(app);
    std::fs::create_dir_all(&cfg.data_dir)?;
    let app_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_dir)?;
    let conn = db::open(&app_dir.join("captures.sqlite"))?;
    let dir = cfg.data_dir.clone();
    app.manage(CaptureState {
        config: Mutex::new(cfg),
        recording: Mutex::new(None),
        hotkeys: Mutex::new(HashMap::new()),
        db: Mutex::new(conn),
        close_to_tray: AtomicBool::new(true),
    });
    tray::build(app)?;
    Ok(dir)
}

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    hotkeys::plugin()
}

/// Whether closing the main window should hide it to the tray instead of quitting.
pub fn should_hide_on_close(app: &AppHandle) -> bool {
    app.try_state::<CaptureState>().map(|s| s.close_to_tray.load(Ordering::Relaxed)).unwrap_or(false)
}

/// Stops any recording cleanly before the app quits.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<CaptureState>() {
        let _ = recorder::stop(app, &state);
    }
}

#[tauri::command]
pub fn capture_config(state: State<'_, CaptureState>) -> Result<config::AppConfig, String> {
    state.config.lock().map(|c| c.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_close_to_tray(state: State<'_, CaptureState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn copy_image(app: AppHandle, state: State<'_, CaptureState>, path: String) -> Result<(), String> {
    let root = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    if !config::is_inside(&root, std::path::Path::new(&path)) {
        return Err("Only files in the Captures folder can be copied.".into());
    }
    let image = tauri::image::Image::from_path(&path).map_err(|e| format!("Couldn't read the image: {e}"))?;
    app.clipboard().write_image(&image).map_err(|e| format!("Couldn't copy to the clipboard: {e}"))
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_mic_settings(app: AppHandle) -> Result<(), String> {
    app.opener().open_url("ms-settings:privacy-microphone", None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_capture_folder(app: AppHandle, state: State<'_, CaptureState>) -> Result<(), String> {
    let dir = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    windows::show_main(&app);
}

