//! Safelight core: scanning sources, reading capture dates, fingerprinting
//! files and keeping the local catalogue. No UI code lives here, so it can be
//! tested on any platform.

pub mod catalogue;
pub mod dates;
pub mod hash;
pub mod media;
pub mod plan;
pub mod scan;

pub use catalogue::{Catalogue, Item, MonthGroup, Source, Stats};
pub use scan::{scan_source, ScanProgress, ScanReport};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
