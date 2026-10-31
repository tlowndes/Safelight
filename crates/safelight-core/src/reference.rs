//! Design reference: images kept apart from photos, sorted into topics and tagged.

use crate::{
    catalogue::{item_from_row, Catalogue, Item, ITEM_SELECT},
    Result,
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Topic {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefItem {
    pub item: Item,
    pub tags: Vec<String>,
}

pub fn ensure_topic(cat: &Catalogue, name: &str) -> Result<i64> {
    let name = name.trim();
    if let Some(id) = cat.conn.query_row("SELECT id FROM topics WHERE name = ?1", [name], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    cat.conn.execute("INSERT INTO topics(name) VALUES (?1)", [name])?;
    Ok(cat.conn.last_insert_rowid())
}

pub fn topics(cat: &Catalogue) -> Result<Vec<Topic>> {
    Ok(cat
        .conn
        .prepare(
            "SELECT t.id, t.name, (SELECT COUNT(*) FROM items i WHERE i.topic_id = t.id AND i.is_reference = 1)
             FROM topics t ORDER BY t.name = 'To sort', t.name",
        )?
        .query_map([], |r| Ok(Topic { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

pub fn rename_topic(cat: &Catalogue, id: i64, name: &str) -> Result<()> {
    cat.conn.execute("UPDATE topics SET name = ?2 WHERE id = ?1", params![id, name.trim()])?;
    Ok(())
}

/// Deleting a topic moves its images back to "To sort".
pub fn delete_topic(cat: &Catalogue, id: i64) -> Result<()> {
    let to_sort = ensure_topic(cat, "To sort")?;
    if id == to_sort {
        return Ok(());
    }
    cat.conn.execute("UPDATE items SET topic_id = ?2 WHERE topic_id = ?1", params![id, to_sort])?;
    cat.conn.execute("DELETE FROM topics WHERE id = ?1", [id])?;
    Ok(())
}

pub fn set_topic(cat: &Catalogue, item_ids: &[i64], topic_id: i64) -> Result<()> {
    let tx = cat.conn.unchecked_transaction()?;
    for id in item_ids {
        tx.execute("UPDATE items SET topic_id = ?2, is_reference = 1 WHERE id = ?1", params![id, topic_id])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn tags(cat: &Catalogue) -> Result<Vec<Tag>> {
    Ok(cat
        .conn
        .prepare("SELECT t.id, t.name, (SELECT COUNT(*) FROM item_tags x WHERE x.tag_id = t.id) FROM tags t ORDER BY t.name")?
        .query_map([], |r| Ok(Tag { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<std::result::Result<_, _>>()?)
}

pub fn add_tag(cat: &Catalogue, item_ids: &[i64], name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    cat.conn.execute("INSERT OR IGNORE INTO tags(name) VALUES (?1)", [name])?;
    let tag: i64 = cat.conn.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))?;
    for id in item_ids {
        cat.conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES (?1, ?2)", params![id, tag])?;
    }
    Ok(())
}

pub fn remove_tag(cat: &Catalogue, item_id: i64, name: &str) -> Result<()> {
    cat.conn.execute(
        "DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = (SELECT id FROM tags WHERE name = ?2)",
        params![item_id, name],
    )?;
    cat.conn.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags)", [])?;
    Ok(())
}

/// Reference images, optionally filtered by topic and tag. One per fingerprint.
pub fn items(cat: &Catalogue, topic_id: Option<i64>, tag: Option<&str>) -> Result<Vec<RefItem>> {
    let mut st = cat.conn.prepare(&format!(
        "{ITEM_SELECT} WHERE i.is_reference = 1
           AND (?1 IS NULL OR i.topic_id = ?1)
           AND (?2 IS NULL OR EXISTS (SELECT 1 FROM item_tags x JOIN tags t ON t.id = x.tag_id WHERE x.item_id = i.id AND t.name = ?2))
           AND i.id IN (SELECT MIN(id) FROM items WHERE is_reference = 1 GROUP BY sha256)
         ORDER BY i.taken_at DESC"
    ))?;
    let items: Vec<Item> = st.query_map(params![topic_id, tag], item_from_row)?.collect::<std::result::Result<_, _>>()?;
    let mut tag_st = cat.conn.prepare(
        "SELECT t.name FROM item_tags x JOIN tags t ON t.id = x.tag_id WHERE x.item_id = ?1 ORDER BY t.name",
    )?;
    items
        .into_iter()
        .map(|item| {
            let tags = tag_st.query_map([item.id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
            Ok(RefItem { item, tags })
        })
        .collect()
}
