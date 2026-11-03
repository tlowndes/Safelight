use safelight_core::{exact, folders, organise, scan_source, Catalogue, Item};
use std::fs;

/// The same photo in Google Drive and Proton Drive, plus one photo only in Google.
fn setup() -> (tempfile::TempDir, Catalogue, i64, i64) {
    let dir = tempfile::tempdir().unwrap();
    let (g, p) = (dir.path().join("google"), dir.path().join("proton"));
    fs::create_dir_all(g.join("Camera/2024")).unwrap();
    fs::create_dir_all(p.join("Photos")).unwrap();
    fs::write(g.join("Camera/2024/IMG_20240614_183205.jpg"), b"same bytes").unwrap();
    fs::write(p.join("Photos/IMG_20240614_183205.jpg"), b"same bytes").unwrap();
    fs::write(g.join("IMG_20240701_120000.jpg"), b"only in google").unwrap();
    let cat = Catalogue::open_in_memory().unwrap();
    // Google is added first, so it would win on id order alone.
    let gid = cat.add_source("Google Drive", "gdrive", g.to_str().unwrap()).unwrap();
    let pid = cat.add_source("Proton Drive", "proton", p.to_str().unwrap()).unwrap();
    scan_source(&cat, gid, |_| {}).unwrap();
    scan_source(&cat, pid, |_| {}).unwrap();
    (dir, cat, gid, pid)
}

fn all(cat: &Catalogue) -> Vec<Item> {
    cat.library(100).unwrap().into_iter().flat_map(|g| g.items).collect()
}

#[test]
fn proton_copy_is_suggested_and_used_for_the_library() {
    let (_d, cat, _gid, pid) = setup();
    let groups = exact::exact_groups(&cat).unwrap();
    assert_eq!(groups.len(), 1);
    let g = &groups[0];
    assert!(!g.decided);
    assert_eq!(g.copies[0].source_kind, "proton");
    assert!(g.copies[0].keep && !g.copies[1].keep);
    assert_eq!(cat.stats().unwrap().exact_to_review, 1);

    // Even before review, the organised library copies from Proton.
    let plan = organise::build_plan(&cat).unwrap();
    let shared = plan.iter().find(|p| p.sha256 == g.sha256).unwrap();
    assert_eq!(cat.item(shared.item_id).unwrap().unwrap().source_id, pid);
}

#[test]
fn keeping_proton_hides_the_google_copy_without_touching_files() {
    let (dir, cat, _gid, _pid) = setup();
    assert_eq!(all(&cat).len(), 3);
    assert_eq!(exact::keep_preferred_all(&cat).unwrap(), 1);
    let lib = all(&cat);
    assert_eq!(lib.len(), 2, "the spare Google copy leaves the library");
    assert!(lib.iter().all(|i| !i.has_exact_duplicate), "the kept copy is no longer flagged");
    assert!(dir.path().join("google/Camera/2024/IMG_20240614_183205.jpg").exists());
    assert_eq!(cat.stats().unwrap().exact_to_review, 0);
    let s = exact::spare_summary(&cat).unwrap();
    assert_eq!((s.files, s.sources[0].kind.as_str()), (1, "gdrive"));

    // Changing your mind is just a catalogue update.
    let sha = exact::exact_groups(&cat).unwrap()[0].sha256.clone();
    exact::reset(&cat, &sha).unwrap();
    assert_eq!(all(&cat).len(), 3);
}

#[test]
fn spares_move_to_the_bin_and_undo_puts_them_back() {
    let (dir, cat, gid, _pid) = setup();
    exact::keep_preferred_all(&cat).unwrap();
    let original = dir.path().join("google/Camera/2024/IMG_20240614_183205.jpg");

    let r = exact::move_spares(&cat, |_, _| {}).unwrap();
    assert_eq!((r.moved, r.skipped), (1, 0), "{:?}", r.errors);
    assert!(!original.exists());
    let binned = dir.path().join("google/Safelight bin");
    assert!(fs::read_dir(&binned).unwrap().next().is_some(), "moved inside the same source");
    assert!(dir.path().join("proton/Photos/IMG_20240614_183205.jpg").exists(), "kept copy untouched");

    // The bin is never re-imported.
    scan_source(&cat, gid, |_| {}).unwrap();
    assert_eq!(all(&cat).len(), 2);
    assert!(exact::exact_groups(&cat).unwrap().is_empty());

    let log = exact::move_batches(&cat).unwrap();
    assert_eq!((log.len(), log[0].files, log[0].undone), (1, 1, 0));
    let u = exact::undo_batch(&cat, r.batch).unwrap();
    assert_eq!(u.restored, 1);
    assert!(original.exists());
    assert!(!binned.exists(), "empty bin folders are tidied away");
    for id in u.source_ids {
        scan_source(&cat, id, |_| {}).unwrap();
    }
    let g = exact::exact_groups(&cat).unwrap();
    assert_eq!(g.len(), 1, "the restored copy is back for review");
    assert!(g[0].copies.iter().find(|c| c.source_kind == "proton").unwrap().keep, "Proton is still the keeper");
    assert_eq!(exact::move_batches(&cat).unwrap()[0].undone, 1);
}

#[test]
fn a_spare_is_left_alone_if_the_kept_copy_has_gone() {
    let (dir, cat, _gid, _pid) = setup();
    exact::keep_preferred_all(&cat).unwrap();
    fs::remove_file(dir.path().join("proton/Photos/IMG_20240614_183205.jpg")).unwrap();
    let r = exact::move_spares(&cat, |_, _| {}).unwrap();
    assert_eq!((r.moved, r.skipped), (0, 1));
    assert!(dir.path().join("google/Camera/2024/IMG_20240614_183205.jpg").exists());
}

#[test]
fn folder_tree_counts_and_filters() {
    let (_d, cat, gid, pid) = setup();
    let tree = folders::folder_tree(&cat).unwrap();
    let find = |s: i64, p: &str| tree.iter().find(|n| n.source_id == s && n.path == p).map(|n| (n.count, n.depth));
    assert_eq!(find(gid, ""), Some((2, 0)));
    assert_eq!(find(gid, "Camera"), Some((1, 1)));
    assert_eq!(find(gid, "Camera/2024"), Some((1, 2)));
    assert_eq!(find(pid, "Photos"), Some((1, 1)));

    let in_folder = |s: i64, p: &str| -> usize {
        let f = folders::FolderRef { source_id: s, path: p.into() };
        cat.library_in(100, Some(&f)).unwrap().into_iter().map(|g| g.items.len()).sum()
    };
    assert_eq!(in_folder(gid, ""), 2);
    assert_eq!(in_folder(gid, "Camera"), 1);
    assert_eq!(in_folder(gid, "Camera/2024"), 1);
    assert_eq!(in_folder(gid, "Cam"), 0, "a folder name prefix isn't a match");
    assert_eq!(in_folder(pid, ""), 1);

    // Spare copies drop out of the counts too.
    exact::keep_preferred_all(&cat).unwrap();
    let tree = folders::folder_tree(&cat).unwrap();
    assert!(!tree.iter().any(|n| n.source_id == gid && n.path == "Camera"));
}
