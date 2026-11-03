//! Smart tagging in the catalogue: what each picture shows, who is in it and where it was taken,
//! plus search, find-similar and topic suggestions built on top.
//!
//! Results are stored per fingerprint, so every copy of a photo shares them and a re-scan never
//! analyses the same picture twice. Nothing here changes a file.

use crate::{
    ai::{self, clip, faces, places, vocab, Engines},
    catalogue::{item_from_row, Catalogue, Item, ITEM_SELECT},
    imaging, Result,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

/// Bump when the models or vocabulary change enough that old results should be redone.
pub const VISION_VERSION: i64 = 1;
/// Long edge of the picture analysed for faces.
const ANALYSE_EDGE: u32 = 1280;
const MAX_FACES: usize = 20;
/// Keep this many signatures per person when matching new faces (the strongest ones first).
const SAMPLES_PER_PERSON: usize = 40;

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ai_items (
  sha256 TEXT PRIMARY KEY,
  vision INTEGER NOT NULL DEFAULT 0,
  clip BLOB,
  place_done INTEGER NOT NULL DEFAULT 0,
  lat REAL, lon REAL, town TEXT, area TEXT, region TEXT, country TEXT
);
CREATE TABLE IF NOT EXISTS ai_tags (
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (sha256, kind, name)
);
CREATE INDEX IF NOT EXISTS ai_tags_name ON ai_tags(name);
CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  score REAL NOT NULL,
  signature BLOB NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  rejected_person INTEGER,
  crop TEXT
);
CREATE INDEX IF NOT EXISTS faces_sha ON faces(sha256);
CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);
"#;

// ---------- status ----------

#[derive(Debug, Clone, Serialize)]
pub struct SmartStatus {
    pub models_ready: bool,
    pub missing: Vec<ai::ModelFile>,
    pub download_mb: u32,
    /// Photos and videos (one per fingerprint) that can be analysed.
    pub total: i64,
    pub analysed: i64,
    pub located: i64,
    pub faces: i64,
    pub people: i64,
    pub named: i64,
}

pub fn status(cat: &Catalogue, models_dir: &Path) -> Result<SmartStatus> {
    let missing = ai::missing_models(models_dir);
    let q = |sql: &str| -> Result<i64> { Ok(cat.conn.query_row(sql, [], |r| r.get(0))?) };
    Ok(SmartStatus {
        models_ready: missing.is_empty(),
        download_mb: missing.iter().map(|m| m.size_mb).sum(),
        missing,
        total: q("SELECT COUNT(DISTINCT sha256) FROM items WHERE hidden = 0")?,
        analysed: q(&format!(
            "SELECT COUNT(*) FROM ai_items WHERE vision >= {VISION_VERSION} AND sha256 IN (SELECT sha256 FROM items WHERE hidden = 0)"
        ))?,
        located: q("SELECT COUNT(*) FROM ai_items WHERE country IS NOT NULL")?,
        faces: q("SELECT COUNT(*) FROM faces")?,
        people: q("SELECT COUNT(*) FROM (SELECT person_id FROM faces WHERE person_id IS NOT NULL GROUP BY person_id HAVING COUNT(*) >= 2)")?,
        named: q("SELECT COUNT(*) FROM people WHERE name IS NOT NULL")?,
    })
}

// ---------- places (no models needed) ----------

