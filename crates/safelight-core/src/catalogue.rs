//! The local catalogue: a SQLite file in the app's data folder (never inside a synced folder).

use crate::{media::Kind, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::{path::Path, time::Duration};

pub struct Catalogue {
    pub(crate) conn: Connection,
}

#[derive(Debug, Clone, Serialize)]
pub struct Source {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub root: String,
    pub item_count: i64,
    pub last_scanned: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: i64,
    pub source_id: i64,
    pub path: String,
    pub kind: Kind,
    pub size: i64,
    pub sha256: String,
    pub taken_at: Option<String>,
    pub date_source: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub has_camera: bool,
    /// Cached thumbnail (JPEG) path, once generated.
    pub thumb: Option<String>,
    /// None = undecided, "keep", or "drop" (a look-alike the user chose not to keep).
    pub dup_status: Option<String>,
    /// None = not decided, true/false once the user (or an accepted suggestion) has said.
    pub is_reference: Option<bool>,
    pub topic_id: Option<i64>,
    pub edited: bool,
    /// True when another file in the catalogue has the same fingerprint.
    pub has_exact_duplicate: bool,
    /// 0 = unrated, 1 to 5 stars.
    pub rating: i64,
    /// 1 = pick, -1 = reject, 0 = unflagged.
    pub flag: i64,
    /// Hidden from the library, the timeline and organising. The file is never touched.
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonthGroup {
    /// "2024-06", or "undated"
    pub month: String,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Stats {
    pub photos: i64,
    pub videos: i64,
    pub total_bytes: i64,
    /// Files that are byte-identical copies of another file (all copies minus one per group).
    pub exact_duplicate_files: i64,
    pub exact_duplicate_groups: i64,
    pub needing_thumbnails: i64,
    pub reference: i64,
    pub hidden: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  last_scanned TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  taken_at TEXT,
  date_source TEXT,
  seen_scan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_sha ON items(sha256);
CREATE INDEX IF NOT EXISTS items_taken ON items(taken_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_day TEXT NOT NULL,
  end_day TEXT NOT NULL,
  UNIQUE(start_day, end_day)
);
CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);
CREATE TABLE IF NOT EXISTS copies (
  sha256 TEXT PRIMARY KEY,
  item_id INTEGER,
  lib_path TEXT NOT NULL,
  lib_verified INTEGER NOT NULL DEFAULT 0,
  backup_path TEXT,
  backup_verified INTEGER NOT NULL DEFAULT 0,
  copied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edits (item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS binned (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  moved_to TEXT NOT NULL,
  at TEXT NOT NULL
);
"#;

/// Columns added after the first release; added in place so existing catalogues keep working.
const ITEM_COLUMNS: &[(&str, &str)] = &[
    ("width", "INTEGER"),
    ("height", "INTEGER"),
    ("has_camera", "INTEGER NOT NULL DEFAULT 0"),
    ("thumb", "TEXT"),
    ("thumb_tried", "INTEGER NOT NULL DEFAULT 0"),
    ("phash", "INTEGER"),
    ("dup_status", "TEXT"),
    ("dup_keeper", "TEXT"),
    ("is_reference", "INTEGER"),
    ("topic_id", "INTEGER"),
    ("rating", "INTEGER NOT NULL DEFAULT 0"),
    ("flag", "INTEGER NOT NULL DEFAULT 0"),
    ("hidden", "INTEGER NOT NULL DEFAULT 0"),
];

pub(crate) const ITEM_SELECT: &str = "SELECT i.id, i.source_id, i.path, i.kind, i.size, i.sha256, i.taken_at, i.date_source,
    i.width, i.height, i.has_camera, i.thumb, i.dup_status, i.is_reference, i.topic_id,
    EXISTS(SELECT 1 FROM edits e WHERE e.item_id = i.id),
    (SELECT COUNT(*) FROM items j WHERE j.sha256 = i.sha256) > 1,
    i.rating, i.flag, i.hidden
  FROM items i";

pub(crate) fn item_from_row(r: &Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        source_id: r.get(1)?,
        path: r.get(2)?,
        kind: Kind::from_str(&r.get::<_, String>(3)?),
        size: r.get(4)?,
        sha256: r.get(5)?,
        taken_at: r.get(6)?,
        date_source: r.get(7)?,
        width: r.get(8)?,
        height: r.get(9)?,
        has_camera: r.get(10)?,
        thumb: r.get(11)?,
        dup_status: r.get(12)?,
        is_reference: r.get(13)?,
        topic_id: r.get(14)?,
        edited: r.get(15)?,
        has_exact_duplicate: r.get(16)?,
        rating: r.get(17)?,
        flag: r.get(18)?,
        hidden: r.get(19)?,
    })
}

impl Catalogue {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.busy_timeout(Duration::from_secs(30))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        conn.execute_batch(SCHEMA)?;
        let existing: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('items')")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        for (col, ty) in ITEM_COLUMNS {
            if !existing.iter().any(|c| c == col) {
                conn.execute_batch(&format!("ALTER TABLE items ADD COLUMN {col} {ty}"))?;
            }
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS items_phash ON items(phash)")?;
        Ok(Self { conn })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    // ---------- settings ----------

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Folders Safelight writes to (library, backup, thumbnail cache). Scans skip these so
    /// copies aren't re-imported, and clean-up never touches them.
    pub fn managed_roots(&self) -> Result<Vec<String>> {
        Ok([self.setting("library_root")?, self.setting("backup_root")?, self.setting("thumb_cache")?]
            .into_iter()
            .flatten()
            .collect())
    }

    // ---------- sources ----------

    pub fn add_source(&self, name: &str, kind: &str, root: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO sources(name, kind, root) VALUES (?1, ?2, ?3)
             ON CONFLICT(root) DO UPDATE SET name = excluded.name, kind = excluded.kind",
            params![name, kind, root],
        )?;
        Ok(self.conn.query_row("SELECT id FROM sources WHERE root = ?1", [root], |r| r.get(0))?)
    }

    pub fn remove_source(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM sources WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn sources(&self) -> Result<Vec<Source>> {
        let mut st = self.conn.prepare(
            "SELECT s.id, s.name, s.kind, s.root, s.last_scanned,
                    (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id)
             FROM sources s ORDER BY s.id",
        )?;
        let rows = st.query_map([], |r| {
            Ok(Source {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                root: r.get(3)?,
                last_scanned: r.get(4)?,
                item_count: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn source_root(&self, id: i64) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT root FROM sources WHERE id = ?1", [id], |r| r.get(0)).optional()?)
    }

    // ---------- items ----------

    pub fn item(&self, id: i64) -> Result<Option<Item>> {
        Ok(self
            .conn
            .query_row(&format!("{ITEM_SELECT} WHERE i.id = ?1"), [id], item_from_row)
            .optional()?)
    }

    /// Star rating for each photo: 0 clears it, 1 to 5 sets it. Only the catalogue changes.
    pub fn set_rating(&self, ids: &[i64], rating: i64) -> Result<()> {
        let rating = rating.clamp(0, 5);
        let mut st = self.conn.prepare("UPDATE items SET rating = ?1 WHERE id = ?2")?;
        for id in ids {
            st.execute(params![rating, id])?;
        }
        Ok(())
    }

    /// Pick (1), reject (-1) or clear (0). Rejecting never deletes anything.
    pub fn set_flag(&self, ids: &[i64], flag: i64) -> Result<()> {
        let flag = flag.signum();
        let mut st = self.conn.prepare("UPDATE items SET flag = ?1 WHERE id = ?2")?;
        for id in ids {
            st.execute(params![flag, id])?;
        }
        Ok(())
    }

    /// Hide or show photos. Hiding applies to every exact copy (same fingerprint), so the photo
    /// doesn't reappear from another source. Nothing on disk changes.
    pub fn set_hidden(&self, ids: &[i64], hidden: bool) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE items SET hidden = ?1 WHERE sha256 = (SELECT sha256 FROM items WHERE id = ?2)",
                params![hidden, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Hidden photos, one per fingerprint, newest first.
    pub fn hidden_items(&self) -> Result<Vec<Item>> {
        let mut st = self.conn.prepare(&format!(
            "{ITEM_SELECT} WHERE i.hidden = 1 AND i.id IN (SELECT MIN(id) FROM items WHERE hidden = 1 GROUP BY sha256)
             ORDER BY i.taken_at IS NULL, i.taken_at DESC, i.path"
        ))?;
        let rows = st.query_map([], item_from_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn stats(&self) -> Result<Stats> {
        let mut s = Stats::default();
        self.conn.query_row(
            "SELECT COALESCE(SUM(kind='photo'),0), COALESCE(SUM(kind='video'),0), COALESCE(SUM(size),0),
                    COALESCE(SUM(thumb_tried = 0),0), COALESCE(SUM(is_reference = 1),0), COALESCE(SUM(hidden = 1),0) FROM items",
            [],
            |r| {
                s.photos = r.get(0)?;
                s.videos = r.get(1)?;
                s.total_bytes = r.get(2)?;
                s.needing_thumbnails = r.get(3)?;
                s.reference = r.get(4)?;
                s.hidden = r.get(5)?;
                Ok(())
            },
        )?;
        self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(n - 1), 0) FROM (SELECT COUNT(*) n FROM items GROUP BY sha256 HAVING n > 1)",
            [],
            |r| {
                s.exact_duplicate_groups = r.get(0)?;
                s.exact_duplicate_files = r.get(1)?;
                Ok(())
            },
        )?;
        Ok(s)
    }

    /// Newest first, grouped by month. Leaves out confirmed reference images and look-alikes
    /// the user chose not to keep. `limit` caps the number of items returned.
    pub fn library(&self, limit: i64) -> Result<Vec<MonthGroup>> {
        let mut st = self.conn.prepare(&format!(
            "{ITEM_SELECT}
             WHERE COALESCE(i.is_reference, 0) = 0 AND COALESCE(i.dup_status, '') <> 'drop' AND i.hidden = 0
             ORDER BY i.taken_at IS NULL, i.taken_at DESC, i.path
             LIMIT ?1"
        ))?;
        let rows = st.query_map([limit], item_from_row)?;
        let mut groups: Vec<MonthGroup> = Vec::new();
        for item in rows {
            let item = item?;
            let month = item.taken_at.as_deref().map(|t| t[..7].to_string()).unwrap_or_else(|| "undated".into());
            match groups.last_mut() {
                Some(g) if g.month == month => g.items.push(item),
                _ => groups.push(MonthGroup { month, items: vec![item] }),
            }
        }
        Ok(groups)
    }
}
