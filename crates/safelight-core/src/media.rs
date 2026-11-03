use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Photo,
    Video,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Photo => "photo",
            Kind::Video => "video",
        }
    }
    pub fn from_str(s: &str) -> Kind {
        if s == "video" { Kind::Video } else { Kind::Photo }
    }
}

const PHOTO: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "tif", "tiff", "bmp", "dng", "cr2", "cr3",
    "nef", "arw", "raf", "orf", "rw2",
];
const VIDEO: &[&str] = &["mp4", "mov", "m4v", "avi", "mkv", "3gp", "mts", "m2ts", "wmv", "webm"];

/// Classify a file by extension. Returns None for anything that isn't a photo or video.
pub fn classify(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if PHOTO.contains(&ext.as_str()) {
        Some(Kind::Photo)
    } else if VIDEO.contains(&ext.as_str()) {
        Some(Kind::Video)
    } else {
        None
    }
}

/// Files and folders we never want to pick up (sync clutter, thumbnails, system files, and
/// the working files capture keeps beside a recording: its poster frames and the segments of a
/// recording still in progress).
pub fn is_ignored(path: &Path) -> bool {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name == "poster.jpg" || name.ends_with(".poster.jpg") || (name.starts_with("segment-") && name.ends_with(".mkv")) {
            return true;
        }
    }
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.')
            || s.eq_ignore_ascii_case("@eaDir")
            || s.eq_ignore_ascii_case("#recycle")
            || s.eq_ignore_ascii_case("$RECYCLE.BIN")
            || s.eq_ignore_ascii_case("Thumbs.db")
            // Where Safelight puts spare copies and cleaned-up files; never re-import them.
            || s.eq_ignore_ascii_case("Safelight bin")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_by_extension() {
        assert_eq!(classify(Path::new("a/IMG_1.HEIC")), Some(Kind::Photo));
        assert_eq!(classify(Path::new("clip.MOV")), Some(Kind::Video));
        assert_eq!(classify(Path::new("notes.txt")), None);
        assert_eq!(classify(Path::new("noext")), None);
    }
    #[test]
    fn ignores_clutter() {
        assert!(is_ignored(Path::new("photos/@eaDir/x.jpg")));
        assert!(is_ignored(Path::new("photos/.trash/x.jpg")));
        assert!(is_ignored(Path::new("Safelight bin/2026-11-03/x.jpg")));
        assert!(!is_ignored(Path::new("photos/2024/x.jpg")));
        assert!(is_ignored(Path::new("Recordings/2026-11-03 17-00-00/poster.jpg")));
        assert!(is_ignored(Path::new("Recordings/2026-11-03 17-00-00/segment-001.mkv")));
        assert!(is_ignored(Path::new("Exports/demo/demo.poster.jpg")));
        assert!(!is_ignored(Path::new("Exports/demo/demo.mp4")));
    }
}
