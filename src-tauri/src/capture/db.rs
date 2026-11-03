//! The capture store: recordings, screenshots, edit recipes and exports. One SQLite file in
//! the app data folder (next to the catalogue, never in a synced folder). The schema and
//! queries live in TypeScript (src/capture/services/library.ts); this side only runs them.
use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{Map, Number, Value};
use tauri::State;

use super::CaptureState as AppState;

fn to_sql(v: &Value) -> Result<SqlValue, String> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => return Err(format!("Can't store {other} in the capture library")),
    })
}

fn to_json(v: SqlValue) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::Number(i.into()),
        SqlValue::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        SqlValue::Text(s) => Value::String(s),
        SqlValue::Blob(_) => Value::Null,
    }
}

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(conn)
}

pub fn execute(conn: &Connection, sql: &str, params: &[Value]) -> Result<(), String> {
    let values = params.iter().map(to_sql).collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    match stmt.execute(rusqlite::params_from_iter(values)) {
        Ok(_) | Err(rusqlite::Error::ExecuteReturnedResults) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn select(conn: &Connection, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
    let values = params.iter().map(to_sql).collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(rusqlite::params_from_iter(values)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut obj = Map::new();
        for (i, name) in names.iter().enumerate() {
            obj.insert(name.clone(), to_json(row.get::<_, SqlValue>(i).map_err(|e| e.to_string())?));
        }
        out.push(obj);
    }
    Ok(out)
}

#[tauri::command]
pub fn capture_db_execute(state: State<'_, AppState>, sql: String, params: Vec<Value>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    execute(&conn, &sql, &params)
}

#[tauri::command]
pub fn capture_db_select(state: State<'_, AppState>, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    select(&conn, &sql, &params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_rows() {
        let conn = Connection::open_in_memory().unwrap();
        execute(&conn, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, fps REAL, note TEXT)", &[]).unwrap();
        execute(&conn, "INSERT INTO t (name, fps, note) VALUES (?, ?, ?)", &[json!("a"), json!(29.97), Value::Null]).unwrap();
        execute(&conn, "PRAGMA user_version = 2", &[]).unwrap();
        let rows = select(&conn, "SELECT * FROM t WHERE name = ?", &[json!("a")]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], json!(1));
        assert_eq!(rows[0]["fps"], json!(29.97));
        assert_eq!(rows[0]["note"], Value::Null);
        let v = select(&conn, "PRAGMA user_version", &[]).unwrap();
        assert_eq!(v[0]["user_version"], json!(2));
    }
}
