//! Smart masks and auto straighten.
//!
//! - Subject: U²-Netp, a 4.6 MB salient-object model, run on this PC. Downloaded once on first use.
//! - Sky: found from the picture itself (bright, smooth, sky-coloured and joined to the top edge).
//! - Auto straighten: finds the strongest near-level or near-upright lines and levels them.

use crate::ai::{model_err, ModelFile};
use crate::Result;
use image::{imageops::FilterType, DynamicImage, GrayImage, Luma, RgbImage};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
};
use tract_onnx::prelude::*;

/// Downloaded the first time someone adds a Select subject mask.
pub const SUBJECT_MODEL: ModelFile = ModelFile {
    file: "subject.onnx",
    purpose: "Finds the main subject for masks",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
    size_mb: 5,
    sha256: Some("309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"),
};
const SUBJECT_SIDE: usize = 320;
/// Masks are worked out at this size and scaled up; edges are feathered anyway.
const MAP_SIDE: u32 = 512;

static MODELS_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
type Plan = Arc<TypedRunnableModel>;
static SUBJECT: OnceLock<Mutex<Option<Plan>>> = OnceLock::new();
/// The last few masks worked out, so dragging a slider doesn't rerun the model.
static CACHE: OnceLock<Mutex<Vec<(u64, GrayImage)>>> = OnceLock::new();

/// Where the app keeps its model files. Call once at start-up.
pub fn set_models_dir(dir: &Path) {
    *MODELS_DIR.write().unwrap() = Some(dir.to_path_buf());
}

fn subject_path() -> Option<PathBuf> {
    MODELS_DIR.read().ok()?.as_ref().map(|d| d.join(SUBJECT_MODEL.file)).filter(|p| p.is_file())
}

/// True once the subject model is on this PC.
pub fn subject_ready() -> bool {
    subject_path().is_some()
}

pub fn is_smart_kind(kind: &str) -> bool {
    kind == "sky" || kind == "subject"
}

fn load_subject(path: &Path) -> Result<Plan> {
    let mut m = tract_onnx::onnx().model_for_path(path).map_err(model_err)?;
    m.set_input_fact(0, f32::fact([1, 3, SUBJECT_SIDE, SUBJECT_SIDE]).into()).map_err(model_err)?;
    Ok(m.into_optimized().map_err(model_err)?.into_runnable().map_err(model_err)?)
}

/// How likely each pixel is to belong to the main subject, 0..255, at the picture's shape.
pub fn subject_map_with(model: &Path, img: &RgbImage) -> Result<GrayImage> {
    run_subject(&load_subject(model)?, img)
}

