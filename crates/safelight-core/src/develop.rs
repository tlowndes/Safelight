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
    pub temperature: f32,
    pub tint: f32,
    pub vibrance: f32,
    pub saturation: f32,
    /// Tone curve points (input, output), 0..1, sorted by input. Empty = straight line.
    pub curve: Vec<[f32; 2]>,
    /// Per-colour hue, saturation, luminance, each -100..100, for
    /// red, orange, yellow, green, aqua, blue, purple, magenta.
    pub hsl: [[f32; 3]; 8],
    /// Normalised crop rectangle [x, y, w, h], applied after rotation.
    pub crop: Option<[f32; 4]>,
    /// Quarter turns clockwise: 0, 1, 2, 3.
    pub rotate: u8,
}

impl Default for Edits {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            temperature: 0.0,
            tint: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            curve: vec![],
            hsl: [[0.0; 3]; 8],
            crop: None,
            rotate: 0,
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

/// Rotate and crop, then run the colour pipeline.
pub fn apply(img: &DynamicImage, e: &Edits) -> RgbImage {
    let mut base = match e.rotate % 4 {
        1 => img.rotate90(),
        2 => img.rotate180(),
        3 => img.rotate270(),
        _ => img.clone(),
    }
    .to_rgb8();
    if let Some([x, y, w, h]) = e.crop {
        let (iw, ih) = (base.width() as f32, base.height() as f32);
        let cx = (x.clamp(0.0, 1.0) * iw) as u32;
        let cy = (y.clamp(0.0, 1.0) * ih) as u32;
        let cw = ((w.clamp(0.01, 1.0) * iw) as u32).min(base.width() - cx).max(1);
        let ch = ((h.clamp(0.01, 1.0) * ih) as u32).min(base.height() - cy).max(1);
        base = imageops::crop_imm(&base, cx, cy, cw, ch).to_image();
    }
    if is_default(&Edits { crop: None, rotate: 0, ..e.clone() }) {
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
        let delta = sh * 0.35 * (1.0 - l).powi(2) * (1.0 - (1.0 - l).powi(6)).max(0.0) + hi * 0.35 * l.powi(2);
        for v in c.iter_mut() {
            *v = ((*v + delta - 0.5) * contrast + 0.5).clamp(0.0, 1.0);
        }
        if let Some(lut) = &curve {
            for v in c.iter_mut() {
                let f = *v * 255.0;
                let i = f.floor() as usize;
                let t = f - i as f32;
                *v = if i >= 255 { lut[255] } else { lut[i] * (1.0 - t) + lut[i + 1] * t };
            }
        }
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
    base
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
    let look = Edits { crop: None, rotate: 0, ..e.clone() };
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
    fn hsl_round_trip() {
        for (r, g, b) in [(0.2, 0.4, 0.8), (0.9, 0.1, 0.1), (0.5, 0.5, 0.5)] {
            let (h, s, l) = rgb_to_hsl(r, g, b);
            let (r2, g2, b2) = hsl_to_rgb(h, s, l);
            assert!((r - r2).abs() < 1e-4 && (g - g2).abs() < 1e-4 && (b - b2).abs() < 1e-4);
        }
    }
}
