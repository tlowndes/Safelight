//! Screenshot import rules, brought over from Snapsort. New screenshots in `Pictures\Screenshots`
//! are read (on the PC by default, or by Claude if switched on), named by what is in them and
//! filed into a category folder. When Safelight isn't sure, the screenshot waits in a review list.
//! Nothing is ever deleted: every move is logged and can be put back.

use crate::{catalogue::Catalogue, Result};
use chrono::{Datelike, Local, NaiveDate, TimeZone};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

// ---------- categories ----------

pub struct Category {
    pub id: &'static str,
    pub label: &'static str,
    /// Folder name under the destination.
    pub folder: &'static str,
    /// On-device clues: each one found in the text adds its weight to the category's score.
    words: &'static [(&'static str, f64)],
}

pub const CATEGORIES: &[Category] = &[
    Category {
        id: "design",
        label: "Design",
        folder: "Design",
        words: &[
            ("figma", 3.0), ("frame", 1.0), ("auto layout", 3.0), ("layers", 1.5), ("prototype", 2.0), ("components", 1.5),
            ("artboard", 3.0), ("photoshop", 3.0), ("illustrator", 3.0), ("canva", 3.0), ("sketch", 1.5), ("framer", 2.0),
            ("fill", 0.75), ("stroke", 1.0), ("opacity", 1.5), ("typography", 2.0), ("inspect", 1.0), ("dev mode", 2.0),
            ("constraints", 1.5), ("variants", 1.5), ("hex", 1.0), ("corner radius", 3.0), ("line height", 2.0),
            ("letter spacing", 2.0), ("adobe", 2.0), ("dribbble", 3.0), ("behance", 3.0), ("wireframe", 3.0), ("mockup", 2.0),
        ],
    },
    Category {
        id: "web",
        label: "Web",
        folder: "Web",
        words: &[
            ("https://", 2.0), ("http://", 2.0), ("www.", 2.0), (".com", 1.0), (".co.uk", 1.5), (".org", 1.0), (".io", 1.0),
            ("accept cookies", 3.0), ("cookie", 1.5), ("sign in", 1.0), ("log in", 1.0), ("subscribe", 1.0), ("search", 0.5),
            ("menu", 0.5), ("about us", 2.0), ("contact us", 2.0), ("privacy policy", 2.0), ("read more", 1.5),
            ("chrome", 1.5), ("edge", 0.5), ("firefox", 2.0), ("safari", 1.5), ("new tab", 2.0), ("bookmarks", 1.5),
        ],
    },
    Category {
        id: "code",
        label: "Code",
        folder: "Code",
        words: &[
            ("function", 1.5), ("const ", 1.5), ("import ", 1.0), ("return", 1.0), ("=>", 1.5), ("console.log", 3.0),
            ("npm ", 2.0), ("git ", 1.5), ("error:", 1.5), ("exception", 1.5), ("traceback", 3.0), ("undefined", 1.5),
            ("visual studio code", 3.0), ("vs code", 3.0), ("terminal", 1.5), ("powershell", 2.0), ("localhost", 2.0),
            ("github", 2.0), ("pull request", 2.0), ("commit", 1.0), ("def ", 1.5), ("class ", 1.0), ("</", 1.5),
            ("stack trace", 3.0), ("null", 0.75), ("async", 1.5), ("await", 1.5),
        ],
    },
    Category {
        id: "receipts",
        label: "Receipts",
        folder: "Receipts",
        words: &[
            ("receipt", 3.0), ("invoice", 3.0), ("order number", 3.0), ("order #", 3.0), ("order confirmed", 3.0),
            ("subtotal", 3.0), ("total", 1.0), ("vat", 1.5), ("paid", 1.5), ("payment", 1.5), ("delivery", 1.0),
            ("dispatched", 2.0), ("refund", 2.0), ("transaction", 2.0), ("card ending", 3.0), ("booking reference", 3.0),
            ("confirmation", 1.5), ("qty", 2.0), ("amount", 1.0), ("£", 1.0), ("€", 1.0), ("$", 0.5), ("paypal", 2.0),
        ],
    },
    Category {
        id: "chats",
        label: "Chats",
        folder: "Chats",
        words: &[
            ("whatsapp", 3.0), ("messenger", 3.0), ("imessage", 3.0), ("slack", 2.5), ("teams", 1.5), ("discord", 3.0),
            ("telegram", 3.0), ("signal", 1.0), ("type a message", 3.0), ("message", 1.0), ("typing", 1.5), ("online", 1.0),
            ("last seen", 3.0), ("delivered", 1.0), ("read ", 0.5), ("reply", 1.0), ("thread", 1.0), ("reacted", 2.0),
            ("sent", 0.75), ("today", 0.5), ("yesterday", 1.0),
        ],
    },
    Category {
        id: "documents",
        label: "Documents",
        folder: "Documents",
        words: &[
            ("page ", 1.0), ("chapter", 2.0), ("word", 1.0), ("google docs", 3.0), ("microsoft word", 3.0), ("pdf", 2.0),
            ("notion", 2.5), ("obsidian", 3.0), ("heading", 1.5), ("table of contents", 3.0), ("dear ", 1.5),
            ("regards", 2.0), ("agenda", 2.0), ("minutes", 1.0), ("spreadsheet", 2.0), ("excel", 2.0), ("slide", 1.5),
            ("powerpoint", 3.0), ("keynote", 2.5), ("cv", 1.5), ("curriculum vitae", 3.0), ("cover letter", 3.0),
        ],
    },
];

