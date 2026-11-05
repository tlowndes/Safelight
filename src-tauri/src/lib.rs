mod capture;
mod models;
mod shots;
mod update;

use base64::Engine;
use safelight_core::{
    ai::Engines, backup, cleanup, develop::{self, Edits, Preset}, dupes, exact, export, folders, imaging, organise, reference, scan_source,
    smart::{self, EmbeddingIndex}, Catalogue, Item, MonthGroup, ScanReport, Source, Stats,
};
use serde::Serialize;
use std::{
    io::Cursor,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};

/// Each command opens its own catalogue connection (SQLite handles the locking), so a long copy
/// or scan never freezes the rest of the app.
struct AppState {
    db_path: PathBuf,
    cache_dir: PathBuf,
    /// Decoded image the editor is working on, at preview size.
    preview: Arc<Mutex<Option<(i64, image::DynamicImage)>>>,
    /// Set while a NAS backup is running, so the weekly timer and the button never overlap.
    backing_up: Arc<AtomicBool>,
    /// Where screenshots and recordings are saved (a library source).
    captures_root: PathBuf,
    /// Where Windows saves screenshots: Pictures\Screenshots.
    shots_default: String,
    shots_known: shots::Known,
    smart: Smart,
    faces_dir: PathBuf,
    smart_running: Arc<AtomicBool>,
    smart_stop: Arc<AtomicBool>,
}

/// Smart tagging models (downloaded once, loaded on first use) and the in-memory search index.
/// Cheap to clone into background work.
#[derive(Clone)]
struct Smart {
    models_dir: PathBuf,
    engines: Arc<Mutex<Option<Arc<Engines>>>>,
    index: Arc<Mutex<Option<Arc<EmbeddingIndex>>>>,
}

impl Smart {
    /// The models, if they've been downloaded. Loading takes a second or two the first time.
    fn engines(&self) -> CmdResult<Option<Arc<Engines>>> {
        if !safelight_core::ai::missing_models(&self.models_dir).is_empty() {
            return Ok(None);
        }
        let mut slot = self.engines.lock().map_err(err)?;
        if slot.is_none() {
            *slot = Some(Arc::new(Engines::load(&self.models_dir).map_err(err)?));
        }
        Ok(slot.clone())
    }

    fn index(&self, cat: &Catalogue) -> CmdResult<Arc<EmbeddingIndex>> {
        let mut slot = self.index.lock().map_err(err)?;
        if slot.is_none() {
            *slot = Some(Arc::new(EmbeddingIndex::load(cat).map_err(err)?));
        }
        Ok(slot.clone().unwrap())
    }

