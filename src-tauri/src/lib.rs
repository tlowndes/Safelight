mod capture;
mod update;

use base64::Engine;
use safelight_core::{
    cleanup, develop::{self, Edits, Preset}, dupes, exact, folders, imaging, organise, reference, scan_source, Catalogue, Item, MonthGroup,
    ScanReport, Source, Stats,
};
use serde::Serialize;
use std::{
    io::Cursor,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State};

/// Each command opens its own catalogue connection (SQLite handles the locking), so a long copy
/// or scan never freezes the rest of the app.
struct AppState {
    db_path: PathBuf,
    cache_dir: PathBuf,
    /// Decoded image the editor is working on, at preview size.
    preview: Arc<Mutex<Option<(i64, image::DynamicImage)>>>,
    /// Where screenshots and recordings are saved (a library source).
    captures_root: PathBuf,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Run blocking work off the UI thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

macro_rules! with_db {
    ($state:expr, |$cat:ident| $body:expr) => {{
        let path = $state.db_path.clone();
        blocking(move || {
            let $cat = Catalogue::open(&path).map_err(err)?;
            $body.map_err(err)
        })
        .await
    }};
}

// ---------- sources and library ----------

#[tauri::command]
async fn list_sources(state: State<'_, AppState>) -> CmdResult<Vec<Source>> {
    with_db!(state, |cat| cat.sources())
}

#[tauri::command]
async fn add_source(state: State<'_, AppState>, name: String, kind: String, root: String) -> CmdResult<i64> {
    with_db!(state, |cat| cat.add_source(&name, &kind, &root))
}

#[tauri::command]
async fn remove_source(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db!(state, |cat| cat.remove_source(id))
}

#[tauri::command]
async fn stats(state: State<'_, AppState>) -> CmdResult<Stats> {
    with_db!(state, |cat| cat.stats())
}

#[tauri::command]
async fn library(state: State<'_, AppState>, limit: Option<i64>, folder: Option<folders::FolderRef>) -> CmdResult<Vec<MonthGroup>> {
    with_db!(state, |cat| cat.library_in(limit.unwrap_or(3000), folder.as_ref()))
}

#[tauri::command]
async fn folder_tree(state: State<'_, AppState>) -> CmdResult<Vec<folders::FolderNode>> {
    with_db!(state, |cat| folders::folder_tree(&cat))
}

#[tauri::command]
async fn item(state: State<'_, AppState>, id: i64) -> CmdResult<Option<Item>> {
    with_db!(state, |cat| cat.item(id))
}

/// Scan one source, then make thumbnails for anything new. Progress goes to the UI as events.
#[tauri::command]
async fn scan(app: tauri::AppHandle, state: State<'_, AppState>, id: i64) -> CmdResult<ScanReport> {
    let (db, cache) = (state.db_path.clone(), state.cache_dir.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let report = scan_source(&cat, id, |p| {
            let _ = app.emit("scan-progress", p);
        })
        .map_err(err)?;
        let moved = organise::auto_move_reference(&cat).map_err(err)?;
        if moved > 0 {
            let _ = app.emit("reference-moved", moved);
        }
        imaging::process_thumbnails(&cat, &cache, |p| {
            let _ = app.emit("thumb-progress", p);
        })
        .map_err(err)?;
        Ok(report)
    })
    .await
}

#[tauri::command]
async fn process_thumbnails(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<u64> {
    let (db, cache) = (state.db_path.clone(), state.cache_dir.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        imaging::process_thumbnails(&cat, &cache, |p| {
            let _ = app.emit("thumb-progress", p);
        })
        .map_err(err)
    })
    .await
}

// ---------- settings ----------

#[derive(Serialize)]
struct Settings {
    library_root: Option<String>,
    backup_root: Option<String>,
    auto_reference: bool,
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        Ok(Settings {
            library_root: cat.setting("library_root").map_err(err)?,
            backup_root: cat.setting("backup_root").map_err(err)?,
            auto_reference: organise::auto_reference_enabled(&cat).map_err(err)?,
        })
    })
    .await
}