/// Anything without a strong match lands here. It's a real folder too, so "File it" always works.
pub const OTHER: Category = Category { id: "other", label: "Other", folder: "Other", words: &[] };

pub fn category(id: &str) -> &'static Category {
    CATEGORIES.iter().find(|c| c.id == id).unwrap_or(&OTHER)
}

pub fn all_categories() -> impl Iterator<Item = &'static Category> {
    CATEGORIES.iter().chain(std::iter::once(&OTHER))
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryInfo {
    pub id: String,
    pub label: String,
    pub folder: String,
}

pub fn category_list() -> Vec<CategoryInfo> {
    all_categories().map(|c| CategoryInfo { id: c.id.into(), label: c.label.into(), folder: c.folder.into() }).collect()
}

// ---------- reading the text ----------

/// Apps and sites worth naming a screenshot after. The first one found wins, so the more
/// specific names come first ("Google Docs" before "Google").
const BRANDS: &[(&str, &str)] = &[
    ("figma", "Figma"), ("canva", "Canva"), ("framer", "Framer"), ("photoshop", "Photoshop"),
    ("illustrator", "Illustrator"), ("dribbble", "Dribbble"), ("behance", "Behance"),
    ("visual studio code", "VS Code"), ("vs code", "VS Code"), ("github", "GitHub"),
    ("whatsapp", "WhatsApp"), ("messenger", "Messenger"), ("imessage", "iMessage"), ("slack", "Slack"),
    ("discord", "Discord"), ("telegram", "Telegram"), ("microsoft teams", "Teams"),
    ("google docs", "Google Docs"), ("notion", "Notion"), ("obsidian", "Obsidian"),
    ("microsoft word", "Word"), ("excel", "Excel"), ("powerpoint", "PowerPoint"),
    ("amazon", "Amazon"), ("paypal", "PayPal"), ("ebay", "eBay"), ("deliveroo", "Deliveroo"),
    ("linkedin", "LinkedIn"), ("instagram", "Instagram"), ("youtube", "YouTube"), ("spotify", "Spotify"),
];

/// Words from app chrome (menus, toolbars) that make poor titles on their own.
const CHROME: &[&str] = &[
    "file", "edit", "view", "help", "share", "present", "search", "menu", "home", "sign in", "log in",
    "settings", "back", "next", "cancel", "ok", "done", "save", "close", "more", "new tab", "untitled",
    "layers", "assets", "design", "prototype", "inspect", "comments", "type a message", "reply",
];

const DOMAIN_ENDINGS: &[&str] = &[".co.uk", ".com", ".org", ".net", ".io", ".dev", ".app", ".design", ".uk"];

/// What a screenshot shows, from the on-device reader or from Claude.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Classified {
    pub category: String,
    pub app: Option<String>,
    pub title: String,
    /// 0 to 1.
    pub confidence: f64,
}

fn count_of(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).take(3).count()
}

/// Scores each category by the clue words in the text. Returns them best first.
pub fn score_categories(text: &str) -> Vec<(&'static str, f64)> {
    let lower = format!(" {} ", text.to_lowercase());
    let mut scores: Vec<_> = CATEGORIES
        .iter()
        .map(|c| (c.id, c.words.iter().map(|(w, weight)| count_of(&lower, w) as f64 * weight).sum::<f64>()))
        .collect();
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scores
}

/// A web address found in the text ("bbc.co.uk", "apple.com"), without the scheme or www.
fn find_domain(lower: &str) -> Option<String> {
    for raw in lower.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == '"' || c == '\'') {
        let mut t = raw.trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.");
        if let Some(cut) = t.find(['/', '?', '#', ':']) {
            t = &t[..cut];
        }
        let t = t.trim_end_matches(['.', ',', ';', '!']);
        if t.is_empty() || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
            continue;
        }
        if let Some(end) = DOMAIN_ENDINGS.iter().find(|e| t.ends_with(*e)) {
            let head = &t[..t.len() - end.len()];
            if !head.is_empty() && !head.ends_with('.') && head.split('.').all(|l| !l.is_empty()) {
                return Some(t.to_string());
            }
        }
    }
    None
}

