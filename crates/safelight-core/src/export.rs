//! Export photos with their edits: one or many, as JPEG, PNG or TIFF, at full size or a
//! chosen long edge, named the way the user picks. Originals are never touched, and an
//! existing file is never overwritten.

use crate::{catalogue::Catalogue, develop, imaging, Result};
use image::{imageops::FilterType, DynamicImage};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Jpeg,
    Png,
    Tiff,
}

impl Format {
    fn ext(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Png => "png",
            Format::Tiff => "tif",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Naming {
    /// IMG_1234.jpg
    Original,
    /// IMG_1234 edited.jpg
    Suffix,
    /// 2025-07-12 001.jpg (capture date and a running number)
    DateNumber,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub folder: String,
    pub format: Format,
    /// JPEG quality, 1..100.
    pub quality: u8,
    /// Longest side in pixels; None keeps the full size. Never enlarges.
    pub max_edge: Option<u32>,
    pub naming: Naming,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ExportReport {
    pub exported: usize,
    pub files: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

/// The file name (without folder) for the `n`th photo of the batch, counting from 1.
pub fn file_name(path: &str, taken_at: Option<&str>, n: usize, opts: &ExportOptions) -> String {
    let stem = Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "photo".into());
    let base = match opts.naming {
        Naming::Original => stem,
        Naming::Suffix => format!("{stem} edited"),
        Naming::DateNumber => {
            let day = taken_at.and_then(|t| t.get(..10)).unwrap_or("Undated");
            format!("{day} {n:03}")
        }
    };
    format!("{base}.{}", opts.format.ext())
}

/// `name`, or `name (2)`, `name (3)`… whichever doesn't exist yet.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    (2..).map(|k| dir.join(format!("{stem} ({k}).{ext}"))).find(|c| !c.exists()).unwrap()
}

/// Decode, develop and resize one photo.
pub fn render(src: &Path, edits: &develop::Edits, max_edge: Option<u32>) -> Option<DynamicImage> {
    // Formats the image library can't decode (HEIC, RAW) export at the largest size Windows can preview.
    let img = imaging::decode(src).or_else(|| imaging::preview_image(src, 4096))?;
    let mut out = DynamicImage::ImageRgb8(develop::apply(&img, edits));
    if let Some(m) = max_edge.filter(|m| *m > 0) {
        if out.width().max(out.height()) > m {
            out = out.resize(m, m, FilterType::Lanczos3);
        }
    }
    Some(out)
}

pub fn write(img: &DynamicImage, dest: &Path, format: Format, quality: u8) -> Result<()> {
    let file = std::io::BufWriter::new(std::fs::File::create(dest)?);
    let res = match format {
        Format::Jpeg => image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality.clamp(1, 100)).encode_image(img),
        Format::Png => img.write_with_encoder(image::codecs::png::PngEncoder::new(file)),
        Format::Tiff => {
            // The TIFF encoder needs to seek, so build it in memory first.
            let mut buf = std::io::Cursor::new(Vec::new());
            img.write_with_encoder(image::codecs::tiff::TiffEncoder::new(&mut buf))
                .and_then(|_| std::fs::write(dest, buf.into_inner()).map_err(image::ImageError::IoError))
        }
    };
    res.map_err(|e| crate::Error::Other(e.to_string()))
}

/// Export each photo with its saved edits. Keeps going past a photo that fails.
pub fn export_items(cat: &Catalogue, ids: &[i64], opts: &ExportOptions, mut progress: impl FnMut(&ExportProgress)) -> Result<ExportReport> {
    let dir = PathBuf::from(&opts.folder);
    std::fs::create_dir_all(&dir)?;
    let mut report = ExportReport::default();
    for (k, &id) in ids.iter().enumerate() {
        let Some(item) = cat.item(id)? else { continue };
        progress(&ExportProgress { done: k, total: ids.len(), current: item.path.clone() });
        let edits = develop::load_edits(cat, id)?;
        let name = file_name(&item.path, item.taken_at.as_deref(), k + 1, opts);
        let file_label = Path::new(&item.path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match render(Path::new(&item.path), &edits, opts.max_edge) {
            None => report.errors.push(format!("{file_label}: Safelight can't open this file")),
            Some(img) => {
                let dest = free_path(&dir, &name);
                match write(&img, &dest, opts.format, opts.quality) {
                    Ok(()) => {
                        report.exported += 1;
                        report.files.push(dest.to_string_lossy().to_string());
                    }
                    Err(e) => report.errors.push(format!("{file_label}: {e}")),
                }
            }
        }
    }
    progress(&ExportProgress { done: ids.len(), total: ids.len(), current: String::new() });
    Ok(report)
}

fn html_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A web gallery: a folder with an index.html, thumbnails and large images, ready to open in a
/// browser or upload anywhere. Works offline; no scripts from the internet.
pub fn web_gallery(cat: &Catalogue, ids: &[i64], folder: &str, title: &str, mut progress: impl FnMut(&ExportProgress)) -> Result<ExportReport> {
    let root = PathBuf::from(folder);
    let (big, small) = (root.join("images"), root.join("thumbs"));
    std::fs::create_dir_all(&big)?;
    std::fs::create_dir_all(&small)?;
    let mut report = ExportReport::default();
    let mut tiles = String::new();
    for (k, &id) in ids.iter().enumerate() {
        let Some(item) = cat.item(id)? else { continue };
        progress(&ExportProgress { done: k, total: ids.len(), current: item.path.clone() });
        let edits = develop::load_edits(cat, id)?;
        let Some(img) = render(Path::new(&item.path), &edits, Some(2048)) else {
            report.errors.push(format!("{}: Safelight can't open this file", item.path));
            continue;
        };
        let name = format!("{:04}.jpg", k + 1);
        write(&img, &big.join(&name), Format::Jpeg, 88)?;
        write(&img.thumbnail(640, 640), &small.join(&name), Format::Jpeg, 82)?;
        let caption = crate::meta::details(cat, id)?.caption;
        let alt = if caption.is_empty() { Path::new(&item.path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() } else { caption };
        tiles.push_str(&format!(
            "<a href=\"images/{name}\" data-caption=\"{c}\"><img src=\"thumbs/{name}\" alt=\"{c}\" loading=\"lazy\"></a>\n",
            c = html_esc(&alt)
        ));
        report.exported += 1;
        report.files.push(big.join(&name).to_string_lossy().to_string());
    }
    let page = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t}</title>
<style>
:root {{ color-scheme: dark; --bg: #0A0A0B; --text: #F4F4F5; --mute: #8A8A93; }}
* {{ box-sizing: border-box; margin: 0; }}
body {{ background: var(--bg); color: var(--text); font: 15px/1.4 system-ui, sans-serif; padding: 32px 16px; }}
h1 {{ font-weight: 600; font-size: 28px; letter-spacing: -0.02em; max-width: 1200px; margin: 0 auto 6px; }}
p {{ color: var(--mute); max-width: 1200px; margin: 0 auto 24px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; max-width: 1200px; margin: 0 auto; }}
.grid a {{ display: block; aspect-ratio: 1; overflow: hidden; border-radius: 10px; background: #1C1C1F; }}
.grid img {{ width: 100%; height: 100%; object-fit: cover; transition: transform .2s; }}
.grid a:hover img {{ transform: scale(1.03); }}
.box {{ position: fixed; inset: 0; background: rgba(0,0,0,.94); display: none; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }}
.box.on {{ display: flex; }}
.box img {{ max-width: 94vw; max-height: 86vh; border-radius: 6px; }}
.box span {{ color: var(--mute); }}
</style></head>
<body>
<h1>{t}</h1><p>{n} photos</p>
<div class="grid">
{tiles}</div>
<div class="box" id="box"><img id="big" alt=""><span id="cap"></span></div>
<script>
const links = [...document.querySelectorAll('.grid a')]; let at = -1;
const box = document.getElementById('box'), big = document.getElementById('big'), cap = document.getElementById('cap');
function show(i) {{ at = (i + links.length) % links.length; big.src = links[at].href; cap.textContent = links[at].dataset.caption; box.classList.add('on'); }}
links.forEach((a, i) => a.addEventListener('click', e => {{ e.preventDefault(); show(i); }}));
box.addEventListener('click', () => box.classList.remove('on'));
addEventListener('keydown', e => {{ if (!box.classList.contains('on')) return; if (e.key === 'Escape') box.classList.remove('on'); if (e.key === 'ArrowRight') show(at + 1); if (e.key === 'ArrowLeft') show(at - 1); }});
</script>
</body></html>
"#,
        t = html_esc(if title.trim().is_empty() { "Photos" } else { title.trim() }),
        n = report.exported,
    );
    std::fs::write(root.join("index.html"), page)?;
    progress(&ExportProgress { done: ids.len(), total: ids.len(), current: String::new() });
    report.files.insert(0, root.join("index.html").to_string_lossy().to_string());
    Ok(report)
}
