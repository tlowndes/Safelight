//! The local catalogue: a SQLite file in the app's data folder (never inside a synced folder).

use crate::{media::Kind, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

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
    /// True when another file in the catalogue has the same fingerprint.
    pub has_exact_duplicate: bool,
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
"#;

impl Catalogue {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

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

    pub fn stats(&self) -> Result<Stats> {
        let mut s = Stats::default();
        self.conn.query_row(
            "SELECT COALESCE(SUM(kind='photo'),0), COALESCE(SUM(kind='video'),0), COALESCE(SUM(size),0) FROM items",
            [],
            |r| {
                s.photos = r.get(0)?;
                s.videos = r.get(1)?;
                s.total_bytes = r.get(2)?;
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

    /// Newest first, grouped by month. `limit` caps the number of items returned.
    pub fn library(&self, limit: i64) -> Result<Vec<MonthGroup>> {
        let mut st = self.conn.prepare(
            "SELECT i.id, i.source_id, i.path, i.kind, i.size, i.sha256, i.taken_at, i.date_source,
                    (SELECT COUNT(*) FROM items j WHERE j.sha256 = i.sha256) > 1
             FROM items i
             ORDER BY i.taken_at IS NULL, i.taken_at DESC, i.path
             LIMIT ?1",
        )?;
        let rows = st.query_map([limit], |r| {
            Ok(Item {
                id: r.get(0)?,
                source_id: r.get(1)?,
                path: r.get(2)?,
                kind: Kind::from_str(&r.get::<_, String>(3)?),
                size: r.get(4)?,
                sha256: r.get(5)?,
                taken_at: r.get(6)?,
                date_source: r.get(7)?,
                has_exact_duplicate: r.get(8)?,
            })
        })?;
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
