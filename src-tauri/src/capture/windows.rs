//! Safelight's extra windows: the recording HUD and the region picker.
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const HUD_W: f64 = 320.0;
const HUD_H: f64 = 60.0;

pub fn show_hud(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("hud") {
        return w.show();
    }
    let (x, y) = match app.primary_monitor()? {
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            (pos.x + (size.width - HUD_W) / 2.0, pos.y + 12.0)
        }
        None => (200.0, 12.0),
    };
    WebviewWindowBuilder::new(app, "hud", WebviewUrl::App("index.html?view=hud".into()))
        .title("Safelight recording")
        .inner_size(HUD_W, HUD_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        // Keeps the HUD out of the recording itself (Windows 10 2004+).
        .content_protected(true)
        .build()?;
    Ok(())
}

pub fn close_hud(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("hud") {
        let _ = w.destroy();
    }
}

/// The bounding box of every monitor combined, i.e. the whole virtual desktop.
fn virtual_desktop_bounds(app: &AppHandle) -> Result<(i32, i32, i32, i32), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for m in &monitors {
        let (p, s) = (m.position(), m.size());
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x + s.width as i32);
        y1 = y1.max(p.y + s.height as i32);
    }
    if monitors.is_empty() {
        (x0, y0, x1, y1) = (0, 0, 1920, 1080);
    }
    Ok((x0, y0, x1, y1))
}

/// Opens a full-desktop overlay where the user drags a region.
/// `purpose` is echoed back with the `region-selected` event.
#[tauri::command]
pub async fn open_region_picker(app: AppHandle, purpose: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("region") {
        let _ = w.destroy();
    }
    let (x0, y0, x1, y1) = virtual_desktop_bounds(&app)?;
    let purpose: String = purpose.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let w = WebviewWindowBuilder::new(&app, "region", WebviewUrl::App(format!("index.html?view=region&purpose={purpose}").into()))
        .title("Safelight select region")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(x0, y0)).map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new((x1 - x0) as u32, (y1 - y0) as u32)).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Briefly flashes the whole virtual desktop white: feedback that a
/// screenshot was taken, visible even when Safelight's own window is hidden.
/// Non-interactive (clicks pass through) and closes itself.
#[tauri::command]
pub async fn flash_screen(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("flash") {
        let _ = w.destroy();
    }
    let (x0, y0, x1, y1) = virtual_desktop_bounds(&app)?;
    let w = WebviewWindowBuilder::new(&app, "flash", WebviewUrl::App("index.html?view=flash".into()))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(x0, y0)).map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new((x1 - x0).max(1) as u32, (y1 - y0).max(1) as u32)).map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true);
    w.show().map_err(|e| e.to_string())?;
    // The flash window has no close button; it closes itself once the CSS fade finishes.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(280));
        let _ = w.destroy();
    });
    Ok(())
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
