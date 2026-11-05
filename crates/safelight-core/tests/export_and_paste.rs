use safelight_core::{develop::{self, Edits}, export::{self, ExportOptions, Format, Naming}, scan_source, Catalogue, Item};
use std::fs;

/// Two real JPEGs in a source folder.
fn setup() -> (tempfile::TempDir, Catalogue, Vec<Item>) {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("photos");
    fs::create_dir_all(&src).unwrap();
    for (name, shade) in [("IMG_20240614_183205.jpg", 90u8), ("IMG_20240701_120000.jpg", 160u8)] {
        let img = image::RgbImage::from_fn(300, 200, |x, _| image::Rgb([shade, (x % 255) as u8, 120]));
        img.save(src.join(name)).unwrap();
    }
    let cat = Catalogue::open_in_memory().unwrap();
    let id = cat.add_source("Local", "local", src.to_str().unwrap()).unwrap();
    scan_source(&cat, id, |_| {}).unwrap();
    let mut items: Vec<Item> = cat.library(100).unwrap().into_iter().flat_map(|g| g.items).collect();
    items.sort_by_key(|i| i.path.clone());
    (dir, cat, items)
}

#[test]
fn paste_copies_the_look_but_keeps_each_crop_and_can_be_undone() {
    let (_d, cat, items) = setup();
    let (a, b) = (items[0].id, items[1].id);
    develop::save_edits(&cat, b, &Edits { rotate: 1, crop: Some([0.1, 0.1, 0.5, 0.5]), contrast: -40.0, ..Default::default() }).unwrap();
    let look = Edits { exposure: 0.5, clarity: 30.0, rotate: 2, ..Default::default() };
    let before = develop::paste_look(&cat, &[a, b], &look).unwrap();

    let ea = develop::load_edits(&cat, a).unwrap();
    assert_eq!((ea.exposure, ea.clarity, ea.rotate), (0.5, 30.0, 0), "look copied, rotation not");
    let eb = develop::load_edits(&cat, b).unwrap();
    assert_eq!((eb.exposure, eb.contrast, eb.rotate, eb.crop), (0.5, 0.0, 1, Some([0.1, 0.1, 0.5, 0.5])));

    develop::restore_edits(&cat, &before).unwrap();
    assert_eq!(develop::load_edits(&cat, a).unwrap(), Edits::default());
    assert_eq!(develop::load_edits(&cat, b).unwrap().contrast, -40.0);
}

#[test]
fn batch_export_resizes_names_and_never_overwrites() {
    let (d, cat, items) = setup();
    let out = d.path().join("out");
    let ids: Vec<i64> = items.iter().map(|i| i.id).collect();
    develop::save_edits(&cat, ids[0], &Edits { rotate: 1, ..Default::default() }).unwrap();
    let opts = ExportOptions { folder: out.to_string_lossy().into(), format: Format::Jpeg, quality: 85, max_edge: Some(150), naming: Naming::Suffix };
    let mut ticks = 0;
    let r = export::export_items(&cat, &ids, &opts, |_| ticks += 1).unwrap();
    assert_eq!((r.exported, r.errors.len()), (2, 0));
    assert!(ticks >= 3);
    let first = image::open(out.join("IMG_20240614_183205 edited.jpg")).unwrap();
    assert_eq!((first.width(), first.height()), (100, 150), "rotated by its edits, long edge 150");

    // Same again: new names, nothing overwritten.
    let r2 = export::export_items(&cat, &ids, &opts, |_| {}).unwrap();
    assert!(r2.files[0].ends_with("IMG_20240614_183205 edited (2).jpg"));

    let png = ExportOptions { format: Format::Png, max_edge: None, naming: Naming::DateNumber, ..opts.clone() };
    let r3 = export::export_items(&cat, &ids, &png, |_| {}).unwrap();
    assert!(r3.files[0].ends_with("2024-06-14 001.png"), "{:?}", r3.files);
    assert_eq!(image::open(&r3.files[1]).unwrap().width(), 300, "full size");

    let tif = ExportOptions { format: Format::Tiff, ..opts };
    let r4 = export::export_items(&cat, &ids[..1], &tif, |_| {}).unwrap();
    assert_eq!(image::open(&r4.files[0]).unwrap().height(), 150);
}
