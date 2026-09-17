//! File/settings commands aligned with pywebview `window.pywebview.api`.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const APP_ID: &str = "StuartMD";
pub const VERSION: &str = "1.12.1";
pub const PROG_ID: &str = "StuartMD.Markdown";
const PDF_MAX: u64 = 40 * 1024 * 1024;
const MD_EXTS: [&str; 5] = [".md", ".markdown", ".mdown", ".mkd", ".txt"];

pub fn data_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let d = base.join(APP_ID);
    let _ = fs::create_dir_all(&d);
    d
}

pub fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn load_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

pub fn save_json(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stuart_get_app_info() -> Value {
    json!({
        "name": APP_ID,
        "version": VERSION,
        "publisher": APP_ID,
        "data_dir": data_dir().to_string_lossy(),
        "install_dir": std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string())).unwrap_or_default(),
        "frozen": true,
        "startup_file": null,
        "prog_id": "StuartMD.Markdown",
        "plugins_dir": data_dir().join("plugins").to_string_lossy(),
        "wallpapers_dir": data_dir().join("wallpapers").to_string_lossy(),
        "languages": ["zh-CN", "zh-TW", "en-US"],
        "github": "https://github.com/ghostLLC/StuartMD",
        "schema_version": 2,
        "shell": "tauri-p2-scaffold"
    })
}

#[tauri::command]
pub fn stuart_get_settings() -> Value {
    load_json(&settings_path())
}

#[tauri::command]
pub fn stuart_save_settings(data: Value) -> Result<bool, String> {
    let path = settings_path();
    let mut cur = load_json(&path);
    if let (Some(obj), Some(patch)) = (cur.as_object_mut(), data.as_object()) {
        for (k, v) in patch {
            obj.insert(k.clone(), v.clone());
        }
    }
    save_json(&path, &cur)?;
    Ok(true)
}

#[tauri::command]
pub fn stuart_file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn stuart_read_file(path: String) -> Value {
    let p = Path::new(&path);
    if !p.exists() {
        return json!({"error": format!("文件不存在: {path}")});
    }
    if p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) == Some("pdf".into()) {
        return stuart_read_pdf(path);
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string());
    let Ok(meta) = meta else {
        return json!({"error": "无法读取文件"});
    };
    if meta.len() > 8 * 1024 * 1024 {
        return json!({"error": "文件过大（>8MB）"});
    }
    let content = fs::read_to_string(p).unwrap_or_else(|_| String::from(""));
    json!({"kind": "markdown", "path": p.to_string_lossy(), "name": p.file_name().unwrap_or_default().to_string_lossy(), "content": content, "size": meta.len()})
}

