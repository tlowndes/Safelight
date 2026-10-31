//! Where a file will live in the organised library: Photos/YYYY/YYYY-MM[ Event]/YYYY-MM-DD HH.MM.SS.ext

use chrono::NaiveDateTime;

pub fn planned_path(taken_at: Option<NaiveDateTime>, event: Option<&str>, original_name: &str) -> String {
    let ext = original_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match taken_at {
        Some(t) => {
            let month = t.format("%Y-%m").to_string();
            let folder = match event.map(clean).filter(|e| !e.is_empty()) {
                Some(e) => format!("{month} {e}"),
                None => month,
            };
            let file = t.format("%Y-%m-%d %H.%M.%S").to_string();
            let file = if ext.is_empty() { file } else { format!("{file}.{ext}") };
            format!("Photos/{}/{}/{}", t.format("%Y"), folder, file)
        }
        None => format!("Photos/Undated/{original_name}"),
    }
}

/// Strip characters Windows won't allow in folder names.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }
    #[test]
    fn builds_year_month_event_paths() {
        assert_eq!(
            planned_path(Some(dt("2024-06-14 18:32:05")), Some("Barcelona"), "IMG_4021.HEIC"),
            "Photos/2024/2024-06 Barcelona/2024-06-14 18.32.05.heic"
        );
        assert_eq!(
            planned_path(Some(dt("2024-07-01 09:00:00")), None, "a.jpg"),
            "Photos/2024/2024-07/2024-07-01 09.00.00.jpg"
        );
        assert_eq!(planned_path(None, None, "old.jpg"), "Photos/Undated/old.jpg");
        assert_eq!(
            planned_path(Some(dt("2025-01-11 12:00:00")), Some("Nan's 80th: party?"), "x.JPG"),
            "Photos/2025/2025-01 Nan's 80th party/2025-01-11 12.00.00.jpg"
        );
    }
}
