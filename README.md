# Safelight

One tidy photo and video library from Proton Drive, Google Drive, Google Photos and a NAS, with duplicates removed and Lightroom-style editing. Windows first, Mac later.

## Status

**Phase 2: read-only catalogue.** Add source folders, scan them, and browse everything in one timeline grouped by month. Nothing on disk is moved or deleted.

- Reads capture dates from camera data (EXIF), Google Takeout JSON files, then file names, then modified time
- Fingerprints every file (SHA-256) so exact duplicates are flagged across sources
- Re-scans only re-read new or changed files
- The catalogue is a SQLite file in the app's data folder, never inside a synced folder

Next: duplicate review (phase 3), organise and copy to Proton + NAS (phase 4), clean-up (phase 5), editor (phase 6).

## Run it on Windows

Needs [Node.js 22](https://nodejs.org) and [Rust](https://rustup.rs) (plus the WebView2 runtime, already on Windows 11).

```
npm install
npm run tauri dev
```

Or get an installer: **Actions → CI → Run workflow** on your branch, then download it from **Releases** once the run finishes.

## Layout

- `crates/safelight-core`: scanning, dates, hashing, catalogue, folder planning (`cargo test -p safelight-core`)
- `src-tauri`: the desktop app shell and the commands the UI calls
- `src`: React interface
