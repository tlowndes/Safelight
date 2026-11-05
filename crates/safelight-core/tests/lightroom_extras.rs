use safelight_core::{
    collections::{self, Rules},
    develop::{self, Edits},
    export, import::{self, Folders, ImportOptions, Rename},
    meta, scan_source, xmp, Catalogue, Item,
};
use std::fs;

fn jpeg(path: &std::path::Path, shade: u8) {
    image::RgbImage::from_fn(120, 80, |x, _| image::Rgb([shade, (x * 2) as u8, 90])).save(path).unwrap();
}

fn setup() -> (tempfile::TempDir, Catalogue, Vec<Item>) {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("photos");
    fs::create_dir_all(src.join("2024")).unwrap();
    jpeg(&src.join("2024/IMG_20240614_183205.jpg"), 40);
    jpeg(&src.join("IMG_20250701_120000.jpg"), 140);
    jpeg(&src.join("IMG_20250702_090000.jpg"), 220);
    let cat = Catalogue::open_in_memory().unwrap();
    let id = cat.add_source("Local", "local", src.to_str().unwrap()).unwrap();
    scan_source(&cat, id, |_| {}).unwrap();
    let mut items: Vec<Item> = cat.library(100).unwrap().into_iter().flat_map(|g| g.items).collect();
    items.sort_by_key(|i| i.taken_at.clone());
    (dir, cat, items)
}

fn ids_of(groups: Vec<safelight_core::MonthGroup>) -> Vec<i64> {
    let mut v: Vec<i64> = groups.into_iter().flat_map(|g| g.items).map(|i| i.id).collect();
    v.sort();
    v
}

#[test]
fn labels_are_stored_and_checked() {
    let (_d, cat, items) = setup();
    cat.set_label(&[items[0].id], Some("red")).unwrap();
    assert_eq!(cat.item(items[0].id).unwrap().unwrap().label.as_deref(), Some("red"));
    assert!(cat.set_label(&[items[0].id], Some("pink")).is_err());
    cat.set_label(&[items[0].id], None).unwrap();
    assert_eq!(cat.item(items[0].id).unwrap().unwrap().label, None);
}

#[test]
fn plain_and_smart_collections() {
    let (_d, cat, items) = setup();
    let trip = collections::create(&cat, "Trip", None).unwrap();
    assert!(collections::create(&cat, " Trip ", None).is_err(), "names are unique");
    collections::add(&cat, trip, &[items[0].id, items[1].id]).unwrap();
    collections::add(&cat, trip, &[items[0].id]).unwrap();
    assert_eq!(ids_of(collections::items(&cat, trip, 100).unwrap()).len(), 2);
    collections::remove(&cat, trip, &[items[0].id]).unwrap();
    assert_eq!(ids_of(collections::items(&cat, trip, 100).unwrap()), vec![items[1].id]);

    cat.set_rating(&[items[1].id, items[2].id], 4).unwrap();
    cat.set_label(&[items[2].id], Some("green")).unwrap();
    let best = collections::create(&cat, "Best of 2025", Some(&Rules { min_rating: Some(4), year_from: Some(2025), ..Default::default() })).unwrap();
    let mut want = vec![items[1].id, items[2].id];
    want.sort();
    assert_eq!(ids_of(collections::items(&cat, best, 100).unwrap()), want);
    let green = collections::create(&cat, "Green", Some(&Rules { label: Some("green".into()), ..Default::default() })).unwrap();
    assert_eq!(ids_of(collections::items(&cat, green, 100).unwrap()), vec![items[2].id]);
    let old = collections::create(&cat, "2024 only", Some(&Rules { year_to: Some(2024), text: Some("img".into()), ..Default::default() })).unwrap();
    assert_eq!(ids_of(collections::items(&cat, old, 100).unwrap()), vec![items[0].id]);

    let list = collections::list(&cat).unwrap();
    assert_eq!(list.iter().find(|c| c.id == best).unwrap().count, 2);
    assert!(list.iter().find(|c| c.id == trip).unwrap().rules.is_none());
    collections::delete(&cat, trip).unwrap();
    assert_eq!(collections::list(&cat).unwrap().len(), 3);
}

