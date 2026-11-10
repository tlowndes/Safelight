//! One-off download of the smart tagging models into the app's data folder. Only the model
//! files come down; nothing about your photos goes up.

use safelight_core::ai::{missing_models, ModelFile};
use serde::Serialize;
use std::{
    io::{Read, Write},
    path::Path,
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
    current: String,
}

/// Only these hosts are trusted for model files.
const HOSTS: &[&str] = &["https://huggingface.co/", "https://github.com/opencv/opencv_zoo/", "https://github.com/danielgatis/rembg/releases/"];

pub fn download(app: &AppHandle, dir: &Path) -> Result<(), String> {
    download_files(app, dir, missing_models(dir))
}

/// The subject model for Select subject masks, if it isn't here yet.
pub fn download_subject(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let m = safelight_core::segment::SUBJECT_MODEL;
    if dir.join(m.file).is_file() {
        return Ok(());
    }
    download_files(app, dir, vec![m])
}

fn download_files(app: &AppHandle, dir: &Path, todo: Vec<ModelFile>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let total: u64 = todo.iter().map(|m| m.size_mb as u64 * 1_000_000).sum();
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(15)).redirects(8).build();
    let mut done_before = 0u64;
    for m in todo {
        if !HOSTS.iter().any(|h| m.url.starts_with(h)) {
            return Err(format!("Refusing to download {} from an unknown site", m.file));
        }
        let resp = agent
            .get(m.url)
            .set("User-Agent", "Safelight")
            .call()
            .map_err(|e| format!("Couldn't download {}: {e}", m.purpose.to_lowercase()))?;
        let expected: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
        let part = dir.join(format!("{}.part", m.file));
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut reader = resp.into_reader();
        let mut buf = vec![0u8; 256 * 1024];
        let mut got = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("Download was interrupted: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            if got % (2 << 20) < n as u64 {
                let _ = app.emit("model-progress", Progress { done: (done_before + got).min(total), total, current: m.purpose.to_string() });
            }
        }
        drop(file);
        if expected > 0 && got != expected {
            let _ = std::fs::remove_file(&part);
            return Err("Download was cut short, try again".into());
        }
        if let Some(want) = m.sha256 {
            let have = safelight_core::hash::sha256_file(&part).map_err(|e| e.to_string())?;
            if have != want {
                let _ = std::fs::remove_file(&part);
                return Err(format!("{} didn't match its fingerprint, so it wasn't used", m.file));
            }
        }
        std::fs::rename(&part, dir.join(m.file)).map_err(|e| e.to_string())?;
        done_before += m.size_mb as u64 * 1_000_000;
    }
    let _ = app.emit("model-progress", Progress { done: total, total, current: String::new() });
    Ok(())
}
