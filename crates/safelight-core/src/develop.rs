//! Non-destructive editing. Edits are a small recipe saved in the catalogue; the original file is
//! never touched. The same pipeline renders the live preview and the full-size export.

use crate::{catalogue::Catalogue, Result};
use image::{imageops, DynamicImage, RgbImage};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Edits {
    /// Stops, -3..3
    pub exposure: f32,
    /// All of these are -100..100
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub temperature: f32,
    pub tint: f32,
    pub vibrance: f32,
    pub saturation: f32,
    /// Presence: local contrast and haze, -100..100.
    pub clarity: f32,
    pub dehaze: f32,
    /// Detail: sharpening 0..150, noise reduction 0..100.
    pub sharpening: f32,
    pub noise: f32,
    /// Darken (-) or lighten (+) the corners, -100..100.
    pub vignette: f32,
    /// Tone curve points (input, output), 0..1, sorted by input. Empty = straight line.
    pub curve: Vec<[f32; 2]>,
    /// Per-colour hue, saturation, luminance, each -100..100, for
    /// red, orange, yellow, green, aqua, blue, purple, magenta.
    pub hsl: [[f32; 3]; 8],
    /// Normalised crop rectangle [x, y, w, h], applied after rotation.
    pub crop: Option<[f32; 4]>,
    /// Quarter turns clockwise: 0, 1, 2, 3.
    pub rotate: u8,
    /// Straighten, in degrees (-45..45). The picture is cropped in so no corners show.
    pub straighten: f32,
    /// Lens: barrel (-) or pincushion (+) fix, -100..100.
    pub distortion: f32,
    /// Lens: colour fringing fix, 0..100.
    pub fringing: f32,
    /// Lens: brighten (+) dark corners the lens made, -100..100.
    pub lens_vignette: f32,
    /// Spot healing, in the rotated and straightened picture before cropping.
    pub spots: Vec<Spot>,
    /// Local adjustments, in the same frame as spots.
    pub masks: Vec<Mask>,
}

/// A healed spot: the circle at (x, y) is filled from the circle at (sx, sy), with its colour
/// matched to the surroundings. Positions are 0..1 of width and height; `r` is 0..1 of width.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Spot {
    pub x: f32,
    pub y: f32,
    pub r: f32,
    pub sx: f32,
    pub sy: f32,
}

/// A local adjustment. "linear": full effect at (x1, y1) fading to none at (x2, y2).
/// "radial": an ellipse centred on (x1, y1) with radii (x2, y2), feathered at the edge.
/// "sky" and "subject": found from the picture (see `segment`); the points are unused.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Mask {
    pub kind: String,
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    /// 0..100: radial, sky and subject.
    pub feather: f32,
    pub invert: bool,
    /// Stops, -3..3.
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub saturation: f32,
    pub temperature: f32,
}

impl Default for Mask {
    fn default() -> Self {
        Self {
            kind: "radial".into(),
            x1: 0.5,
            y1: 0.5,
            x2: 0.25,
            y2: 0.25,
            feather: 50.0,
            invert: false,
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            saturation: 0.0,
            temperature: 0.0,
        }
    }
}

impl Default for Edits {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            temperature: 0.0,
            tint: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            clarity: 0.0,
            dehaze: 0.0,
            sharpening: 0.0,
            noise: 0.0,
            vignette: 0.0,
            curve: vec![],
            hsl: [[0.0; 3]; 8],
            crop: None,
            rotate: 0,
            straighten: 0.0,
            distortion: 0.0,
            fringing: 0.0,
            lens_vignette: 0.0,
            spots: vec![],
            masks: vec![],
        }
    }
}

const HUE_CENTRES: [f32; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 310.0];

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
fn linear_to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// Monotone cubic (Fritsch–Carlson) curve through the points, as a 256-entry lookup table.
pub fn curve_lut(points: &[[f32; 2]]) -> [f32; 256] {
    let mut lut = [0.0f32; 256];
    let mut pts: Vec<[f32; 2]> = points.to_vec();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
    if pts.first().map(|p| p[0] > 0.0).unwrap_or(true) {
        pts.insert(0, [0.0, 0.0]);
    }
    if pts.last().map(|p| p[0] < 1.0).unwrap_or(true) {
        pts.push([1.0, 1.0]);
    }
    pts.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-4);
    let n = pts.len();
    let d: Vec<f32> = (0..n - 1).map(|i| (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0])).collect();
    let mut m = vec![0.0f32; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
            let s = a * a + b * b;
            if s > 9.0 {
                let t = 3.0 / s.sqrt();
                m[i] = t * a * d[i];
                m[i + 1] = t * b * d[i];
            }
        }
    }
    for (k, out) in lut.iter_mut().enumerate() {
        let x = k as f32 / 255.0;
        let i = (0..n - 1).find(|&i| x <= pts[i + 1][0]).unwrap_or(n - 2);
        let h = pts[i + 1][0] - pts[i][0];
        let t = ((x - pts[i][0]) / h).clamp(0.0, 1.0);
        let (t2, t3) = (t * t, t * t * t);
        let y = (2.0 * t3 - 3.0 * t2 + 1.0) * pts[i][1]
            + (t3 - 2.0 * t2 + t) * h * m[i]
            + (-2.0 * t3 + 3.0 * t2) * pts[i + 1][1]
            + (t3 - t2) * h * m[i + 1];
        *out = y.clamp(0.0, 1.0);
    }
    lut
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } * 60.0;
    (h, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s <= 0.0 {
        return (l, l, l);
    }
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    (r + m, g + m, b + m)
}