#[tauri::command]
async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    if !matches!(key.as_str(), "library_root" | "backup_root" | "auto_reference") {
        return Err(format!("unknown setting {key}"));
    }
    with_db!(state, |cat| cat.set_setting(&key, &value))
}

// ---------- duplicates ----------

#[tauri::command]
async fn dup_groups(state: State<'_, AppState>) -> CmdResult<Vec<dupes::Group>> {
    with_db!(state, |cat| dupes::lookalike_groups(&cat))
}

#[tauri::command]
async fn dup_resolve(state: State<'_, AppState>, keep: Vec<i64>, drop: Vec<i64>) -> CmdResult<()> {
    with_db!(state, |cat| dupes::resolve(&cat, &keep, &drop))
}

#[tauri::command]
async fn exact_groups(state: State<'_, AppState>) -> CmdResult<Vec<exact::ExactGroup>> {
    with_db!(state, |cat| exact::exact_groups(&cat))
}

#[tauri::command]
async fn exact_resolve(state: State<'_, AppState>, sha256: String, keep: Vec<i64>) -> CmdResult<()> {
    with_db!(state, |cat| exact::resolve(&cat, &sha256, &keep))
}

#[tauri::command]
async fn exact_keep_preferred_all(state: State<'_, AppState>) -> CmdResult<u64> {
    with_db!(state, |cat| exact::keep_preferred_all(&cat))
}

#[tauri::command]
async fn exact_reset(state: State<'_, AppState>, sha256: String) -> CmdResult<()> {
    with_db!(state, |cat| exact::reset(&cat, &sha256))
}

#[tauri::command]
async fn spare_summary(state: State<'_, AppState>) -> CmdResult<exact::SpareSummary> {
    with_db!(state, |cat| exact::spare_summary(&cat))
}

#[tauri::command]
async fn move_spares(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<exact::MoveReport> {
    with_db!(state, |cat| exact::move_spares(&cat, |done, total| {
        let _ = app.emit("move-progress", serde_json::json!({ "done": done, "total": total }));
    }))
}

#[tauri::command]
async fn move_batches(state: State<'_, AppState>) -> CmdResult<Vec<exact::MoveBatch>> {
    with_db!(state, |cat| exact::move_batches(&cat))
}

/// Put a batch of moved files back, then re-scan their sources so they reappear.
#[tauri::command]
async fn undo_moves(state: State<'_, AppState>, batch: i64) -> CmdResult<exact::UndoReport> {
    with_db!(state, |cat| (|| {
        let report = exact::undo_batch(&cat, batch)?;
        for id in &report.source_ids {
            scan_source(&cat, *id, |_| {})?;
        }
        Ok::<_, safelight_core::Error>(report)
    })())
}

// ---------- organise ----------

#[tauri::command]
async fn suggest_events(state: State<'_, AppState>) -> CmdResult<Vec<organise::EventSuggestion>> {
    with_db!(state, |cat| organise::suggest_events(&cat))
}

#[tauri::command]
async fn save_event(state: State<'_, AppState>, name: String, start_day: String, end_day: String) -> CmdResult<i64> {
    with_db!(state, |cat| organise::save_event(&cat, &name, &start_day, &end_day))
}

#[tauri::command]
async fn delete_event(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db!(state, |cat| organise::delete_event(&cat, id))
}

#[tauri::command]
async fn reference_suggestions(state: State<'_, AppState>) -> CmdResult<Vec<Item>> {
    with_db!(state, |cat| organise::reference_suggestions(&cat))
}

#[tauri::command]
async fn set_reference(state: State<'_, AppState>, ids: Vec<i64>, is_reference: bool) -> CmdResult<()> {
    with_db!(state, |cat| organise::set_reference(&cat, &ids, is_reference))
}

#[tauri::command]
async fn plan_summary(state: State<'_, AppState>) -> CmdResult<organise::PlanSummary> {
    with_db!(state, |cat| organise::plan_summary(&cat))
}

#[tauri::command]
async fn run_copy(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<organise::CopyReport> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        organise::run_copy(&cat, |p| {
            let _ = app.emit("copy-progress", p);
        })
        .map_err(err)
    })
    .await
}

// ---------- clean-up ----------

