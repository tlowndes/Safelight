use safelight_core::{scan_source, Catalogue};
use std::fs;

#[test]
fn scans_dates_and_finds_exact_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("2024")).unwrap();
    fs::create_dir_all(root.join("@eaDir")).unwrap();
    fs::write(root.join("2024/IMG_20240614_183205.jpg"), b"same bytes").unwrap();
    fs::write(root.join("copy of holiday.jpg"), b"same bytes").unwrap();
    fs::write(root.join("takeout.jpg"), b"different").unwrap();
    fs::write(root.join("takeout.jpg.json"), r#"{"photoTakenTime":{"timestamp":"1718389925"}}"#).unwrap();
    fs::write(root.join("clip.MOV"), b"video").unwrap();
    fs::write(root.join("notes.txt"), b"not media").unwrap();
    fs::write(root.join("@eaDir/thumb.jpg"), b"nas thumbnail").unwrap();

    let cat = Catalogue::open_in_memory().unwrap();
    let id = cat.add_source("NAS", "nas", root.to_str().unwrap()).unwrap();
    let report = scan_source(&cat, id, |_| {}).unwrap();
    assert_eq!(report.found, 4, "{report:?}");
    assert_eq!(report.added, 4);

    let stats = cat.stats().unwrap();
    assert_eq!(stats.photos, 3);
    assert_eq!(stats.videos, 1);
    assert_eq!(stats.exact_duplicate_groups, 1);
    assert_eq!(stats.exact_duplicate_files, 1);

    let lib = cat.library(100).unwrap();
    let all: Vec<_> = lib.iter().flat_map(|g| &g.items).collect();
    let named = all.iter().find(|i| i.path.ends_with("IMG_20240614_183205.jpg")).unwrap();
    assert_eq!(named.taken_at.as_deref(), Some("2024-06-14 18:32:05"));
    assert_eq!(named.date_source.as_deref(), Some("filename"));
    assert!(named.has_exact_duplicate);
    let takeout = all.iter().find(|i| i.path.ends_with("takeout.jpg")).unwrap();
    assert_eq!(takeout.taken_at.as_deref(), Some("2024-06-14 18:32:05"));
    assert_eq!(takeout.date_source.as_deref(), Some("takeout"));

    // Re-scan: nothing re-hashed; a deleted file drops out.
    fs::remove_file(root.join("clip.MOV")).unwrap();
    let again = scan_source(&cat, id, |_| {}).unwrap();
    assert_eq!(again.unchanged, 3);
    assert_eq!(again.removed, 1);
    assert_eq!(cat.sources().unwrap()[0].item_count, 3);
}