#[test]
fn virtual_copies_keep_separate_edits() {
    let (_d, cat, items) = setup();
    let id = items[0].id;
    develop::save_edits(&cat, id, &Edits { exposure: 1.0, ..Default::default() }).unwrap();
    let name = meta::new_version(&cat, id).unwrap();
    assert_eq!(name, "Copy 1");
    develop::save_edits(&cat, id, &Edits { saturation: -100.0, ..Default::default() }).unwrap();
    assert_eq!(cat.item(id).unwrap().unwrap().versions, 1);
    let vs = meta::versions(&cat, id).unwrap();
    assert_eq!((vs[0].name.as_str(), vs[0].active, vs[1].name.as_str()), ("Copy 1", true, "Master"));
    let back = meta::switch_version(&cat, id, vs[1].id.unwrap()).unwrap();
    assert_eq!(back.exposure, 1.0);
    assert_eq!(develop::load_edits(&cat, id).unwrap().exposure, 1.0);
    let vs = meta::versions(&cat, id).unwrap();
    assert_eq!((vs[0].name.as_str(), vs[1].name.as_str()), ("Master", "Copy 1"));
    meta::switch_version(&cat, id, vs[1].id.unwrap()).unwrap();
    assert_eq!(develop::load_edits(&cat, id).unwrap().saturation, -100.0);
    meta::delete_version(&cat, id, meta::versions(&cat, id).unwrap()[1].id.unwrap()).unwrap();
    assert_eq!(cat.item(id).unwrap().unwrap().versions, 0);
}

#[test]
fn details_and_xmp_sidecars() {
    let (_d, cat, items) = setup();
    let it = &items[1];
    meta::set_details(&cat, &[it.id], &meta::Details { caption: "Sunset <pier>".into(), copyright: "© Tom".into() }).unwrap();
    assert_eq!(meta::details(&cat, it.id).unwrap().caption, "Sunset <pier>");
    cat.set_rating(&[it.id], 3).unwrap();
    cat.set_label(&[it.id], Some("blue")).unwrap();
    develop::save_edits(&cat, it.id, &Edits { exposure: 0.5, ..Default::default() }).unwrap();
    let r = xmp::write_sidecars(&cat, &[it.id], false).unwrap();
    assert_eq!(r.written, 1);
    let side = xmp::sidecar_path(std::path::Path::new(&it.path));
    let text = fs::read_to_string(&side).unwrap();
    assert!(text.contains("xmp:Rating=\"3\"") && text.contains("xmp:Label=\"Blue\"") && text.contains("crs:Exposure2012=\"+0.50\""));
    assert!(text.contains("Sunset &lt;pier&gt;"));
    // Another app's sidecar is left alone.
    let other = xmp::sidecar_path(std::path::Path::new(&items[2].path));
    fs::write(&other, r#"<x:xmpmeta xmp:Rating="5" xmp:Label="Red"/>"#).unwrap();
    assert_eq!(xmp::write_sidecars(&cat, &[items[2].id], false).unwrap().written, 0);
    assert_eq!(xmp::read_sidecars(&cat, &[items[2].id]).unwrap(), 1);
    let i2 = cat.item(items[2].id).unwrap().unwrap();
    assert_eq!((i2.rating, i2.label.as_deref()), (5, Some("red")));
    // Camera info: none in these test files, and that's fine.
    assert_eq!(meta::camera_info(std::path::Path::new(&it.path)), meta::CameraInfo::default());
}

#[test]
fn import_skips_known_photos_and_sorts_by_date() {
    let (d, cat, _items) = setup();
    let card = d.path().join("card/DCIM/100CANON");
    fs::create_dir_all(&card).unwrap();
    fs::copy(d.path().join("photos/IMG_20250701_120000.jpg"), card.join("IMG_20250701_120000.jpg")).unwrap();
    jpeg(&card.join("IMG_20250801_101500.jpg"), 77);
    let p = import::preview(&cat, &d.path().join("card")).unwrap();
    assert_eq!((p.found, p.new, p.already), (2, 1, 1));
    let to = d.path().join("Imports");
    let opts = ImportOptions { from: d.path().join("card").to_string_lossy().into(), to: to.to_string_lossy().into(), folders: Folders::ByDate, rename: Rename::DateTime };
    let r = import::run(&cat, &opts, |_| {}).unwrap();
    assert_eq!((r.copied, r.skipped, r.errors.len()), (1, 1, 0));
    assert!(to.join("2025/2025-08-01/2025-08-01 10.15.00.jpg").exists());
    let src = r.source_id.unwrap();
    scan_source(&cat, src, |_| {}).unwrap();
    // Running again copies nothing new.
    let again = import::run(&cat, &opts, |_| {}).unwrap();
    assert_eq!((again.copied, again.skipped, again.source_id), (0, 2, Some(src)));
}

#[test]
fn web_gallery_writes_a_page_and_images() {
    let (d, cat, items) = setup();
    let out = d.path().join("gallery");
    let ids: Vec<i64> = items.iter().map(|i| i.id).collect();
    let r = export::web_gallery(&cat, &ids, out.to_str().unwrap(), "Summer <2025>", |_| {}).unwrap();
    assert_eq!(r.exported, 3);
    let html = fs::read_to_string(out.join("index.html")).unwrap();
    assert!(html.contains("Summer &lt;2025&gt;") && html.contains("thumbs/0003.jpg"));
    assert!(out.join("images/0001.jpg").exists());
}
