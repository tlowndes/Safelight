use safelight_core::{cleanup, dupes, imaging, organise, reference, scan_source, Catalogue};
use std::{fs, path::Path};

fn photo(path: &Path, w: u32, h: u32, seed: f32) {
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let r = 127.0 + 127.0 * (fx * (3.0 + seed * 23.0) + seed * 5.0).sin();
        let g = 127.0 + 127.0 * (fy * (2.0 + seed * 17.0)).cos();
        image::Rgb([r as u8, g as u8, ((fx + fy) * 120.0) as u8])
    });
    img.save(path).unwrap();
}

#[test]
fn whole_flow_scan_dedupe_organise_copy_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let (nas, gdrive, lib, backup, cache) =
        (tmp.path().join("nas"), tmp.path().join("gdrive"), tmp.path().join("lib"), tmp.path().join("backup"), tmp.path().join("cache"));
    for d in [&nas, &gdrive, &lib, &backup] {
        fs::create_dir_all(d).unwrap();
    }
    // A trip: 25 photos over two days, plus a resized copy on Google Drive and an exact copy.
    for i in 0..25 {
        let day = if i < 13 { 14 } else { 15 };
        photo(&nas.join(format!("IMG_202406{day}_1{:05}.jpg", i * 3)), 320, 240, 0.1 + i as f32 * 0.03);
    }
    let original = nas.join("IMG_20240614_100000.jpg");
    image::open(&original).unwrap().resize(160, 120, image::imageops::FilterType::Lanczos3)
        .save(gdrive.join("barcelona small.jpg")).unwrap();
    fs::copy(&original, gdrive.join("IMG_20240614_100000.jpg")).unwrap();
    // A screenshot that should be suggested as reference.
    photo(&gdrive.join("Screenshot 2024-03-01 at 10.00.00.png"), 300, 200, 0.9);
    // Some everyday photos in other months so the trip stands out.
    for (m, d) in [(5, 3), (5, 9), (7, 2)] {
        photo(&nas.join(format!("IMG_20240{m}0{d}_120000.jpg")), 300 + d * 7, 240, 0.25 + d as f32 * 0.07);
    }

    let cat = Catalogue::open_in_memory().unwrap();
    cat.set_setting("thumb_cache", cache.to_str().unwrap()).unwrap();
    let s_nas = cat.add_source("NAS", "nas", nas.to_str().unwrap()).unwrap();
    let s_gd = cat.add_source("Google Drive", "gdrive", gdrive.to_str().unwrap()).unwrap();
    scan_source(&cat, s_nas, |_| {}).unwrap();
    scan_source(&cat, s_gd, |_| {}).unwrap();
    imaging::process_thumbnails(&cat, &cache, |_| {}).unwrap();
    let stats = cat.stats().unwrap();
    assert_eq!(stats.exact_duplicate_files, 1);
    assert_eq!(stats.needing_thumbnails, 0);

    // Look-alikes: the resized copy groups with the original; the full-size one is suggested.
    let groups = dupes::lookalike_groups(&cat).unwrap();
    let g = groups.iter().find(|g| g.members.iter().any(|m| m.item.path.ends_with("barcelona small.jpg"))).expect("look-alike group");
    assert!(g.members[g.best].item.path.ends_with("IMG_20240614_100000.jpg"));
    let keep: Vec<i64> = vec![g.members[g.best].item.id];
    let drop: Vec<i64> = g.members.iter().enumerate().filter(|(i, _)| *i != g.best).map(|(_, m)| m.item.id).collect();
    dupes::resolve(&cat, &keep, &drop).unwrap();
    assert!(dupes::lookalike_groups(&cat).unwrap().iter().all(|g| g.key != keep[0].to_string()));

    // Reference suggestion and topics.
    let refs = organise::reference_suggestions(&cat).unwrap();
    assert_eq!(refs.len(), 1);
    organise::set_reference(&cat, &[refs[0].id], true).unwrap();
    let ui = reference::ensure_topic(&cat, "UI").unwrap();
    reference::set_topic(&cat, &[refs[0].id], ui).unwrap();
    reference::add_tag(&cat, &[refs[0].id], "Dark UI").unwrap();
    assert_eq!(reference::items(&cat, Some(ui), Some("Dark UI")).unwrap().len(), 1);

    // Events: the two busy days are suggested; name it.
    let events = organise::suggest_events(&cat).unwrap();
    let trip = events.iter().find(|e| e.start_day == "2024-06-14").expect("trip suggested");
    assert_eq!(trip.end_day, "2024-06-15");
    organise::save_event(&cat, "Barcelona", &trip.start_day, &trip.end_day).unwrap();

    // Copy into the library, mirrored to backup.
    cat.set_setting("library_root", lib.to_str().unwrap()).unwrap();
    cat.set_setting("backup_root", backup.to_str().unwrap()).unwrap();
    let summary = organise::plan_summary(&cat).unwrap();
    assert_eq!(summary.to_copy, 29); // 25 trip + 3 everyday + 1 reference; exact & look-alike copies merged
    let report = organise::run_copy(&cat, |_| {}).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.copied, 29);
    assert!(lib.join("Photos/2024/2024-06 Barcelona/2024-06-14 10.00.00.jpg").exists());
    assert!(backup.join("Photos/2024/2024-06 Barcelona/2024-06-15 10.00.39.jpg").exists());
    assert!(lib.join("Photos/2024/2024-05/2024-05-03 12.00.00.jpg").exists());
    assert!(lib.join("Reference/UI/Screenshot 2024-03-01 at 10.00.00.png").exists());
    // Running again copies nothing.
    assert_eq!(organise::run_copy(&cat, |_| {}).unwrap().copied, 0);

    // Re-scanning a source that contains the library doesn't import the copies.
    let s_lib_parent = cat.add_source("Proton", "proton", tmp.path().to_str().unwrap()).unwrap();
    let r = scan_source(&cat, s_lib_parent, |_| {}).unwrap();
    assert_eq!(r.found, 31, "only the nas + gdrive originals, not lib/backup/cache");
    cat.remove_source(s_lib_parent).unwrap();

    // Clean-up offers every original, including the dropped look-alike and the exact copy.
    let c = cleanup::summary(&cat).unwrap();
    let gd = c.sources.iter().find(|s| s.source_id == s_gd).unwrap();
    assert_eq!(gd.files, 3);
    let nas_s = c.sources.iter().find(|s| s.source_id == s_nas).unwrap();
    assert_eq!(nas_s.files, 28);
    let list = cleanup::file_list(&cat, &[s_gd]).unwrap();
    assert!(list.iter().any(|p| p.ends_with("barcelona small.jpg")));
}