/// How much each of the 8 colour bands applies to a hue (weights sum to 1).
fn band_weights(h: f32) -> [f32; 8] {
    let mut w = [0.0f32; 8];
    for i in 0..8 {
        let a = HUE_CENTRES[i];
        let b = if i == 7 { HUE_CENTRES[0] + 360.0 } else { HUE_CENTRES[i + 1] };
        let hh = if h < a { h + 360.0 } else { h };
        if hh >= a && hh <= b {
            let t = (hh - a) / (b - a);
            w[i] = 1.0 - t;
            w[(i + 1) % 8] = t;
            break;
        }
    }
    w
}

pub fn is_default(e: &Edits) -> bool {
    e == &Edits::default()
}

/// Bilinear sample of an RGB image at a fractional position, clamped to the edges.
fn sample(img: &RgbImage, x: f32, y: f32) -> [f32; 3] {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let x = x.clamp(0.0, w - 1.0);
    let y = y.clamp(0.0, h - 1.0);
    let (x0, y0) = (x.floor() as u32, y.floor() as u32);
    let (x1, y1) = ((x0 + 1).min(img.width() - 1), (y0 + 1).min(img.height() - 1));
    let (tx, ty) = (x - x0 as f32, y - y0 as f32);
    let (a, b, c, d) = (img.get_pixel(x0, y0), img.get_pixel(x1, y0), img.get_pixel(x0, y1), img.get_pixel(x1, y1));
    let mut out = [0.0; 3];
    for k in 0..3 {
        let top = a[k] as f32 * (1.0 - tx) + b[k] as f32 * tx;
        let bot = c[k] as f32 * (1.0 - tx) + d[k] as f32 * tx;
        out[k] = top * (1.0 - ty) + bot * ty;
    }
    out
}

/// How much to scale in so a picture turned by `deg` has no empty corners.
fn straighten_scale(w: f32, h: f32, deg: f32) -> f32 {
    let a = deg.to_radians().abs();
    let (c, s) = (a.cos(), a.sin());
    // The turned picture must cover the original frame.
    ((w * c + h * s) / w).max((w * s + h * c) / h)
}