pub fn find_brand(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if let Some((_, name)) = BRANDS.iter().find(|(needle, _)| lower.contains(needle)) {
        return Some(name.to_string());
    }
    find_domain(&lower)
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn looks_like_time(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len()).any(|i| {
        b[i] == b':'
            && i >= 1
            && b[i - 1].is_ascii_digit()
            && b.get(i + 1).is_some_and(|c| c.is_ascii_digit())
            && b.get(i + 2).is_some_and(|c| c.is_ascii_digit())
    })
}

fn looks_like_price(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    chars.iter().enumerate().any(|(i, c)| {
        matches!(c, '£' | '€' | '$')
            && (chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())
                || (chars.get(i + 1) == Some(&' ') && chars.get(i + 2).is_some_and(|d| d.is_ascii_digit())))
    })
}

/// Shortens to at most `max` characters, cutting back to the last whole word.
fn cut_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    match cut.rfind(char::is_whitespace) {
        Some(i) => cut[..i].to_string(),
        None => cut,
    }
}

/// Picks the line that reads most like a heading: a few real words, mostly letters, near the top,
/// and not a menu item, a time or a price.
pub fn find_title(lines: &[&str], brand: Option<&str>) -> String {
    let brand_lower = brand.unwrap_or("").to_lowercase();
    let mut best: Option<(String, i64)> = None;
    for (index, raw) in lines.iter().enumerate() {
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let lower = line.to_lowercase();
        let words: Vec<&str> = line.split(' ').filter(|w| !w.is_empty()).collect();
        let len = line.chars().count();
        if words.len() < 2 || words.len() > 8 || len < 6 || len > 60 {
            continue;
        }
        if CHROME.contains(&lower.as_str()) || lower == brand_lower {
            continue;
        }
        // A menu bar read as one line: "File Edit View Help".
        if words.iter().all(|w| CHROME.contains(&w.to_lowercase().as_str())) {
            continue;
        }
        if looks_like_time(&line) || looks_like_price(&line) || lower.contains("http:") || lower.contains("https:") || lower.contains("www.") {
            continue;
        }
        let letters = line.chars().filter(|c| c.is_ascii_alphabetic()).count();
        if (letters as f64) / (len as f64) < 0.7 {
            continue;
        }
        let all_caps = line == line.to_uppercase();
        let score = 10 - (index.min(8) as i64) + (words.len().min(5) as i64) - if all_caps { 3 } else { 0 };
        if best.as_ref().map_or(true, |(_, s)| score > *s) {
            best = Some((line, score));
        }
    }
    match best {
        Some((line, _)) => capitalise(&cut_words(line.trim_end_matches(['.', ':', ';', ',']), 48)),
        None => String::new(),
    }
}

/// Works out what a screenshot is from its text alone. Strong clues for one category and few
/// for the rest score high; a near tie or very little text scores low, so the screenshot waits
/// in the review list instead of being filed.
pub fn classify_text(text: &str) -> Classified {
    let clean = text.trim();
    let lines: Vec<&str> = clean.lines().collect();
    let app = find_brand(clean);
    let title = find_title(&lines, app.as_deref());
    let scores = score_categories(clean);
    let (top, second) = (scores[0], scores.get(1).copied());
    if top.1 < 2.0 {
        return Classified { category: OTHER.id.into(), app, title, confidence: if clean.is_empty() { 0.0 } else { 0.2 } };
    }
    let strength = (top.1 / 8.0).min(1.0);
    let margin = top.1 / (top.1 + second.map_or(0.0, |s| s.1));
    Classified { category: top.0.into(), app, title, confidence: (strength * margin * 100.0).round() / 100.0 }
}

// ---------- naming ----------

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const MAX_NAME: usize = 90;

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Takes out characters Windows won't allow in a file name, and tidies the spacing.
pub fn safe_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { ' ' } else { c })
        .collect();
    let cleaned = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.chars().count() <= MAX_NAME {
        return cleaned;
    }
    cut_words(&cleaned, MAX_NAME).trim_end_matches(['.', ' ', '–', '-']).to_string()
}

/// When the screenshot was really taken. Screenshot tools put the date in the name
/// ("Screenshot 2026-10-31 224512.png", "Screenshot_20261031_224512.png"); that wins over the
/// file's modified time, which changes if the file is copied. Returns "YYYY-MM-DD".
pub fn taken_on(path: &Path, mtime_secs: i64) -> String {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if let Some(d) = date_in_name(name) {
        return d.format("%Y-%m-%d").to_string();
    }
    Local
        .timestamp_opt(mtime_secs, 0)
        .single()
        .map(|t| t.date_naive().format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| Local::now().date_naive().format("%Y-%m-%d").to_string())
}

