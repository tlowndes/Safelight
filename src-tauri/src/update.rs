//! Updates from GitHub releases. On launch the app asks GitHub for the newest release; if its
//! version is higher, the user can download the installer and Safelight runs it and restarts.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter};

/// The GitHub repository that publishes Safelight's installers.
pub const REPO: &str = "tlowndes/Safelight";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub version: String,
    pub notes: String,
    pub url: String,
    pub size: u64,
    pub page: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    body: Option<String>,
    html_url: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

/// "v0.1.12" or "0.1.12-preview.3" → (0, 1, 12). Anything after a '-' is ignored.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim_start_matches('v').split('-').next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(10)).build()
}

pub fn check(current: &str) -> Result<Option<UpdateInfo>, String> {
    let releases: Vec<Release> = agent()
        .get(&format!("https://api.github.com/repos/{REPO}/releases?per_page=20"))
        .set("User-Agent", "Safelight")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "Can't see Safelight's releases on GitHub (is the repository public?)".to_string(),
            e => format!("Couldn't reach GitHub: {e}"),
        })?
        .into_json()
        .map_err(|e| e.to_string())?;
    let now = parse_version(current).unwrap_or((0, 0, 0));
    let best = releases
        .into_iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let v = parse_version(&r.tag_name)?;
            let asset = r.assets.iter().find(|a| a.name.to_lowercase().ends_with("-setup.exe"))?;
            Some((v, UpdateInfo {
                current: current.to_string(),
                version: format!("{}.{}.{}", v.0, v.1, v.2),
                notes: r.body.clone().unwrap_or_default(),
                url: asset.browser_download_url.clone(),
                size: asset.size,
                page: r.html_url.clone(),
            }))
        })
        .max_by_key(|(v, _)| *v);
    Ok(best.filter(|(v, _)| *v > now).map(|(_, u)| u))
}

#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// Download the installer, start it (passive mode, relaunching Safelight when done) and quit.
pub fn install(app: &AppHandle, url: &str) -> Result<(), String> {
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return Err("Refusing to download an update from outside Safelight's GitHub releases".into());
    }
    let resp = agent().get(url).set("User-Agent", "Safelight").call().map_err(|e| format!("Download failed: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let path = std::env::temp_dir().join("Safelight-update-setup.exe");
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        let _ = app.emit("update-progress", Progress { done, total });
    }
    drop(file);
    if total > 0 && done != total {
        return Err("Download was cut short, try again".into());
    }
    // Tauri's NSIS installer: /P shows a small progress window, /R relaunches the app after.
    std::process::Command::new(&path).args(["/P", "/R"]).spawn().map_err(|e| format!("Couldn't start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_version;
    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.1.12"), Some((0, 1, 12)));
        assert_eq!(parse_version("v0.1.0-preview.8"), Some((0, 1, 0)));
        assert!(parse_version("v0.1.12") > parse_version("0.1.0"));
        assert_eq!(parse_version("nightly"), None);
    }
}