/// Turn, straighten and lens corrections: everything that moves pixels, before cropping.
/// Spots and masks are placed in this frame.
pub fn geometry(img: &DynamicImage, e: &Edits) -> RgbImage {
    let base = match e.rotate % 4 {
        1 => img.rotate90(),
        2 => img.rotate180(),
        3 => img.rotate270(),
        _ => img.clone(),
    }
    .to_rgb8();
    let (st, dist, fringe) = (e.straighten.clamp(-45.0, 45.0), e.distortion / 100.0, e.fringing / 100.0);
    if st == 0.0 && dist == 0.0 && fringe == 0.0 && e.lens_vignette == 0.0 {
        return base;
    }
    let (w, h) = (base.width(), base.height());
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let rmax = (cx * cx + cy * cy).sqrt();
    let (sn, cs) = (-st.to_radians()).sin_cos();
    // A positive fix reaches past the corners, so zoom in just enough to keep the frame full.
    let zoom = straighten_scale(w as f32, h as f32, st) * (1.0 + dist.max(0.0) * 0.25);
    let lv = e.lens_vignette / 100.0;
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in out.enumerate_pixels_mut() {
        let (dx, dy) = ((x as f32 + 0.5 - cx) / zoom, (y as f32 + 0.5 - cy) / zoom);
        // Undo the turn.
        let (rx, ry) = (dx * cs - dy * sn, dx * sn + dy * cs);
        let r2 = (rx * rx + ry * ry) / (rmax * rmax);
        let k = 1.0 + dist * 0.25 * r2;
        let (sx, sy) = (cx + rx * k, cy + ry * k);
        let g = sample(&base, sx - 0.5, sy - 0.5);
        let mut c = g;
        if fringe != 0.0 {
            // Red and blue land at slightly different sizes; nudge them back into line.
            let f = fringe * 0.004;
            c[0] = sample(&base, cx + rx * k * (1.0 - f) - 0.5, cy + ry * k * (1.0 - f) - 0.5)[0];
            c[2] = sample(&base, cx + rx * k * (1.0 + f) - 0.5, cy + ry * k * (1.0 + f) - 0.5)[2];
        }
        let gain = if lv != 0.0 { 1.0 + lv * 0.6 * r2 } else { 1.0 };
        for i in 0..3 {
            px[i] = (c[i] * gain).clamp(0.0, 255.0).round() as u8;
        }
    }
    out
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn ring_mean(img: &RgbImage, cx: f32, cy: f32, r: f32) -> [f32; 3] {
    let mut sum = [0.0f32; 3];
    let mut n = 0.0;
    let steps = ((r * 6.0) as usize).clamp(12, 96);
    for i in 0..steps {
        let a = i as f32 / steps as f32 * std::f32::consts::TAU;
        let p = sample(img, cx + a.cos() * r * 1.15, cy + a.sin() * r * 1.15);
        for k in 0..3 {
            sum[k] += p[k];
        }
        n += 1.0;
    }
    sum.map(|v| v / n)
}

/// Fill each spot from its source, matching colour to what surrounds the spot.
fn heal(img: &mut RgbImage, spots: &[Spot]) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    for s in spots {
        let (cx, cy, r) = (s.x * w, s.y * h, (s.r * w).max(1.5));
        let (sx, sy) = (s.sx * w, s.sy * h);
        let src = img.clone();
        let (dm, sm) = (ring_mean(&src, cx, cy, r), ring_mean(&src, sx, sy, r));
        let (x0, x1) = ((cx - r).floor().max(0.0) as u32, ((cx + r).ceil() as u32).min(img.width() - 1));
        let (y0, y1) = ((cy - r).floor().max(0.0) as u32, ((cy + r).ceil() as u32).min(img.height() - 1));
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
                let d = (dx * dx + dy * dy).sqrt() / r;
                if d >= 1.0 {
                    continue;
                }
                let a = 1.0 - smoothstep((d - 0.6) / 0.4);
                let from = sample(&src, sx + dx - 0.5, sy + dy - 0.5);
                let p = img.get_pixel_mut(x, y);
                for k in 0..3 {
                    let v = from[k] + (dm[k] - sm[k]);
                    p[k] = (p[k] as f32 * (1.0 - a) + v * a).clamp(0.0, 255.0).round() as u8;
                }
            }
        }
    }
}

/// Pick where to heal a spot from: the nearby circle whose edge best matches the spot's edge.
/// Positions in and out are 0..1 of the picture (as in `Spot`).
pub fn find_spot_source(img: &RgbImage, x: f32, y: f32, r: f32) -> (f32, f32) {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let (cx, cy, rp) = (x * w, y * h, (r * w).max(2.0));
    let target = |px: f32, py: f32| -> Vec<[f32; 3]> {
        (0..24).map(|i| {
            let a = i as f32 / 24.0 * std::f32::consts::TAU;
            sample(img, px + a.cos() * rp * 1.2, py + a.sin() * rp * 1.2)
        }).collect()
    };
    let want = target(cx, cy);
    let mut best = (f32::MAX, cx + rp * 2.4, cy);
    for dist in [2.4f32, 3.4] {
        for i in 0..12 {
            let a = i as f32 / 12.0 * std::f32::consts::TAU;
            let (px, py) = (cx + a.cos() * rp * dist, cy + a.sin() * rp * dist);
            if px - rp < 0.0 || py - rp < 0.0 || px + rp > w || py + rp > h {
                continue;
            }
            let got = target(px, py);
            let score: f32 = want.iter().zip(&got).map(|(p, q)| (0..3).map(|k| (p[k] - q[k]).abs()).sum::<f32>()).sum::<f32>() + dist * 4.0;
            if score < best.0 {
                best = (score, px, py);
            }
        }
    }
    (best.1 / w, best.2 / h)
}

/// How much a mask applies at a point (0..1), in the frame before cropping.
fn mask_weight(m: &Mask, map: Option<&image::GrayImage>, x: f32, y: f32, aspect: f32) -> f32 {
    if crate::segment::is_smart_kind(&m.kind) {
        let w = map.map_or(0.0, |mp| crate::segment::sample_map(mp, x, y));
        return if m.invert { 1.0 - w } else { w };
    }
    let w = match m.kind.as_str() {
        "linear" => {
            let (dx, dy) = (m.x2 - m.x1, (m.y2 - m.y1) / aspect);
            let len2 = dx * dx + dy * dy;
            if len2 < 1e-8 {
                0.0
            } else {
                let t = ((x - m.x1) * dx + (y - m.y1) / aspect * dy) / len2;
                1.0 - smoothstep(t)
            }
        }
        _ => {
            let (rx, ry) = (m.x2.abs().max(1e-3), m.y2.abs().max(1e-3));
            let d = (((x - m.x1) / rx).powi(2) + ((y - m.y1) / ry).powi(2)).sqrt();
            let f = (m.feather / 100.0).clamp(0.01, 1.0);
            1.0 - smoothstep((d - (1.0 - f)) / f)
        }
    };
    if m.invert { 1.0 - w } else { w }
}