    fn forget_index(&self) {
        if let Ok(mut slot) = self.index.lock() {
            *slot = None;
        }
    }
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

/// Like `with_db!`, with the smart tagging handles too.
macro_rules! with_smart {
    ($state:expr, |$cat:ident, $smart:ident| $body:expr) => {{
        let path = $state.db_path.clone();
        let $smart = $state.smart.clone();
        blocking(move || {
            let $cat = Catalogue::open(&path).map_err(err)?;
            $body
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
async fn item_folder(state: State<'_, AppState>, id: i64) -> CmdResult<Option<folders::FolderRef>> {
    with_db!(state, |cat| folders::folder_of(&cat, id))
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
        // Places only need the camera data, so they're named straight away, models or not.
        smart::tag_places(&cat).map_err(err)?;
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
    smart_tagging: bool,
    confirm_delete: bool,
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
            smart_tagging: cat.setting("smart_tagging").map_err(err)?.as_deref() != Some("0"),
            confirm_delete: cat.setting("confirm_delete").map_err(err)?.as_deref() != Some("0"),
        })
    })
    .await
}

#[tauri::command]
async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    if !matches!(key.as_str(), "library_root" | "backup_root" | "auto_reference" | "auto_backup" | "smart_tagging" | "confirm_delete") {
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

// ---------- NAS backup ----------

#[tauri::command]
async fn backup_status(state: State<'_, AppState>) -> CmdResult<backup::BackupStatus> {
    with_db!(state, |cat| backup::status(&cat))
}

/// Back up now (the button). The weekly timer uses the same path.
#[tauri::command]
async fn run_backup(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<backup::BackupReport> {
    let (db, flag) = (state.db_path.clone(), state.backing_up.clone());
    blocking(move || backup_once(&app, &db, &flag, false)).await
}

fn backup_once(app: &tauri::AppHandle, db: &std::path::Path, flag: &AtomicBool, automatic: bool) -> CmdResult<backup::BackupReport> {
    if flag.swap(true, Ordering::SeqCst) {
        return Err("a backup is already running".into());
    }
    let result = Catalogue::open(db).map_err(err).and_then(|cat| {
        backup::run_backup(&cat, automatic, |p| {
            let _ = app.emit("backup-progress", p);
        })
        .map_err(err)
    });
    flag.store(false, Ordering::SeqCst);
    let _ = app.emit("backup-finished", &result);
    result
}

/// Checks every hour (and shortly after launch) whether the weekly backup is due. If the NAS
/// can't be reached it quietly tries again next hour, so a laptop away from home just catches up later.
fn start_backup_timer(app: tauri::AppHandle, db: PathBuf, flag: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        loop {
            let due = Catalogue::open(&db).and_then(|cat| {
                let root = cat.setting("backup_root")?;
                Ok(backup::is_due_now(&cat)? && root.as_deref().is_some_and(backup::reachable))
            });
            if matches!(due, Ok(true)) {
                let _ = backup_once(&app, &db, &flag, true);
            }
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
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

// ---------- smart tagging ----------

#[derive(Serialize)]
struct SmartState {
    #[serde(flatten)]
    status: smart::SmartStatus,
    running: bool,
    enabled: bool,
}

#[tauri::command]
async fn smart_status(state: State<'_, AppState>) -> CmdResult<SmartState> {
    let running = state.smart_running.load(Ordering::Relaxed);
    with_smart!(state, |cat, sm| Ok(SmartState {
        status: smart::status(&cat, &sm.models_dir).map_err(err)?,
        running,
        enabled: cat.setting("smart_tagging").map_err(err)?.as_deref() != Some("0"),
    }))
}

#[tauri::command]
async fn download_models(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.smart.models_dir.clone();
    blocking(move || models::download(&app, &dir)).await
}

/// Name places, then look at every picture not analysed yet. Runs in the background; progress
/// goes to the UI as events. Returns how many pictures were analysed.
#[tauri::command]
async fn run_smart(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<u64> {
    if state.smart_running.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    state.smart_stop.store(false, Ordering::SeqCst);
    let (faces_dir, stop, running) = (state.faces_dir.clone(), state.smart_stop.clone(), state.smart_running.clone());
    let result = with_smart!(state, |cat, sm| {
        smart::tag_places(&cat).map_err(err)?;
        let Some(eng) = sm.engines()? else { return Ok(0) };
        let n = smart::analyse(&cat, &eng, &faces_dir, &stop, |p| {
            let _ = app.emit("smart-progress", p);
        })
        .map_err(err)?;
        sm.forget_index();
        Ok(n)
    });
    running.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn stop_smart(state: State<'_, AppState>) {
    state.smart_stop.store(true, Ordering::SeqCst);
}

/// Item ids matching words: people, places, tags, and pictures that look like the words.
#[tauri::command]
async fn smart_search(state: State<'_, AppState>, query: String) -> CmdResult<Vec<i64>> {
    with_smart!(state, |cat, sm| {
        let eng = sm.engines()?;
        let index = if eng.is_some() { Some(sm.index(&cat)?) } else { None };
        smart::search(&cat, eng.as_ref().map(|e| &e.clip), index.as_deref(), &query).map_err(err)
    })
}

#[tauri::command]
async fn similar(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<Item>> {
    with_smart!(state, |cat, sm| smart::similar(&cat, &*sm.index(&cat)?, id, 80).map_err(err))
}

#[tauri::command]
async fn people(state: State<'_, AppState>) -> CmdResult<Vec<smart::Person>> {
    with_db!(state, |cat| smart::people(&cat))
}

#[tauri::command]
async fn person_faces(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<smart::FaceRow>> {
    with_db!(state, |cat| smart::person_faces(&cat, id))
}

#[tauri::command]
async fn person_items(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<Item>> {
    with_db!(state, |cat| smart::person_items(&cat, id))
}

#[tauri::command]
async fn name_person(state: State<'_, AppState>, id: i64, name: String) -> CmdResult<i64> {
    with_db!(state, |cat| smart::name_person(&cat, id, &name))
}

#[tauri::command]
async fn merge_people(state: State<'_, AppState>, from: i64, into: i64) -> CmdResult<()> {
    with_db!(state, |cat| smart::merge_people(&cat, from, into))
}

#[tauri::command]
async fn remove_face(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db!(state, |cat| smart::remove_face(&cat, id))
}

#[tauri::command]
async fn hide_person(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db!(state, |cat| smart::hide_person(&cat, id))
}

#[tauri::command]
async fn places(state: State<'_, AppState>) -> CmdResult<Vec<smart::PlaceCount>> {
    with_db!(state, |cat| smart::places(&cat))
}

#[tauri::command]
async fn smart_tags(state: State<'_, AppState>, kind: String) -> CmdResult<Vec<smart::TagCount>> {
    with_db!(state, |cat| smart::smart_tags(&cat, &kind))
}

#[tauri::command]
async fn item_smart(state: State<'_, AppState>, id: i64) -> CmdResult<smart::ItemSmart> {
    with_db!(state, |cat| smart::item_smart(&cat, id))
}

#[tauri::command]
async fn topic_suggestions(state: State<'_, AppState>) -> CmdResult<Vec<smart::TopicSuggestion>> {
    with_smart!(state, |cat, sm| {
        let Some(eng) = sm.engines()? else { return Ok(vec![]) };
        smart::topic_suggestions(&cat, &eng.clip, &*sm.index(&cat)?).map_err(err)
    })
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

/// Export one photo as JPEG with the given (possibly unsaved) edits.
#[tauri::command]
async fn export_image(state: State<'_, AppState>, id: i64, edits: Edits, path: String, max_edge: Option<u32>) -> CmdResult<String> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        let item = cat.item(id).map_err(err)?.ok_or("photo not found")?;
        let out = export::render(std::path::Path::new(&item.path), &edits, max_edge).ok_or("Safelight can't open this file for export")?;
        export::write(&out, std::path::Path::new(&path), export::Format::Jpeg, 92).map_err(err)?;
        Ok(path)
    })
    .await
}

/// Export many photos with their saved edits, reporting progress as "export-progress".
#[tauri::command]
async fn export_items(app: tauri::AppHandle, state: State<'_, AppState>, ids: Vec<i64>, options: export::ExportOptions) -> CmdResult<export::ExportReport> {
    let db = state.db_path.clone();
    blocking(move || {
        let cat = Catalogue::open(&db).map_err(err)?;
        export::export_items(&cat, &ids, &options, |p| {
            let _ = app.emit("export-progress", p);
        })
        .map_err(err)
    })
    .await
}

#[tauri::command]
async fn paste_look(state: State<'_, AppState>, ids: Vec<i64>, edits: Edits) -> CmdResult<Vec<(i64, Edits)>> {
    with_db!(state, |cat| develop::paste_look(&cat, &ids, &edits))
}

#[tauri::command]
async fn restore_edits(state: State<'_, AppState>, edits: Vec<(i64, Edits)>) -> CmdResult<()> {
    with_db!(state, |cat| develop::restore_edits(&cat, &edits))
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
            let shots_default = app
                .path()
                .picture_dir()
                .map(|p| p.join("Screenshots"))
                .unwrap_or_else(|_| PathBuf::from("Screenshots"))
                .to_string_lossy()
                .into_owned();
            let shots_known = shots::Known::default();
            shots::start_watcher(app.handle().clone(), db_path.clone(), shots_default.clone(), shots_known.clone());
            let backing_up = Arc::new(AtomicBool::new(false));
            start_backup_timer(app.handle().clone(), db_path.clone(), backing_up.clone());
            let models_dir = dir.join("models");
            let faces_dir = app.path().app_cache_dir()?.join("faces");
            app.manage(AppState {
                db_path,
                cache_dir,
                preview: Arc::new(Mutex::new(None)),
                shots_default,
                shots_known,
                captures_root,
                backing_up,
                smart: Smart { models_dir, engines: Arc::new(Mutex::new(None)), index: Arc::new(Mutex::new(None)) },
                faces_dir,
                smart_running: Arc::new(AtomicBool::new(false)),
                smart_stop: Arc::new(AtomicBool::new(false)),
            });
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
            suggest_events, save_event, delete_event, reference_suggestions, set_reference, plan_summary, run_copy, backup_status, run_backup,
            cleanup_summary, cleanup_files, cleanup_run, delete_items, check_reference, check_update, install_update, app_version,
            topics, create_topic, rename_topic, delete_topic, set_topic, tags, add_tag, remove_tag, reference_items,
            load_edits, save_edits, render_preview, export_image, export_items, paste_look, restore_edits, presets, save_preset, delete_preset,
            set_rating, set_flag, set_hidden, hidden_items, view_image, import_captures,
            capture::capture_config, capture::set_close_to_tray, capture::copy_image, capture::copy_text,
            capture::reveal_in_folder, item_folder, capture::open_mic_settings, capture::open_capture_folder, capture::show_main_window,
            capture::db::capture_db_execute, capture::db::capture_db_select,
            capture::tools::run_tool, capture::tools::tool_available,
            capture::files::fs_exists, capture::files::fs_mkdirp, capture::files::fs_read_text, capture::files::fs_write_text,
            capture::files::fs_remove, capture::files::fs_remove_dir, capture::files::fs_trash, capture::files::fs_size, capture::files::fs_list,
            capture::files::data_size, capture::platform::list_windows,
            capture::windows::open_region_picker, capture::windows::flash_screen,
            capture::recorder::rec_start, capture::recorder::rec_toggle_pause, capture::recorder::rec_stop, capture::recorder::rec_status,
            capture::hotkeys::set_hotkeys,
            shots::shot_info, shots::shot_set, shots::shot_set_api_key, shots::shot_queue, shots::shot_file,
            shots::shot_leave, shots::shot_undo, shots::shot_moves, shots::shot_sort_existing, shots::shot_reread,
            smart_status, download_models, run_smart, stop_smart, smart_search, similar, people, person_faces, person_items,
            name_person, merge_people, remove_face, hide_person, places, smart_tags, item_smart, topic_suggestions
        ])
        .run(tauri::generate_context!())
        .expect("error while running Safelight");
}
