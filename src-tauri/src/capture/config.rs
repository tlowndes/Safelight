//! Where captures live and where the tools are. Values can be overridden in a `.env` file
//! next to the app (or in the project folder when developing).
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Captures folder: Screenshots, Recordings and Exports. Scanned into the library.
    pub data_dir: PathBuf,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub whisper_bin: Option<String>,
    pub whisper_model: Option<PathBuf>,
    pub platform: &'static str,
    pub version: String,
}

pub fn load_env() {
    let _ = dotenvy::dotenv();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = dotenvy::from_path(dir.join(".env"));
        }
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

pub fn resolve(app: &AppHandle) -> AppConfig {
    let data_dir = env_value("SAFELIGHT_CAPTURE_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().picture_dir().ok().map(|p| p.join("Safelight Captures")))
        .or_else(|| app.path().home_dir().ok().map(|h| h.join("Pictures").join("Safelight Captures")))
        .unwrap_or_else(|| PathBuf::from("Safelight Captures"));

    // Transcription tools live in the app's own data folder, never in the captures folder.
    let tools_dir = app.path().app_data_dir().unwrap_or_else(|_| data_dir.clone());
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let whisper_bin = env_value("SAFELIGHT_WHISPER_BIN").or_else(|| {
        first_existing(&[tools_dir.join("whisper").join(format!("whisper-cli{exe}"))]).map(|p| p.to_string_lossy().into_owned())
    });
    let whisper_model = env_value("SAFELIGHT_WHISPER_MODEL")
        .map(PathBuf::from)
        .or_else(|| first_existing(&[tools_dir.join("models").join("ggml-base.bin")]));

    AppConfig {
        ffmpeg: env_value("SAFELIGHT_FFMPEG").unwrap_or_else(|| "ffmpeg".into()),
        ffprobe: env_value("SAFELIGHT_FFPROBE").unwrap_or_else(|| "ffprobe".into()),
        whisper_bin,
        whisper_model,
        data_dir,
        platform: if cfg!(windows) { "windows" } else { "other" },
        version: app.package_info().version.to_string(),
    }
}

/// True when `path` is inside `root`. Rejects `..` components outright.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let (r, p) = (norm(root), norm(path));
    p == r || p.starts_with(&format!("{r}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment() {
        let root = Path::new("C:/Users/tom/Pictures/Safelight Captures");
        assert!(is_inside(root, Path::new("c:/users/tom/pictures/safelight captures/Exports/a.mp4")));
        assert!(!is_inside(root, Path::new("C:/Users/tom/Pictures/Safelight Captures/../secret.txt")));
        assert!(!is_inside(root, Path::new("C:/Users/tom/Pictures/Safelight CapturesX/a")));
    }
}