/// Local adjustments on the finished picture. `frame` maps the cropped picture back to the
/// frame masks are placed in: [x, y, w, h] as in `Edits::crop`.
fn apply_masks(img: &mut RgbImage, masks: &[Mask], maps: &[Option<image::GrayImage>], frame: [f32; 4], full_aspect: f32) {
    let active: Vec<(&Mask, Option<&image::GrayImage>)> = masks
        .iter()
        .zip(maps.iter().map(|m| m.as_ref()).chain(std::iter::repeat(None)))
        .filter(|(m, _)| [m.exposure, m.contrast, m.highlights, m.shadows, m.saturation, m.temperature].iter().any(|v| *v != 0.0))
        .collect();
    if active.is_empty() {
        return;
    }
    let (w, h) = (img.width() as f32, img.height() as f32);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let fx = frame[0] + (x as f32 + 0.5) / w * frame[2];
        let fy = frame[1] + (y as f32 + 0.5) / h * frame[3];
        let mut c = [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0];
        for (m, map) in &active {
            let a = mask_weight(m, *map, fx, fy, full_aspect);
            if a <= 1e-3 {
                continue;
            }
            let gain = 2f32.powf(m.exposure * a);
            let t = m.temperature / 100.0 * a;
            let wb = [gain * (1.0 + 0.25 * t), gain, gain * (1.0 - 0.25 * t)];
            for k in 0..3 {
                c[k] = linear_to_srgb(srgb_to_linear(c[k]) * wb[k]);
            }
            let l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            let delta = (m.shadows / 100.0 * 0.35 * (1.0 - l).powi(2) + m.highlights / 100.0 * 0.35 * l * l) * a;
            let k = 1.0 + m.contrast / 100.0 * a;
            for v in c.iter_mut() {
                *v = ((*v + delta - 0.5) * k + 0.5).clamp(0.0, 1.0);
            }
            if m.saturation != 0.0 {
                let l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
                let s = 1.0 + m.saturation / 100.0 * a;
                for v in c.iter_mut() {
                    *v = (l + (*v - l) * s).clamp(0.0, 1.0);
                }
            }
        }
        for k in 0..3 {
            p[k] = (c[k] * 255.0 + 0.5) as u8;
        }
    }
}

/// Sky and subject masks for this picture (in the frame before cropping), one per mask.
fn smart_maps(img: &RgbImage, masks: &[Mask]) -> Vec<Option<image::GrayImage>> {
    masks
        .iter()
        .map(|m| {
            let busy = [m.exposure, m.contrast, m.highlights, m.shadows, m.saturation, m.temperature].iter().any(|v| *v != 0.0);
            if !busy || !crate::segment::is_smart_kind(&m.kind) {
                return None;
            }
            crate::segment::smart_map(&m.kind, img).map(|mp| crate::segment::feathered(&mp, m.feather))
        })
        .collect()
}

/// A sky or subject mask as the editor shows it: 0..255 over the frame before cropping.
pub fn mask_overlay(img: &DynamicImage, e: &Edits, kind: &str) -> Option<image::GrayImage> {
    let mut base = geometry(img, e);
    if !e.spots.is_empty() {
        heal(&mut base, &e.spots);
    }
    crate::segment::smart_map(kind, &base)
}

