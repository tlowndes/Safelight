//! Camera RAW previews without camera codecs. Every RAW format Safelight lists (CR2, CR3, NEF,
//! ARW, RAF, ORF, RW2, DNG) carries a full-size or near full-size JPEG the camera made at the
//! moment of capture. We find the biggest one that decodes and turn it the right way up.

use image::DynamicImage;
use std::path::Path;

pub const RAW: &[&str] = &["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"];

pub fn is_raw(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| RAW.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The largest embedded JPEG in a RAW file, rotated by the file's orientation tag.
pub fn embedded_preview(path: &Path) -> Option<DynamicImage> {
    let data = std::fs::read(path).ok()?;
    let mut img = largest_jpeg(&data)?;
    if let Some(o) = orientation(path) {
        img.apply_orientation(o);
    }
    Some(img)
}

/// Decode the biggest baseline or progressive JPEG stream inside `data`. Lossless JPEG (the
/// RAW sensor data itself in CR2 and some DNGs) fails to decode and is skipped.
pub fn largest_jpeg(data: &[u8]) -> Option<DynamicImage> {
    let mut found = jpeg_streams(data);
    found.sort_by_key(|&(start, end)| std::cmp::Reverse(end - start));
    found.into_iter().find_map(|(start, end)| {
        let bytes = &data[start..end];
        let dec = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes)).ok()?;
        DynamicImage::from_decoder(dec).ok().filter(|i| i.width() >= 32 && i.height() >= 32)
    })
}

/// Byte ranges of complete JPEG streams (SOI to EOI). Walks the marker segments so the tiny
/// thumbnails tucked inside a JPEG's own EXIF block aren't mistaken for the end of it.
fn jpeg_streams(data: &[u8]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            if let Some(end) = jpeg_end(data, i) {
                out.push((i, end));
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn jpeg_end(data: &[u8], start: usize) -> Option<usize> {
    let mut p = start + 2;
    // Header segments, up to the start of scan.
    loop {
        if p + 4 > data.len() || data[p] != 0xFF {
            return None;
        }
        let marker = data[p + 1];
        match marker {
            0xFF => p += 1, // fill byte
            0xD9 => return Some(p + 2),
            0x01 | 0xD0..=0xD7 => p += 2,
            _ => {
                let len = u16::from_be_bytes([data[p + 2], data[p + 3]]) as usize;
                if len < 2 {
                    return None;
                }
                p += 2 + len;
                if marker == 0xDA {
                    break;
                }
            }
        }
    }
    // Entropy-coded data: a real marker is 0xFF followed by anything but 0x00 or a restart.
    while p + 1 < data.len() {
        if data[p] == 0xFF {
            match data[p + 1] {
                0x00 | 0xD0..=0xD7 | 0xFF => p += 1,
                0xD9 => return Some(p + 2),
                // Another scan (progressive JPEG) or table: skip its header and keep going.
                0xDA | 0xC4 | 0xDB | 0xDD => {
                    if p + 4 > data.len() {
                        return None;
                    }
                    let len = u16::from_be_bytes([data[p + 2], data[p + 3]]) as usize;
                    p += 2 + len;
                    continue;
                }
                _ => return None,
            }
        }
        p += 1;
    }
    None
}

/// EXIF orientation of a TIFF-based RAW (CR2, NEF, ARW, DNG, ORF, RW2).
fn orientation(path: &Path) -> Option<image::metadata::Orientation> {
    let file = std::fs::File::open(path).ok()?;
    let exif = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)).ok()?;
    let v = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?.value.get_uint(0)?;
    image::metadata::Orientation::from_exif(v as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn finds_the_biggest_embedded_jpeg() {
        // A fake RAW: TIFF-ish header, a small thumbnail, sensor junk, then the big preview.
        let mut raw = b"II*\0\x10\0\0\0CR\x02\0".to_vec();
        raw.extend(jpeg(160, 120));
        raw.extend((0..5000u32).map(|n| (n * 7 % 251) as u8));
        raw.extend(jpeg(1200, 800));
        raw.extend([0u8; 64]);
        let img = largest_jpeg(&raw).expect("preview");
        assert_eq!((img.width(), img.height()), (1200, 800));
    }

    #[test]
    fn nothing_found_in_random_bytes() {
        let junk: Vec<u8> = (0..20000u32).map(|n| (n * 31 % 253) as u8).collect();
        assert!(largest_jpeg(&junk).is_none());
    }

    #[test]
    fn raw_extensions() {
        assert!(is_raw(Path::new("IMG_0001.CR2")));
        assert!(is_raw(Path::new("a/b.nef")));
        assert!(!is_raw(Path::new("a.jpg")));
    }
}
