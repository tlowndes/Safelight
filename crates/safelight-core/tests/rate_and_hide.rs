use safelight_core::{scan_source, Catalogue};
use std::fs;

fn setup() -> (tempfile::TempDir, Catalogue) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("IMG_20240614_183205.jpg"), b"same bytes").unwrap();
    fs::create_dir_all(root.join("backup")).unwrap();
    fs::write(root.join("backup/copy.jpg"), b"same bytes").unwrap();
    fs::write(root.join("IMG_20240701_120000.jpg"), b"other").unwrap();
    let cat = Catalogue::open_in_memory().unwrap();
    let id = cat.add_source("Local", "local", root.to_str().unwrap()).unwrap();
    scan_source(&cat, id, |_| {}).unwrap();
    (dir, cat)
}

fn all(cat: &Catalogue) -> Vec<safelight_core::Item> {
    cat.library(100).unwrap().into_iter().flat_map(|g| g.items).collect()
}

#[test]
fn ratings_and_flags_are_stored() {
    let (_d, cat) = setup();
    let id = all(&cat)[0].id;
    cat.set_rating(&[id], 4).unwrap();
    cat.set_flag(&[id], 1).unwrap();
    let it = cat.item(id).unwrap().unwrap();
    assert_eq!((it.rating, it.flag), (4, 1));
    cat.set_rating(&[id], 9).unwrap();
    cat.set_flag(&[id], -7).unwrap();
    let it = cat.item(id).unwrap().unwrap();
    assert_eq!((it.rating, it.flag), (5, -1), "clamped");
}

#[test]
fn hiding_removes_every_copy_from_the_library_and_can_be_undone() {
    let (dir, cat) = setup();
    assert_eq!(all(&cat).len(), 3);
    let dup = all(&cat).into_iter().find(|i| i.has_exact_duplicate).unwrap();
    cat.set_hidden(&[dup.id], true).unwrap();

    let left = all(&cat);
    assert_eq!(left.len(), 1, "both exact copies are hidden");
    assert_eq!(cat.hidden_items().unwrap().len(), 1, "listed once per fingerprint");
    assert_eq!(cat.stats().unwrap().hidden, 2);
    assert!(dir.path().join("backup/copy.jpg").exists(), "nothing on disk changes");

    // A fresh copy turning up on the next scan stays hidden.
    fs::write(dir.path().join("third copy.jpg"), b"same bytes").unwrap();
    scan_source(&cat, 1, |_| {}).unwrap();
    assert_eq!(all(&cat).len(), 1);

    cat.set_hidden(&[dup.id], false).unwrap();
    assert_eq!(all(&cat).len(), 4);
    assert!(cat.hidden_items().unwrap().is_empty());
}