/// Turn, heal, crop, then run the colour pipeline and local adjustments.
pub fn apply(img: &DynamicImage, e: &Edits) -> RgbImage {
    let mut base = geometry(img, e);
    if !e.spots.is_empty() {
        heal(&mut base, &e.spots);
    }
    let full_aspect = base.width() as f32 / base.height().max(1) as f32;
    let maps = smart_maps(&base, &e.masks);
    let mut frame = [0.0, 0.0, 1.0, 1.0];
    if let Some([x, y, w, h]) = e.crop {
        let (iw, ih) = (base.width() as f32, base.height() as f32);
        let cx = (x.clamp(0.0, 1.0) * iw) as u32;
        let cy = (y.clamp(0.0, 1.0) * ih) as u32;
        let cw = ((w.clamp(0.01, 1.0) * iw) as u32).min(base.width() - cx).max(1);
        let ch = ((h.clamp(0.01, 1.0) * ih) as u32).min(base.height() - cy).max(1);
        frame = [cx as f32 / iw, cy as f32 / ih, cw as f32 / iw, ch as f32 / ih];
        base = imageops::crop_imm(&base, cx, cy, cw, ch).to_image();
    }
    let geometry_only = Edits { crop: None, rotate: 0, straighten: 0.0, distortion: 0.0, fringing: 0.0, lens_vignette: 0.0, spots: vec![], masks: vec![], ..e.clone() };
    if is_default(&geometry_only) {
        apply_masks(&mut base, &e.masks, &maps, frame, full_aspect);
        return base;
    }

    let to_lin: Vec<f32> = (0..256).map(|v| srgb_to_linear(v as f32 / 255.0)).collect();
    let curve = if e.curve.is_empty() { None } else { Some(curve_lut(&e.curve)) };
    let gain = 2f32.powf(e.exposure);
    let temp = e.temperature / 100.0;
    let tint = e.tint / 100.0;
    let wb = [gain * (1.0 + 0.25 * temp), gain * (1.0 - 0.2 * tint), gain * (1.0 - 0.25 * temp)];
    let contrast = 1.0 + e.contrast / 100.0;
    let (hi, sh) = (e.highlights / 100.0, e.shadows / 100.0);
    let (wh, bl) = (e.whites / 100.0, e.blacks / 100.0);
    // Dehaze: pull the haze floor down and stretch, plus a little colour back.
    let haze = e.dehaze / 100.0 * 0.12;
    let (sat, vib) = (e.saturation / 100.0, e.vibrance / 100.0);
    let hsl_on = e.hsl.iter().any(|b| b.iter().any(|v| *v != 0.0));

    for px in base.pixels_mut() {
        // Light and white balance in linear light, like a camera.
        let mut c = [0f32; 3];
        for k in 0..3 {
            c[k] = linear_to_srgb(to_lin[px[k] as usize] * wb[k]);
        }
        // Highlights and shadows: lift or recover by brightness zone.
        let l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        let delta = sh * 0.35 * (1.0 - l).powi(2) * (1.0 - (1.0 - l).powi(6)).max(0.0) + hi * 0.35 * l.powi(2)
            + wh * 0.25 * l.powi(4) + bl * 0.25 * (1.0 - l).powi(4);
        for v in c.iter_mut() {
            *v = ((*v + delta - 0.5) * contrast + 0.5).clamp(0.0, 1.0);
            if haze != 0.0 {
                *v = ((*v - haze) / (1.0 - haze)).clamp(0.0, 1.0);
            }
        }
        if let Some(lut) = &curve {
            for v in c.iter_mut() {
                let f = *v * 255.0;
                let i = f.floor() as usize;
                let t = f - i as f32;
                *v = if i >= 255 { lut[255] } else { lut[i] * (1.0 - t) + lut[i + 1] * t };
            }
        }
        let sat = sat + e.dehaze / 100.0 * 0.25;
        if sat != 0.0 || vib != 0.0 || hsl_on {
            let (mut h, mut s, mut l) = rgb_to_hsl(c[0], c[1], c[2]);
            if hsl_on && s > 0.0 {
                let w = band_weights(h);
                let (mut dh, mut ds, mut dl) = (0.0, 0.0, 0.0);
                for i in 0..8 {
                    dh += w[i] * e.hsl[i][0];
                    ds += w[i] * e.hsl[i][1];
                    dl += w[i] * e.hsl[i][2];
                }
                h += dh / 100.0 * 30.0;
                s *= 1.0 + ds / 100.0;
                l += dl / 100.0 * 0.3 * s.min(1.0);
            }
            // Vibrance boosts muted colours more than strong ones.
            s = s * (1.0 + sat) + vib * (1.0 - s).max(0.0) * s;
            let (r, g, b) = hsl_to_rgb(h, s.clamp(0.0, 1.0), l.clamp(0.0, 1.0));
            c = [r, g, b];
        }
        for k in 0..3 {
            px[k] = (c[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    spatial(&mut base, e);
    apply_masks(&mut base, &e.masks, &maps, frame, full_aspect);
    base
}

/// Box blur of one channel, run twice for a smoother, near-Gaussian result. O(pixels).
fn blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let pass = |src: &[f32], horizontal: bool| -> Vec<f32> {
        let mut out = vec![0.0; src.len()];
        let (n, lines) = if horizontal { (w, h) } else { (h, w) };
        let at = |line: usize, i: usize| if horizontal { line * w + i } else { i * w + line };
        let norm = 1.0 / (2 * r + 1) as f32;
        for line in 0..lines {
            let get = |i: isize| src[at(line, i.clamp(0, n as isize - 1) as usize)];
            let mut acc: f32 = (-(r as isize)..=r as isize).map(get).sum();
            for i in 0..n {
                out[at(line, i)] = acc * norm;
                acc += get(i as isize + r as isize + 1) - get(i as isize - r as isize);
            }
        }
        out
    };
    let mut b = src.to_vec();
    for _ in 0..2 {
        b = pass(&pass(&b, true), false);
    }
    b
}

/// Effects that need neighbouring pixels: noise reduction, clarity, sharpening and vignette.
/// They work on brightness, so colours don't shift.
fn spatial(img: &mut RgbImage, e: &Edits) {
    if e.noise == 0.0 && e.clarity == 0.0 && e.sharpening == 0.0 && e.vignette == 0.0 {
        return;
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let luma: Vec<f32> = img.pixels().map(|p| (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0).collect();
    let mut target = luma.clone();
    if e.noise > 0.0 {
        // Smooth only where the difference is small (grain), keep edges.
        let soft = blur(&luma, w, h, 1);
        let k = e.noise / 100.0;
        for i in 0..target.len() {
            let d = (soft[i] - luma[i]).abs();
            let keep_edge = (1.0 - d / 0.08).clamp(0.0, 1.0);
            target[i] += (soft[i] - luma[i]) * k * keep_edge;
        }
    }
    if e.clarity != 0.0 {
        let r = (w.max(h) / 80).max(2);
        let wide = blur(&target, w, h, r);
        let k = e.clarity / 100.0 * 0.8;
        for i in 0..target.len() {
            // Midtones get the most, so highlights and shadows don't clip.
            let mid = 1.0 - (2.0 * target[i] - 1.0).powi(2);
            target[i] += (target[i] - wide[i]) * k * mid;
        }
    }
    if e.sharpening > 0.0 {
        let fine = blur(&target, w, h, 1);
        let k = e.sharpening / 100.0 * 1.2;
        for i in 0..target.len() {
            target[i] += (target[i] - fine[i]) * k;
        }
    }
    let vig = e.vignette / 100.0;
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let rmax = (cx * cx + cy * cy).sqrt().max(1.0);
    for (i, p) in img.pixels_mut().enumerate() {
        let mut gain = if luma[i] > 1e-4 { target[i].max(0.0) / luma[i] } else { 1.0 };
        let mut add = if luma[i] > 1e-4 { 0.0 } else { target[i].max(0.0) };
        if vig != 0.0 {
            let (x, y) = ((i % w) as f32 + 0.5 - cx, (i / w) as f32 + 0.5 - cy);
            let d = ((x * x + y * y).sqrt() / rmax).powi(2);
            let f = (d - 0.15).max(0.0) / 0.85;
            if vig < 0.0 {
                gain *= 1.0 + vig * 0.8 * f;
            } else {
                add += vig * 0.5 * f * (1.0 - target[i].clamp(0.0, 1.0));
            }
        }
        for k in 0..3 {
            let v = p[k] as f32 / 255.0 * gain + add;
            p[k] = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
}

/// 64-bucket brightness histogram, normalised so the tallest bar is 1.
pub fn histogram(img: &RgbImage) -> Vec<f32> {
    let mut h = vec![0u32; 64];
    for p in img.pixels() {
        let l = (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) as usize;
        h[(l / 4).min(63)] += 1;
    }
    let max = *h.iter().max().unwrap_or(&1) as f32;
    h.into_iter().map(|v| v as f32 / max.max(1.0)).collect()
}

// ---------- saved edits and presets ----------

pub fn load_edits(cat: &Catalogue, item_id: i64) -> Result<Edits> {
    let json: Option<String> = cat
        .conn
        .query_row("SELECT json FROM edits WHERE item_id = ?1", [item_id], |r| r.get(0))
        .optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
}

pub fn save_edits(cat: &Catalogue, item_id: i64, e: &Edits) -> Result<()> {
    if is_default(e) {
        cat.conn.execute("DELETE FROM edits WHERE item_id = ?1", [item_id])?;
    } else {
        let json = serde_json::to_string(e).map_err(|x| crate::Error::Other(x.to_string()))?;
        cat.conn.execute(
            "INSERT INTO edits(item_id, json) VALUES (?1, ?2) ON CONFLICT(item_id) DO UPDATE SET json = excluded.json",
            params![item_id, json],
        )?;
    }
    Ok(())
}

/// Copy one photo's look onto others, keeping each photo's own crop and rotation.
/// Returns what each photo had before, so the paste can be undone.
pub fn paste_look(cat: &Catalogue, ids: &[i64], look: &Edits) -> Result<Vec<(i64, Edits)>> {
    let mut before = Vec::with_capacity(ids.len());
    for &id in ids {
        let old = load_edits(cat, id)?;
        // Framing and spot fixes belong to each photo; the look (including masks) is copied.
        save_edits(cat, id, &Edits { crop: old.crop, rotate: old.rotate, straighten: old.straighten, spots: old.spots.clone(), ..look.clone() })?;
        before.push((id, old));
    }
    Ok(before)
}

/// Put back edits saved by `paste_look`.
pub fn restore_edits(cat: &Catalogue, edits: &[(i64, Edits)]) -> Result<()> {
    for (id, e) in edits {
        save_edits(cat, *id, e)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: i64,
    pub name: String,
    pub edits: Edits,
}

fn builtin_presets() -> Vec<(&'static str, Edits)> {
    let mut hsl = [[0.0; 3]; 8];
    hsl[1] = [-10.0, 15.0, 5.0];
    hsl[5] = [0.0, -20.0, 0.0];
    vec![
        ("Safelight Warm", Edits { exposure: 0.1, contrast: 10.0, temperature: 18.0, vibrance: 15.0, shadows: 10.0, hsl, ..Default::default() }),
        ("Film 400", Edits { contrast: -10.0, highlights: -25.0, saturation: -12.0, temperature: 8.0, curve: vec![[0.0, 0.06], [0.25, 0.24], [0.75, 0.78], [1.0, 0.95]], ..Default::default() }),
        ("Faded Matte", Edits { contrast: -20.0, saturation: -20.0, curve: vec![[0.0, 0.12], [0.5, 0.52], [1.0, 0.93]], ..Default::default() }),
        ("Clean B&W", Edits { saturation: -100.0, contrast: 18.0, shadows: 8.0, ..Default::default() }),
        ("Golden Hour", Edits { exposure: 0.15, temperature: 35.0, tint: 6.0, vibrance: 20.0, highlights: -15.0, ..Default::default() }),
        ("Night City", Edits { exposure: -0.2, contrast: 15.0, temperature: -22.0, vibrance: 25.0, shadows: -10.0, ..Default::default() }),
    ]
}

pub fn presets(cat: &Catalogue) -> Result<Vec<Preset>> {
    let count: i64 = cat.conn.query_row("SELECT COUNT(*) FROM presets", [], |r| r.get(0))?;
    if count == 0 && cat.setting("presets_seeded")?.is_none() {
        for (name, e) in builtin_presets() {
            save_preset(cat, name, &e)?;
        }
        cat.set_setting("presets_seeded", "1")?;
    }
    let rows: Vec<(i64, String, String)> = cat
        .conn
        .prepare("SELECT id, name, json FROM presets ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, json)| Preset { id, name, edits: serde_json::from_str(&json).unwrap_or_default() })
        .collect())
}

/// Presets carry look, not framing: crop and rotation are left out.
pub fn save_preset(cat: &Catalogue, name: &str, e: &Edits) -> Result<i64> {
    let look = Edits { crop: None, rotate: 0, straighten: 0.0, spots: vec![], masks: vec![], ..e.clone() };
    let json = serde_json::to_string(&look).map_err(|x| crate::Error::Other(x.to_string()))?;
    cat.conn.execute(
        "INSERT INTO presets(name, json) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET json = excluded.json",
        params![name.trim(), json],
    )?;
    Ok(cat.conn.query_row("SELECT id FROM presets WHERE name = ?1", [name.trim()], |r| r.get(0))?)
}

pub fn delete_preset(cat: &Catalogue, id: i64) -> Result<()> {
    cat.conn.execute("DELETE FROM presets WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_curve_is_straight() {
        let lut = curve_lut(&[]);
        for (i, v) in lut.iter().enumerate() {
            assert!((v - i as f32 / 255.0).abs() < 1e-3);
        }
    }
    #[test]
    fn curve_is_monotone() {
        let lut = curve_lut(&[[0.25, 0.1], [0.5, 0.6], [0.75, 0.95]]);
        assert!(lut.windows(2).all(|w| w[1] >= w[0] - 1e-6));
    }
    #[test]
    fn default_edits_leave_pixels_alone_and_exposure_brightens() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(4, 4, |x, y| image::Rgb([(x * 60) as u8, (y * 60) as u8, 128])));
        assert_eq!(apply(&img, &Edits::default()), img.to_rgb8());
        let brighter = apply(&img, &Edits { exposure: 1.0, ..Default::default() });
        let sum = |i: &RgbImage| i.pixels().map(|p| p[0] as u32 + p[1] as u32 + p[2] as u32).sum::<u32>();
        assert!(sum(&brighter) > sum(&img.to_rgb8()));
        let bw = apply(&img, &Edits { saturation: -100.0, ..Default::default() });
        assert!(bw.pixels().all(|p| p[0].abs_diff(p[1]) <= 1 && p[1].abs_diff(p[2]) <= 1));
    }
    #[test]
    fn rotate_and_crop() {
        let img = DynamicImage::ImageRgb8(RgbImage::new(40, 20));
        let out = apply(&img, &Edits { rotate: 1, crop: Some([0.0, 0.0, 0.5, 0.5]), ..Default::default() });
        assert_eq!((out.width(), out.height()), (10, 20));
    }
    #[test]
    fn new_sliders_do_something_and_old_recipes_still_load() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(64, 48, |x, y| {
            let v = ((x * 3 + y * 2) % 200 + 20) as u8;
            image::Rgb([v, v.saturating_sub(10), v.saturating_add(10)])
        }));
        let base = img.to_rgb8();
        for e in [
            Edits { whites: 60.0, ..Default::default() },
            Edits { blacks: -60.0, ..Default::default() },
            Edits { clarity: 80.0, ..Default::default() },
            Edits { dehaze: 50.0, ..Default::default() },
            Edits { sharpening: 100.0, ..Default::default() },
            Edits { noise: 80.0, ..Default::default() },
            Edits { vignette: -80.0, ..Default::default() },
            Edits { vignette: 80.0, ..Default::default() },
        ] {
            let out = apply(&img, &e);
            assert_eq!(out.dimensions(), base.dimensions());
            assert_ne!(out, base, "{e:?} changed nothing");
        }
        // A dark vignette darkens the corner more than the centre.
        let v = apply(&img, &Edits { vignette: -100.0, ..Default::default() });
        let corner = base.get_pixel(0, 0)[0] as i32 - v.get_pixel(0, 0)[0] as i32;
        let centre = base.get_pixel(32, 24)[0] as i32 - v.get_pixel(32, 24)[0] as i32;
        assert!(corner > centre);
        // Recipes saved before these sliders existed still load.
        let old: Edits = serde_json::from_str(r#"{"exposure":0.5,"contrast":10}"#).unwrap();
        assert_eq!(old.clarity, 0.0);
        assert_eq!(old.exposure, 0.5);
    }
    #[test]
    fn straighten_fills_the_frame_and_lens_fixes_change_pixels() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(80, 60, |x, y| image::Rgb([(x * 3) as u8, (y * 4) as u8, 200])));
        let out = apply(&img, &Edits { straighten: 10.0, ..Default::default() });
        assert_eq!(out.dimensions(), (80, 60));
        // No black corners: the corner pixel still has the blue of the picture.
        assert!(out.get_pixel(0, 0)[2] > 150);
        let big = DynamicImage::ImageRgb8(RgbImage::from_fn(600, 400, |x, y| image::Rgb([((x / 7) % 2 * 200) as u8, (y % 255) as u8, 90])));
        for e in [Edits { distortion: -60.0, ..Default::default() }, Edits { fringing: 80.0, ..Default::default() }, Edits { lens_vignette: 80.0, ..Default::default() }] {
            assert!(apply(&big, &e) != big.to_rgb8(), "{e:?} changed nothing");
        }
    }
    #[test]
    fn healing_removes_a_dust_spot() {
        let mut raw = RgbImage::from_pixel(100, 100, image::Rgb([120, 130, 140]));
        for y in 45..55 { for x in 45..55 { raw.put_pixel(x, y, image::Rgb([10, 10, 10])); } }
        let img = DynamicImage::ImageRgb8(raw);
        let (sx, sy) = find_spot_source(&img.to_rgb8(), 0.5, 0.5, 0.08);
        assert!((sx - 0.5).abs() > 0.1 || (sy - 0.5).abs() > 0.1, "source is somewhere else");
        let out = apply(&img, &Edits { spots: vec![Spot { x: 0.5, y: 0.5, r: 0.08, sx, sy }], ..Default::default() });
        let p = out.get_pixel(50, 50);
        assert!(p[0] > 100, "spot healed: {p:?}");
    }
    #[test]
    fn masks_only_touch_their_area() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 50, image::Rgb([100, 100, 100])));
        let radial = Mask { kind: "radial".into(), x1: 0.25, y1: 0.5, x2: 0.15, y2: 0.3, feather: 20.0, exposure: 1.0, ..Default::default() };
        let out = apply(&img, &Edits { masks: vec![radial.clone()], ..Default::default() });
        assert!(out.get_pixel(25, 25)[0] > 130, "inside brighter");
        assert_eq!(out.get_pixel(90, 25)[0], 100, "outside untouched");
        let inv = apply(&img, &Edits { masks: vec![Mask { invert: true, ..radial }], ..Default::default() });
        assert_eq!(inv.get_pixel(25, 25)[0], 100);
        let sky = Mask { kind: "linear".into(), x1: 0.5, y1: 0.0, x2: 0.5, y2: 0.5, exposure: -1.0, ..Default::default() };
        let out = apply(&img, &Edits { masks: vec![sky], ..Default::default() });
        assert!(out.get_pixel(50, 2)[0] < 80 && out.get_pixel(50, 45)[0] == 100);
    }
    #[test]
    fn blur_keeps_flat_areas_flat() {
        let flat = vec![0.4f32; 30 * 20];
        assert!(blur(&flat, 30, 20, 3).iter().all(|v| (v - 0.4).abs() < 1e-5));
    }
    #[test]
    fn hsl_round_trip() {
        for (r, g, b) in [(0.2, 0.4, 0.8), (0.9, 0.1, 0.1), (0.5, 0.5, 0.5)] {
            let (h, s, l) = rgb_to_hsl(r, g, b);
            let (r2, g2, b2) = hsl_to_rgb(h, s, l);
            assert!((r - r2).abs() < 1e-4 && (g - g2).abs() < 1e-4 && (b - b2).abs() < 1e-4);
        }
    }
}
