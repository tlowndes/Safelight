//! Reads the text in a screenshot with the OCR engine built into Windows, so nothing leaves the PC.
//! Elsewhere (the Linux tests) there's no OCR, so it finds no text.

use std::path::Path;

/// The PowerShell script that calls Windows.Media.Ocr (ported from Snapsort).
pub const SCRIPT: &str = include_str!("../assets/ocr.ps1");

pub fn is_available() -> bool {
    cfg!(windows)
}

/// The lines of text in an image, top to bottom.
#[cfg(windows)]
pub fn read_text(image: &Path) -> Result<Vec<String>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = std::env::temp_dir().join("safelight-ocr-v1.ps1");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
        std::fs::write(&script, SCRIPT).map_err(|e| format!("OCR couldn't start: {e}"))?;
    }
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-Path")
        .arg(image)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("OCR couldn't start: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("OCR failed: {}", err.lines().find(|l| !l.trim().is_empty()).unwrap_or("unknown error").trim()));
    }
    parse_output(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(windows))]
pub fn read_text(_image: &Path) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// Reads the script's `{"lines":[...]}` output. PowerShell prints a single line as a bare string.
pub fn parse_output(stdout: &str) -> Result<Vec<String>, String> {
    let s = stdout.trim().trim_start_matches('\u{feff}');
    if s.is_empty() {
        return Ok(Vec::new());
    }
    let v: serde_json::Value = serde_json::from_str(s).map_err(|_| "OCR returned something unreadable".to_string())?;
    Ok(match &v["lines"] {
        serde_json::Value::Array(a) => a.iter().filter_map(|l| l.as_str().map(String::from)).collect(),
        serde_json::Value::String(one) => vec![one.clone()],
        _ => Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_script_output() {
        assert_eq!(super::parse_output("{\"lines\":[\"Figma\",\"Layers\"]}\r\n").unwrap(), vec!["Figma", "Layers"]);
        assert_eq!(super::parse_output("{\"lines\":\"Only one\"}").unwrap(), vec!["Only one"]);
        assert!(super::parse_output("").unwrap().is_empty());
        assert!(super::parse_output("oops").is_err());
    }
}
