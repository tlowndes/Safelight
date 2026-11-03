//! CLIP: turns pictures and words into vectors in the same space, so "beach at sunset" lands
//! near photos of beaches at sunset. Used for scene and design tags, find-similar and search.

use super::{model_err, normalise};
use crate::Result;
use image::{imageops::FilterType, DynamicImage};
use std::{path::Path, sync::Arc};
use tract_onnx::prelude::*;

type Plan = Arc<TypedRunnableModel>;

pub const DIM: usize = 512;
const SIDE: u32 = 224;
const CONTEXT: usize = 77;
const MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const STD: [f32; 3] = [0.268_629_54, 0.261_302_6, 0.275_777_1];
/// CLIP's end-of-text token, also used as padding.
const EOT: i64 = 49407;

pub struct Clip {
    vision: Plan,
    text: Plan,
    /// How many inputs the text model takes: 1 (ids) or 2 (ids and attention mask).
    text_inputs: usize,
    tokenizer: tokenizers::Tokenizer,
}

/// Load an ONNX model with fixed input shapes, keeping only the output called `want` (or the
/// first output when no output has that name).
fn load(path: &Path, inputs: &[InferenceFact], want: &str) -> Result<(Plan, usize)> {
    let mut model = tract_onnx::onnx().model_for_path(path).map_err(model_err)?;
    let n_inputs = model.input_outlets().map_err(model_err)?.len();
    for i in 0..n_inputs {
        let fact = inputs.get(i).or(inputs.last()).cloned().unwrap_or_default();
        model.set_input_fact(i, fact).map_err(model_err)?;
    }
    let outs = model.output_outlets().map_err(model_err)?.to_vec();
    let chosen = outs
        .iter()
        .find(|o| model.outlet_label(**o).map(|l| l == want).unwrap_or(false) || model.node(o.node).name == want)
        .copied()
        .unwrap_or(outs[0]);
    model.select_output_outlets(&[chosen]).map_err(model_err)?;
    let plan = model.into_optimized().map_err(model_err)?.into_runnable().map_err(model_err)?;
    Ok((plan, n_inputs))
}

impl Clip {
    pub fn load(vision: &Path, text: &Path, tokenizer: &Path) -> Result<Self> {
        let (vision, _) = load(vision, &[f32::fact([1, 3, SIDE as usize, SIDE as usize]).into()], "image_embeds")?;
        let (text, text_inputs) = load(text, &[i64::fact([1, CONTEXT]).into()], "text_embeds")?;
        let tokenizer = tokenizers::Tokenizer::from_file(tokenizer).map_err(model_err)?;
        Ok(Self { vision, text, text_inputs, tokenizer })
    }

    /// Unit-length picture vector.
    pub fn embed_image(&self, img: &DynamicImage) -> Result<Vec<f32>> {
        let input = preprocess(img);
        let out = self.vision.run(tvec!(input.into())).map_err(model_err)?;
        let mut v = out[0].to_plain_array_view::<f32>().map_err(model_err)?.iter().copied().collect::<Vec<_>>();
        normalise(&mut v);
        Ok(v)
    }

    /// Unit-length vector for a phrase.
    pub fn embed_text(&self, text: &str) -> Result<Vec<f32>> {
        let enc = self.tokenizer.encode(text.to_lowercase(), true).map_err(model_err)?;
        let mut ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        if ids.len() > CONTEXT {
            ids.truncate(CONTEXT);
            ids[CONTEXT - 1] = EOT;
        }
        let real = ids.len();
        ids.resize(CONTEXT, EOT);
        let ids_t = tract_ndarray::Array2::from_shape_vec((1, CONTEXT), ids).map_err(model_err)?.into_tensor();
        let mut inputs: TVec<TValue> = tvec!(ids_t.into());
        if self.text_inputs > 1 {
            let mask: Vec<i64> = (0..CONTEXT).map(|i| (i < real) as i64).collect();
            inputs.push(tract_ndarray::Array2::from_shape_vec((1, CONTEXT), mask).map_err(model_err)?.into_tensor().into());
        }
        let out = self.text.run(inputs).map_err(model_err)?;
        let mut v = out[0].to_plain_array_view::<f32>().map_err(model_err)?.iter().copied().collect::<Vec<_>>();
        normalise(&mut v);
        Ok(v)
    }
}

/// Shortest side to 224, centre crop, CLIP's colour normalisation, laid out as 1×3×224×224.
fn preprocess(img: &DynamicImage) -> Tensor {
    let (w, h) = (img.width().max(1), img.height().max(1));
    let scale = SIDE as f32 / w.min(h) as f32;
    let (nw, nh) = (((w as f32 * scale).round() as u32).max(SIDE), ((h as f32 * scale).round() as u32).max(SIDE));
    let resized = img.resize_exact(nw, nh, FilterType::CatmullRom).to_rgb8();
    let (x0, y0) = ((nw - SIDE) / 2, (nh - SIDE) / 2);
    let s = SIDE as usize;
    tract_ndarray::Array4::from_shape_fn((1, 3, s, s), |(_, c, y, x)| {
        let p = resized.get_pixel(x0 + x as u32, y0 + y as u32)[c] as f32 / 255.0;
        (p - MEAN[c]) / STD[c]
    })
    .into_tensor()
}

/// Score `image` against labels, CLIP style: softmax over cosine × 100. Returns (label index,
/// probability) for the labels above `min_prob`, best first, at most `max` of them.
pub fn zero_shot(image: &[f32], labels: &[Vec<f32>], min_prob: f32, max: usize) -> Vec<(usize, f32)> {
    if labels.is_empty() {
        return vec![];
    }
    let logits: Vec<f32> = labels.iter().map(|l| super::dot(image, l) * 100.0).collect();
    let top = logits.iter().cloned().fold(f32::MIN, f32::max);
    let exps: Vec<f32> = logits.iter().map(|l| (l - top).exp()).collect();
    let sum: f32 = exps.iter().sum();
    let mut scored: Vec<(usize, f32)> = exps.iter().map(|e| e / sum).enumerate().filter(|(_, p)| *p >= min_prob).collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(max);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_shot_picks_the_closest_label() {
        let img = vec![1.0, 0.0];
        let labels = vec![vec![0.0, 1.0], vec![0.995, 0.0998], vec![0.7071, 0.7071]];
        let got = zero_shot(&img, &labels, 0.05, 2);
        assert_eq!(got[0].0, 1);
        assert!(got.len() <= 2);
    }

    /// Runs only when SAFELIGHT_MODELS points at the downloaded models (CI does this).
    #[test]
    fn clip_matches_pictures_to_words() {
        let Some(dir) = crate::ai::test_models(&["clip-vision.onnx", "clip-text.onnx", "clip-tokenizer.json", "test-football.jpg"]) else { return };
        let clip = Clip::load(&dir.join("clip-vision.onnx"), &dir.join("clip-text.onnx"), &dir.join("clip-tokenizer.json")).unwrap();
        let img = image::open(dir.join("test-football.jpg")).expect("test-football.jpg next to the models");
        let v = clip.embed_image(&img).unwrap();
        assert_eq!(v.len(), DIM);
        let words = ["a photo of a football player", "a photo of a cat", "a screenshot of a spreadsheet", "a bowl of soup"];
        let sims: Vec<f32> = words.iter().map(|w| super::super::dot(&v, &clip.embed_text(w).unwrap())).collect();
        eprintln!("clip similarities {sims:?}");
        assert!(sims[0] > sims[1] && sims[0] > sims[2] && sims[0] > sims[3], "{sims:?}");
    }
}