fn run_subject(plan: &Plan, img: &RgbImage) -> Result<GrayImage> {
    let small = image::imageops::resize(img, SUBJECT_SIDE as u32, SUBJECT_SIDE as u32, FilterType::Triangle);
    let max = small.pixels().flat_map(|p| p.0).max().unwrap_or(255).max(1) as f32;
    let (mean, std) = ([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
    let input = tract_ndarray::Array4::from_shape_fn((1, 3, SUBJECT_SIDE, SUBJECT_SIDE), |(_, c, y, x)| {
        (small.get_pixel(x as u32, y as u32)[c] as f32 / max - mean[c]) / std[c]
    })
    .into_tensor();
    let out = plan.run(tvec!(input.into())).map_err(model_err)?;
    let vals: Vec<f32> = out[0].to_plain_array_view::<f32>().map_err(model_err)?.iter().copied().collect();
    let (lo, hi) = vals.iter().fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    let span = (hi - lo).max(1e-6);
    let side = SUBJECT_SIDE as u32;
    let map = GrayImage::from_fn(side, side, |x, y| Luma([(((vals[(y * side + x) as usize] - lo) / span) * 255.0) as u8]));
    let (w, h) = fit(img.width(), img.height());
    Ok(image::imageops::resize(&map, w, h, FilterType::Triangle))
}

fn fit(w: u32, h: u32) -> (u32, u32) {
    let s = (MAP_SIDE as f32 / w.max(h).max(1) as f32).min(1.0);
    (((w as f32 * s) as u32).max(1), ((h as f32 * s) as u32).max(1))
}

/// Sky: bright, smooth, sky-coloured pixels joined to the top of the picture, plus matching
/// patches seen through trees and between buildings. 0..255 at a working size.
pub fn sky_map(img: &RgbImage) -> GrayImage {
    let (w, h) = fit(img.width(), img.height());
    let small = image::imageops::resize(img, w, h, FilterType::Triangle);
    let px = |x: u32, y: u32| {
        let p = small.get_pixel(x, y);
        [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0]
    };
    let lum: Vec<f32> = small.pixels().map(|p| (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0).collect();
    let at = |x: u32, y: u32| (y * w + x) as usize;
    // Local texture: mean gradient over a small window. Sky is smooth.
    let mut grad = vec![0f32; (w * h) as usize];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let gx = lum[at(x + 1, y)] - lum[at(x - 1, y)];
            let gy = lum[at(x, y + 1)] - lum[at(x, y - 1)];
            grad[at(x, y)] = (gx * gx + gy * gy).sqrt();
        }
    }
    let tex = box_blur(&grad, w, h, 3);
    let skyish = |x: u32, y: u32| {
        let [r, g, b] = px(x, y);
        let l = lum[at(x, y)];
        let blue = b - r > 0.02 && b >= g - 0.04;
        let pale = l > 0.62 && (r - b).abs() < 0.12 && (g - b).abs() < 0.12;
        let dusk = l > 0.4 && r > g && g > b && (r - b) < 0.45 && y < h / 2;
        let greenish = g > b + 0.04 && g > r;
        tex[at(x, y)] < 0.045 && l > 0.25 && (blue || pale || dusk) && !greenish
    };
    // Grow from the top edge through neighbours that look like sky and change colour gently.
    let mut sky = vec![false; (w * h) as usize];
    let mut stack: Vec<(u32, u32)> = (0..w).filter(|&x| skyish(x, 0)).map(|x| (x, 0)).collect();
    for &(x, y) in &stack {
        sky[at(x, y)] = true;
    }
    while let Some((x, y)) = stack.pop() {
        let c = px(x, y);
        for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
            if nx >= w || ny >= h || sky[at(nx, ny)] || !skyish(nx, ny) {
                continue;
            }
            let n = px(nx, ny);
            if (0..3).map(|k| (n[k] - c[k]).abs()).sum::<f32>() < 0.09 {
                sky[at(nx, ny)] = true;
                stack.push((nx, ny));
            }
        }
    }
    // Sky glimpsed through gaps: same colour as the sky found, no lower than its lowest point.
    let found: Vec<usize> = (0..sky.len()).filter(|&i| sky[i]).collect();
    if found.len() > 20 {
        let mut mean = [0f32; 3];
        for &i in &found {
            let p = small.as_raw();
            for k in 0..3 {
                mean[k] += p[i * 3 + k] as f32 / 255.0;
            }
        }
        mean.iter_mut().for_each(|m| *m /= found.len() as f32);
        let lowest = found.iter().map(|&i| i as u32 / w).max().unwrap_or(0);
        for y in 0..=lowest.min(h - 1) {
            for x in 0..w {
                let c = px(x, y);
                if !sky[at(x, y)] && skyish(x, y) && (0..3).map(|k| (c[k] - mean[k]).abs()).sum::<f32>() < 0.15 {
                    sky[at(x, y)] = true;
                }
            }
        }
    }
    let soft = box_blur(&sky.iter().map(|&s| if s { 1.0 } else { 0.0 }).collect::<Vec<_>>(), w, h, 2);
    GrayImage::from_fn(w, h, |x, y| Luma([(soft[at(x, y)] * 255.0) as u8]))
}

fn box_blur(v: &[f32], w: u32, h: u32, r: i32) -> Vec<f32> {
    let (wi, hi) = (w as i32, h as i32);
    let pass = |src: &[f32], horizontal: bool| -> Vec<f32> {
        let mut out = vec![0f32; src.len()];
        for y in 0..hi {
            for x in 0..wi {
                let (mut s, mut n) = (0f32, 0f32);
                for d in -r..=r {
                    let (xx, yy) = if horizontal { (x + d, y) } else { (x, y + d) };
                    if xx >= 0 && yy >= 0 && xx < wi && yy < hi {
                        s += src[(yy * wi + xx) as usize];
                        n += 1.0;
                    }
                }
                out[(y * wi + x) as usize] = s / n;
            }
        }
        out
    };
    pass(&pass(v, true), false)
}

/// Cheap fingerprint of a picture: its size and a sparse sample of pixels.
fn fingerprint(kind: &str, img: &RgbImage) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut h);
    img.dimensions().hash(&mut h);
    let raw = img.as_raw();
    let step = (raw.len() / 4096).max(1);
    raw.iter().step_by(step).for_each(|b| b.hash(&mut h));
    h.finish()
}