fn date_in_name(name: &str) -> Option<NaiveDate> {
    let b = name.as_bytes();
    let digits = |s: &[u8]| -> Option<u32> {
        s.iter().all(|c| c.is_ascii_digit()).then(|| std::str::from_utf8(s).ok()?.parse().ok()).flatten()
    };
    let sep = |c: u8| matches!(c, b'-' | b'_' | b'.');
    for i in 0..b.len() {
        if b.len() < i + 8 || b[i] != b'2' || b[i + 1] != b'0' {
            continue;
        }
        let Some(year) = digits(&b[i..i + 4]) else { continue };
        let mut j = i + 4;
        if b.get(j).copied().is_some_and(sep) {
            j += 1;
        }
        let Some(month) = b.get(j..j + 2).and_then(digits) else { continue };
        j += 2;
        if b.get(j).copied().is_some_and(sep) {
            j += 1;
        }
        let Some(day) = b.get(j..j + 2).and_then(digits) else { continue };
        if let Some(d) = NaiveDate::from_ymd_opt(year as i32, month, day) {
            if d.year() >= 2000 {
                return Some(d);
            }
        }
    }
    None
}

/// "Figma – Onboarding flow", "Amazon – Order confirmed", or just "Figma".
pub fn describe(c: &Classified) -> String {
    let lead = c.app.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| category(&c.category).label.to_string());
    let title = c.title.trim();
    if title.is_empty() || title.eq_ignore_ascii_case(&lead) {
        return lead;
    }
    if title.to_lowercase().starts_with(&lead.to_lowercase()) {
        return title.to_string();
    }
    format!("{lead} – {title}")
}

/// The full new file name, keeping the original extension: "2026-10-31 Figma – Onboarding flow.png".
pub fn build_file_name(description: &str, date: &str, ext: &str, date_prefix: bool) -> String {
    let body = safe_name(description);
    let body = if body.is_empty() { "Screenshot".to_string() } else { body };
    let ext = ext.to_lowercase();
    let dot = if ext.is_empty() { "" } else { "." };
    if date_prefix && !date.is_empty() {
        format!("{date} {body}{dot}{ext}")
    } else {
        format!("{body}{dot}{ext}")
    }
}

// ---------- suggestions ----------

/// What Safelight thinks one screenshot is, and what it would call it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    pub path: String,
    pub category: String,
    pub app: Option<String>,
    pub title: String,
    pub confidence: f64,
    /// "device" (Windows OCR) or "claude".
    pub engine: String,
    /// "YYYY-MM-DD"
    pub date: String,
    pub description: String,
    pub new_name: String,
    /// Why something went wrong reading it, if it did (shown on the card).
    pub note: Option<String>,
    /// Text found in the screenshot, kept so it can be searched.
    pub text: String,
    pub found: String,
}

