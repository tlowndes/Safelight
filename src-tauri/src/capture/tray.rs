//! System tray: always reachable Stop, plus quick capture actions.
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use super::{recorder, windows, CaptureState as AppState};

const IDLE_ICON: &[u8] = include_bytes!("../../icons/tray.png");
const REC_ICON: &[u8] = include_bytes!("../../icons/tray-recording.png");

pub struct TrayItems {
    stop: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let stop = MenuItem::with_id(app, "stop", "Stop recording\tCtrl+Shift+2", false, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause recording\tCtrl+Shift+P", false, None::<&str>)?;
    let shot_region = MenuItem::with_id(app, "screenshot-region", "Screenshot region\tCtrl+Shift+4", true, None::<&str>)?;
    let shot_screen = MenuItem::with_id(app, "screenshot-screen", "Screenshot screen\tCtrl+Shift+3", true, None::<&str>)?;
    let record = MenuItem::with_id(app, "record", "Record…\tCtrl+Shift+5", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open library", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Safelight", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&stop, &pause, &sep()?, &shot_region, &shot_screen, &record, &sep()?, &open, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(IDLE_ICON)?)
        .tooltip("Safelight")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let state = app.state::<AppState>();
            match event.id().as_ref() {
                "stop" => {
                    let _ = recorder::stop(app, &state);
                }
                "pause" => {
                    let _ = recorder::toggle_pause(app, &state);
                }
                "open" => windows::show_main(app),
                "quit" => {
                    let _ = recorder::stop(app, &state);
                    app.exit(0);
                }
                action => {
                    // Capture actions are handled by the UI, same as hotkeys.
                    let _ = app.emit("hotkey", action.to_string());
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                windows::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayItems { stop, pause });
    Ok(())
}

/// Updates icon, tooltip and menu. `None` means idle.
pub fn set_recording(app: &AppHandle, rec: Option<(&str, u64)>) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let items = app.state::<TrayItems>();
    match rec {
        Some((status, ms)) => {
            let s = ms / 1000;
            let label = if status == "paused" { "paused" } else { "recording" };
            let _ = tray.set_tooltip(Some(format!("Safelight: {label} {:02}:{:02}", s / 60, s % 60)));
            let _ = tray.set_icon(Image::from_bytes(REC_ICON).ok());
            let _ = items.stop.set_enabled(true);
            let _ = items.pause.set_enabled(true);
            let _ = items.pause.set_text(if status == "paused" { "Resume recording\tCtrl+Shift+P" } else { "Pause recording\tCtrl+Shift+P" });
        }
        None => {
            let _ = tray.set_tooltip(Some("Safelight"));
            let _ = tray.set_icon(Image::from_bytes(IDLE_ICON).ok());
            let _ = items.stop.set_enabled(false);
            let _ = items.pause.set_enabled(false);
            let _ = items.pause.set_text("Pause recording\tCtrl+Shift+P");
        }
    }
}
