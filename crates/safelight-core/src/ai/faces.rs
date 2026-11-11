//! Faces: YuNet finds them (with eye, nose and mouth points), SFace turns each one into a
//! 128-number signature. Two signatures of the same person point the same way.

use super::{model_err, normalise};
use crate::Result;
use image::{imageops::FilterType, DynamicImage, GenericImageView, RgbImage};
use std::{path::Path, sync::Arc};
use tract_onnx::prelude::*;

type Plan = Arc<TypedRunnableModel>;

const DET_SIDE: usize = 640;
const MIN_SCORE: f32 = 0.8;
const NMS_IOU: f32 = 0.3;
/// Faces smaller than this (pixels, on the detector's 640 canvas) are too small to recognise.
const MIN_FACE: f32 = 22.0;
/// Side of the face crop kept for the People screen; sharpness is measured on it too.
pub const CROP_SIDE: u32 = 160;
/// Faces whose crop scores below this on [`sharpness`] are too blurred to tell who it is,
/// so they're left out of People (they only split one person into lots of look-alike groups).
pub const MIN_SHARPNESS: f32 = 50.0;
/// Cosine above which two face signatures are the same person (SFace's published threshold is 0.363;
/// a little stricter keeps different people apart).
pub const SAME_PERSON: f32 = 0.42;

/// Where a face is, in the analysed picture's pixels.
#[derive(Debug, Clone)]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    /// Right eye, left eye, nose tip, right and left mouth corners.
    pub points: [(f32, f32); 5],
}

pub struct FaceEngine {
    detect: Plan,
    recognise: Plan,
    det_names: Vec<String>,
}

impl FaceEngine {
    pub fn load(detect: &Path, recognise: &Path) -> Result<Self> {
        let mut det = tract_onnx::onnx().model_for_path(detect).map_err(model_err)?;
        det.set_input_fact(0, f32::fact([1, 3, DET_SIDE, DET_SIDE]).into()).map_err(model_err)?;
        let det_names = det
            .output_outlets()
            .map_err(model_err)?
            .iter()
            .map(|o| det.outlet_label(*o).map(str::to_string).unwrap_or_else(|| det.node(o.node).name.clone()))
            .collect();
        let detect = det.into_optimized().map_err(model_err)?.into_runnable().map_err(model_err)?;
        let mut rec = tract_onnx::onnx().model_for_path(recognise).map_err(model_err)?;
        rec.set_input_fact(0, f32::fact([1, 3, 112, 112]).into()).map_err(model_err)?;
        let recognise = rec.into_optimized().map_err(model_err)?.into_runnable().map_err(model_err)?;
        Ok(Self { detect, recognise, det_names })
    }

    /// Faces in `img`, best first.
    pub fn detect(&self, img: &DynamicImage) -> Result<Vec<Face>> {
        let (w, h) = img.dimensions();
        let scale = DET_SIDE as f32 / w.max(h).max(1) as f32;
        let (nw, nh) = (((w as f32 * scale) as u32).clamp(1, DET_SIDE as u32), ((h as f32 * scale) as u32).clamp(1, DET_SIDE as u32));
        let small = img.resize_exact(nw, nh, FilterType::Triangle).to_rgb8();
        // YuNet wants BGR, 0-255, padded with black to 640×640.
        let input = tract_ndarray::Array4::from_shape_fn((1, 3, DET_SIDE, DET_SIDE), |(_, c, y, x)| {
            if x as u32 >= nw || y as u32 >= nh {
                0.0
            } else {
                small.get_pixel(x as u32, y as u32)[2 - c] as f32
            }
        })
        .into_tensor();
        let out = self.detect.run(tvec!(input.into())).map_err(model_err)?;
        let get = |name: &str| -> Result<Vec<f32>> {
            let i = self.det_names.iter().position(|n| n == name).ok_or_else(|| model_err(format!("face model has no {name} output")))?;
            Ok(out[i].to_plain_array_view::<f32>().map_err(model_err)?.iter().copied().collect())
        };
        let mut faces = Vec::new();
        for stride in [8usize, 16, 32] {
            let (cls, obj, bbox, kps) = (get(&format!("cls_{stride}"))?, get(&format!("obj_{stride}"))?, get(&format!("bbox_{stride}"))?, get(&format!("kps_{stride}"))?);
            let cols = DET_SIDE / stride;
            for (idx, (&c, &o)) in cls.iter().zip(&obj).enumerate() {
                let score = (c.clamp(0.0, 1.0) * o.clamp(0.0, 1.0)).sqrt();
                if score < MIN_SCORE {
                    continue;
                }
                let (col, row, s) = ((idx % cols) as f32, (idx / cols) as f32, stride as f32);
                let b = &bbox[idx * 4..idx * 4 + 4];
                let (cx, cy, bw, bh) = ((col + b[0]) * s, (row + b[1]) * s, b[2].exp() * s, b[3].exp() * s);
                if bw < MIN_FACE || bh < MIN_FACE {
                    continue;
                }
                let k = &kps[idx * 10..idx * 10 + 10];
                let mut points = [(0.0, 0.0); 5];
                for (n, p) in points.iter_mut().enumerate() {
                    *p = (((k[n * 2] + col) * s) / scale, ((k[n * 2 + 1] + row) * s) / scale);
                }
                faces.push(Face { x: (cx - bw / 2.0) / scale, y: (cy - bh / 2.0) / scale, w: bw / scale, h: bh / scale, score, points });
            }
        }
        Ok(nms(faces))
    }

