//! Screen recording: drives ffmpeg segments, the clock, cursor sampling,
//! the HUD and the tray. Arguments for each segment are built in TypeScript
//! (src/core/ffmpeg.ts) and passed in as a template containing `{segment}`.
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::config::is_inside;
use super::tools::{binary_for, command};
use super::{platform, tray, windows, CaptureState as AppState};

#[derive(Default)]
struct Clock {
    accumulated: Duration,
    running_since: Option<Instant>,
}

impl Clock {
    fn elapsed(&self) -> Duration {
        self.accumulated + self.running_since.map(|s| s.elapsed()).unwrap_or_default()
    }
    fn pause(&mut self) {
        if let Some(s) = self.running_since.take() {
            self.accumulated += s.elapsed();
        }
    }
    fn resume(&mut self) {
        if self.running_since.is_none() {
            self.running_since = Some(Instant::now());
        }
    }
}

pub struct Recording {
    folder: PathBuf,
    template: Vec<String>,
    segments: Vec<PathBuf>,
    child: Option<Child>,
    clock: Arc<Mutex<Clock>>,
    cursor: Arc<Mutex<Vec<[i64; 3]>>>,
    stop_flag: Arc<AtomicBool>,
    started_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecState {
    status: &'static str,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecFinished {
    folder: String,
    segments: Vec<String>,
    cursor_file: Option<String>,
    started_at_ms: u64,
    duration_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn spawn_segment(app: &AppHandle, rec: &mut Recording) -> Result<(), String> {
    let state = app.state::<AppState>();
    let bin = binary_for(&state, "ffmpeg")?.unwrap_or_else(|| "ffmpeg".into());
    let n = rec.segments.len() + 1;
    let seg = rec.folder.join(format!("segment-{n:03}.mkv"));
    let log = rec.folder.join(format!("segment-{n:03}.log"));
    let args: Vec<String> = rec.template.iter().map(|a| a.replace("{segment}", &seg.to_string_lossy())).collect();
    let log_file = File::create(&log).map_err(|e| e.to_string())?;
    let mut child = command(&bin)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("program not found: ffmpeg ({bin})")
            } else {
                format!("Couldn't start ffmpeg: {e}")
            }
        })?;

    // Give ffmpeg a moment to open the screen and microphone; if it exits, report why.
    let deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            let detail = std::fs::read_to_string(&log).unwrap_or_default();
            let _ = std::fs::remove_file(&seg);
            return Err(if detail.trim().is_empty() { "ffmpeg exited immediately".into() } else { detail });
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    rec.segments.push(seg);
    rec.child = Some(child);
    Ok(())
}

