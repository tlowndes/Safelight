//! File operations for the UI, restricted to the Captures folder.
use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use super::config::is_inside;
use super::CaptureState as AppState;

fn guard(state: &AppState, path: &str) -> Result<PathBuf, String> {
    let root = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    let p = PathBuf::from(path);
    if !p.is_absolute() || !is_inside(&root, &p) {
        return Err(format!("Safelight capture only reads and writes inside {}", root.display()));
    }
    Ok(p)
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    // Existence checks are allowed anywhere (e.g. a whisper model configured in .env).
    Path::new(&path).exists()
}

#[tauri::command]
pub fn fs_mkdirp(state: State<'_, AppState>, path: String) -> Result<(), String> {
    fs::create_dir_all(guard(&state, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_read_text(state: State<'_, AppState>, path: String) -> Result<String, String> {
    fs::read_to_string(guard(&state, &path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_text(state: State<'_, AppState>, path: String, text: String) -> Result<(), String> {
    let p = guard(&state, &path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_remove(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = guard(&state, &path)?;
    match fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn fs_remove_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = guard(&state, &path)?;
    let root = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    if p == root {
        return Err("Refusing to delete the whole Captures folder.".into());
    }
    match fs::remove_dir_all(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Moves a capture (a screenshot, or a recording's whole folder) to the Recycle Bin.
#[tauri::command]
pub fn fs_trash(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = guard(&state, &path)?;
    let root = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    if p == root {
        return Err("Refusing to delete the whole Captures folder.".into());
    }
    if !p.exists() {
        return Ok(());
    }
    trash::delete(&p).map_err(|e| format!("Couldn't move it to the Recycle Bin: {e}"))
}

#[tauri::command]
pub fn fs_size(state: State<'_, AppState>, path: String) -> Result<u64, String> {
    fs::metadata(guard(&state, &path)?).map(|m| m.len()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_list(state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let p = guard(&state, &path)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let mut names: Vec<String> = fs::read_dir(p)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    Ok(names)
}

/// Total size of the data folder in bytes (shown in the library sidebar).
#[tauri::command]
pub async fn data_size(state: State<'_, AppState>) -> Result<u64, String> {
    let root = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || dir_size(&root)).await.unwrap_or(0))
}

fn dir_size(p: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(p) else { return 0 };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}
