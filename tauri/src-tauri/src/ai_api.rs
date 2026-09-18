//! AI / memory / workspace tool surface for StuartMD (medium-term AI prep).
//! Storage lives under `%APPDATA%\StuartMD\ai\` — never touches document UX.
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::fs_api::{data_dir, VERSION};
use crate::fs_api::MD_EXTS;

const AI_API_VERSION: i64 = 1;
const MEMORY_MAX_BYTES: u64 = 512 * 1024;
const SEARCH_MAX_FILES: usize = 200;
const SEARCH_MAX_HITS: usize = 50;
const SEARCH_FILE_MAX: u64 = 2 * 1024 * 1024;

pub fn ai_home() -> PathBuf {
    let d = data_dir().join("ai");
    let _ = fs::create_dir_all(&d);
    d
}

pub fn memory_dir() -> PathBuf {
    let d = ai_home().join("memory");
    let _ = fs::create_dir_all(&d);
    d
}

fn sanitize_memory_key(key: &str) -> Result<String, String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("记忆键不能为空".into());
    }
    if k.len() > 64 {
        return Err("记忆键过长（≤64）".into());
    }
    if k.starts_with('.') || k.contains("..") {
        return Err("记忆键非法".into());
    }
    if !k
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("记忆键仅允许字母数字 - _ .".into());
    }
    Ok(format!("{k}.md"))
}

fn memory_path(key: &str) -> Result<PathBuf, String> {
    Ok(memory_dir().join(sanitize_memory_key(key)?))
}

fn mtime_secs(p: &Path) -> u64 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub fn stuart_get_capabilities() -> Value {
    json!({
        "version": VERSION,
        "api_version": AI_API_VERSION,
        "host": "tauri",
        "features": {
            "document": true,
            "outline": true,
            "blocks": true,
            "selection": true,
            "find": true,
            "memory": true,
            "workspace_search": true,
            "plugins": true,
            "pdf_annotations": true,
            "ai_chat": false,
            "ai_tools": true
        },
        "paths": {
            "ai_home": ai_home().to_string_lossy(),
            "memory_dir": memory_dir().to_string_lossy()
        },
        "limits": {
            "memory_key_max": 64,
            "memory_value_max_bytes": MEMORY_MAX_BYTES,
            "search_max_files": SEARCH_MAX_FILES,
            "search_max_hits": SEARCH_MAX_HITS,
            "read_file_max_bytes": 8 * 1024 * 1024
        }
    })
}

#[tauri::command]
pub fn stuart_ai_home() -> Value {
    let d = ai_home();
    json!({"ok": true, "path": d.to_string_lossy()})
}

#[tauri::command]
pub fn stuart_memory_list() -> Value {
    let dir = memory_dir();
    let mut items = vec![];
    let Ok(rd) = fs::read_dir(&dir) else {
        return json!({"ok": true, "keys": []});
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("json") {
            continue;
        }
        let name = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        items.push(json!({
            "key": name,
            "size": size,
            "mtime": mtime_secs(&p)
        }));
    }
    items.sort_by(|a, b| {
        let ak = a.get("key").and_then(|k| k.as_str()).unwrap_or("");
        let bk = b.get("key").and_then(|k| k.as_str()).unwrap_or("");
        ak.cmp(bk)
    });
    json!({"ok": true, "keys": items})
}

#[tauri::command]
pub fn stuart_memory_get(key: String) -> Value {
    let p = match memory_path(&key) {
        Ok(p) => p,
        Err(e) => return json!({"error": e}),
    };
    if !p.is_file() {
        return json!({"error": "记忆不存在", "key": key});
    }
    match fs::read(&p) {
        Ok(bytes) => {
            let content = String::from_utf8_lossy(&bytes).to_string();
            json!({
                "ok": true,
                "key": key,
                "content": content,
                "path": p.to_string_lossy(),
                "size": bytes.len()
            })
        }
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_memory_set(key: String, content: String) -> Value {
    let p = match memory_path(&key) {
        Ok(p) => p,
        Err(e) => return json!({"error": e}),
    };
    if content.len() as u64 > MEMORY_MAX_BYTES {
        return json!({"error": format!("记忆内容过大（>{}KB）", MEMORY_MAX_BYTES / 1024)});
    }
    match fs::write(&p, content.as_bytes()) {
        Ok(()) => json!({"ok": true, "key": key, "path": p.to_string_lossy()}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_memory_delete(key: String) -> Value {
    let p = match memory_path(&key) {
        Ok(p) => p,
        Err(e) => return json!({"error": e}),
    };
    if !p.is_file() {
        return json!({"ok": true, "key": key, "deleted": false});
    }
    match fs::remove_file(&p) {
        Ok(()) => json!({"ok": true, "key": key, "deleted": true}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

/// Bounded full-text search over Markdown under `root`. For AI tools + folder find backend.
#[tauri::command]
pub fn stuart_search_md(root: String, query: String, limit: Option<usize>) -> Value {
    let q = query.trim();
    if q.is_empty() {
        return json!({"error": "查询为空"});
    }
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return json!({"error": "目录不存在"});
    }
    let max_hits = limit.unwrap_or(SEARCH_MAX_HITS).clamp(1, 200);
    let needle = q.to_lowercase();
    let mut hits = vec![];
    let mut scanned = 0usize;
    let mut stack = vec![root_path.to_path_buf()];
    'outer: while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if scanned >= SEARCH_MAX_FILES || hits.len() >= max_hits {
                break 'outer;
            }
            if p.is_dir() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                stack.push(p);
                continue;
            }
            let Some(ext) = p.extension().and_then(|x| x.to_str()) else {
                continue;
            };
            let ext_dot = format!(".{}", ext.to_lowercase());
            if !MD_EXTS.contains(&ext_dot.as_str()) {
                continue;
            }
            let Ok(meta) = fs::metadata(&p) else { continue };
            if meta.len() > SEARCH_FILE_MAX {
                continue;
            }
            scanned += 1;
            let Ok(bytes) = fs::read(&p) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(&needle.as_str()) {
                    let preview: String = line.trim().chars().take(160).collect();
                    hits.push(json!({
                        "path": p.to_string_lossy(),
                        "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        "line": i + 1,
                        "preview": preview
                    }));
                    if hits.len() >= max_hits {
                        break 'outer;
                    }
                }
            }
        }
    }
    json!({
        "ok": true,
        "query": q,
        "root": root_path.to_string_lossy(),
        "scanned_files": scanned,
        "hits": hits,
        "truncated": hits.len() >= max_hits || scanned >= SEARCH_MAX_FILES
    })
}

/// List Markdown files under a workspace root (depth-limited via walk_md).
#[tauri::command]
pub fn stuart_workspace_files(root: String) -> Value {
    let p = Path::new(&root);
    if !p.is_dir() {
        return json!({"error": "目录不存在"});
    }
    let items = crate::fs_api::walk_md_public(p);
    json!({
        "ok": true,
        "root": p.to_string_lossy(),
        "items": items
    })
}