/// Builds a suggestion for one screenshot from the text read on the PC and, if Claude was asked
/// and answered, Claude's view (which wins).
pub fn suggest(path: &Path, lines: &[String], claude: Option<Classified>, note: Option<String>, date_prefix: bool) -> Result<Suggestion> {
    let meta = fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64);
    let text = lines.join("\n");
    let (result, engine) = match claude {
        Some(c) => (c, "claude"),
        None => (classify_text(&text), "device"),
    };
    let date = taken_on(path, mtime);
    let description = describe(&result);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    Ok(Suggestion {
        path: path.to_string_lossy().into_owned(),
        new_name: build_file_name(&description, &date, ext, date_prefix),
        category: result.category,
        app: result.app,
        title: result.title,
        confidence: result.confidence,
        engine: engine.into(),
        date,
        description,
        note,
        text: text.chars().take(2000).collect(),
        found: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}

// ---------- settings ----------

/// How sure a suggestion has to be before it's filed without asking.
pub fn threshold(sureness: &str) -> f64 {
    match sureness {
        "careful" => 0.85,
        "relaxed" => 0.55,
        _ => 0.7,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotSettings {
    /// The folder Windows saves screenshots to.
    pub folder: String,
    /// Where category folders go. Defaults to the screenshot folder itself.
    pub destination: String,
    /// Watch the folder and handle new screenshots as they arrive.
    pub watch: bool,
    /// "device" (Windows OCR, nothing leaves the PC) or "claude".
    pub reader: String,
    /// "best" or "cheapest".
    pub claude_model: String,
    pub has_api_key: bool,
    pub auto_file: bool,
    /// "careful", "balanced" or "relaxed".
    pub sureness: String,
    pub date_prefix: bool,
}

const KEYS: &[&str] = &["folder", "destination", "watch", "reader", "claude_model", "auto_file", "sureness", "date_prefix"];

impl ShotSettings {
    pub fn load(cat: &Catalogue, default_folder: &str) -> Result<Self> {
        let get = |k: &str| cat.setting(&format!("shots_{k}"));
        let folder = get("folder")?.filter(|s| !s.is_empty()).unwrap_or_else(|| default_folder.to_string());
        Ok(Self {
            destination: get("destination")?.filter(|s| !s.is_empty()).unwrap_or_else(|| folder.clone()),
            folder,
            watch: get("watch")?.as_deref() != Some("0"),
            reader: get("reader")?.filter(|r| r == "claude").unwrap_or_else(|| "device".into()),
            claude_model: get("claude_model")?.filter(|m| m == "cheapest").unwrap_or_else(|| "best".into()),
            has_api_key: get("api_key")?.is_some_and(|k| !k.is_empty()),
            auto_file: get("auto_file")?.as_deref() != Some("0"),
            sureness: get("sureness")?.filter(|s| s == "careful" || s == "relaxed").unwrap_or_else(|| "balanced".into()),
            date_prefix: get("date_prefix")?.as_deref() != Some("0"),
        })
    }

    pub fn threshold(&self) -> f64 {
        threshold(&self.sureness)
    }

    /// True when screenshots should go to Claude (switched on and a key saved).
    pub fn use_claude(&self) -> bool {
        self.reader == "claude" && self.has_api_key
    }
}

/// Saves one screenshot setting. Only known keys are accepted.
pub fn set_setting(cat: &Catalogue, key: &str, value: &str) -> Result<()> {
    if !KEYS.contains(&key) {
        return Err(crate::Error::Other(format!("unknown screenshot setting {key}")));
    }
    cat.set_setting(&format!("shots_{key}"), value)
}

/// The Claude API key, stored already protected (see `secret`).
pub fn stored_api_key(cat: &Catalogue) -> Result<Option<String>> {
    Ok(cat.setting("shots_api_key")?.filter(|k| !k.is_empty()))
}

pub fn store_api_key(cat: &Catalogue, protected: &str) -> Result<()> {
    cat.set_setting("shots_api_key", protected)
}

// ---------- the review list and the move log ----------

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS shot_queue (
  path TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  found TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shot_moves (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  confidence REAL NOT NULL,
  auto INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  undone_at TEXT
);
"#;

fn key(path: &str) -> String {
    // Windows paths aren't case-sensitive, so neither is the review list.
    path.to_lowercase()
}

pub fn queue_put(cat: &Catalogue, s: &Suggestion) -> Result<()> {
    let json = serde_json::to_string(s).map_err(|e| crate::Error::Other(e.to_string()))?;
    cat.conn.execute(
        "INSERT INTO shot_queue(path, json, found) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET json = excluded.json",
        params![key(&s.path), json, s.found],
    )?;
    Ok(())
}

pub fn queue_get(cat: &Catalogue, path: &str) -> Result<Option<Suggestion>> {
    let json: Option<String> = cat.conn.query_row("SELECT json FROM shot_queue WHERE path = ?1", [key(path)], |r| r.get(0)).optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

pub fn queue_has(cat: &Catalogue, path: &str) -> Result<bool> {
    Ok(cat.conn.query_row("SELECT 1 FROM shot_queue WHERE path = ?1", [key(path)], |_| Ok(())).optional()?.is_some())
}

pub fn queue_remove(cat: &Catalogue, path: &str) -> Result<()> {
    cat.conn.execute("DELETE FROM shot_queue WHERE path = ?1", [key(path)])?;
    Ok(())
}

/// The review list, newest first. Entries whose file has gone (moved or deleted by hand) are
/// dropped as they're found.
pub fn queue(cat: &Catalogue) -> Result<Vec<Suggestion>> {
    let rows: Vec<(String, String)> = cat
        .conn
        .prepare("SELECT path, json FROM shot_queue ORDER BY found DESC, path")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    for (k, json) in rows {
        match serde_json::from_str::<Suggestion>(&json) {
            Ok(s) if Path::new(&s.path).exists() => out.push(s),
            _ => {
                cat.conn.execute("DELETE FROM shot_queue WHERE path = ?1", [k])?;
            }
        }
    }
    Ok(out)
}

pub fn queue_count(cat: &Catalogue) -> Result<i64> {
    Ok(cat.conn.query_row("SELECT COUNT(*) FROM shot_queue", [], |r| r.get(0))?)
}

#[derive(Debug, Clone, Serialize)]
pub struct Move {
    pub id: i64,
    pub at: String,
    pub from: String,
    pub to: String,
    pub category: String,
    pub name: String,
    pub engine: String,
    pub confidence: f64,
    /// Filed without asking (the watcher was sure).
    pub auto: bool,
    pub undone: bool,
}

fn move_from_row(r: &rusqlite::Row) -> rusqlite::Result<Move> {
    Ok(Move {
        id: r.get(0)?,
        at: r.get(1)?,
        from: r.get(2)?,
        to: r.get(3)?,
        category: r.get(4)?,
        name: r.get(5)?,
        engine: r.get(6)?,
        confidence: r.get(7)?,
        auto: r.get(8)?,
        undone: r.get::<_, Option<String>>(9)?.is_some(),
    })
}

const MOVE_SELECT: &str = "SELECT id, at, from_path, to_path, category, name, engine, confidence, auto, undone_at FROM shot_moves";

pub fn get_move(cat: &Catalogue, id: i64) -> Result<Option<Move>> {
    Ok(cat.conn.query_row(&format!("{MOVE_SELECT} WHERE id = ?1"), [id], move_from_row).optional()?)
}

/// Recently filed screenshots, newest first. `query` matches the new name or the words found
/// in the screenshot.
pub fn moves(cat: &Catalogue, query: Option<&str>, limit: i64) -> Result<Vec<Move>> {
    let like = query.filter(|q| !q.trim().is_empty()).map(|q| format!("%{}%", q.trim().to_lowercase()));
    let mut st = cat.conn.prepare(&format!(
        "{MOVE_SELECT} WHERE (?1 IS NULL OR lower(name) LIKE ?1 OR lower(text) LIKE ?1) ORDER BY id DESC LIMIT ?2"
    ))?;
    let rows = st.query_map(params![like, limit], move_from_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// A path in `dir` that does not exist yet: "name.png", then "name (2).png", and so on.
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let p = Path::new(file_name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut candidate = dir.join(file_name);
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/// Moves a file to a path that's free, creating folders as needed. Never overwrites. Across drives
/// it copies, checks the copy's size, then removes the original, so a failed move loses nothing.
fn relocate(from: &Path, to: &Path) -> Result<()> {
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    if to.exists() {
        return Err(crate::Error::Other(format!("{} already exists", to.display())));
    }
    if fs::rename(from, to).is_err() {
        let size = fs::metadata(from)?.len();
        fs::copy(from, to)?;
        if fs::metadata(to)?.len() != size {
            let _ = fs::remove_file(to);
            return Err(crate::Error::Other("The copy didn't match, so nothing was moved".into()));
        }
        fs::remove_file(from)?;
    }
    Ok(())
}

/// Keeps the catalogue pointing at the file after it moves, so ratings, tags and edits follow it.
fn follow_in_catalogue(cat: &Catalogue, from: &Path, to: &Path) -> Result<()> {
    cat.conn.execute(
        "UPDATE items SET path = ?2 WHERE path = ?1 AND NOT EXISTS (SELECT 1 FROM items WHERE path = ?2)",
        params![from.to_string_lossy(), to.to_string_lossy()],
    )?;
    Ok(())
}

/// The user's changes from the review list.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FileEdits {
    pub category: Option<String>,
    /// The name without the date or extension, e.g. "Figma – Onboarding flow".
    pub description: Option<String>,
}

/// Moves a screenshot into its category folder under its new name, logs the move and takes it
/// off the review list. Returns the logged move.
pub fn file_shot(cat: &Catalogue, s: &Suggestion, edits: &FileEdits, destination: &str, date_prefix: bool, auto: bool) -> Result<Move> {
    let from = Path::new(&s.path);
    if !from.exists() {
        queue_remove(cat, &s.path)?;
        return Err(crate::Error::Other("That screenshot is no longer there".into()));
    }
    let cat_info = category(edits.category.as_deref().unwrap_or(&s.category));
    let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("");
    let name = match edits.description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => build_file_name(d, &s.date, ext, date_prefix),
        None => s.new_name.clone(),
    };
    let name = Some(safe_name(&name)).filter(|n| !n.is_empty()).unwrap_or_else(|| from.file_name().unwrap().to_string_lossy().into_owned());
    let dir = Path::new(destination).join(cat_info.folder);
    fs::create_dir_all(&dir)?;
    let to = unique_path(&dir, &name);
    relocate(from, &to)?;
    follow_in_catalogue(cat, from, &to)?;
    let stem = to.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    cat.conn.execute(
        "INSERT INTO shot_moves(at, from_path, to_path, category, name, engine, confidence, auto, text)
         VALUES (datetime('now', 'localtime'), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![s.path, to.to_string_lossy(), cat_info.id, stem, s.engine, s.confidence, auto, s.text],
    )?;
    let id = cat.conn.last_insert_rowid();
    queue_remove(cat, &s.path)?;
    Ok(get_move(cat, id)?.expect("move just logged"))
}

/// Puts a filed screenshot back where it was, under its old name (or a numbered one if that name
/// has been taken since). Returns where it went.
pub fn undo(cat: &Catalogue, id: i64) -> Result<String> {
    let m = get_move(cat, id)?.ok_or_else(|| crate::Error::Other("That move isn't in the log".into()))?;
    if m.undone {
        return Err(crate::Error::Other("Already put back".into()));
    }
    let current = Path::new(&m.to);
    if !current.exists() {
        return Err(crate::Error::Other("It has been moved or deleted since, so it can't be put back".into()));
    }
    let original = Path::new(&m.from);
    let dir = original.parent().unwrap_or(Path::new("."));
    let back = unique_path(dir, &original.file_name().unwrap_or_default().to_string_lossy());
    relocate(current, &back)?;
    follow_in_catalogue(cat, current, &back)?;
    cat.conn.execute("UPDATE shot_moves SET undone_at = datetime('now', 'localtime') WHERE id = ?1", [id])?;
    Ok(back.to_string_lossy().into_owned())
}

/// Screenshots sitting loose at the top of the folder, i.e. not filed yet. Newest first.
pub fn unsorted(folder: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(folder) else { return Vec::new() };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| is_image(p) && !p.file_name().unwrap_or_default().to_string_lossy().starts_with('.'))
        .map(|p| {
            let t = fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            (p, t)
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.into_iter().map(|(p, _)| p).collect()
}

// ---------- Claude (optional) ----------

pub const MODEL_BEST: &str = "claude-opus-5-5";
pub const MODEL_CHEAPEST: &str = "claude-haiku-5-5";

pub fn claude_model(choice: &str) -> &'static str {
    if choice == "cheapest" { MODEL_CHEAPEST } else { MODEL_BEST }
}

fn claude_system() -> String {
    let mut s = vec![
        "You name and file screenshots for a designer.".to_string(),
        "Look at the screenshot and decide which folder it belongs in:".to_string(),
    ];
    s.extend(all_categories().map(|c| format!("- {}: {}", c.id, c.label)));
    s.push("Give the app or website it shows, and a short title a person would recognise later,".into());
    s.push("such as \"Onboarding flow\", \"Order confirmed\" or \"Build error\". Use UK spelling.".into());
    s.push("Never put personal details such as phone numbers, addresses or card numbers in the title.".into());
    s.join("\n")
}

/// The Messages API request body for one screenshot. The image is sent with any text the PC
/// already read, which helps with small print. The answer comes back as JSON matching a schema.
pub fn claude_request(model: &str, media_type: &str, image_base64: &str, ocr_text: &str) -> serde_json::Value {
    let ids: Vec<&str> = all_categories().map(|c| c.id).collect();
    let text = if ocr_text.trim().is_empty() {
        "No text was found in the screenshot.".to_string()
    } else {
        format!("Text found in the screenshot:\n{}", ocr_text.chars().take(4000).collect::<String>())
    };
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 2000,
        "system": claude_system(),
        "output_config": {
            "effort": "low",
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "category": { "type": "string", "enum": ids },
                        "app": { "type": "string", "description": "The app or website shown, e.g. \"Figma\" or \"bbc.co.uk\". Empty if unclear." },
                        "title": { "type": "string", "description": "A short, specific title for what the screenshot shows, 2 to 6 words, sentence case." },
                        "confidence": { "type": "number", "description": "How sure you are of the category, from 0 to 1." }
                    },
                    "required": ["category", "app", "title", "confidence"],
                    "additionalProperties": false
                }
            }
        },
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": media_type, "data": image_base64 } },
                { "type": "text", "text": text }
            ]
        }]
    });
    // If the best model declines, the API retries on a suitable fallback inside the same call.
    if model == MODEL_BEST {
        body["fallbacks"] = serde_json::json!("default");
    }
    body
}