#[tauri::command]
async fn cleanup_summary(state: State<'_, AppState>) -> CmdResult<cleanup::CleanupSummary> {
    with_db!(state, |cat| cleanup::summary(&cat))
}

#[tauri::command]
async fn cleanup_files(state: State<'_, AppState>, source_ids: Vec<i64>) -> CmdResult<Vec<String>> {
    with_db!(state, |cat| cleanup::file_list(&cat, &source_ids))
}

#[tauri::command]
async fn cleanup_run(app: tauri::AppHandle, state: State<'_, AppState>, source_ids: Vec<i64>) -> CmdResult<cleanup::CleanupReport> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        cleanup::run(&cat, &source_ids, |p| {
            let _ = app.emit("cleanup-progress", p);
        })
        .map_err(err)
    })
    .await
}

#[tauri::command]
async fn check_reference(state: State<'_, AppState>) -> CmdResult<u64> {
    with_db!(state, |cat| organise::move_reference_now(&cat))
}

#[tauri::command]
async fn delete_items(app: tauri::AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> CmdResult<safelight_core::delete::DeleteReport> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        safelight_core::delete::delete_items(&cat, &ids, |done, total| {
            let _ = app.emit("delete-progress", serde_json::json!({ "done": done, "total": total }));
        })
        .map_err(err)
    })
    .await
}

// ---------- updates ----------

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> CmdResult<Option<update::UpdateInfo>> {
    let current = app.package_info().version.to_string();
    blocking(move || update::check(&current)).await
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    blocking(move || update::install(&app, &url)).await
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------- reference ----------

#[tauri::command]
async fn topics(state: State<'_, AppState>) -> CmdResult<Vec<reference::Topic>> {
    with_db!(state, |cat| reference::topics(&cat))
}

#[tauri::command]
async fn create_topic(state: State<'_, AppState>, name: String) -> CmdResult<i64> {
    with_db!(state, |cat| reference::ensure_topic(&cat, &name))
}

#[tauri::command]
async fn rename_topic(state: State<'_, AppState>, id: i64, name: String) -> CmdResult<()> {
    with_db!(state, |cat| reference::rename_topic(&cat, id, &name))
}

#[tauri::command]
async fn delete_topic(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db!(state, |cat| reference::delete_topic(&cat, id))
}

#[tauri::command]
async fn set_topic(state: State<'_, AppState>, ids: Vec<i64>, topic_id: i64) -> CmdResult<()> {
    with_db!(state, |cat| reference::set_topic(&cat, &ids, topic_id))
}

#[tauri::command]
async fn tags(state: State<'_, AppState>) -> CmdResult<Vec<reference::Tag>> {
    with_db!(state, |cat| reference::tags(&cat))
}

#[tauri::command]
async fn add_tag(state: State<'_, AppState>, ids: Vec<i64>, name: String) -> CmdResult<()> {
    with_db!(state, |cat| reference::add_tag(&cat, &ids, &name))
}

#[tauri::command]
async fn remove_tag(state: State<'_, AppState>, id: i64, name: String) -> CmdResult<()> {
    with_db!(state, |cat| reference::remove_tag(&cat, id, &name))
}

#[tauri::command]
async fn reference_items(state: State<'_, AppState>, topic_id: Option<i64>, tag: Option<String>) -> CmdResult<Vec<reference::RefItem>> {
    with_db!(state, |cat| reference::items(&cat, topic_id, tag.as_deref()))
}

// ---------- editor ----------

const PREVIEW_EDGE: u32 = 1600;

#[derive(Serialize)]
struct Rendered {
    /// data: URL of a JPEG preview
    image: String,
    histogram: Vec<f32>,
    width: u32,
    height: u32,
}

#[tauri::command]
async fn load_edits(state: State<'_, AppState>, id: i64) -> CmdResult<Edits> {
    with_db!(state, |cat| develop::load_edits(&cat, id))
}

#[tauri::command]
async fn save_edits(state: State<'_, AppState>, id: i64, edits: Edits) -> CmdResult<()> {
    with_db!(state, |cat| develop::save_edits(&cat, id, &edits))
}

#[tauri::command]
async fn render_preview(state: State<'_, AppState>, id: i64, edits: Edits) -> CmdResult<Rendered> {
    let db = state.db_path.clone();
    let cache = state.preview.clone();
    blocking(move || {
        let mut slot = cache.lock().map_err(err)?;
        if slot.as_ref().map(|s| s.0) != Some(id) {
            let cat = Catalogue::open(&db).map_err(err)?;
            let item = cat.item(id).map_err(err)?.ok_or("photo not found")?;
            let img = imaging::preview_image(std::path::Path::new(&item.path), PREVIEW_EDGE)
                .ok_or("Safelight can't open this file for editing yet")?;
            *slot = Some((id, img));
        }
        let base = &slot.as_ref().unwrap().1;
        let out = develop::apply(base, &edits);
        let histogram = develop::histogram(&out);
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(out.clone())
            .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .map_err(err)?;
        Ok(Rendered {
            image: format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpeg)),
            histogram,
            width: out.width(),
            height: out.height(),
        })
    })
    .await
}

