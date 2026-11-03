//! The folder tree: every source and the folders inside it, as they are on disk, with how many
//! library photos and videos each holds (subfolders included).

use crate::{catalogue::Catalogue, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Component, PathBuf, MAIN_SEPARATOR},
};

/// A folder inside a source. `path` is relative to the source's root, with "/" between parts;
/// "" is the source itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderRef {
    pub source_id: i64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderNode {
    pub source_id: i64,
    pub path: String,
    /// Last part of the path, or the source's name for its root.
    pub name: String,
    pub depth: usize,
    pub count: i64,
}

/// Sources in the order they were added, each followed by its folders in alphabetical order.
/// Only folders that hold something in the library are listed.
pub fn folder_tree(cat: &Catalogue) -> Result<Vec<FolderNode>> {
    let mut out = Vec::new();
    let mut st = cat.conn.prepare(&format!(
        "SELECT i.path FROM items i WHERE i.source_id = ?1 AND {}",
        crate::catalogue::IN_LIBRARY
    ))?;
    for src in cat.sources()? {
        let root = PathBuf::from(&src.root);
        let mut counts: BTreeMap<String, i64> = BTreeMap::new();
        let mut total = 0;
        for path in st.query_map([src.id], |r| r.get::<_, String>(0))? {
            let path = PathBuf::from(path?);
            total += 1;
            let Ok(rel) = path.strip_prefix(&root) else { continue };
            let parts: Vec<String> = rel
                .parent()
                .map(|p| {
                    p.components()
                        .filter_map(|c| match c {
                            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            for d in 1..=parts.len() {
                *counts.entry(parts[..d].join("/")).or_default() += 1;
            }
        }
        if total == 0 {
            continue;
        }
        out.push(FolderNode { source_id: src.id, path: String::new(), name: src.name.clone(), depth: 0, count: total });
        // Sort case-insensitively, parent before child.
        let mut folders: Vec<(String, i64)> = counts.into_iter().collect();
        folders.sort_by(|a, b| {
            let ka: Vec<String> = a.0.split('/').map(str::to_lowercase).collect();
            let kb: Vec<String> = b.0.split('/').map(str::to_lowercase).collect();
            ka.cmp(&kb)
        });
        for (path, count) in folders {
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            let depth = path.split('/').count();
            out.push(FolderNode { source_id: src.id, path, name, depth, count });
        }
    }
    Ok(out)
}

/// The text every file path inside `folder` starts with, exactly as paths are stored.
pub(crate) fn prefix(cat: &Catalogue, folder: &FolderRef) -> Result<String> {
    let root = cat
        .source_root(folder.source_id)?
        .ok_or_else(|| crate::Error::Other(format!("no source with id {}", folder.source_id)))?;
    let mut dir = PathBuf::from(&root);
    for part in folder.path.split('/').filter(|p| !p.is_empty()) {
        dir.push(part);
    }
    let mut s = dir.to_string_lossy().to_string();
    if !s.ends_with(MAIN_SEPARATOR) && !s.ends_with('/') {
        s.push(MAIN_SEPARATOR);
    }
    Ok(s)
}
