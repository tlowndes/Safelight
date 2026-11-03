# Safelight

One tidy photo and video library from Proton Drive, Google Drive, Google Photos and a NAS, with duplicates removed and Lightroom-style editing. Windows first, Mac later.

## Status

**First full version, ready to test.** Every step from scan to edit is in.

- **Sources:** scan Proton Drive, Google Drive, a Google Photos Takeout folder and the NAS as folders. Dates come from camera data (EXIF), Takeout JSON, file names, then modified time.
- **Duplicates:** exact copies (SHA-256) merge automatically; look-alikes (visual fingerprint) go to a review screen that suggests the best-quality copy.
- **Organise:** suggests events from busy days, previews the new `Photos/YYYY/YYYY-MM Event/` structure, then copies to the library and the backup mirror, checking every file.
- **Clean-up:** once copies are verified, moves originals to each source's Recycle Bin (or a `Safelight bin` folder on network drives). Nothing goes without your OK.
- **Reference:** screenshots and saved images are kept apart in topics with tags.
- **Screenshots (from Snapsort):** watches `Pictures\Screenshots`, reads each new screenshot with the OCR built into Windows (or Claude, if you add an API key) and names it by what's in it, e.g. `Design/2026-10-31 Figma – Onboarding flow.png`. When it's sure, it files it and offers Undo; otherwise it waits in **To review** (Enter to file, Del to leave, F2 to rename). **Sort existing** puts older screenshots on the list first. Nothing is deleted, and every move is logged under **Filed** and can be put back.
- **Viewer:** full-screen loupe with glass overlays and a filmstrip. The mouse wheel moves to the next photo, Ctrl + wheel zooms at the cursor, double-click toggles fit and 100%.
- **Rate, flag, hide:** 1–5 stars, Pick (P) and Reject (X), and Hide (H) to keep photos out of the library without touching the files. Hidden photos are listed under Hidden and can be brought back.
- **Keyboard:** Lightroom-style shortcuts throughout. Press `?` for the full list (kept in `src/shortcuts.ts`).
- **Look:** graphite panels, white main buttons, amber only for selection and focus. Follows the Windows light or dark setting.
- **Editor:** light, colour, tone curve, HSL, crop, rotate and presets. Edits are saved separately and originals are never changed; export to JPEG.

Not yet: Google Photos Picker API top-ups, RAW editing, Mac build.

## Run it on Windows

Needs [Node.js 22](https://nodejs.org) and [Rust](https://rustup.rs) (plus the WebView2 runtime, already on Windows 11).

```
npm install
npm run tauri dev
```

Or get an installer: **Actions → CI → Run workflow** on your branch, then download it from **Releases** once the run finishes.

## Layout

- `crates/safelight-core`: scanning, dates, hashing, catalogue, folder planning, screenshot rules (`cargo test -p safelight-core`)
- `src-tauri`: the desktop app shell and the commands the UI calls
- `src`: React interface