/// Full-size export as JPEG. Formats the image library can't decode (e.g. HEIC) export at the
/// largest size Windows can preview them.
#[tauri::command]
async fn export_image(state: State<'_, AppState>, id: i64, edits: Edits, path: String, max_edge: Option<u32>) -> CmdResult<String> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let item = cat.item(id).map_err(err)?.ok_or("photo not found")?;
        let src = std::path::Path::new(&item.path);
        let img = imaging::decode(src)
            .or_else(|| imaging::preview_image(src, 4096))
            .ok_or("Safelight can't open this file for export")?;
        let mut out = image::DynamicImage::ImageRgb8(develop::apply(&img, &edits));
        if let Some(m) = max_edge {
            if out.width().max(out.height()) > m {
                out = out.resize(m, m, image::imageops::FilterType::Lanczos3);
            }
        }
        let file = std::fs::File::create(&path).map_err(err)?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 92);
        enc.encode_image(&out).map_err(err)?;
        Ok(path)
    })
    .await
}

#[tauri::command]
async fn presets(state: State<'_, AppState>) -> CmdResult<Vec<Preset>> {
    with_db!(state, |cat| develop::presets(&cat))
}

#[tauri::command]
async fn save_preset(state: State<'_, AppState>, name: String, edits: Edits) -> CmdResult<i64> {
    with_db!(state, |cat| develop::save_preset(&cat, &name, &edits))
}

#[tauri::command]
async fn delete_preset(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db!(state, |cat| develop::delete_preset(&cat, id))
}

// ---------- viewer: rating, flags, hiding ----------

#[tauri::command]
async fn set_rating(state: State<'_, AppState>, ids: Vec<i64>, rating: i64) -> CmdResult<()> {
    with_db!(state, |cat| cat.set_rating(&ids, rating))
}

#[tauri::command]
async fn set_flag(state: State<'_, AppState>, ids: Vec<i64>, flag: i64) -> CmdResult<()> {
    with_db!(state, |cat| cat.set_flag(&ids, flag))
}

#[tauri::command]
async fn set_hidden(state: State<'_, AppState>, ids: Vec<i64>, hidden: bool) -> CmdResult<()> {
    with_db!(state, |cat| cat.set_hidden(&ids, hidden))
}

#[tauri::command]
async fn hidden_items(state: State<'_, AppState>) -> CmdResult<Vec<Item>> {
    with_db!(state, |cat| cat.hidden_items())
}

/// Long edge of the loupe picture for files the webview can't show directly (HEIC, RAW, TIFF).
const VIEW_EDGE: u32 = 2560;