/// Read GPS for everything not looked at yet and name the place. Cheap: only the camera data is read.
pub fn tag_places(cat: &Catalogue) -> Result<u64> {
    let todo: Vec<(String, String)> = cat
        .conn
        .prepare(
            "SELECT sha256, MIN(path) FROM items
             WHERE sha256 NOT IN (SELECT sha256 FROM ai_items WHERE place_done = 1)
             GROUP BY sha256",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut found = 0;
    for chunk in todo.chunks(200) {
        let tx = cat.conn.unchecked_transaction()?;
        for (sha, path) in chunk {
            let place = places::gps(Path::new(path)).map(|(lat, lon)| places::lookup(lat, lon));
            tx.execute(
                "INSERT INTO ai_items(sha256, place_done, lat, lon, town, area, region, country) VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(sha256) DO UPDATE SET place_done = 1, lat = excluded.lat, lon = excluded.lon,
                   town = excluded.town, area = excluded.area, region = excluded.region, country = excluded.country",
                params![
                    sha,
                    place.as_ref().map(|p| p.lat),
                    place.as_ref().map(|p| p.lon),
                    place.as_ref().and_then(|p| p.town.clone()),
                    place.as_ref().and_then(|p| p.area.clone()),
                    place.as_ref().and_then(|p| p.region.clone()),
                    place.as_ref().and_then(|p| p.country.clone()),
                ],
            )?;
            tx.execute("DELETE FROM ai_tags WHERE sha256 = ?1 AND kind = 'place'", [sha])?;
            if let Some(p) = &place {
                for name in p.names() {
                    tx.execute("INSERT OR IGNORE INTO ai_tags(sha256, kind, name, score) VALUES (?1, 'place', ?2, 1)", params![sha, name])?;
                }
                if p.country.is_some() {
                    found += 1;
                }
            }
        }
        tx.commit()?;
    }
    Ok(found)
}

// ---------- analysis (needs models) ----------

#[derive(Debug, Clone, Serialize)]
pub struct SmartProgress {
    pub done: u64,
    pub total: u64,
}

/// Text vectors for a vocabulary list.
fn embed_vocab(eng: &Engines, list: &[(&str, &str)]) -> Result<Vec<Vec<f32>>> {
    list.iter().map(|(_, phrase)| eng.clip.embed_text(phrase)).collect()
}

/// Signatures of faces already sorted into people, used to match new faces.
fn person_samples(cat: &Catalogue) -> Result<Vec<(i64, Vec<f32>)>> {
    let mut per: HashMap<i64, usize> = HashMap::new();
    let rows: Vec<(i64, Vec<u8>)> = cat
        .conn
        .prepare("SELECT person_id, signature FROM faces WHERE person_id IS NOT NULL ORDER BY score DESC")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(p, _)| {
            let n = per.entry(*p).or_default();
            *n += 1;
            *n <= SAMPLES_PER_PERSON
        })
        .map(|(p, b)| (p, ai::from_blob(&b)))
        .collect())
}

