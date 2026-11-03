//! Global keyboard shortcuts. The UI owns the bindings (stored in settings)
//! and calls `set_hotkeys`; presses are emitted as `hotkey` events, except
//! Stop and Pause which act immediately so they work whatever the UI is doing.
use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::{recorder, CaptureState as AppState};

#[derive(Serialize)]
pub struct HotkeyFailure {
    action: String,
    accelerator: String,
    reason: String,
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let state = app.state::<AppState>();
            let action = state.hotkeys.lock().ok().and_then(|m| m.get(&shortcut.id()).cloned());
            match action.as_deref() {
                Some("stop") => {
                    let _ = recorder::stop(app, &state);
                }
                Some("pause") => {
                    let _ = recorder::toggle_pause(app, &state);
                }
                Some(other) => {
                    let _ = app.emit("hotkey", other.to_string());
                }
                None => {}
            }
        })
        .build()
}

#[tauri::command]
pub fn set_hotkeys(app: AppHandle, state: State<'_, AppState>, bindings: HashMap<String, String>) -> Vec<HotkeyFailure> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = HashMap::new();
    let mut failures = Vec::new();
    for (action, accelerator) in bindings {
        if accelerator.trim().is_empty() {
            continue;
        }
        let result = accelerator
            .parse::<Shortcut>()
            .map_err(|e| format!("Not a valid shortcut: {e}"))
            .and_then(|sc| {
                gs.register(sc).map_err(|_| "Another app is already using this shortcut.".to_string())?;
                Ok(sc)
            });
        match result {
            Ok(sc) => {
                map.insert(sc.id(), action);
            }
            Err(reason) => failures.push(HotkeyFailure { action, accelerator, reason }),
        }
    }
    if let Ok(mut m) = state.hotkeys.lock() {
        *m = map;
    }
    failures
}
