//! Collections: sets of photos that don't move any files. A plain collection holds the photos
//! you add to it; a smart collection holds whatever matches its rules, and keeps up by itself.

use crate::catalogue::{group_by_month, item_from_row, Catalogue, MonthGroup, IN_LIBRARY, ITEM_SELECT, LABELS};
use crate::Result;
use rusqlite::{params, types::Value, OptionalExtension};
use serde::{Deserialize, Serialize};

/// What a smart collection matches. Every rule that's set must hold.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Rules {
    /// At least this many stars.
    pub min_rating: Option<i64>,
    /// 1 picks, -1 rejects, 0 unflagged.
    pub flag: Option<i64>,
    pub label: Option<String>,
    /// "photo" or "video".
    pub kind: Option<String>,
    /// Taken in this year or later / earlier.
    pub year_from: Option<i32>,
    pub year_to: Option<i32>,
    /// Only photos with edits (true) or without (false).
    pub edited: Option<bool>,
    /// Words that must appear in the file path.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub rules: Option<Rules>,
    pub count: i64,
}

fn where_clause(r: &Rules) -> (String, Vec<Value>) {
    let mut sql = vec![IN_LIBRARY.to_string()];
    let mut args: Vec<Value> = vec![];
    if let Some(v) = r.min_rating.filter(|v| *v > 0) {
        sql.push("i.rating >= ?".into());
        args.push(v.into());
    }
    if let Some(v) = r.flag {
        sql.push("i.flag = ?".into());
        args.push(v.signum().into());
    }
    if let Some(v) = r.label.as_ref().filter(|l| LABELS.contains(&l.as_str())) {
        sql.push("i.label = ?".into());
        args.push(v.clone().into());
    }
    if let Some(v) = r.kind.as_ref().filter(|k| *k == "photo" || *k == "video") {
        sql.push("i.kind = ?".into());
        args.push(v.clone().into());
    }
    if let Some(y) = r.year_from {
        sql.push("i.taken_at >= ?".into());
        args.push(format!("{y:04}").into());
    }
    if let Some(y) = r.year_to {
        sql.push("i.taken_at < ?".into());
        args.push(format!("{:04}", y + 1).into());
    }
    if let Some(e) = r.edited {
        sql.push(format!("{}EXISTS(SELECT 1 FROM edits e WHERE e.item_id = i.id)", if e { "" } else { "NOT " }));
    }
    if let Some(t) = r.text.as_ref().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        for word in t.split_whitespace() {
            sql.push("lower(i.path) LIKE ?".into());
            args.push(format!("%{}%", word.to_lowercase()).into());
        }
    }
    (sql.join(" AND "), args)
}

fn rules_of(cat: &Catalogue, id: i64) -> Result<Option<Option<Rules>>> {
    let row: Option<Option<String>> = cat.conn.query_row("SELECT rules FROM collections WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    Ok(row.map(|r| r.and_then(|j| serde_json::from_str(&j).ok())))
}

fn count(cat: &Catalogue, id: i64, rules: &Option<Rules>) -> Result<i64> {
    Ok(match rules {
        Some(r) => {
            let (w, args) = where_clause(r);
            cat.conn.query_row(&format!("SELECT COUNT(*) FROM items i WHERE {w}"), rusqlite::params_from_iter(args), |r| r.get(0))?
        }
        None => cat.conn.query_row(
            &format!("SELECT COUNT(*) FROM items i JOIN collection_items c ON c.item_id = i.id WHERE c.collection_id = ?1 AND {IN_LIBRARY}"),
            [id],
            |r| r.get(0),
        )?,
    })
}

pub fn list(cat: &Catalogue) -> Result<Vec<Collection>> {
    let rows: Vec<(i64, String, Option<String>)> = cat
        .conn
        .prepare("SELECT id, name, rules FROM collections ORDER BY lower(name)")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<std::result::Result<_, _>>()?;
    rows.into_iter()
        .map(|(id, name, rules)| {
            let rules = rules.and_then(|j| serde_json::from_str(&j).ok());
            Ok(Collection { id, count: count(cat, id, &rules)?, name, rules })
        })
        .collect()
}

/// Make a collection; `rules` makes it a smart one. Names must be unique.
pub fn create(cat: &Catalogue, name: &str, rules: Option<&Rules>) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(crate::Error::Other("A collection needs a name".into()));
    }
    let json = rules.map(|r| serde_json::to_string(r).unwrap_or_default());
    cat.conn
        .execute("INSERT INTO collections(name, rules) VALUES (?1, ?2)", params![name, json])
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                crate::Error::Other(format!("There's already a collection called {name}"))
            }
            e => e.into(),
        })?;
    Ok(cat.conn.last_insert_rowid())
}

pub fn update(cat: &Catalogue, id: i64, name: &str, rules: Option<&Rules>) -> Result<()> {
    let json = rules.map(|r| serde_json::to_string(r).unwrap_or_default());
    cat.conn.execute("UPDATE collections SET name = ?2, rules = ?3 WHERE id = ?1", params![id, name.trim(), json])?;
    Ok(())
}

pub fn delete(cat: &Catalogue, id: i64) -> Result<()> {
    cat.conn.execute("DELETE FROM collections WHERE id = ?1", [id])?;
    Ok(())
}

/// Add photos to a plain collection (smart collections choose their own).
pub fn add(cat: &Catalogue, id: i64, item_ids: &[i64]) -> Result<()> {
    let mut st = cat.conn.prepare("INSERT OR IGNORE INTO collection_items(collection_id, item_id) VALUES (?1, ?2)")?;
    for item in item_ids {
        st.execute(params![id, item])?;
    }
    Ok(())
}

pub fn remove(cat: &Catalogue, id: i64, item_ids: &[i64]) -> Result<()> {
    let mut st = cat.conn.prepare("DELETE FROM collection_items WHERE collection_id = ?1 AND item_id = ?2")?;
    for item in item_ids {
        st.execute(params![id, item])?;
    }
    Ok(())
}

/// What's in a collection, newest first, in months.
pub fn items(cat: &Catalogue, id: i64, limit: i64) -> Result<Vec<MonthGroup>> {
    let Some(rules) = rules_of(cat, id)? else { return Ok(vec![]) };
    let order = "ORDER BY i.taken_at IS NULL, i.taken_at DESC, i.path";
    let list = match rules {
        Some(r) => {
            let (w, mut args) = where_clause(&r);
            args.push(limit.into());
            let mut st = cat.conn.prepare(&format!("{ITEM_SELECT} WHERE {w} {order} LIMIT ?"))?;
            let rows = st.query_map(rusqlite::params_from_iter(args), item_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        }
        None => {
            let mut st = cat.conn.prepare(&format!(
                "{ITEM_SELECT} JOIN collection_items c ON c.item_id = i.id WHERE c.collection_id = ?1 AND {IN_LIBRARY} {order} LIMIT ?2"
            ))?;
            let rows = st.query_map(params![id, limit], item_from_row)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    group_by_month(list)
}