/// Asks ffmpeg to finish the file cleanly ("q"), and kills it if it doesn't.
fn stop_child(child: &mut Child) {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn start_background(app: &AppHandle, clock: Arc<Mutex<Clock>>, cursor: Arc<Mutex<Vec<[i64; 3]>>>, stop: Arc<AtomicBool>, origin: (i32, i32)) {
    // Cursor sampler (~30 Hz). Records positions relative to the capture origin
    // on the recording timeline, so pauses don't shift the highlight.
    {
        let (clock, cursor, stop) = (clock.clone(), cursor, stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let (running, t) = {
                    let c = clock.lock().unwrap();
                    (c.running_since.is_some(), c.elapsed().as_millis() as i64)
                };
                if running {
                    if let Some((x, y)) = platform::cursor_pos() {
                        cursor.lock().unwrap().push([t, (x - origin.0) as i64, (y - origin.1) as i64]);
                    }
                }
                std::thread::sleep(Duration::from_millis(33));
            }
        });
    }
    // Ticker: keeps the HUD and tray up to date.
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last_tray = u64::MAX;
        while !stop.load(Ordering::Relaxed) {
            let (status, elapsed) = {
                let c = clock.lock().unwrap();
                (if c.running_since.is_some() { "recording" } else { "paused" }, c.elapsed().as_millis() as u64)
            };
            let _ = app.emit("rec-state", RecState { status, elapsed_ms: elapsed });
            if elapsed / 1000 != last_tray {
                last_tray = elapsed / 1000;
                tray::set_recording(&app, Some((status, elapsed)));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[tauri::command]
pub async fn rec_start(
    app: AppHandle,
    state: State<'_, AppState>,
    template: Vec<String>,
    folder: String,
    origin_x: i32,
    origin_y: i32,
) -> Result<(), String> {
    let mut slot = state.recording.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("A recording is already running. Stop it first.".into());
    }
    let folder = PathBuf::from(folder);
    let root = state.config.lock().map_err(|e| e.to_string())?.data_dir.clone();
    if !is_inside(&root, &folder) {
        return Err("Recordings must be saved inside the Captures folder.".into());
    }
    if !template.iter().any(|a| a.contains("{segment}")) {
        return Err("Recording template is missing its output.".into());
    }
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let mut rec = Recording {
        folder,
        template,
        segments: vec![],
        child: None,
        clock: Arc::new(Mutex::new(Clock::default())),
        cursor: Arc::new(Mutex::new(Vec::new())),
        stop_flag: Arc::new(AtomicBool::new(false)),
        started_at_ms: now_ms(),
    };
    spawn_segment(&app, &mut rec)?;
    rec.clock.lock().unwrap().resume();
    start_background(&app, rec.clock.clone(), rec.cursor.clone(), rec.stop_flag.clone(), (origin_x, origin_y));
    *slot = Some(rec);
    drop(slot);
    let _ = windows::show_hud(&app);
    let _ = app.emit("rec-state", RecState { status: "recording", elapsed_ms: 0 });
    Ok(())
}

#[tauri::command]
pub async fn rec_toggle_pause(app: AppHandle, state: State<'_, AppState>) -> Result<&'static str, String> {
    toggle_pause(&app, &state)
}

pub fn toggle_pause(app: &AppHandle, state: &AppState) -> Result<&'static str, String> {
    let mut slot = state.recording.lock().map_err(|e| e.to_string())?;
    let rec = slot.as_mut().ok_or("Nothing is recording.")?;
    if let Some(mut child) = rec.child.take() {
        stop_child(&mut child);
        rec.clock.lock().unwrap().pause();
        let elapsed = rec.clock.lock().unwrap().elapsed().as_millis() as u64;
        let _ = app.emit("rec-state", RecState { status: "paused", elapsed_ms: elapsed });
        Ok("paused")
    } else {
        spawn_segment(app, rec)?;
        rec.clock.lock().unwrap().resume();
        Ok("recording")
    }
}

#[tauri::command]
pub async fn rec_stop(app: AppHandle, state: State<'_, AppState>) -> Result<Option<RecFinished>, String> {
    stop(&app, &state)
}

/// Stops the recording (from the UI, the HUD, a hotkey or the tray) and
/// emits `rec-finished` so the library can import it.
pub fn stop(app: &AppHandle, state: &AppState) -> Result<Option<RecFinished>, String> {
    let rec = state.recording.lock().map_err(|e| e.to_string())?.take();
    let Some(mut rec) = rec else { return Ok(None) };
    if let Some(mut child) = rec.child.take() {
        stop_child(&mut child);
    }
    rec.clock.lock().unwrap().pause();
    rec.stop_flag.store(true, Ordering::Relaxed);
    let duration_ms = rec.clock.lock().unwrap().elapsed().as_millis() as u64;

    let samples = std::mem::take(&mut *rec.cursor.lock().unwrap());
    let cursor_file = if samples.is_empty() {
        None
    } else {
        let path = rec.folder.join("cursor.json");
        let json = serde_json::json!({ "version": 1, "samples": samples });
        std::fs::write(&path, json.to_string()).ok().map(|_| path.to_string_lossy().into_owned())
    };
    for n in 1..=rec.segments.len() {
        let log = rec.folder.join(format!("segment-{n:03}.log"));
        let _ = std::fs::remove_file(log);
    }

    windows::close_hud(app);
    tray::set_recording(app, None);
    let done = RecFinished {
        folder: rec.folder.to_string_lossy().into_owned(),
        segments: rec.segments.iter().map(|s| s.to_string_lossy().into_owned()).collect(),
        cursor_file,
        started_at_ms: rec.started_at_ms,
        duration_ms,
    };
    let _ = app.emit("rec-finished", done.clone());
    Ok(Some(done))
}

#[tauri::command]
pub fn rec_status(state: State<'_, AppState>) -> RecState {
    match state.recording.lock().ok().as_ref().and_then(|s| s.as_ref()) {
        Some(rec) => {
            let c = rec.clock.lock().unwrap();
            RecState { status: if c.running_since.is_some() { "recording" } else { "paused" }, elapsed_ms: c.elapsed().as_millis() as u64 }
        }
        None => RecState { status: "idle", elapsed_ms: 0 },
    }
}

#[cfg(test)]
mod tests {
    use super::Clock;
    use std::time::Duration;

    #[test]
    fn clock_excludes_paused_time() {
        let mut c = Clock::default();
        c.resume();
        std::thread::sleep(Duration::from_millis(30));
        c.pause();
        let paused_at = c.elapsed();
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(c.elapsed(), paused_at);
        c.resume();
        std::thread::sleep(Duration::from_millis(10));
        assert!(c.elapsed() > paused_at);
    }
}