/// The person whose faces look most like `sig`, if anyone is close enough.
pub fn best_match(samples: &[(i64, Vec<f32>)], sig: &[f32]) -> Option<(i64, f32)> {
    samples
        .iter()
        .map(|(p, s)| (*p, ai::dot(s, sig)))
        .filter(|(_, sim)| *sim >= faces::SAME_PERSON)
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// Analyse everything not done yet: scene and design tags, picture vectors, faces and people.
/// Stops early (keeping what's done) when `stop` is set.
pub fn analyse(cat: &Catalogue, eng: &Engines, faces_dir: &Path, stop: &AtomicBool, mut progress: impl FnMut(&SmartProgress)) -> Result<u64> {
    std::fs::create_dir_all(faces_dir)?;
    let scenes = embed_vocab(eng, vocab::SCENES)?;
    let design = embed_vocab(eng, vocab::DESIGN)?;
    let todo: Vec<(String, String, String, Option<String>, bool, bool)> = cat
        .conn
        .prepare(&format!(
            "SELECT sha256, MIN(path), MIN(kind), MAX(thumb), MAX(has_camera), MAX(COALESCE(is_reference, 0)) FROM items
             WHERE hidden = 0 AND sha256 NOT IN (SELECT sha256 FROM ai_items WHERE vision >= {VISION_VERSION})
             GROUP BY sha256 ORDER BY MAX(taken_at) DESC"
        ))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let total = todo.len() as u64;
    let mut samples = person_samples(cat)?;
    let mut done = 0;
    for (n, (sha, path, kind, thumb, has_camera, is_reference)) in todo.into_iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        progress(&SmartProgress { done: n as u64, total });
        let img = if kind == "photo" { imaging::preview_image(Path::new(&path), ANALYSE_EDGE) } else { None }
            .or_else(|| thumb.as_deref().and_then(|t| image::open(t).ok()));
        let tx = cat.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM ai_tags WHERE sha256 = ?1 AND kind IN ('scene', 'design')", [&sha])?;
        let mut vector = None;
        if let Some(img) = &img {
            let v = eng.clip.embed_image(img)?;
            for (i, p) in clip::zero_shot(&v, &scenes, 0.15, 3) {
                tx.execute("INSERT OR IGNORE INTO ai_tags(sha256, kind, name, score) VALUES (?1, 'scene', ?2, ?3)", params![sha, vocab::SCENES[i].0, p])?;
            }
            if !has_camera || is_reference {
                for (i, p) in clip::zero_shot(&v, &design, 0.12, 3) {
                    tx.execute("INSERT OR IGNORE INTO ai_tags(sha256, kind, name, score) VALUES (?1, 'design', ?2, ?3)", params![sha, vocab::DESIGN[i].0, p])?;
                }
            }
            vector = Some(ai::to_blob(&v));

            // Faces: redo this picture's faces, but keep any the user has already corrected.
            tx.execute("DELETE FROM faces WHERE sha256 = ?1 AND rejected_person IS NULL", [&sha])?;
            let kept: Vec<faces::Face> = tx
                .prepare("SELECT x, y, w, h FROM faces WHERE sha256 = ?1")?
                .query_map([&sha], |r| Ok(faces::Face { x: r.get(0)?, y: r.get(1)?, w: r.get(2)?, h: r.get(3)?, score: 0.0, points: [(0.0, 0.0); 5] }))?
                .collect::<std::result::Result<_, _>>()?;
            let found = eng.faces.detect(img)?;
            for face in found.into_iter().filter(|f| kept.iter().all(|k| faces::iou(k, f) < 0.5)).take(MAX_FACES) {
                let sig = eng.faces.signature(img, &face)?;
                let person = match best_match(&samples, &sig) {
                    Some((p, _)) => p,
                    None => {
                        tx.execute("INSERT INTO people(name) VALUES (NULL)", [])?;
                        tx.last_insert_rowid()
                    }
                };
                tx.execute(
                    "INSERT INTO faces(sha256, x, y, w, h, score, signature, person_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![sha, face.x, face.y, face.w, face.h, face.score, ai::to_blob(&sig), person],
                )?;
                let id = tx.last_insert_rowid();
                let out = faces_dir.join(format!("{id}.jpg"));
                if faces::crop(img, &face, 160).to_rgb8().save_with_format(&out, image::ImageFormat::Jpeg).is_ok() {
                    tx.execute("UPDATE faces SET crop = ?2 WHERE id = ?1", params![id, out.to_string_lossy()])?;
                }
                samples.push((person, sig));
            }
        }
        tx.execute(
            "INSERT INTO ai_items(sha256, vision, clip) VALUES (?1, ?2, ?3)
             ON CONFLICT(sha256) DO UPDATE SET vision = excluded.vision, clip = excluded.clip",
            params![sha, VISION_VERSION, vector],
        )?;
        tx.commit()?;
        done += 1;
    }
    progress(&SmartProgress { done: total, total });
    // People with no faces left (after re-analysis) and no name aren't worth keeping.
    cat.conn.execute("DELETE FROM people WHERE name IS NULL AND id NOT IN (SELECT person_id FROM faces WHERE person_id IS NOT NULL)", [])?;
    Ok(done)
}

// ---------- picture vectors: search and find-similar ----------

/// Every analysed picture's vector, held in memory for fast search.
#[derive(Default)]
pub struct EmbeddingIndex {
    pub shas: Vec<String>,
    data: Vec<f32>,
}

impl EmbeddingIndex {
    pub fn load(cat: &Catalogue) -> Result<Self> {
        let mut idx = Self::default();
        let mut st = cat.conn.prepare("SELECT sha256, clip FROM ai_items WHERE clip IS NOT NULL")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let v = ai::from_blob(&r.get::<_, Vec<u8>>(1)?);
            if v.len() == clip::DIM {
                idx.shas.push(r.get(0)?);
                idx.data.extend(v);
            }
        }
        Ok(idx)
    }

    pub fn len(&self) -> usize {
        self.shas.len()
    }

    pub fn is_empty(&self) -> bool {
        self.shas.is_empty()
    }

    fn vector(&self, sha: &str) -> Option<&[f32]> {
        let i = self.shas.iter().position(|s| s == sha)?;
        Some(&self.data[i * clip::DIM..(i + 1) * clip::DIM])
    }

    /// (fingerprint, similarity), best first.
    pub fn rank(&self, query: &[f32]) -> Vec<(&str, f32)> {
        let mut out: Vec<(&str, f32)> =
            self.data.chunks_exact(clip::DIM).zip(&self.shas).map(|(v, s)| (s.as_str(), ai::dot(v, query))).collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out
    }
}

