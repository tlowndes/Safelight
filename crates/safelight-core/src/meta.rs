//! Photo details: camera settings read from the file, your caption and copyright, and
//! virtual copies (more than one set of edits for the same photo).

use crate::{catalogue::Catalogue, develop::{self, Edits}, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct CameraInfo {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub shutter: Option<String>,
    pub aperture: Option<String>,
    pub focal_length: Option<String>,
    pub flash: Option<String>,
    pub software: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Details {
    pub caption: String,
    pub copyright: String,
}

fn text(ex: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let f = ex.get_field(tag, exif::In::PRIMARY)?;
    let v = match &f.value {
        exif::Value::Ascii(parts) => parts.iter().map(|p| String::from_utf8_lossy(p).trim().to_string()).collect::<Vec<_>>().join(" "),
        _ => f.display_value().with_unit(ex).to_string(),
    };
    let v = v.trim().trim_matches('"').trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Camera settings from the file's EXIF data. Empty when the file has none.
pub fn camera_info(path: &Path) -> CameraInfo {
    let Ok(file) = std::fs::File::open(path) else { return CameraInfo::default() };
    let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else { return CameraInfo::default() };
    let make = text(&ex, exif::Tag::Make);
    let model = text(&ex, exif::Tag::Model);
    let camera = match (make, model) {
        (Some(m), Some(md)) if md.to_lowercase().starts_with(&m.to_lowercase()) => Some(md),
        (Some(m), Some(md)) => Some(format!("{m} {md}")),
        (a, b) => a.or(b),
    };
    let rational = |tag| ex.get_field(tag, exif::In::PRIMARY).and_then(|f| match &f.value {
        exif::Value::Rational(v) => v.first().map(|r| r.to_f64()),
        _ => None,
    });
    let shutter = rational(exif::Tag::ExposureTime).map(|t| if t >= 1.0 { format!("{t:.1} s") } else { format!("1/{:.0} s", 1.0 / t) });
    let aperture = rational(exif::Tag::FNumber).map(|f| format!("f/{}", (f * 10.0).round() / 10.0));
    let focal_length = rational(exif::Tag::FocalLength).map(|f| format!("{:.0} mm", f));
    CameraInfo {
        camera,
        lens: text(&ex, exif::Tag::LensModel),
        iso: text(&ex, exif::Tag::PhotographicSensitivity).map(|v| format!("ISO {v}")),
        shutter,
        aperture,
        focal_length,
        flash: text(&ex, exif::Tag::Flash),
        software: text(&ex, exif::Tag::Software),
    }
}

pub fn details(cat: &Catalogue, item_id: i64) -> Result<Details> {
    Ok(cat
        .conn
        .query_row("SELECT caption, copyright FROM item_meta WHERE item_id = ?1", [item_id], |r| Ok(Details { caption: r.get(0)?, copyright: r.get(1)? }))
        .optional()?
        .unwrap_or_default())
}

/// Save caption and copyright for each photo.
pub fn set_details(cat: &Catalogue, item_ids: &[i64], d: &Details) -> Result<()> {
    let mut st = cat.conn.prepare(
        "INSERT INTO item_meta(item_id, caption, copyright) VALUES (?1, ?2, ?3)
         ON CONFLICT(item_id) DO UPDATE SET caption = excluded.caption, copyright = excluded.copyright",
    )?;
    for id in item_ids {
        st.execute(params![id, d.caption.trim(), d.copyright.trim()])?;
    }
    Ok(())
}

// ---------- virtual copies ----------

#[derive(Debug, Clone, Serialize)]
pub struct Version {
    /// None for the version being shown (its edits are the photo's edits).
    pub id: Option<i64>,
    pub name: String,
    pub active: bool,
}

fn active_name(cat: &Catalogue, item_id: i64) -> Result<String> {
    let n: Option<Option<String>> = cat.conn.query_row("SELECT version_name FROM item_meta WHERE item_id = ?1", [item_id], |r| r.get(0)).optional()?;
    Ok(n.flatten().unwrap_or_else(|| "Master".into()))
}

fn set_active_name(cat: &Catalogue, item_id: i64, name: &str) -> Result<()> {
    cat.conn.execute(
        "INSERT INTO item_meta(item_id, version_name) VALUES (?1, ?2) ON CONFLICT(item_id) DO UPDATE SET version_name = excluded.version_name",
        params![item_id, name],
    )?;
    Ok(())
}

/// Every version of a photo: the one being shown first, then the others by age.
pub fn versions(cat: &Catalogue, item_id: i64) -> Result<Vec<Version>> {
    let mut out = vec![Version { id: None, name: active_name(cat, item_id)?, active: true }];
    let mut st = cat.conn.prepare("SELECT id, name FROM versions WHERE item_id = ?1 ORDER BY id")?;
    for row in st.query_map([item_id], |r| Ok(Version { id: Some(r.get(0)?), name: r.get(1)?, active: false }))? {
        out.push(row?);
    }
    Ok(out)
}

/// Make a virtual copy: keep the current edits as they are, and start a new version from
/// them, which becomes the one shown. Returns the new version's name.
pub fn new_version(cat: &Catalogue, item_id: i64) -> Result<String> {
    let current = develop::load_edits(cat, item_id)?;
    let name = active_name(cat, item_id)?;
    let json = serde_json::to_string(&current).map_err(|e| crate::Error::Other(e.to_string()))?;
    cat.conn.execute("INSERT INTO versions(item_id, name, json) VALUES (?1, ?2, ?3)", params![item_id, name, json])?;
    let n: i64 = cat.conn.query_row("SELECT COUNT(*) FROM versions WHERE item_id = ?1", [item_id], |r| r.get(0))?;
    let new_name = format!("Copy {n}");
    set_active_name(cat, item_id, &new_name)?;
    Ok(new_name)
}

/// Show another version: the current one is kept, and `version_id` becomes the photo's edits.
pub fn switch_version(cat: &Catalogue, item_id: i64, version_id: i64) -> Result<Edits> {
    let (name, json): (String, String) = cat.conn.query_row(
        "SELECT name, json FROM versions WHERE id = ?1 AND item_id = ?2",
        params![version_id, item_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let target: Edits = serde_json::from_str(&json).unwrap_or_default();
    let current = develop::load_edits(cat, item_id)?;
    let cur_json = serde_json::to_string(&current).map_err(|e| crate::Error::Other(e.to_string()))?;
    let tx = cat.conn.unchecked_transaction()?;
    tx.execute("UPDATE versions SET name = ?2, json = ?3 WHERE id = ?1", params![version_id, active_name(cat, item_id)?, cur_json])?;
    develop::save_edits(cat, item_id, &target)?;
    set_active_name(cat, item_id, &name)?;
    tx.commit()?;
    Ok(target)
}

/// Delete a version that isn't being shown.
pub fn delete_version(cat: &Catalogue, item_id: i64, version_id: i64) -> Result<()> {
    cat.conn.execute("DELETE FROM versions WHERE id = ?1 AND item_id = ?2", params![version_id, item_id])?;
    Ok(())
}

pub fn rename_version(cat: &Catalogue, item_id: i64, version_id: Option<i64>, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    match version_id {
        None => set_active_name(cat, item_id, name),
        Some(v) => {
            cat.conn.execute("UPDATE versions SET name = ?3 WHERE id = ?1 AND item_id = ?2", params![v, item_id, name])?;
            Ok(())
        }
    }
}

// ---------- map ----------

#[derive(Debug, Clone, Serialize)]
pub struct MapPoint {
    pub id: i64,
    pub lat: f64,
    pub lon: f64,
    pub place: Option<String>,
}

/// Library photos with a GPS position (found by smart tagging's place step), one per photo.
pub fn map_points(cat: &Catalogue) -> Result<Vec<MapPoint>> {
    let mut st = cat.conn.prepare(&format!(
        "SELECT MIN(i.id), a.lat, a.lon, COALESCE(a.town, a.area, a.region, a.country)
         FROM items i JOIN ai_items a ON a.sha256 = i.sha256
         WHERE a.lat IS NOT NULL AND a.lon IS NOT NULL AND {}
         GROUP BY i.sha256",
        crate::catalogue::IN_LIBRARY
    ))?;
    let rows = st.query_map([], |r| Ok(MapPoint { id: r.get(0)?, lat: r.get(1)?, lon: r.get(2)?, place: r.get(3)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}