    /// Unit-length signature for one face.
    pub fn signature(&self, img: &DynamicImage, face: &Face) -> Result<Vec<f32>> {
        let aligned = align(&img.to_rgb8(), &face.points);
        let input = tract_ndarray::Array4::from_shape_fn((1, 3, 112, 112), |(_, c, y, x)| aligned.get_pixel(x as u32, y as u32)[c] as f32).into_tensor();
        let out = self.recognise.run(tvec!(input.into())).map_err(model_err)?;
        let mut v: Vec<f32> = out[0].to_plain_array_view::<f32>().map_err(model_err)?.iter().copied().collect();
        normalise(&mut v);
        Ok(v)
    }
}

pub(crate) fn iou(a: &Face, b: &Face) -> f32 {
    let (x1, y1) = (a.x.max(b.x), a.y.max(b.y));
    let (x2, y2) = ((a.x + a.w).min(b.x + b.w), (a.y + a.h).min(b.y + b.h));
    let inter = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    inter / (a.w * a.h + b.w * b.h - inter).max(1e-6)
}

fn nms(mut faces: Vec<Face>) -> Vec<Face> {
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Face> = Vec::new();
    for f in faces {
        if kept.iter().all(|k| iou(k, &f) < NMS_IOU) {
            kept.push(f);
        }
    }
    kept
}

/// Where the five face points sit on SFace's 112×112 input (the standard ArcFace layout).
const TEMPLATE: [(f32, f32); 5] = [(38.2946, 51.6963), (73.5318, 51.5014), (56.0252, 71.7366), (41.5493, 92.3655), (70.7299, 92.2041)];

/// Best rotation + scale + shift taking `src` points onto `dst` (least squares, no mirroring).
/// Returns (a, b, tx, ty) for x' = a·x − b·y + tx, y' = b·x + a·y + ty.
pub(crate) fn similarity(src: &[(f32, f32); 5], dst: &[(f32, f32); 5]) -> (f32, f32, f32, f32) {
    let mean = |p: &[(f32, f32); 5]| (p.iter().map(|q| q.0).sum::<f32>() / 5.0, p.iter().map(|q| q.1).sum::<f32>() / 5.0);
    let ((msx, msy), (mdx, mdy)) = (mean(src), mean(dst));
    let (mut num_a, mut num_b, mut den) = (0.0, 0.0, 0.0);
    for (s, d) in src.iter().zip(dst) {
        let (sx, sy, dx, dy) = (s.0 - msx, s.1 - msy, d.0 - mdx, d.1 - mdy);
        num_a += sx * dx + sy * dy;
        num_b += sx * dy - sy * dx;
        den += sx * sx + sy * sy;
    }
    let (a, b) = if den > 0.0 { (num_a / den, num_b / den) } else { (1.0, 0.0) };
    (a, b, mdx - (a * msx - b * msy), mdy - (b * msx + a * msy))
}

