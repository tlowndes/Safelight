use safelight_core::{
    scan_source,
    screenshots::{self, FileEdits},
    Catalogue,
};
use std::fs;

fn shot(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    fs::write(&p, b"pixels").unwrap();
    p
}

#[test]
fn files_a_screenshot_logs_it_and_puts_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let file = shot(root, "Screenshot 2026-10-31 224512.png");
    let cat = Catalogue::open_in_memory().unwrap();
    let lines: Vec<String> = ["Figma", "Onboarding flow", "Auto layout", "Corner radius 12", "Prototype"].iter().map(|s| s.to_string()).collect();
    let s = screenshots::suggest(&file, &lines, None, None, true).unwrap();
    assert_eq!(s.new_name, "2026-10-31 Figma – Onboarding flow.png");
    screenshots::queue_put(&cat, &s).unwrap();
    assert_eq!(screenshots::queue(&cat).unwrap().len(), 1);

    let m = screenshots::file_shot(&cat, &s, &FileEdits::default(), root.to_str().unwrap(), true, false).unwrap();
    assert!(!file.exists());
    assert!(root.join("Design/2026-10-31 Figma – Onboarding flow.png").exists());
    assert_eq!(screenshots::queue_count(&cat).unwrap(), 0, "filing takes it off the review list");
    assert_eq!(screenshots::moves(&cat, Some("auto layout"), 10).unwrap().len(), 1, "searchable by its words");

    let back = screenshots::undo(&cat, m.id).unwrap();
    assert_eq!(back, file.to_string_lossy());
    assert!(file.exists());
    assert!(screenshots::get_move(&cat, m.id).unwrap().unwrap().undone);
    assert!(screenshots::undo(&cat, m.id).is_err(), "can't put back twice");
}

#[test]
fn never_overwrites_and_edits_win() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("Receipts")).unwrap();
    fs::write(root.join("Receipts/2026-10-31 Amazon order.png"), b"older").unwrap();
    let file = shot(root, "Screenshot 2026-10-31 100000.png");
    let cat = Catalogue::open_in_memory().unwrap();
    let s = screenshots::suggest(&file, &[], None, None, true).unwrap();
    assert_eq!(s.category, "other");
    let edits = FileEdits { category: Some("receipts".into()), description: Some("Amazon order".into()) };
    let m = screenshots::file_shot(&cat, &s, &edits, root.to_str().unwrap(), true, false).unwrap();
    assert!(m.to.ends_with("2026-10-31 Amazon order (2).png"));
    assert_eq!(fs::read(root.join("Receipts/2026-10-31 Amazon order.png")).unwrap(), b"older");
}

#[test]
fn the_catalogue_follows_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let file = shot(root, "Screenshot 2026-10-31 120000.png");
    let cat = Catalogue::open_in_memory().unwrap();
    let src = cat.add_source("Screenshots", "local", root.to_str().unwrap()).unwrap();
    scan_source(&cat, src, |_| {}).unwrap();
    let id = cat.library(10).unwrap()[0].items[0].id;
    cat.set_rating(&[id], 4).unwrap();
    let s = screenshots::suggest(&file, &["WhatsApp".into(), "Type a message".into(), "last seen today".into()], None, None, false).unwrap();
    let m = screenshots::file_shot(&cat, &s, &FileEdits::default(), root.to_str().unwrap(), false, true).unwrap();
    let item = cat.item(id).unwrap().unwrap();
    assert_eq!(item.path, m.to);
    assert_eq!(item.rating, 4);
    assert!(m.auto);
}

#[test]
fn unsorted_lists_only_loose_images() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    shot(root, "a.png");
    shot(root, "notes.txt");
    fs::create_dir_all(root.join("Design")).unwrap();
    shot(&root.join("Design"), "b.png");
    let found = screenshots::unsorted(root);
    assert_eq!(found.len(), 1);
    assert!(found[0].ends_with("a.png"));
}

#[test]
fn settings_have_safe_defaults() {
    let cat = Catalogue::open_in_memory().unwrap();
    let s = screenshots::ShotSettings::load(&cat, "C:/Users/tom/Pictures/Screenshots").unwrap();
    assert_eq!(s.destination, s.folder);
    assert_eq!((s.reader.as_str(), s.auto_file, s.watch, s.threshold()), ("device", true, true, 0.7));
    assert!(!s.use_claude());
    screenshots::set_setting(&cat, "reader", "claude").unwrap();
    assert!(!screenshots::ShotSettings::load(&cat, "x").unwrap().use_claude(), "needs a key too");
    assert!(screenshots::set_setting(&cat, "api_key", "x").is_err());
}