/// The sky or subject mask for a picture (0..255), or None when the model isn't on this PC yet.
pub fn smart_map(kind: &str, img: &RgbImage) -> Option<GrayImage> {
    let key = fingerprint(kind, img);
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Some((_, m)) = cache.lock().ok()?.iter().find(|(k, _)| *k == key) {
        return Some(m.clone());
    }
    let map = match kind {
        "sky" => sky_map(img),
        "subject" => {
            let path = subject_path()?;
            let slot = SUBJECT.get_or_init(|| Mutex::new(None));
            let plan = {
                let mut s = slot.lock().ok()?;
                if s.is_none() {
                    *s = load_subject(&path).ok();
                }
                s.clone()?
            };
            run_subject(&plan, img).ok()?
        }
        _ => return None,
    };
    let mut c = cache.lock().ok()?;
    c.push((key, map.clone()));
    if c.len() > 6 {
        c.remove(0);
    }
    Some(map)
}

/// Sample a map at a point given as 0..1 across and down.
pub(crate) fn sample_map(map: &GrayImage, x: f32, y: f32) -> f32 {
    let (w, h) = (map.width() as f32, map.height() as f32);
    let (fx, fy) = ((x * w - 0.5).clamp(0.0, w - 1.0), (y * h - 0.5).clamp(0.0, h - 1.0));
    let (x0, y0) = (fx.floor() as u32, fy.floor() as u32);
    let (x1, y1) = ((x0 + 1).min(map.width() - 1), (y0 + 1).min(map.height() - 1));
    let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
    let g = |x, y| map.get_pixel(x, y)[0] as f32 / 255.0;
    let top = g(x0, y0) * (1.0 - tx) + g(x1, y0) * tx;
    let bot = g(x0, y1) * (1.0 - tx) + g(x1, y1) * tx;
    top * (1.0 - ty) + bot * ty
}

/// Soften a map's edge; `feather` is 0..100.
pub(crate) fn feathered(map: &GrayImage, feather: f32) -> GrayImage {
    let r = (feather / 100.0 * 10.0).round() as i32;
    if r < 1 {
        return map.clone();
    }
    let v: Vec<f32> = map.pixels().map(|p| p[0] as f32).collect();
    let b = box_blur(&v, map.width(), map.height(), r);
    GrayImage::from_fn(map.width(), map.height(), |x, y| Luma([b[(y * map.width() + x) as usize] as u8]))
}