/// Beta header to send with `claude_request` for this model, if any.
pub fn claude_beta(model: &str) -> Option<&'static str> {
    (model == MODEL_BEST).then_some("server-side-fallback-2026-07-01")
}

/// Reads Claude's answer. Unknown categories become Other; confidence is kept between 0 and 1.
pub fn parse_claude_response(v: &serde_json::Value) -> std::result::Result<Classified, String> {
    if v["stop_reason"] == "refusal" {
        return Err("Claude declined to describe this screenshot".into());
    }
    let text = v["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .ok_or("Claude sent back no answer")?;
    let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| "Claude's answer was unreadable".to_string())?;
    let cat_id = parsed["category"].as_str().unwrap_or("");
    let app = parsed["app"].as_str().map(str::trim).filter(|a| !a.is_empty()).map(String::from);
    Ok(Classified {
        category: category(cat_id).id.to_string(),
        app,
        title: parsed["title"].as_str().unwrap_or("").trim().to_string(),
        confidence: parsed["confidence"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0),
    })
}

/// A plain-English reason for a failed Claude call, for the screenshot's card.
pub fn explain_claude_status(status: u16) -> String {
    match status {
        401 | 403 => "Your Claude API key was turned down. Check it in Settings.".into(),
        429 | 529 => "Claude is busy. It was read on the PC instead.".into(),
        s => format!("Claude had a problem ({s}). It was read on the PC instead."),
    }
}