#[tauri::command]
pub fn stuart_write_file(path: String, content: String) -> Value {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(p, content) {
        Ok(()) => json!({"ok": true, "path": p.to_string_lossy()}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_read_pdf(path: String) -> Value {
    let p = Path::new(&path);
    if !p.exists() {
        return json!({"error": format!("文件不存在: {path}")});
    }
    let meta = match fs::metadata(p) {
        Ok(m) => m,
        Err(e) => return json!({"error": e.to_string()}),
    };
    if meta.len() > PDF_MAX {
        return json!({"error": format!("PDF 过大（>{}MB）", PDF_MAX / (1024 * 1024))});
    }
    let bytes = match fs::read(p) {
        Ok(b) => b,
        Err(e) => return json!({"error": e.to_string()}),
    };
    json!({
        "kind": "pdf",
        "path": p.to_string_lossy(),
        "name": p.file_name().unwrap_or_default().to_string_lossy(),
        "size": meta.len(),
        "b64": B64.encode(&bytes),
        "annotations": []
    })
}

fn walk_md(dir: &Path, depth: i32, max_depth: i32) -> Vec<Value> {
    if depth > max_depth {
        return vec![];
    }
    let mut items = vec![];
    let Ok(rd) = fs::read_dir(dir) else {
        return items;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| {
        let is_dir = e.path().is_dir();
        let name = e.file_name().to_string_lossy().to_lowercase();
        (!is_dir, name)
    });
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            let children = walk_md(&p, depth + 1, max_depth);
            let has_md = fs::read_dir(&p)
                .map(|rd| {
                    rd.flatten().any(|c| {
                        c.path().is_file()
                            && c
                                .path()
                                .extension()
                                .and_then(|x| x.to_str())
                                .map(|x| {
                                    let e = format!(".{}", x.to_lowercase());
                                    MD_EXTS.contains(&e.as_str())
                                })
                                .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            if !children.is_empty() || has_md {
                items.push(json!({"name": name, "path": p.to_string_lossy(), "type": "dir", "children": children}));
            }
        } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            let e2 = format!(".{}", ext.to_lowercase());
            if MD_EXTS.contains(&e2.as_str()) {
                items.push(json!({"name": name, "path": p.to_string_lossy(), "type": "file"}));
            }
        }
    }
    items
}

#[tauri::command]
pub fn stuart_read_dir_tree(path: String) -> Value {
    let root = Path::new(&path);
    if !root.is_dir() {
        return json!({"error": "目录不存在"});
    }
    json!({
        "path": root.to_string_lossy(),
        "name": root.file_name().unwrap_or_default().to_string_lossy(),
        "items": walk_md(root, 1, 3)
    })
}

#[tauri::command]
pub fn stuart_open_in_new_window(path: Option<String>) -> Value {
    let Some(path) = path else {
        return json!({"error": "未指定文件路径"});
    };
    let p = Path::new(&path);
    if !p.exists() {
        return json!({"error": format!("文件不存在: {path}")});
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg(p);
    match cmd.spawn() {
        Ok(_) => json!({"ok": true, "path": p.to_string_lossy(), "kind": if p.is_dir() { "folder" } else { "file" }}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_open_url(url: String) -> bool {
    if !url.starts_with("http") {
        return false;
    }
    // opener plugin would be used in full integration; scaffold uses shell open
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .is_ok()
}

#[tauri::command]
pub fn stuart_list_plugins() -> Value {
    let dir = data_dir().join("plugins");
    let _ = fs::create_dir_all(&dir);
    let mut plugins = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("js") {
                plugins.push(json!({
                    "id": p.file_stem().unwrap_or_default().to_string_lossy(),
                    "path": p.to_string_lossy(),
                    "name": p.file_stem().unwrap_or_default().to_string_lossy(),
                    "enabled": true
                }));
            }
        }
    }
    json!({"plugins": plugins, "dir": dir.to_string_lossy()})
}

#[tauri::command]
pub fn stuart_read_plugin_source(path: String) -> Value {
    match fs::read_to_string(&path) {
        Ok(source) => json!({"path": path, "source": source}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_import_wallpaper(b64: String, name: Option<String>) -> Value {
    let raw = B64.decode(b64.split(',').last().unwrap_or("")).unwrap_or_default();
    let dir = data_dir().join("wallpapers");
    let _ = fs::create_dir_all(&dir);
    let safe = name.unwrap_or_else(|| "wallpaper.png".into());
    let safe: String = safe
        .chars()
        .filter(|c| c.is_alphanumeric() || "._- ".contains(*c))
        .collect();
    let file = dir.join(if safe.is_empty() { "wallpaper.png".into() } else { safe });
    if fs::write(&file, &raw).is_err() {
        return json!({"error": "写入壁纸失败"});
    }
    json!({"ok": true, "path": file.to_string_lossy(), "uri": format!("file:///{}", file.to_string_lossy().replace('\\', "/")), "colors": ["#f5f5f5", "#ffffff", "#333333", "#1a1a1a", "#555555"]})
}

#[tauri::command]
pub fn stuart_get_wallpaper() -> Value {
    let wp = load_json(&settings_path());
    wp.get("wallpaper").cloned().unwrap_or_else(|| json!({}))
}

#[tauri::command]
pub fn stuart_open_welcome() -> Value {
    // Prefer packaged sample next to exe
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    for cand in [
        exe_dir.join("_internal").join("samples").join("欢迎使用 StuartMD.md"),
        exe_dir.join("samples").join("欢迎使用 StuartMD.md"),
    ] {
        if cand.exists() {
            return stuart_read_file(cand.to_string_lossy().to_string());
        }
    }
    json!({
        "path": null,
        "name": "欢迎使用 StuartMD.md",
        "kind": "markdown",
        "welcome": true,
        "content": "# StuartMD\n\n轻量 Markdown 阅读与编辑器。\n",
        "size": 0
    })
}
