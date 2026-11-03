//! Runs ffmpeg, ffprobe and whisper.cpp as child processes.
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::CaptureState as AppState;

#[derive(Serialize)]
pub struct ToolResult {
    code: i32,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolLine {
    job_id: String,
    line: String,
}

/// A Command that never flashes a console window on Windows.
pub fn command(bin: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Makes gdigrab capture real pixels on scaled (high-DPI) displays.
        cmd.env("__COMPAT_LAYER", "HighDpiAware");
    }
    cmd
}

pub fn binary_for(state: &AppState, tool: &str) -> Result<Option<String>, String> {
    let cfg = state.config.lock().map_err(|e| e.to_string())?;
    Ok(match tool {
        "ffmpeg" => Some(cfg.ffmpeg.clone()),
        "ffprobe" => Some(cfg.ffprobe.clone()),
        "whisper" => cfg.whisper_bin.clone(),
        other => return Err(format!("Unknown tool: {other}")),
    })
}

const MAX_CAPTURE: usize = 256 * 1024;

fn keep_tail(s: &mut String) {
    if s.len() > MAX_CAPTURE {
        let mut cut = s.len() - MAX_CAPTURE;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

#[tauri::command]
pub async fn run_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
    args: Vec<String>,
    cwd: Option<String>,
    job_id: Option<String>,
) -> Result<ToolResult, String> {
    let Some(bin) = binary_for(&state, &tool)? else {
        return Ok(ToolResult { code: 127, stdout: String::new(), stderr: format!("program not found: {tool}") });
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&bin);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            cmd.current_dir(dir);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ToolResult { code: 127, stdout: String::new(), stderr: format!("program not found: {tool} ({bin})") })
            }
            Err(e) => return Err(format!("Couldn't start {tool}: {e}")),
        };
        let mut stderr_pipe = child.stderr.take().expect("stderr piped");
        let stderr_thread = std::thread::spawn(move || {
            let mut buf = String::new();
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stderr_pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                keep_tail(&mut buf);
            }
            buf
        });
        let mut stdout = String::new();
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(id) = &job_id {
                    let _ = app.emit("tool-line", ToolLine { job_id: id.clone(), line: line.clone() });
                }
                stdout.push_str(&line);
                stdout.push('\n');
                keep_tail(&mut stdout);
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr = stderr_thread.join().unwrap_or_default();
        Ok(ToolResult { code: status.code().unwrap_or(1), stdout, stderr })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tool_available(state: State<'_, AppState>, tool: String) -> Result<bool, String> {
    let Some(bin) = binary_for(&state, &tool)? else { return Ok(false) };
    let probe_arg = if tool == "whisper" { "--help" } else { "-version" };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        command(&bin).arg(probe_arg).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()
    })
    .await
    .unwrap_or(false))
}