/// Cut the face out, upright and at the size and position the recogniser expects.
fn align(img: &RgbImage, points: &[(f32, f32); 5]) -> RgbImage {
    let (a, b, tx, ty) = similarity(points, &TEMPLATE);
    let det = (a * a + b * b).max(1e-9);
    let (w, h) = (img.width() as f32, img.height() as f32);
    RgbImage::from_fn(112, 112, |u, v| {
        let (du, dv) = (u as f32 - tx, v as f32 - ty);
        let (x, y) = ((a * du + b * dv) / det, (-b * du + a * dv) / det);
        if x < 0.0 || y < 0.0 || x > w - 1.0 || y > h - 1.0 {
            return image::Rgb([0, 0, 0]);
        }
        let (x0, y0) = (x.floor() as u32, y.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(img.width() - 1), (y0 + 1).min(img.height() - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let mut px = [0u8; 3];
        for (c, out) in px.iter_mut().enumerate() {
            let p = |xx, yy| img.get_pixel(xx, yy)[c] as f32;
            let top = p(x0, y0) * (1.0 - fx) + p(x1, y0) * fx;
            let bot = p(x0, y1) * (1.0 - fx) + p(x1, y1) * fx;
            *out = (top * (1.0 - fy) + bot * fy).round() as u8;
        }
        image::Rgb(px)
    })
}

/// A square crop around the face for the People screen.
pub fn crop(img: &DynamicImage, face: &Face, size: u32) -> DynamicImage {
    let side = face.w.max(face.h) * 1.6;
    let (cx, cy) = (face.x + face.w / 2.0, face.y + face.h / 2.0);
    let x = (cx - side / 2.0).max(0.0) as u32;
    let y = (cy - side / 2.0).max(0.0) as u32;
    let s = (side as u32).min(img.width().saturating_sub(x)).min(img.height().saturating_sub(y)).max(1);
    img.crop_imm(x, y, s, s).resize_exact(size, size, FilterType::CatmullRom)
}

/// How sharp a face crop is: the spread of the edge filter (variance of the Laplacian) over the
/// middle of the crop, where the face is. Crisp faces score in the hundreds; out of focus, shaken
/// or tiny blown-up faces score in single or low double figures.
pub fn sharpness(crop: &DynamicImage) -> f32 {
    let g = crop.resize_exact(CROP_SIDE, CROP_SIDE, FilterType::Triangle).to_luma8();
    // The crop is 1.6× the face, so the face sits in roughly the middle 60%.
    let (lo, hi) = (CROP_SIDE * 2 / 10, CROP_SIDE * 8 / 10);
    let px = |x: u32, y: u32| g.get_pixel(x, y)[0] as f32;
    let (mut sum, mut sq, mut n) = (0.0f64, 0.0f64, 0.0f64);
    for y in lo..hi {
        for x in lo..hi {
            let l = (px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1) - 4.0 * px(x, y)) as f64;
            sum += l;
            sq += l * l;
            n += 1.0;
        }
    }
    let mean = sum / n;
    (sq / n - mean * mean) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_recovers_a_known_transform() {
        // Rotate 30°, scale 2, shift (5, -3).
        let (c, s) = (30f32.to_radians().cos() * 2.0, 30f32.to_radians().sin() * 2.0);
        let mut moved = [(0.0, 0.0); 5];
        for (m, p) in moved.iter_mut().zip(TEMPLATE) {
            *m = (c * p.0 - s * p.1 + 5.0, s * p.0 + c * p.1 - 3.0);
        }
        let (a, b, tx, ty) = similarity(&TEMPLATE, &moved);
        assert!((a - c).abs() < 1e-3 && (b - s).abs() < 1e-3 && (tx - 5.0).abs() < 1e-2 && (ty + 3.0).abs() < 1e-2);
    }

    /// Runs only when SAFELIGHT_MODELS points at the downloaded models (CI does this).
    #[test]
    fn faces_found_and_told_apart() {
        let Some(dir) = crate::ai::test_models(&["face-detect.onnx", "face-recognise.onnx", "test-face-a.jpg", "test-face-b.jpg"]) else { return };
        let eng = FaceEngine::load(&dir.join("face-detect.onnx"), &dir.join("face-recognise.onnx")).unwrap();
        let a = image::open(dir.join("test-face-a.jpg")).expect("test-face-a.jpg next to the models");
        let b = image::open(dir.join("test-face-b.jpg")).expect("test-face-b.jpg next to the models");
        let fa = eng.detect(&a).unwrap();
        let fb = eng.detect(&b).unwrap();
        assert!(!fa.is_empty() && !fb.is_empty(), "faces: {} and {}", fa.len(), fb.len());
        let sa = eng.signature(&a, &fa[0]).unwrap();
        // The same photo, smaller and flipped, is still the same person.
        let a2 = a.resize(a.width() * 3 / 4, a.height() * 3 / 4, FilterType::Triangle).fliph();
        let fa2 = eng.detect(&a2).unwrap();
        let sa2 = eng.signature(&a2, &fa2[0]).unwrap();
        let sb = eng.signature(&b, &fb[0]).unwrap();
        let (same, diff) = (super::super::dot(&sa, &sa2), super::super::dot(&sa, &sb));
        eprintln!("same person {same}, different people {diff}");
        assert!(same > SAME_PERSON && diff < SAME_PERSON, "same {same}, diff {diff}");

        // Sharp faces pass the blur check; the same face out of focus doesn't.
        for (name, img, face) in [("a", &a, &fa[0]), ("b", &b, &fb[0])] {
            let sharp = sharpness(&crop(img, face, CROP_SIDE));
            let sigma = face.w.max(face.h) / 40.0;
            let soft = sharpness(&crop(&img.blur(sigma), face, CROP_SIDE));
            let softer = sharpness(&crop(&img.blur(sigma * 2.0), face, CROP_SIDE));
            eprintln!("face {name} ({:.0}px): sharp {sharp:.1}, blurred {soft:.1}, very blurred {softer:.1}", face.w);
            assert!(sharp >= MIN_SHARPNESS && soft < MIN_SHARPNESS, "face {name}: sharp {sharp}, blurred {soft}");
        }
    }
}