/// Words-to-picture similarity: CLIP scores a good match around 0.28-0.35 and an unrelated
/// picture around 0.15-0.2. Keep results near the best one and above a floor.
const SEARCH_FLOOR: f32 = 0.235;
const SEARCH_BAND: f32 = 0.05;
const SEARCH_MAX: usize = 600;

/// Item ids matching a search: people, places, tags (yours and smart ones), and, when the
/// models are ready, pictures that look like the words.
pub fn search(cat: &Catalogue, clip: Option<&clip::Clip>, index: Option<&EmbeddingIndex>, q: &str) -> Result<Vec<i64>> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let like = format!("%{}%", q.replace('%', "").replace('_', ""));
    let mut ids: Vec<i64> = cat
        .conn
        .prepare(
            "SELECT i.id FROM items i WHERE i.sha256 IN (
                SELECT sha256 FROM ai_tags WHERE name LIKE ?1
                UNION SELECT f.sha256 FROM faces f JOIN people p ON p.id = f.person_id WHERE p.name LIKE ?1)
             OR i.id IN (SELECT x.item_id FROM item_tags x JOIN tags t ON t.id = x.tag_id WHERE t.name LIKE ?1)",
        )?
        .query_map([&like], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    if let (Some(clip), Some(index)) = (clip, index) {
        if q.chars().count() >= 3 && !index.is_empty() {
            let v = clip.embed_text(&format!("a photo of {q}"))?;
            let ranked = index.rank(&v);
            let best = ranked.first().map(|r| r.1).unwrap_or(0.0);
            let cut = SEARCH_FLOOR.max(best - SEARCH_BAND);
            let shas: Vec<&str> = ranked.into_iter().take_while(|(_, s)| *s >= cut).take(SEARCH_MAX).map(|(s, _)| s).collect();
            let mut st = cat.conn.prepare("SELECT id FROM items WHERE sha256 = ?1")?;
            for sha in shas {
                ids.extend(st.query_map([sha], |r| r.get::<_, i64>(0))?.collect::<std::result::Result<Vec<_>, _>>()?);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(*id));
    Ok(ids)
}

/// Pictures that look like this one, most alike first (one per fingerprint, hidden ones left out).
pub fn similar(cat: &Catalogue, index: &EmbeddingIndex, item_id: i64, limit: usize) -> Result<Vec<Item>> {
    let Some(sha) = cat.conn.query_row("SELECT sha256 FROM items WHERE id = ?1", [item_id], |r| r.get::<_, String>(0)).optional()? else {
        return Ok(vec![]);
    };
    let Some(v) = index.vector(&sha).map(<[f32]>::to_vec) else { return Ok(vec![]) };
    let mut st = cat.conn.prepare(&format!("{ITEM_SELECT} WHERE i.id = (SELECT MIN(id) FROM items WHERE sha256 = ?1 AND hidden = 0)"))?;
    let mut out = Vec::new();
    for (s, sim) in index.rank(&v) {
        if out.len() >= limit || sim < 0.72 {
            break;
        }
        if s == sha {
            continue;
        }
        if let Some(item) = st.query_row([s], item_from_row).optional()? {
            out.push(item);
        }
    }
    Ok(out)
}

// ---------- people ----------

#[derive(Debug, Clone, Serialize)]
pub struct Person {
    pub id: i64,
    pub name: Option<String>,
    /// Photos this person is in.
    pub photos: i64,
    pub cover: Option<String>,
}

/// Named people, then unnamed groups of two or more photos, biggest first.
pub fn people(cat: &Catalogue) -> Result<Vec<Person>> {
    Ok(cat
        .conn
        .prepare(
            "SELECT p.id, p.name, COUNT(DISTINCT f.sha256),
                    (SELECT crop FROM faces c WHERE c.person_id = p.id AND c.crop IS NOT NULL ORDER BY c.score * c.w DESC LIMIT 1)
             FROM people p JOIN faces f ON f.person_id = p.id
             WHERE p.hidden = 0
             GROUP BY p.id
             HAVING p.name IS NOT NULL OR COUNT(DISTINCT f.sha256) >= 2
             ORDER BY p.name IS NULL, COUNT(DISTINCT f.sha256) DESC, p.name",
        )?
        .query_map([], |r| Ok(Person { id: r.get(0)?, name: r.get(1)?, photos: r.get(2)?, cover: r.get(3)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize)]
pub struct FaceRow {
    pub id: i64,
    pub crop: Option<String>,
    pub item_id: i64,
}

pub fn person_faces(cat: &Catalogue, person_id: i64) -> Result<Vec<FaceRow>> {
    Ok(cat
        .conn
        .prepare(
            "SELECT f.id, f.crop, (SELECT MIN(i.id) FROM items i WHERE i.sha256 = f.sha256) AS item
             FROM faces f WHERE f.person_id = ?1 AND item IS NOT NULL ORDER BY f.score DESC",
        )?
        .query_map([person_id], |r| Ok(FaceRow { id: r.get(0)?, crop: r.get(1)?, item_id: r.get(2)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

/// Photos with this person in them, newest first.
pub fn person_items(cat: &Catalogue, person_id: i64) -> Result<Vec<Item>> {
    let mut st = cat.conn.prepare(&format!(
        "{ITEM_SELECT} WHERE i.hidden = 0 AND i.id IN (SELECT MIN(id) FROM items WHERE sha256 IN (SELECT sha256 FROM faces WHERE person_id = ?1) GROUP BY sha256)
         ORDER BY i.taken_at IS NULL, i.taken_at DESC"
    ))?;
    let rows = st.query_map([person_id], item_from_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Name someone. Giving two groups the same name merges them. Returns the person's id after.
pub fn name_person(cat: &Catalogue, person_id: i64, name: &str) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        cat.conn.execute("UPDATE people SET name = NULL WHERE id = ?1", [person_id])?;
        return Ok(person_id);
    }
    let existing: Option<i64> = cat
        .conn
        .query_row("SELECT id FROM people WHERE name = ?1 COLLATE NOCASE AND id <> ?2", params![name, person_id], |r| r.get(0))
        .optional()?;
    match existing {
        Some(into) => {
            merge_people(cat, person_id, into)?;
            Ok(into)
        }
        None => {
            cat.conn.execute("UPDATE people SET name = ?2, hidden = 0 WHERE id = ?1", params![person_id, name])?;
            Ok(person_id)
        }
    }
}

pub fn merge_people(cat: &Catalogue, from: i64, into: i64) -> Result<()> {
    if from == into {
        return Ok(());
    }
    let tx = cat.conn.unchecked_transaction()?;
    tx.execute("UPDATE faces SET person_id = ?2 WHERE person_id = ?1", params![from, into])?;
    tx.execute("DELETE FROM people WHERE id = ?1", [from])?;
    tx.commit()?;
    Ok(())
}

/// "That's not them": take a face out of a person. It stays out on later passes.
pub fn remove_face(cat: &Catalogue, face_id: i64) -> Result<()> {
    cat.conn.execute("UPDATE faces SET rejected_person = person_id, person_id = NULL WHERE id = ?1", [face_id])?;
    Ok(())
}

/// Stop showing a group on the People screen (strangers in the background, statues…).
pub fn hide_person(cat: &Catalogue, person_id: i64) -> Result<()> {
    cat.conn.execute("UPDATE people SET hidden = 1 WHERE id = ?1", [person_id])?;
    Ok(())
}

// ---------- places and things ----------

#[derive(Debug, Clone, Serialize)]
pub struct PlaceCount {
    pub country: String,
    pub town: Option<String>,
    pub count: i64,
}

pub fn places(cat: &Catalogue) -> Result<Vec<PlaceCount>> {
    Ok(cat
        .conn
        .prepare(
            "SELECT a.country, a.town, COUNT(*) FROM ai_items a
             WHERE a.country IS NOT NULL AND a.sha256 IN (SELECT sha256 FROM items WHERE hidden = 0)
             GROUP BY a.country, a.town ORDER BY a.country, COUNT(*) DESC",
        )?
        .query_map([], |r| Ok(PlaceCount { country: r.get(0)?, town: r.get(1)?, count: r.get(2)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize)]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

/// Smart tags of one kind ("scene" or "design") with how many pictures carry each.
pub fn smart_tags(cat: &Catalogue, kind: &str) -> Result<Vec<TagCount>> {
    Ok(cat
        .conn
        .prepare(
            "SELECT name, COUNT(*) FROM ai_tags WHERE kind = ?1 AND sha256 IN (SELECT sha256 FROM items WHERE hidden = 0)
             GROUP BY name ORDER BY COUNT(*) DESC, name",
        )?
        .query_map([kind], |r| Ok(TagCount { name: r.get(0)?, count: r.get(1)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ItemSmart {
    /// Named people first; unnamed faces are counted in `faces`.
    pub people: Vec<String>,
    pub faces: i64,
    pub place: Option<String>,
    pub tags: Vec<String>,
}

/// What smart tagging knows about one photo, for the viewer's details panel.
pub fn item_smart(cat: &Catalogue, item_id: i64) -> Result<ItemSmart> {
    let Some(sha) = cat.conn.query_row("SELECT sha256 FROM items WHERE id = ?1", [item_id], |r| r.get::<_, String>(0)).optional()? else {
        return Ok(ItemSmart::default());
    };
    let people = cat
        .conn
        .prepare("SELECT DISTINCT p.name FROM faces f JOIN people p ON p.id = f.person_id WHERE f.sha256 = ?1 AND p.name IS NOT NULL ORDER BY p.name")?
        .query_map([&sha], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let faces = cat.conn.query_row("SELECT COUNT(*) FROM faces WHERE sha256 = ?1", [&sha], |r| r.get(0))?;
    let place = cat
        .conn
        .query_row("SELECT town, area, region, country FROM ai_items WHERE sha256 = ?1", [&sha], |r| {
            Ok(places::Place { lat: 0.0, lon: 0.0, town: r.get(0)?, area: r.get(1)?, region: r.get(2)?, country: r.get(3)? })
        })
        .optional()?
        .and_then(|p| p.label());
    let tags = cat
        .conn
        .prepare("SELECT name FROM ai_tags WHERE sha256 = ?1 AND kind IN ('scene', 'design') ORDER BY score DESC")?
        .query_map([&sha], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(ItemSmart { people, faces, place, tags })
}

// ---------- reference topics ----------

#[derive(Debug, Clone, Serialize)]
pub struct TopicSuggestion {
    pub item_id: i64,
    pub topic_id: i64,
    pub topic: String,
}

/// For reference images still in "To sort": the topic each most likely belongs in. Looks at
/// images you've already sorted first (nearest neighbours), then at the topic's name.
pub fn topic_suggestions(cat: &Catalogue, clip: &clip::Clip, index: &EmbeddingIndex) -> Result<Vec<TopicSuggestion>> {
    let topics: Vec<(i64, String)> = cat
        .conn
        .prepare("SELECT id, name FROM topics WHERE name <> 'To sort' ORDER BY id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    if topics.is_empty() {
        return Ok(vec![]);
    }
    let phrases: Vec<Vec<f32>> = topics.iter().map(|(_, n)| clip.embed_text(&vocab::topic_phrase(n))).collect::<Result<_>>()?;
    // Already sorted reference images: (vector, topic index).
    let sorted: Vec<(Vec<f32>, usize)> = cat
        .conn
        .prepare("SELECT DISTINCT sha256, topic_id FROM items WHERE is_reference = 1 AND topic_id IS NOT NULL")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .filter_map(|r| r.ok())
        .filter_map(|(sha, t)| Some((index.vector(&sha)?.to_vec(), topics.iter().position(|(id, _)| *id == t)?)))
        .collect();
    let unsorted: Vec<(i64, String)> = cat
        .conn
        .prepare(
            "SELECT MIN(i.id), i.sha256 FROM items i LEFT JOIN topics t ON t.id = i.topic_id
             WHERE i.is_reference = 1 AND (i.topic_id IS NULL OR t.name = 'To sort' OR t.id IS NULL)
             GROUP BY i.sha256",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    for (item_id, sha) in unsorted {
        let Some(v) = index.vector(&sha) else { continue };
        let mut near: Vec<(f32, usize)> = sorted.iter().map(|(s, t)| (ai::dot(s, v), *t)).collect();
        near.sort_by(|a, b| b.0.total_cmp(&a.0));
        let by_neighbours = near.first().filter(|(sim, _)| *sim >= 0.82).map(|_| {
            let mut votes = vec![0f32; topics.len()];
            for (sim, t) in near.iter().take(5).filter(|(s, _)| *s >= 0.75) {
                votes[*t] += sim;
            }
            votes.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| i).unwrap_or(0)
        });
        let pick = by_neighbours.or_else(|| clip::zero_shot(v, &phrases, 0.3, 1).first().map(|(i, _)| *i));
        if let Some(t) = pick {
            out.push(TopicSuggestion { item_id, topic_id: topics[t].0, topic: topics[t].1.clone() });
        }
    }
    Ok(out)
}

/// Smart design tags for each picture, keyed by fingerprint (used by the Reference screen).
pub fn design_tags(cat: &Catalogue, sha: &str) -> Result<Vec<String>> {
    Ok(cat
        .conn
        .prepare("SELECT name FROM ai_tags WHERE sha256 = ?1 AND kind = 'design' ORDER BY score DESC")?
        .query_map([sha], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat_with_items(n: usize) -> Catalogue {
        let cat = Catalogue::open_in_memory().unwrap();
        cat.conn.execute("INSERT INTO sources(name, kind, root) VALUES ('s', 'local', '/s')", []).unwrap();
        for i in 0..n {
            cat.conn
                .execute(
                    "INSERT INTO items(source_id, path, kind, size, mtime, sha256, taken_at) VALUES (1, ?1, 'photo', 1, 0, ?2, '2024-06-01 12:00:00')",
                    params![format!("/s/{i}.jpg"), format!("sha{i}")],
                )
                .unwrap();
        }
        cat
    }

    fn add_face(cat: &Catalogue, sha: &str, person: i64) -> i64 {
        cat.conn.execute("INSERT OR IGNORE INTO people(id) VALUES (?1)", [person]).unwrap();
        cat.conn
            .execute(
                "INSERT INTO faces(sha256, x, y, w, h, score, signature, person_id) VALUES (?1, 0, 0, 10, 10, 0.9, ?2, ?3)",
                params![sha, ai::to_blob(&[1.0, 0.0]), person],
            )
            .unwrap();
        cat.conn.last_insert_rowid()
    }

    #[test]
    fn naming_merges_and_search_finds_people_places_and_tags() {
        let cat = cat_with_items(4);
        add_face(&cat, "sha0", 1);
        add_face(&cat, "sha1", 1);
        add_face(&cat, "sha2", 2);
        add_face(&cat, "sha3", 2);
        assert_eq!(people(&cat).unwrap().len(), 2);
        name_person(&cat, 1, "Mum").unwrap();
        // Same name, other case: the two groups become one.
        let id = name_person(&cat, 2, "mum").unwrap();
        assert_eq!(id, 1);
        let ps = people(&cat).unwrap();
        assert_eq!((ps.len(), ps[0].photos, ps[0].name.as_deref()), (1, 4, Some("Mum")));
        assert_eq!(search(&cat, None, None, "mum").unwrap().len(), 4);

        cat.conn.execute("INSERT INTO ai_tags(sha256, kind, name, score) VALUES ('sha0', 'place', 'Brighton', 1), ('sha1', 'scene', 'Beach', 0.6)", []).unwrap();
        assert_eq!(search(&cat, None, None, "bright").unwrap(), vec![1]);
        assert_eq!(search(&cat, None, None, "Beach").unwrap(), vec![2]);
        assert!(search(&cat, None, None, "  ").unwrap().is_empty());
    }

    #[test]
    fn removed_faces_leave_the_person() {
        let cat = cat_with_items(3);
        let f = add_face(&cat, "sha0", 1);
        add_face(&cat, "sha1", 1);
        add_face(&cat, "sha2", 1);
        remove_face(&cat, f).unwrap();
        assert_eq!(people(&cat).unwrap()[0].photos, 2);
        assert_eq!(person_faces(&cat, 1).unwrap().len(), 2);
    }

    #[test]
    fn best_match_needs_a_close_face() {
        let samples = vec![(1, vec![1.0, 0.0]), (2, vec![0.0, 1.0])];
        assert_eq!(best_match(&samples, &[0.9, 0.436]).map(|m| m.0), Some(1));
        assert_eq!(best_match(&samples, &[-1.0, 0.0]), None);
    }

    #[test]
    fn index_ranks_and_finds_similar() {
        let cat = cat_with_items(3);
        let mut a = vec![0.0; clip::DIM];
        a[0] = 1.0;
        let mut b = a.clone();
        b[1] = 0.2;
        ai::normalise(&mut b);
        let mut c = vec![0.0; clip::DIM];
        c[5] = 1.0;
        for (sha, v) in [("sha0", &a), ("sha1", &b), ("sha2", &c)] {
            cat.conn.execute("INSERT INTO ai_items(sha256, vision, clip) VALUES (?1, 1, ?2)", params![sha, ai::to_blob(v)]).unwrap();
        }
        let idx = EmbeddingIndex::load(&cat).unwrap();
        assert_eq!(idx.len(), 3);
        let sim = similar(&cat, &idx, 1, 10).unwrap();
        assert_eq!(sim.iter().map(|i| i.id).collect::<Vec<_>>(), vec![2]);
    }

    /// Full pass on real pictures; runs only when SAFELIGHT_MODELS is set (CI does this).
    #[test]
    fn analyse_tags_faces_and_groups_people() {
        let Some(dir) = ai::test_models(&["clip-vision.onnx", "clip-text.onnx", "clip-tokenizer.json", "face-detect.onnx", "face-recognise.onnx", "test-face-a.jpg", "test-face-b.jpg", "test-football.jpg"]) else { return };
        let eng = Engines::load(&dir).unwrap();
        let cat = Catalogue::open_in_memory().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        cat.conn.execute("INSERT INTO sources(name, kind, root) VALUES ('s', 'local', '/s')", []).unwrap();
        let a = image::open(dir.join("test-face-a.jpg")).unwrap();
        let files = [
            ("a.jpg", a.clone()),
            ("a-small.jpg", a.resize(a.width() * 2 / 3, a.height() * 2 / 3, image::imageops::FilterType::Triangle)),
            ("b.jpg", image::open(dir.join("test-face-b.jpg")).unwrap()),
            ("football.jpg", image::open(dir.join("test-football.jpg")).unwrap()),
        ];
        for (i, (name, img)) in files.iter().enumerate() {
            let p = tmp.path().join(name);
            img.to_rgb8().save(&p).unwrap();
            cat.conn
                .execute(
                    "INSERT INTO items(source_id, path, kind, size, mtime, sha256, has_camera) VALUES (1, ?1, 'photo', 1, 0, ?2, 1)",
                    params![p.to_string_lossy(), format!("sha{i}")],
                )
                .unwrap();
        }
        let stop = AtomicBool::new(false);
        assert_eq!(analyse(&cat, &eng, &tmp.path().join("faces"), &stop, |_| {}).unwrap(), 4);
        // The two copies of the same face end up as one person.
        let ps = people(&cat).unwrap();
        eprintln!("people {ps:?}");
        assert!(ps.iter().any(|p| p.photos == 2), "{ps:?}");
        let idx = EmbeddingIndex::load(&cat).unwrap();
        let found = search(&cat, Some(&eng.clip), Some(&idx), "football").unwrap();
        eprintln!("football search {found:?}, tags {:?}", item_smart(&cat, 4).unwrap());
        assert!(found.contains(&4), "{found:?}");
        // Running again does nothing new.
        assert_eq!(analyse(&cat, &eng, &tmp.path().join("faces"), &stop, |_| {}).unwrap(), 0);
    }
}
