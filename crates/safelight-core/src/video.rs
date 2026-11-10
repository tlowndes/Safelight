//! Video frames and playable copies through ffmpeg, for clips Windows and the webview can't
//! open themselves (HEVC .mov from iPhones, older QuickTime, AVI, MKV and so on).
//! The original is only ever read.

use image::DynamicImage;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Where to find ffmpeg: `SAFELIGHT_FFMPEG`, then the folder winget links it into (so a fresh
/// `winget install Gyan.FFmpeg` works before the next sign-in refreshes PATH), then PATH.
pub fn ffmpeg_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("SAFELIGHT_FFMPEG").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let linked = Path::new(&local).join("Microsoft").join("WinGet").join("Links").join("ffmpeg.exe");
            if linked.exists() {
                return linked;
            }
        }
    }
    PathBuf::from("ffmpeg")
}

fn command() -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(ffmpeg_bin());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// One frame about a second in (the very first is often black), at most `max` pixels on the
/// long edge. Very short clips fall back to the first frame.
pub fn frame(path: &Path, max: u32) -> Option<DynamicImage> {
    ["1", "0"].iter().find_map(|at| grab(path, at, max))
}

fn grab(path: &Path, at: &str, max: u32) -> Option<DynamicImage> {
    let scale = format!("scale='min({max},iw)':'min({max},ih)':force_original_aspect_ratio=decrease");
    let out = command()
        .args(["-hide_banner", "-loglevel", "error", "-ss", at, "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", &scale, "-f", "image2pipe", "-vcodec", "png", "-"])
        .stdout(Stdio::piped())
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }
    image::load_from_memory_with_format(&out.stdout, image::ImageFormat::Png).ok()
}

/// Make an H.264/AAC MP4 copy of `src` at `out` that the webview can play. Written to a temp
/// name first so a half-finished copy is never served.
pub fn playable_copy(src: &Path, out: &Path) -> std::result::Result<(), String> {
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = out.with_extension("part.mp4");
    let status = command()
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args([
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
            "-vf", "scale='min(1920,iw)':-2",
            "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart",
        ])
        .arg(&tmp)
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Playing this video needs ffmpeg. Install it with: winget install Gyan.FFmpeg".to_string()
            } else {
                format!("Couldn't start ffmpeg: {e}")
            }
        })?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err("ffmpeg couldn't convert this video".into());
    }
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn have_ffmpeg() -> bool {
        command().arg("-version").stdout(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }

    #[test]
    fn frame_and_copy_from_a_mov() {
        if !have_ffmpeg() {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mov = dir.path().join("clip.MOV");
        let ok = command()
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=2", "-c:v", "mpeg4", "-f", "mov"])
            .arg(&mov)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let img = frame(&mov, 320).expect("frame");
        assert_eq!((img.width(), img.height()), (320, 180));
        let out = dir.path().join("play").join("clip.mp4");
        playable_copy(&mov, &out).unwrap();
        assert!(out.metadata().unwrap().len() > 1000);
    }
}