/// The angle to put on the Straighten slider to level the picture, from its strongest near-level
/// or near-upright edges. None when there's nothing clear to go by (a portrait against a wall).
pub fn auto_straighten(img: &DynamicImage) -> Option<f32> {
    // A light blur first, so stair-stepped edges read as the line they draw, not as flat steps.
    let small = image::imageops::blur(&img.resize(900, 900, FilterType::Triangle).to_luma8(), 1.2);
    let (w, h) = (small.width() as i32, small.height() as i32);
    if w < 16 || h < 16 {
        return None;
    }
    let g = |x: i32, y: i32| small.get_pixel(x as u32, y as u32)[0] as f32;
    // Edge directions from Sobel gradients, folded so level and upright lines both land near 0°.
    const RANGE: f32 = 20.0;
    const BINS: usize = 400; // 0.1° each
    let mut hist = vec![0f32; BINS];
    let mut mags = Vec::new();
    let mut samples = Vec::new();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let gx = (g(x + 1, y - 1) + 2.0 * g(x + 1, y) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2.0 * g(x - 1, y) + g(x - 1, y + 1));
            let gy = (g(x - 1, y + 1) + 2.0 * g(x, y + 1) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2.0 * g(x, y - 1) + g(x + 1, y - 1));
            let m = (gx * gx + gy * gy).sqrt();
            if m > 40.0 {
                let a = gy.atan2(gx).to_degrees();
                let d = (a + 45.0).rem_euclid(90.0) - 45.0;
                if d.abs() < RANGE {
                    samples.push((d, m));
                }
                mags.push(m);
            }
        }
    }
    if samples.len() < 200 {
        return None;
    }
    // Strong edges only: the top quarter.
    mags.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let cut = mags[mags.len() * 3 / 4];
    for (d, m) in &samples {
        if *m >= cut {
            let b = (((d + RANGE) / (2.0 * RANGE)) * BINS as f32) as usize;
            hist[b.min(BINS - 1)] += m;
        }
    }
    // Smooth over about a degree and find the peak.
    let sm: Vec<f32> = (0..BINS).map(|i| (i.saturating_sub(5)..(i + 6).min(BINS)).map(|j| hist[j]).sum::<f32>()).collect();
    let (peak, &best) = sm.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap())?;
    let mean = sm.iter().sum::<f32>() / BINS as f32;
    if best < mean * 4.0 {
        return None;
    }
    // Refine with a weighted mean around the peak.
    let to_deg = |i: usize| (i as f32 + 0.5) / BINS as f32 * 2.0 * RANGE - RANGE;
    let lo = peak.saturating_sub(10);
    let hi = (peak + 11).min(BINS);
    let total: f32 = hist[lo..hi].iter().sum();
    if total <= 0.0 {
        return None;
    }
    let tilt = (lo..hi).map(|i| to_deg(i) * hist[i]).sum::<f32>() / total;
    if tilt.abs() < 0.05 {
        return Some(0.0);
    }
    // The slider turns the other way to the tilt it corrects.
    Some((-tilt * 10.0).round() / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::develop::{geometry, Edits};
    use image::Rgb;

    /// A tilted horizon with a few upright posts, as a camera held slightly off level would see it.
    fn tilted(deg: f32) -> DynamicImage {
        // Edges blend over a pixel by distance, the way a lens and sensor draw them.
        let (w, h) = (900u32, 600u32);
        let (sn, cs) = deg.to_radians().sin_cos();
        let cover = |d: f32| (d + 0.5).clamp(0.0, 1.0);
        let mix = |a: [f32; 3], b: [f32; 3], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        let img = RgbImage::from_fn(w, h, |x, y| {
            // Coordinates in the tilted world: u along the horizon, v down from it.
            let (dx, dy) = (x as f32 + 0.5 - 450.0, y as f32 + 0.5 - 300.0);
            let (u, v) = (dx * cs + dy * sn, -dx * sn + dy * cs);
            let mut c = mix([120.0, 170.0, 230.0], [70.0, 110.0, 60.0], cover(v));
            for post in [-300.0f32, -30.0, 250.0] {
                let inside = cover(6.0 - (u - post).abs()) * cover(v + 120.0);
                c = mix(c, [60.0, 40.0, 30.0], inside);
            }
            Rgb([c[0] as u8, c[1] as u8, c[2] as u8])
        });
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn auto_straighten_levels_a_tilted_horizon() {
        for deg in [-4.0f32, 2.5, 7.0] {
            let img = tilted(deg);
            let fix = auto_straighten(&img).expect("finds a level");
            assert!(fix.abs() > 1.0, "a {deg}° tilt needs a fix, got {fix}");
            let fixed = geometry(&img, &Edits { straighten: fix, ..Default::default() });
            let left = auto_straighten(&DynamicImage::ImageRgb8(fixed)).unwrap_or(0.0);
            assert!(left.abs() < 0.6, "after fixing {deg}° by {fix}°, {left}° is left");
        }
    }

    #[test]
    fn auto_straighten_leaves_a_level_photo_alone_and_gives_up_on_noise() {
        assert!(auto_straighten(&tilted(0.0)).unwrap().abs() < 0.3);
        let mut seed = 7u32;
        let noise = RgbImage::from_fn(400, 300, |_, _| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let v = (seed >> 24) as u8;
            Rgb([v, v, v])
        });
        let flat = RgbImage::from_pixel(400, 300, Rgb([128, 128, 128]));
        assert!(auto_straighten(&DynamicImage::ImageRgb8(flat)).is_none());
        let _ = auto_straighten(&DynamicImage::ImageRgb8(noise)); // must not panic
    }

    #[test]
    fn sky_mask_covers_the_sky_and_not_the_ground() {
        let img = tilted(0.0).to_rgb8();
        let map = sky_map(&img);
        assert!(sample_map(&map, 0.5, 0.2) > 0.9, "sky is masked");
        assert!(sample_map(&map, 0.5, 0.8) < 0.1, "ground isn't");
    }

    #[test]
    fn subject_model_finds_the_subject() {
        let Some(dir) = crate::ai::test_models(&[SUBJECT_MODEL.file]) else { return };
        // A bright disc on a plain background.
        let img = RgbImage::from_fn(400, 300, |x, y| {
            let d = ((x as f32 - 200.0).powi(2) + (y as f32 - 150.0).powi(2)).sqrt();
            if d < 70.0 { Rgb([220, 60, 40]) } else { Rgb([200, 200, 205]) }
        });
        let map = subject_map_with(&dir.join(SUBJECT_MODEL.file), &img).unwrap();
        assert!(sample_map(&map, 0.5, 0.5) > sample_map(&map, 0.05, 0.05) + 0.3);
    }
}
