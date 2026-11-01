use safelight_core::{delete, organise, scan_source, Catalogue};
use std::fs;

#[test]
fn delete_bins_original_copies_and_library_files() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b, lib) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("lib"));
    for d in [&a, &b, &lib] {
        fs::create_dir_all(d).unwrap();
    }
    let img = image::RgbImage::from_fn(64, 48, |x, y| image::Rgb([x as u8 * 3, y as u8 * 4, 90]));
    img.save(a.join("IMG_20240614_100000.jpg")).unwrap();
    fs::copy(a.join("IMG_20240614_100000.jpg"), b.join("copy.jpg")).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([200, 10, 10])).save(a.join("IMG_20240615_100000.jpg")).unwrap();

    let cat = Catalogue::open_in_memory().unwrap();
    let sa = cat.add_source("A", "folder", a.to_str().unwrap()).unwrap();
    let sb = cat.add_source("B", "folder", b.to_str().unwrap()).unwrap();
    scan_source(&cat, sa, |_| {}).unwrap();
    scan_source(&cat, sb, |_| {}).unwrap();
    cat.set_setting("library_root", lib.to_str().unwrap()).unwrap();
    organise::run_copy(&cat, |_| {}).unwrap();
    let lib_files = || walkdir::WalkDir::new(&lib).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).count();
    assert_eq!(lib_files(), 2);

    let all = || cat.library(1000).unwrap().into_iter().flat_map(|g| g.items).collect::<Vec<_>>();
    let id = all().iter().find(|i| i.path.ends_with("IMG_20240614_100000.jpg")).unwrap().id;
    let r = delete::delete_items(&cat, &[id], |_, _| {}).unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(r.photos, 1);
    assert_eq!(r.files, 3); // original, exact copy, library copy
    assert!(!a.join("IMG_20240614_100000.jpg").exists());
    assert!(!b.join("copy.jpg").exists());
    assert!(a.join("IMG_20240615_100000.jpg").exists());
    assert_eq!(lib_files(), 1);
    assert_eq!(all().len(), 1);
}
