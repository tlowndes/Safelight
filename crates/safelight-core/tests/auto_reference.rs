use safelight_core::{organise, scan_source, Catalogue};
use std::fs;

#[test]
fn auto_moves_reference_but_respects_user_choice_and_setting() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    fs::create_dir_all(&src).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([10, 200, 10])).save(src.join("Screenshot 2024-03-01.png")).unwrap();
    image::RgbImage::from_pixel(40, 30, image::Rgb([200, 10, 10])).save(src.join("IMG_20240615_100000.jpg")).unwrap();
    let cat = Catalogue::open_in_memory().unwrap();
    let s = cat.add_source("S", "folder", src.to_str().unwrap()).unwrap();
    scan_source(&cat, s, |_| {}).unwrap();

    assert!(organise::auto_reference_enabled(&cat).unwrap());
    assert_eq!(organise::auto_move_reference(&cat).unwrap(), 1);
    assert_eq!(cat.stats().unwrap().reference, 1);

    // Sent back as a photo: never picked again, even by "Check now".
    let id = organise::reference_suggestions(&cat).unwrap().len();
    assert_eq!(id, 0);
    let all: Vec<i64> = safelight_core::reference::items(&cat, None, None).unwrap().into_iter().map(|r| r.item.id).collect();
    organise::set_reference(&cat, &all, false).unwrap();
    assert_eq!(organise::move_reference_now(&cat).unwrap(), 0);

    // Switched off: scans leave things alone.
    cat.set_setting("auto_reference", "0").unwrap();
    assert!(!organise::auto_reference_enabled(&cat).unwrap());
}
