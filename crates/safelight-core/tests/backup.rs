use chrono::{Duration, NaiveDateTime};
use safelight_core::{backup, organise, scan_source, Catalogue};
use std::fs;

fn photo(path: &std::path::Path, seed: u8) {
    image::RgbImage::from_fn(64, 48, |x, y| image::Rgb([x as u8 ^ seed, y as u8, seed])).save(path).unwrap();
}

#[test]
fn weekly_backup_copies_only_new_and_changed_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (src, nas) = (tmp.path().join("photos"), tmp.path().join("nas"));
    fs::create_dir_all(&src).unwrap();
    for i in 0..3 {
        photo(&src.join(format!("IMG_2024061{i}_120000.jpg")), i * 40);
    }
    let cat = Catalogue::open_in_memory().unwrap();
    let s = cat.add_source("Photos", "local", src.to_str().unwrap()).unwrap();
    scan_source(&cat, s, |_| {}).unwrap();

    // No backup folder yet: nothing is due.
    let now = NaiveDateTime::parse_from_str("2026-11-03 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    assert!(!backup::is_due(&cat, now).unwrap());

    // NAS offline: the run refuses rather than writing anywhere else.
    cat.set_setting("backup_root", nas.to_str().unwrap()).unwrap();
    assert!(backup::is_due(&cat, now).unwrap());
    assert!(backup::run_backup(&cat, true, |_| {}).is_err());
    assert!(!nas.exists());

    fs::create_dir_all(&nas).unwrap();
    let st = backup::status(&cat).unwrap();
    assert!(st.reachable && st.weekly);
    assert_eq!(st.waiting, 3);

    let r = backup::run_backup(&cat, true, |_| {}).unwrap();
    assert_eq!((r.backed_up, r.skipped, r.errors.len()), (3, 0, 0));
    assert_eq!(backup::status(&cat).unwrap().waiting, 0);
    // Just ran, so not due for another week.
    let last = NaiveDateTime::parse_from_str(&r.finished_at, "%Y-%m-%d %H:%M:%S").unwrap();
    assert!(!backup::is_due(&cat, last + Duration::days(6)).unwrap());
    assert!(backup::is_due(&cat, last + Duration::days(7)).unwrap());

    // Second run: nothing new, nothing re-copied.
    let r = backup::run_backup(&cat, true, |_| {}).unwrap();
    assert_eq!((r.backed_up, r.skipped), (0, 3));

    // One new photo and one edited original: both copied, and the old version is kept.
    photo(&src.join("IMG_20240620_120000.jpg"), 200);
    let edited = src.join("IMG_20240610_120000.jpg");
    photo(&edited, 99);
    scan_source(&cat, s, |_| {}).unwrap();
    let r = backup::run_backup(&cat, false, |_| {}).unwrap();
    assert_eq!((r.backed_up, r.errors.len()), (2, 0), "{:?}", r.errors);
    let files: Vec<_> = walk(&nas);
    assert_eq!(files.len(), 5, "{files:?}");
    assert!(files.iter().any(|f| f.contains("(2)")));

    // A file removed from the NAS by hand is copied again next time.
    fs::remove_file(nas.join(&files[0])).unwrap();
    let r = backup::run_backup(&cat, true, |_| {}).unwrap();
    assert_eq!(r.backed_up, 1);

    // Turning the weekly backup off stops it being due.
    cat.set_setting("auto_backup", "0").unwrap();
    assert!(!backup::is_due(&cat, now + Duration::days(30)).unwrap());

    // The library copy still works after a backup-only run.
    let lib = tmp.path().join("lib");
    fs::create_dir_all(&lib).unwrap();
    cat.set_setting("library_root", lib.to_str().unwrap()).unwrap();
    let c = organise::run_copy(&cat, |_| {}).unwrap();
    assert_eq!((c.copied, c.backed_up, c.errors.len()), (4, 0, 0), "{:?}", c.errors);
}

fn walk(dir: &std::path::Path) -> Vec<String> {
    let mut out = vec![];
    for e in walkdir(dir) {
        out.push(e.strip_prefix(dir).unwrap().to_string_lossy().to_string());
    }
    out.sort();
    out
}

fn walkdir(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut v = vec![];
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() { v.extend(walkdir(&p)); } else { v.push(p); }
    }
    v
}