/// A full-screen picture of a photo the webview can't open itself, cached as a JPEG beside the
/// thumbnails. Returns its path. The original is only read.
#[tauri::command]
async fn view_image(state: State<'_, AppState>, id: i64) -> CmdResult<String> {
    let db = state.db_path.clone();
    let dir = state.cache_dir.join("view");
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let item = cat.item(id).map_err(err)?.ok_or("photo not found")?;
        let out = dir.join(format!("{}.jpg", &item.sha256[..32.min(item.sha256.len())]));
        if !out.exists() {
            std::fs::create_dir_all(&dir).map_err(err)?;
            let img = imaging::preview_image(std::path::Path::new(&item.path), VIEW_EDGE)
                .ok_or("Safelight can't show this file yet")?;
            image::DynamicImage::ImageRgb8(img.to_rgb8()).save_with_format(&out, image::ImageFormat::Jpeg).map_err(err)?;
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
}

// ---------- capture ----------

/// Scans the Captures folder so new screenshots, recordings and exports show up in the library.
#[tauri::command]
async fn import_captures(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<ScanReport> {
    let (db, cache, root) = (state.db_path.clone(), state.cache_dir.clone(), state.captures_root.clone());
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let id = ensure_captures_source(&cat, &root)?;
        let report = scan_source(&cat, id, |_| {}).map_err(err)?;
        imaging::process_thumbnails(&cat, &cache, |p| {
            let _ = app.emit("thumb-progress", p);
        })
        .map_err(err)?;
        let _ = app.emit("captures-imported", report.added);
        Ok(report)
    })
    .await
}

/// The Captures folder is always a library source, so captures land in the library.
fn ensure_captures_source(cat: &Catalogue, root: &std::path::Path) -> CmdResult<i64> {
    let root = root.to_string_lossy();
    if let Some(s) = cat.sources().map_err(err)?.into_iter().find(|s| s.root == root) {
        return Ok(s.id);
    }
    cat.add_source("Captures", "captures", &root).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch brings the running Safelight forward (it may be in the tray).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| capture::windows::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(capture::global_shortcut_plugin())
        .setup(|app| {
            // The catalogue and thumbnails live in the app's own folders, never inside a synced folder.
            let dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?.join("thumbs");
            std::fs::create_dir_all(&dir)?;
            std::fs::create_dir_all(&cache_dir)?;
            let db_path = dir.join("catalogue.sqlite");
            let cat = Catalogue::open(&db_path)?;
            cat.set_setting("thumb_cache", &cache_dir.to_string_lossy())?;
            let captures_root = capture::init(app.handle())?;
            ensure_captures_source(&cat, &captures_root)?;
            app.manage(AppState { db_path, cache_dir, preview: Arc::new(Mutex::new(None)), captures_root });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window keeps Safelight in the tray so capture shortcuts still work
            // (switch this off in Capture settings).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && capture::should_hide_on_close(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == "main" {
                    capture::shutdown(window.app_handle());
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sources, add_source, remove_source, stats, library, item, scan, process_thumbnails,
            get_settings, set_setting,
            dup_groups, dup_resolve, folder_tree,
            exact_groups, exact_resolve, exact_keep_preferred_all, exact_reset, spare_summary, move_spares, move_batches, undo_moves,
            suggest_events, save_event, delete_event, reference_suggestions, set_reference, plan_summary, run_copy,
            cleanup_summary, cleanup_files, cleanup_run, delete_items, check_reference, check_update, install_update, app_version,
            topics, create_topic, rename_topic, delete_topic, set_topic, tags, add_tag, remove_tag, reference_items,
            load_edits, save_edits, render_preview, export_image, presets, save_preset, delete_preset,
            set_rating, set_flag, set_hidden, hidden_items, view_image, import_captures,
            capture::capture_config, capture::set_close_to_tray, capture::copy_image, capture::copy_text,
            capture::reveal_in_folder, capture::open_mic_settings, capture::open_capture_folder, capture::show_main_window,
            capture::db::capture_db_execute, capture::db::capture_db_select,
            capture::tools::run_tool, capture::tools::tool_available,
            capture::files::fs_exists, capture::files::fs_mkdirp, capture::files::fs_read_text, capture::files::fs_write_text,
            capture::files::fs_remove, capture::files::fs_remove_dir, capture::files::fs_trash, capture::files::fs_size, capture::files::fs_list,
            capture::files::data_size, capture::platform::list_windows,
            capture::windows::open_region_picker, capture::windows::flash_screen,
            capture::recorder::rec_start, capture::recorder::rec_toggle_pause, capture::recorder::rec_stop, capture::recorder::rec_status,
            capture::hotkeys::set_hotkeys
        ])
        .run(tauri::generate_context!())
        .expect("error while running Safelight");
}