/// Claude reads images up to about 1568 pixels on the long edge and a few MB; bigger screenshots
/// are scaled down first. Returns the media type and the bytes to send.
pub fn claude_image(path: &Path) -> Result<(&'static str, Vec<u8>)> {
    const MAX_BYTES: u64 = 3_500_000;
    const MAX_EDGE: u32 = 1568;
    let size = fs::metadata(path)?.len();
    let dims = image::image_dimensions(path).ok();
    if size <= MAX_BYTES && dims.is_some_and(|(w, h)| w.max(h) <= MAX_EDGE) {
        return Ok((media_type(path), fs::read(path)?));
    }
    let img = image::open(path)?;
    let img = if img.width().max(img.height()) > MAX_EDGE { img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3) } else { img };
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    if png.len() as u64 <= MAX_BYTES {
        return Ok(("image/png", png));
    }
    let mut jpeg = Vec::new();
    image::DynamicImage::ImageRgb8(img.to_rgb8()).write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)?;
    Ok(("image/jpeg", jpeg))
}

pub fn media_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn figma_is_design_named_after_the_frame() {
        let r = classify_text("Figma\nFile Edit View\nLayers\nAssets\nOnboarding flow\nAuto layout\nFill\nStroke\nCorner radius 12");
        assert_eq!(r.category, "design");
        assert_eq!(r.app.as_deref(), Some("Figma"));
        assert_eq!(r.title, "Onboarding flow");
        assert!(r.confidence >= 0.7, "confidence {}", r.confidence);
    }

    #[test]
    fn receipts_chats_and_code() {
        let r = classify_text("Order confirmed\nOrder number 204-118\nSubtotal £24.00\nVAT £4.80\nTotal paid £28.80");
        assert_eq!(r.category, "receipts");
        assert_eq!(r.title, "Order confirmed");
        assert_eq!(classify_text("WhatsApp\nMum\nlast seen today at 21:04\nType a message").category, "chats");
        assert_eq!(classify_text("const x = await load()\nconsole.log(x)\nTypeError: undefined is not a function").category, "code");
    }

    #[test]
    fn little_text_is_other_and_unsure() {
        let empty = classify_text("");
        assert_eq!((empty.category.as_str(), empty.confidence), ("other", 0.0));
        let r = classify_text("Hello there");
        assert_eq!(r.category, "other");
        assert!(r.confidence < 0.5);
    }

    #[test]
    fn a_near_tie_is_less_sure() {
        let clear = classify_text("Figma Auto layout Corner radius Prototype Components");
        let tie = classify_text("Figma prototype\nconst x = 1\nconsole.log(x)");
        assert!(tie.confidence < clear.confidence);
    }

    #[test]
    fn brands_then_web_addresses() {
        assert_eq!(find_brand("Shared in Slack").as_deref(), Some("Slack"));
        assert_eq!(find_brand("https://www.forestandfield.co.uk/shop").as_deref(), Some("forestandfield.co.uk"));
        assert_eq!(find_brand("nothing here"), None);
    }

    #[test]
    fn titles_skip_menus_times_and_prices() {
        assert_eq!(find_title(&["File", "10:42", "£12.00", "Pricing cards v3", "Share"], None), "Pricing cards v3");
        assert_eq!(find_title(&["OK"], None), "");
    }

    #[test]
    fn names_are_safe_on_windows() {
        assert_eq!(safe_name("Figma: \"Home\"/v2?"), "Figma Home v2");
        assert_eq!(safe_name("trailing dots..."), "trailing dots");
        assert!(safe_name(&"word ".repeat(40)).chars().count() <= 90);
    }

    #[test]
    fn dates_come_from_the_name_first() {
        assert_eq!(taken_on(Path::new("Screenshot 2026-10-31 224512.png"), 0), "2026-10-31");
        assert_eq!(taken_on(Path::new("Screenshot_20261031_224512.png"), 0), "2026-10-31");
        assert_eq!(taken_on(Path::new("Screenshot 2026-13-45.png"), 0).len(), 10);
    }

    #[test]
    fn descriptions_and_file_names() {
        let c = |cat: &str, app: Option<&str>, title: &str| Classified { category: cat.into(), app: app.map(String::from), title: title.into(), confidence: 1.0 };
        assert_eq!(describe(&c("design", Some("Figma"), "Onboarding flow")), "Figma – Onboarding flow");
        assert_eq!(describe(&c("receipts", None, "")), "Receipts");
        assert_eq!(describe(&c("web", Some("GitHub"), "GitHub pull request")), "GitHub pull request");
        assert_eq!(build_file_name("Figma – Onboarding flow", "2026-10-31", "PNG", true), "2026-10-31 Figma – Onboarding flow.png");
        assert_eq!(build_file_name("", "2026-10-31", "png", false), "Screenshot.png");
    }

    #[test]
    fn claude_answers_are_checked() {
        let ok = serde_json::json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "{\"category\":\"nope\",\"app\":\" \",\"title\":\" Build error \",\"confidence\":4}" }] });
        let r = parse_claude_response(&ok).unwrap();
        assert_eq!((r.category.as_str(), r.app, r.title.as_str(), r.confidence), ("other", None, "Build error", 1.0));
        assert!(parse_claude_response(&serde_json::json!({ "stop_reason": "refusal", "content": [] })).is_err());
        let body = claude_request(MODEL_BEST, "image/png", "AAAA", "");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert_eq!(body["fallbacks"], "default");
        assert!(claude_request(MODEL_CHEAPEST, "image/png", "AAAA", "").get("fallbacks").is_none());
    }
}
