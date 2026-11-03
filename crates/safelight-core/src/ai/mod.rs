//! On-device smart tagging: image understanding (CLIP), faces and places.
//!
//! Everything runs on this PC. The models are downloaded once into the app's data folder; no
//! photo, face or search ever leaves the machine.

pub mod clip;
pub mod faces;
pub mod places;
pub mod vocab;

use crate::{Error, Result};
use std::path::{Path, PathBuf};

/// One model file Safelight needs, and where to fetch it the first time.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct ModelFile {
    pub file: &'static str,
    /// What it's for, in plain words, for the set-up screen.
    pub purpose: &'static str,
    pub url: &'static str,
    /// Rough size for the set-up screen.
    pub size_mb: u32,
    /// Checked after download when known.
    #[serde(skip)]
    pub sha256: Option<&'static str>,
}

pub const MODELS: &[ModelFile] = &[
    ModelFile {
        file: "clip-vision.onnx",
        purpose: "Understands what's in a picture",
        url: concat!("https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main", "/onnx/vision_model_quantized.onnx"),
        size_mb: 88,
        sha256: None,
    },
    ModelFile {
        file: "clip-text.onnx",
        purpose: "Matches your search words to pictures",
        url: concat!("https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main", "/onnx/text_model_quantized.onnx"),
        size_mb: 64,
        sha256: None,
    },
    ModelFile {
        file: "clip-tokenizer.json",
        purpose: "Splits search words for the text model",
        url: concat!("https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main", "/tokenizer.json"),
        size_mb: 2,
        sha256: None,
    },
    ModelFile {
        file: "face-detect.onnx",
        purpose: "Finds faces",
        url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        size_mb: 1,
        sha256: Some("8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    },
    ModelFile {
        file: "face-recognise.onnx",
        purpose: "Tells people apart",
        url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        size_mb: 37,
        sha256: Some("0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"),
    },
];

/// Model files not yet in `dir`.
pub fn missing_models(dir: &Path) -> Vec<ModelFile> {
    MODELS.iter().copied().filter(|m| !dir.join(m.file).is_file()).collect()
}

/// The loaded models. Cheap to share between threads.
pub struct Engines {
    pub clip: clip::Clip,
    pub faces: faces::FaceEngine,
}

impl Engines {
    pub fn load(dir: &Path) -> Result<Self> {
        let p = |f: &str| -> PathBuf { dir.join(f) };
        Ok(Self {
            clip: clip::Clip::load(&p("clip-vision.onnx"), &p("clip-text.onnx"), &p("clip-tokenizer.json"))?,
            faces: faces::FaceEngine::load(&p("face-detect.onnx"), &p("face-recognise.onnx"))?,
        })
    }
}

pub(crate) fn model_err(e: impl std::fmt::Display) -> Error {
    Error::Other(format!("smart tagging model: {e}"))
}

/// Scale a vector to unit length so a dot product is the cosine similarity.
pub fn normalise(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// Folder of model files used by the integration tests (`SAFELIGHT_MODELS`), if set and holding
/// the files a test needs. Set `SAFELIGHT_MODELS_REQUIRED=1` to fail instead of skipping (CI does).
#[cfg(test)]
pub(crate) fn test_models(files: &[&str]) -> Option<PathBuf> {
    let required = std::env::var_os("SAFELIGHT_MODELS_REQUIRED").is_some();
    let Some(dir) = std::env::var_os("SAFELIGHT_MODELS").map(PathBuf::from) else {
        assert!(!required, "SAFELIGHT_MODELS isn't set");
        return None;
    };
    let missing: Vec<&&str> = files.iter().filter(|f| !dir.join(f).is_file()).collect();
    assert!(!required || missing.is_empty(), "missing from SAFELIGHT_MODELS: {missing:?}");
    missing.is_empty().then_some(dir)
}
