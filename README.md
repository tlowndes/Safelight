# Safelight

One tidy photo and video library from Proton Drive, Google Drive, Google Photos and a NAS, with duplicates removed and Lightroom-style editing. Windows first, Mac later.

## Status

**First full version, ready to test.** Every step from scan to edit is in.

- **Sources:** scan Proton Drive, Google Drive, a Google Photos Takeout folder and the NAS as folders. Dates come from camera data (EXIF), Takeout JSON, file names, then modified time.
- **Duplicates:** exact copies (SHA-256) merge automatically; look-alikes (visual fingerprint) go to a review screen that suggests the best-quality copy.
- **Organise:** suggests events from busy days, previews the new `Photos/YYYY/YYYY-MM Event/` structure, then copies to the library and the backup mirror, checking every file.
- **Clean-up:** once copies are verified, moves originals to each source's Recycle Bin (or a `Safelight bin` folder on network drives). Nothing goes without your OK.
- **Reference:** screenshots and saved images are kept apart in topics with tags.
- **Viewer:** full-screen loupe with glass overlays and a filmstrip. The mouse wheel moves to the next photo, Ctrl + wheel zooms at the cursor, double-click toggles fit and 100%.
- **Rate, flag, hide:** 1–5 stars, Pick (P) and Reject (X), and Hide (H) to keep photos out of the library without touching the files. Hidden photos are listed under Hidden and can be brought back.
- **Keyboard:** Lightroom-style shortcuts throughout. Press `?` for the full list (kept in `src/shortcuts.ts`).
- **Look:** graphite panels, white main buttons, amber only for selection and focus. Follows the Windows light or dark setting.
- **Capture (from Keepshot):** screenshot or record a screen, window or dragged region, with an optional microphone. Global shortcuts (`Ctrl+Shift+4` region, `Ctrl+Shift+3` screen, `Ctrl+Shift+5` record, `Ctrl+Shift+2` stop, `Ctrl+Shift+P` pause) work from any app, and a tray icon and an always-on-top timer keep Stop in reach. Recordings open in an editor to trim, crop, zoom, add callouts, a cursor highlight and key moments, then export MP4, WebM or a small MP4 with ffmpeg. Copy the image or the file path, or show it in Explorer. Captures are saved to `Pictures\Safelight Captures`, which is a library source, so they land in All photos straight away.
- **Editor:** light, colour, tone curve, HSL, crop, rotate and presets. Edits are saved separately and originals are never changed; export to JPEG.

Not yet: Google Photos Picker API top-ups, RAW editing, Mac build.

## Run it on Windows

Needs [Node.js 22](https://nodejs.org) and [Rust](https://rustup.rs) (plus the WebView2 runtime, already on Windows 11). Capture and video export also need ffmpeg: `winget install Gyan.FFmpeg`. Local transcripts of recordings are optional: `npm run setup:whisper` once.

```
npm install
npm run tauri dev
```

Or get an installer: **Actions → CI → Run workflow** on your branch, then download it from **Releases** once the run finishes.

## Layout

- `crates/safelight-core`: scanning, dates, hashing, catalogue, folder planning (`cargo test -p safelight-core`)
- `src-tauri`: the desktop app shell and the commands the UI calls
- `src`: React interface
- `src/capture`: capture and the recording editor. `core` builds every ffmpeg command as pure, tested functions; `services` runs the capture → library → export pipeline; `ui` holds the screens, the recording HUD and the region picker. Tests: `npm test` (needs ffmpeg).
- `src-tauri/src/capture`: the native side of capture: recorder, tray, global shortcuts, extra windows, clipboard, and the capture store (`captures.sqlite` in the app data folder)
