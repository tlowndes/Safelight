//! Safelight core: scanning sources, reading capture dates, fingerprinting files, finding
//! duplicates, planning and copying the organised library, NAS backup, clean-up, reference, editing,
//! screenshot import rules (from Snapsort) and on-device smart tagging (faces, places, scenes).
//! No UI code lives here, so it can be tested on any platform.

pub mod ai;
pub mod backup;
pub mod catalogue;
pub mod cleanup;
pub mod dates;
pub mod delete;
pub mod develop;
pub mod dupes;
pub mod export;
pub mod exact;
pub mod folders;
pub mod hash;
pub mod imaging;
pub mod media;
pub mod ocr;
pub mod organise;
pub mod plan;
pub mod reference;
pub mod scan;
pub mod smart;
pub mod screenshots;
pub mod secret;
#[cfg(windows)]
pub mod winshell;

pub use catalogue::{Catalogue, Item, MonthGroup, Source, Stats};
pub use scan::{scan_source, ScanProgress, ScanReport};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
