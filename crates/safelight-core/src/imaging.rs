//! Decoding, thumbnails and visual fingerprints.

use crate::{catalogue::Catalogue, Result};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageDecoder, ImageReader};
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const THUMB_SIZE: u32 = 480;

/// Decode a full image with the `image` crate, applying the camera's rotation flag.
/// Covers JPEG, PNG, WebP, GIF, TIFF and BMP.
pub fn decode(path: &Path) -> Option<DynamicImage> {
    let reader = ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Some(img)
}

/// Best available picture of a file at roughly `max` pixels on its long edge.
/// Falls back to the Windows shell for HEIC, RAW and video.
pub fn preview_image(path: &Path, max: u32) -> Option<DynamicImage> {
    if let Some(img) = decode(path) {
        return Some(if img.width().max(img.height()) > max { img.resize(max, max, FilterType::Triangle) } else { img });
    }
    shell_preview(path, max)
}

#[cfg(windows)]
fn shell_preview(path: &Path, max: u32) -> Option<DynamicImage> {
    crate::winshell::shell_thumbnail(path, max as i32).map(DynamicImage::ImageRgba8)
}

#[cfg(not(windows))]
fn shell_preview(_path: &Path, _max: u32) -> Option<DynamicImage> {
    None
}

/// 64-bit difference hash: survives resizing and recompression, so it finds look-alike copies.
pub fn dhash(img: &DynamicImage) -> u64 {
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h <<= 1;
            if small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0] {
                h |= 1;
            }
        }
    }
    h
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[derive(Debug, Clone, Serialize)]
pub struct ThumbProgress {
    pub done: u64,
    pub total: u64,
}

/// Make thumbnails and fingerprints for everything that hasn't had a go yet.
/// Thumbnails are named by content fingerprint, so identical copies share one file.
pub fn process_thumbnails(cat: &Catalogue, cache_dir: &Path, mut progress: impl FnMut(&ThumbProgress)) -> Result<u64> {
    std::fs::create_dir_all(cache_dir)?;
    let todo: Vec<(i64, String, String)> = cat
        .conn
        .prepare("SELECT id, path, sha256 FROM items WHERE thumb_tried = 0 ORDER BY taken_at DESC")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let total = todo.len() as u64;
    let mut made = 0;
    for (n, (id, path, sha)) in todo.into_iter().enumerate() {
        if n % 10 == 0 {
            progress(&ThumbProgress { done: n as u64, total });
        }
        let out: PathBuf = cache_dir.join(format!("{sha}.jpg"));
        let path = Path::new(&path);
        // Full decode gives us true dimensions too; shell thumbnails don't.
        let full = decode(path);
        let dims = full.as_ref().map(|i| i.dimensions());
        let thumb = match full {
            Some(img) => Some(img.thumbnail(THUMB_SIZE, THUMB_SIZE)),
            None => shell_preview(path, THUMB_SIZE),
        };
        match thumb {
            Some(t) => {
                let ph = dhash(&t) as i64;
                if !out.exists() {
                    t.to_rgb8().save_with_format(&out, image::ImageFormat::Jpeg).ok();
                }
                let thumb_path = out.exists().then(|| out.to_string_lossy().to_string());
                cat.conn.execute(
                    "UPDATE items SET thumb = ?2, phash = ?3, thumb_tried = 1,
                       width = COALESCE(?4, width), height = COALESCE(?5, height) WHERE id = ?1",
                    params![id, thumb_path, ph, dims.map(|d| d.0), dims.map(|d| d.1)],
                )?;
                made += 1;
            }
            None => {
                cat.conn.execute("UPDATE items SET thumb_tried = 1 WHERE id = ?1", [id])?;
            }
        }
    }
    progress(&ThumbProgress { done: total, total });
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dhash_matches_resized_copy_not_different_image() {
        let mut a = image::RgbImage::new(200, 150);
        for (x, y, p) in a.enumerate_pixels_mut() {
            // A smooth scene: bright blob on a gradient.
            let d = (((x as f32 - 70.0).powi(2) + (y as f32 - 60.0).powi(2)).sqrt() * 3.0).min(255.0);
            *p = image::Rgb([255 - d as u8, (y * 255 / 150) as u8, (x * 255 / 200) as u8]);
        }
        let a = DynamicImage::ImageRgb8(a);
        let small = a.resize_exact(80, 60, FilterType::Lanczos3);
        let mut b = image::RgbImage::new(200, 150);
        for (x, y, p) in b.enumerate_pixels_mut() {
            let d = (((x as f32 - 150.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt() * 3.0).min(255.0);
            *p = image::Rgb([d as u8, 255 - (y * 255 / 150) as u8, 40]);
        }
        let b = DynamicImage::ImageRgb8(b);
        let (same, diff) = (hamming(dhash(&a), dhash(&small)), hamming(dhash(&a), dhash(&b)));
        assert!(same <= 6, "resized copy differs by {same}");
        assert!(diff > 12, "different image only differs by {diff}");
    }
}
