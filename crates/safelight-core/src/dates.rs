//! Working out when a photo or video was taken.
//! Order of trust: camera data (EXIF) > Google Takeout JSON > file name > file modified time.

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use std::{fs, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateSource {
    Exif,
    Takeout,
    FileName,
    Modified,
}

impl DateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DateSource::Exif => "exif",
            DateSource::Takeout => "takeout",
            DateSource::FileName => "filename",
            DateSource::Modified => "modified",
        }
    }
}

/// Capture time as a naive local timestamp "YYYY-MM-DD HH:MM:SS", plus where it came from.
pub fn taken_at(path: &Path, modified: Option<std::time::SystemTime>) -> Option<(NaiveDateTime, DateSource)> {
    if let Some(d) = from_exif(path) {
        return Some((d, DateSource::Exif));
    }
    fallback_date(path, modified)
}

/// Every date source except EXIF, for callers that have already read the camera data.
pub fn fallback_date(path: &Path, modified: Option<std::time::SystemTime>) -> Option<(NaiveDateTime, DateSource)> {
    if let Some(d) = from_takeout_json(path) {
        return Some((d, DateSource::Takeout));
    }
    if let Some(d) = path.file_name().and_then(|n| n.to_str()).and_then(from_file_name) {
        return Some((d, DateSource::FileName));
    }
    modified.map(|m| (DateTime::<Utc>::from(m).naive_utc(), DateSource::Modified))
}

/// What we read from a file's camera data in one pass.
#[derive(Debug, Clone, Default)]
pub struct ExifInfo {
    pub taken: Option<NaiveDateTime>,
    /// Camera make or model present: a strong sign this is a real photo, not a screenshot or download.
    pub has_camera: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub fn read_exif(path: &Path) -> Option<ExifInfo> {
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let ex = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let mut info = ExifInfo::default();
    for tag in [exif::Tag::DateTimeOriginal, exif::Tag::DateTimeDigitized, exif::Tag::DateTime] {
        if let Some(f) = ex.get_field(tag, exif::In::PRIMARY) {
            if let exif::Value::Ascii(ref v) = f.value {
                if let Some(raw) = v.first() {
                    let s = String::from_utf8_lossy(raw);
                    if let Ok(d) = NaiveDateTime::parse_from_str(s.trim(), "%Y:%m:%d %H:%M:%S") {
                        info.taken = Some(d);
                        break;
                    }
                }
            }
        }
    }
    info.has_camera = [exif::Tag::Make, exif::Tag::Model]
        .iter()
        .any(|t| ex.get_field(*t, exif::In::PRIMARY).map(|f| !f.display_value().to_string().trim_matches('"').trim().is_empty()).unwrap_or(false));
    let dim = |t| ex.get_field(t, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0));
    info.width = dim(exif::Tag::PixelXDimension).or_else(|| dim(exif::Tag::ImageWidth));
    info.height = dim(exif::Tag::PixelYDimension).or_else(|| dim(exif::Tag::ImageLength));
    Some(info)
}

fn from_exif(path: &Path) -> Option<NaiveDateTime> {
    read_exif(path)?.taken
}

/// Google Takeout writes `photo.jpg.json` (sometimes `photo.jpg.supplemental-metadata.json`
/// or `photo.json`) next to each file. Returns that sidecar, parsed, if there is one.
pub fn takeout_sidecar(path: &Path) -> Option<serde_json::Value> {
    let name = path.file_name()?.to_str()?;
    let dir = path.parent()?;
    let stem = path.file_stem()?.to_str()?;
    let candidates = [
        format!("{name}.json"),
        format!("{name}.supplemental-metadata.json"),
        format!("{stem}.json"),
    ];
    candidates
        .iter()
        .filter_map(|c| fs::read_to_string(dir.join(c)).ok())
        .find_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
}

/// Takeout's `photoTakenTime.timestamp` is in Unix seconds.
fn from_takeout_json(path: &Path) -> Option<NaiveDateTime> {
    let v = takeout_sidecar(path)?;
    let ts = v["photoTakenTime"]["timestamp"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .or_else(|| v["photoTakenTime"]["timestamp"].as_i64())?;
    DateTime::from_timestamp(ts, 0).map(|d| d.naive_utc())
}

/// Recognises common phone and camera naming patterns, e.g.
/// `IMG_20240614_183205.jpg`, `20240614_183205.mp4`, `PXL_20240614_183205123.jpg`,
/// `2024-06-14 18.32.05.jpg`, `Screenshot 2024-06-14 at 18.32.05.png`, `WhatsApp Image 2024-06-14 at 18.32.05.jpeg`.
pub fn from_file_name(name: &str) -> Option<NaiveDateTime> {
    // Gather runs of digits separated by at most one non-digit character.
    let chars: Vec<char> = name.chars().collect();
    let mut groups: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut gap = 0;
    for &c in &chars {
        if c.is_ascii_digit() {
            cur.push(c);
            gap = 0;
        } else if !cur.is_empty() {
            gap += 1;
            if gap > 4 {
                groups.push(std::mem::take(&mut cur));
                gap = 0;
            }
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    for g in groups {
        if g.len() < 8 {
            continue;
        }
        let (y, m, d) = (&g[0..4], &g[4..6], &g[6..8]);
        let (Ok(y), Ok(m), Ok(d)) = (y.parse::<i32>(), m.parse::<u32>(), d.parse::<u32>()) else { continue };
        if !(1990..=2100).contains(&y) {
            continue;
        }
        let Some(date) = NaiveDate::from_ymd_opt(y, m, d) else { continue };
        let (hh, mm, ss) = if g.len() >= 14 {
            (g[8..10].parse().unwrap_or(0), g[10..12].parse().unwrap_or(0), g[12..14].parse().unwrap_or(0))
        } else {
            (0, 0, 0)
        };
        if let Some(dt) = date.and_hms_opt(hh, mm, ss) {
            return Some(dt);
        }
        return date.and_hms_opt(0, 0, 0);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }
    #[test]
    fn parses_common_file_names() {
        assert_eq!(from_file_name("IMG_20240614_183205.jpg"), Some(dt("2024-06-14 18:32:05")));
        assert_eq!(from_file_name("PXL_20240614_183205123.jpg"), Some(dt("2024-06-14 18:32:05")));
        assert_eq!(from_file_name("2024-06-14 18.32.05.jpg"), Some(dt("2024-06-14 18:32:05")));
        assert_eq!(from_file_name("Screenshot 2024-06-14 at 18.32.05.png"), Some(dt("2024-06-14 18:32:05")));
        assert_eq!(from_file_name("WhatsApp Image 2024-06-14 at 18.32.05.jpeg"), Some(dt("2024-06-14 18:32:05")));
        assert_eq!(from_file_name("VID-20240614-WA0003.mp4"), Some(dt("2024-06-14 00:00:00")));
        assert_eq!(from_file_name("holiday.jpg"), None);
        assert_eq!(from_file_name("IMG_4021.HEIC"), None);
    }
}
