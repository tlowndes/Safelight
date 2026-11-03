//! Windows-specific helpers: window list and cursor position.
//! Other platforms get empty results so the app still runs (for development).
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct WindowInfo {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[cfg(windows)]
mod imp {
    use super::WindowInfo;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetCursorPos, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible,
    };

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam as *mut Vec<WindowInfo>);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        let mut cloaked: u32 = 0;
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, &mut cloaked as *mut _ as *mut _, 4);
        if cloaked != 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return 1;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) == 0 {
            return 1;
        }
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w >= 50 && h >= 50 && !title.trim().is_empty() && title != "Program Manager" && !title.starts_with("Safelight") {
            out.push(WindowInfo { title, x: r.left, y: r.top, w, h });
        }
        1
    }

    pub fn list_windows() -> Vec<WindowInfo> {
        let mut out: Vec<WindowInfo> = Vec::new();
        unsafe { EnumWindows(Some(collect), &mut out as *mut _ as LPARAM) };
        out
    }

    pub fn cursor_pos() -> Option<(i32, i32)> {
        let mut p = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::WindowInfo;
    pub fn list_windows() -> Vec<WindowInfo> {
        Vec::new()
    }
    pub fn cursor_pos() -> Option<(i32, i32)> {
        None
    }
}

pub use imp::cursor_pos;

#[tauri::command]
pub fn list_windows() -> Vec<WindowInfo> {
    imp::list_windows()
}
