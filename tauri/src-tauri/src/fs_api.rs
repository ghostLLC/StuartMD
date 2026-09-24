//! File/settings commands aligned with pywebview `window.pywebview.api`.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::ipc::Response;

const APP_ID: &str = "StuartMD";
pub const VERSION: &str = "3.3.0";
pub const PROG_ID: &str = "StuartMD.Markdown";
pub const PROG_ID_PDF: &str = "StuartMD.PDF";
pub const SETTINGS_SCHEMA: i64 = 4;
const PDF_MAX: u64 = 40 * 1024 * 1024;
pub const PDF_MAX_BYTES: u64 = 100 * 1024 * 1024; // 100 MB 上限
pub const MD_EXTS: [&str; 5] = [".md", ".markdown", ".mdown", ".mkd", ".txt"];

static ATOMIC_WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn walk_md_public(dir: &Path) -> Vec<Value> {
    walk_md(dir, 1, 4)
}

static STARTUP_FILE: OnceLock<Option<String>> = OnceLock::new();

pub fn set_startup_file(path: Option<String>) {
    let _ = STARTUP_FILE.set(path);
}

pub fn startup_file() -> Option<String> {
    STARTUP_FILE.get().cloned().flatten()
}

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
}

pub fn data_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let d = base.join(APP_ID);
    let _ = fs::create_dir_all(&d);
    d
}

pub fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn plugins_dir() -> PathBuf {
    let d = data_dir().join("plugins");
    let _ = fs::create_dir_all(&d);
    d
}

pub fn wallpapers_dir() -> PathBuf {
    let d = data_dir().join("wallpapers");
    let _ = fs::create_dir_all(&d);
    d
}

pub fn load_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

pub fn atomic_write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };

    if parent != Path::new(".") {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
    }

    let pid = std::process::id();
    let mut last_err = String::new();

    for attempt in 0..5 {
        let seq = ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or(0);
        let tmp_name = format!(".~stuart_tmp_{}_{}_{:x}_{}.tmp", pid, seq, timestamp, attempt);
        let tmp_path = parent.join(&tmp_name);

        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = format!("临时文件碰撞: {e}");
                continue;
            }
            Err(e) => return Err(format!("创建临时文件失败: {e}")),
        };

        if let Err(e) = file.write_all(content) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("写入临时文件失败: {e}"));
        }

        if let Err(e) = file.sync_all() {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("数据持久化刷盘失败 (fsync): {e}"));
        }
        drop(file);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS};

            let replace_res = if path.exists() {
                let wide_target: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                let wide_tmp: Vec<u16> = tmp_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

                let ret = unsafe {
                    ReplaceFileW(
                        wide_target.as_ptr(),
                        wide_tmp.as_ptr(),
                        std::ptr::null(),
                        REPLACEFILE_IGNORE_MERGE_ERRORS,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if ret != 0 {
                    Ok(())
                } else {
                    fs::rename(&tmp_path, path).map_err(|e| format!("Windows ReplaceFileW 及 rename 降级均失败: {e}"))
                }
            } else {
                fs::rename(&tmp_path, path).map_err(|e| format!("原子文件移动创建失败: {e}"))
            };

            if let Err(e) = replace_res {
                let _ = fs::remove_file(&tmp_path);
                return Err(e);
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = fs::rename(&tmp_path, path) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("原子文件替换失败: {e}"));
            }
        }

        return Ok(());
    }

    Err(format!("超过最大重试次数，临时文件创建失败: {last_err}"))
}

pub fn save_json(path: &Path, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    atomic_write_file(path, &bytes)
}

pub fn default_settings() -> Value {
    json!({
        "schema_version": SETTINGS_SCHEMA,
        "recent": [],
        "theme": "light",
        "last_folder": "",
        "sidebar": true,
        "mode": "preview",
        "autosave": true,
        "glass": false,
        "language": "zh-CN",
        "plugins_disabled": [],
        "wallpaper": {},
        "app_version": VERSION,
        "open_mode": "smart",
        "new_doc_mode": "tab",
        "content_width": "default",
        "music": {"volume": 0.4, "currentId": "rain", "customName": "", "playing": false},
        "sample_dismissed": false,
        "session": {"tabs": [], "active_path": ""},
        "last_open_files": [],
        "window_state": null,
        "ai": crate::ai_chat::builtin_ai_defaults(),
    })
}

/// Upgrade old settings in place; keep all user data intact.
pub fn migrate_settings(raw: Option<Value>) -> Value {
    let mut s = match raw {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    let from_v = s
        .get("schema_version")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);

    if from_v < 2 {
        if let Some(obj) = s.as_object_mut() {
            obj.entry("language".to_string())
                .or_insert_with(|| json!("zh-CN"));
            obj.entry("plugins_disabled".to_string())
                .or_insert_with(|| json!([]));
            obj.entry("wallpaper".to_string()).or_insert_with(|| json!({}));
            let theme = obj.get("theme").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if theme == "glass" || theme == "frosted" || theme == "Stuart" || theme == "MiniTypora" {
                obj.insert("theme".into(), json!("light"));
            }
            obj.insert("glass".into(), json!(false));
        }
    }

    if from_v < 3 {
        // Existing installs already used the app — don't force the sample page on them
        if let Some(obj) = s.as_object_mut() {
            let has_recent = obj
                .get("recent")
                .and_then(|r| r.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let has_folder = obj
                .get("last_folder")
                .and_then(|f| f.as_str())
                .map(|f| !f.is_empty())
                .unwrap_or(false);
            if has_recent || has_folder {
                obj.insert("sample_dismissed".into(), json!(true));
            }
        }
    }

    if from_v < 4 {
        if let Some(obj) = s.as_object_mut() {
            obj.entry("ai".to_string())
                .or_insert_with(crate::ai_chat::builtin_ai_defaults);
        }
    }

    if let (Some(obj), Some(defaults)) = (s.as_object_mut(), default_settings().as_object().cloned()) {
        for (k, v) in defaults {
            obj.entry(k).or_insert(v);
        }
        obj.insert("schema_version".into(), json!(SETTINGS_SCHEMA));
        obj.insert("app_version".into(), json!(VERSION));
    }
    s
}

pub fn export_safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "export.html".into());
    let cleaned: String = base
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .filter(|c| *c != '\0')
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "export.html".into()
    } else if cleaned.len() > 120 {
        cleaned.chars().take(120).collect()
    } else {
        cleaned
    }
}

pub fn is_under_plugin_dir(p: &Path) -> bool {
    let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let roots = [plugins_dir(), exe_dir().join("plugins")];
    for root in roots {
        let root_c = root.canonicalize().unwrap_or(root);
        if canonical.starts_with(&root_c) {
            return true;
        }
    }
    false
}

static SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn settings_guard() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn load_settings_migrated_unlocked() -> Value {
    let path = settings_path();
    let before = if path.exists() { Some(load_json(&path)) } else { None };
    let s = migrate_settings(before.clone());
    let changed = match &before {
        None => true,
        Some(b) => b != &s,
    };
    if changed {
        let _ = save_json(&path, &s);
    }
    s
}

pub fn load_settings_migrated() -> Value {
    let _guard = settings_guard();
    load_settings_migrated_unlocked()
}

pub fn modify_settings<F>(modifier: F) -> Result<Value, String>
where
    F: FnOnce(&mut Value) -> Result<(), String>,
{
    let _guard = settings_guard();
    let path = settings_path();
    let mut current = load_settings_migrated_unlocked();

    modifier(&mut current)?;

    save_json(&path, &current)?;
    Ok(current)
}

pub fn push_recent(path: &str, kind: &str) {
    let _guard = settings_guard();
    let path_ref = settings_path();
    let mut s = load_settings_migrated_unlocked();
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    if let Some(obj) = s.as_object_mut() {
        let mut recents: Vec<Value> = obj
            .get("recent")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();
        // Already at head with same kind → skip disk write
        if let Some(first) = recents.first() {
            let p = first.get("path").and_then(|x| x.as_str()).unwrap_or("");
            let k = first.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            if p == path && k == kind {
                return;
            }
        }
        recents.retain(|r| r.get("path").and_then(|p| p.as_str()) != Some(path));
        recents.insert(0, json!({"path": path, "name": name, "kind": kind}));
        recents.truncate(20);
        obj.insert("recent".into(), json!(recents));
    }
    let _ = save_json(&path_ref, &s);
}

pub fn path_to_file_uri(p: &Path) -> String {
    let abs = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut s = abs.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        format!("file:///{}", s)
    } else if s.starts_with("//") {
        format!("file:{}", s)
    } else {
        format!("file:///{}", s.trim_start_matches('/'))
    }
}

fn sample_candidates(name: &str) -> Vec<PathBuf> {
    let exe = exe_dir();
    let cwd = std::env::current_dir().unwrap_or_default();
    vec![
        exe.join("samples").join(name),
        exe.join("_internal").join("samples").join(name),
        exe.join("resources").join("samples").join(name),
        cwd.join("samples").join(name),
        cwd.join("..").join("samples").join(name),
        cwd.join("..").join("..").join("samples").join(name),
    ]
}

fn find_sample(name: &str) -> Option<PathBuf> {
    sample_candidates(name).into_iter().find(|p| p.is_file())
}

#[tauri::command]
pub fn stuart_get_app_info() -> Value {
    json!({
        "name": APP_ID,
        "version": VERSION,
        "publisher": APP_ID,
        "data_dir": data_dir().to_string_lossy(),
        "install_dir": exe_dir().to_string_lossy(),
        "frozen": true,
        "startup_file": startup_file(),
        "prog_id": PROG_ID,
        "plugins_dir": plugins_dir().to_string_lossy(),
        "wallpapers_dir": wallpapers_dir().to_string_lossy(),
        "languages": ["zh-CN", "zh-TW", "en-US"],
        "github": "https://github.com/ghostLLC/StuartMD",
        "schema_version": SETTINGS_SCHEMA,
        "shell": "tauri"
    })
}

#[tauri::command]
pub fn stuart_get_settings() -> Value {
    load_settings_migrated()
}

#[tauri::command]
pub fn stuart_save_settings(data: Value) -> Result<bool, String> {
    modify_settings(|cur| {
        if let (Some(obj), Some(patch)) = (cur.as_object_mut(), data.as_object()) {
            for (k, v) in patch {
                obj.insert(k.clone(), v.clone());
            }
        }
        Ok(())
    })?;
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
        let path_s = path.clone();
        let mut v = stuart_read_pdf(path);
        if let Some(obj) = v.as_object_mut() {
            if !obj.contains_key("error") {
                push_recent(&path_s, "file");
            }
        }
        return v;
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string());
    let Ok(meta) = meta else {
        return json!({"error": "无法读取文件"});
    };
    if meta.len() > 8 * 1024 * 1024 {
        return json!({"error": "文件过大（>8MB）"});
    }
    let bytes = match fs::read(p) {
        Ok(b) => b,
        Err(e) => return json!({"error": e.to_string()}),
    };
    // Never silently return empty content on encoding failures
    let (content, encoding) = match String::from_utf8(bytes) {
        Ok(s) => (s, "utf-8"),
        Err(e) => (
            String::from_utf8_lossy(e.as_bytes()).to_string(),
            "lossy",
        ),
    };
    push_recent(&p.to_string_lossy(), "file");
    json!({
        "kind": "markdown",
        "path": p.to_string_lossy(),
        "name": p.file_name().unwrap_or_default().to_string_lossy(),
        "content": content,
        "size": meta.len(),
        "encoding": encoding
    })
}

#[tauri::command]
pub fn stuart_write_file(path: String, content: String) -> Value {
    let p = Path::new(&path);
    match atomic_write_file(p, content.as_bytes()) {
        Ok(()) => {
            push_recent(&p.to_string_lossy(), "file");
            json!({"ok": true, "path": p.to_string_lossy()})
        }
        Err(e) => {
            eprintln!("[I/O Error] stuart_write_file failed for {}: {}", path, e);
            json!({"error": e})
        }
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
    let annotations = crate::win_api::load_annotations_for(p);
    json!({
        "kind": "pdf",
        "path": p.to_string_lossy(),
        "name": p.file_name().unwrap_or_default().to_string_lossy(),
        "size": meta.len(),
        "b64": B64.encode(&bytes),
        "annotations": annotations
    })
}

#[tauri::command]
pub fn stuart_read_pdf_binary(path: String) -> Result<Response, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("PDF 文件不存在".to_string());
    }

    let meta = fs::metadata(p).map_err(|e| format!("获取 PDF 元数据失败: {e}"))?;
    if !meta.is_file() {
        return Err("目标路径不是常规文件".to_string());
    }
    if meta.len() > PDF_MAX_BYTES {
        return Err(format!(
            "PDF 文件过大 ({:.2} MB)，超过系统 100 MB 安全处理上限",
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }

    let bytes = fs::read(p).map_err(|e| format!("读取 PDF 文件失败: {e}"))?;
    push_recent(&p.to_string_lossy(), "file");
    Ok(Response::new(bytes))
}

fn walk_md(dir: &Path, depth: i32, max_depth: i32) -> Vec<Value> {
    walk_md_capped(dir, depth, max_depth, &mut 0)
}

fn walk_md_capped(dir: &Path, depth: i32, max_depth: i32, count: &mut usize) -> Vec<Value> {
    const MAX_NODES: usize = 2500;
    if depth > max_depth || *count >= MAX_NODES {
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
        if *count >= MAX_NODES {
            break;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            let children = walk_md_capped(&p, depth + 1, max_depth, count);
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
                *count += 1;
                items.push(json!({"name": name, "path": p.to_string_lossy(), "type": "dir", "children": children}));
            }
        } else if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
            let e2 = format!(".{}", ext.to_lowercase());
            if MD_EXTS.contains(&e2.as_str()) {
                *count += 1;
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
pub fn stuart_get_recents() -> Value {
    let s = load_settings_migrated();
    let recents = s
        .get("recent")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = recents;
    out.truncate(12);
    json!(out)
}

#[tauri::command]
pub fn stuart_open_path(path: String) -> Value {
    let p = Path::new(&path);
    if p.is_dir() {
        let _ = modify_settings(|s| {
            if let Some(obj) = s.as_object_mut() {
                obj.insert("last_folder".into(), json!(p.to_string_lossy()));
            }
            Ok(())
        });
        push_recent(&p.to_string_lossy(), "folder");
        return json!({"kind": "folder", "path": p.to_string_lossy()});
    }
    stuart_read_file(path)
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
        Ok(_) => json!({
            "ok": true,
            "path": p.to_string_lossy(),
            "kind": if p.is_dir() { "folder" } else { "file" }
        }),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_open_new_window() -> Value {
    let exe = std::env::current_exe().unwrap_or_default();
    match std::process::Command::new(&exe).spawn() {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_open_url(app: tauri::AppHandle, url: String) -> bool {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }

    if u.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '`' || c == ' ' || c == '\r' || c == '\n') {
        return false;
    }

    if url::Url::parse(u).is_err() {
        return false;
    }

    #[cfg(feature = "custom-protocol")]
    {
        use tauri_plugin_opener::OpenerExt;
        if app.opener().open_url(u, None::<&str>).is_ok() {
            return true;
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        const SW_SHOWNORMAL: i32 = 1;

        let wide_op: Vec<u16> = OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let wide_url: Vec<u16> = OsStr::new(u)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let instance = ShellExecuteW(
                std::ptr::null_mut(),
                wide_op.as_ptr(),
                wide_url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
            (instance as usize) > 32
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, u);
        false
    }
}

fn plugin_meta(p: &Path, disabled: &[String]) -> Value {
    let id = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut meta = json!({
        "id": id,
        "path": p.to_string_lossy(),
        "name": id,
        "enabled": !disabled.contains(&id)
    });
    let mf = p.with_extension("json");
    if let Ok(txt) = fs::read_to_string(&mf) {
        if let Ok(extra) = serde_json::from_str::<Value>(&txt) {
            if let (Some(obj), Some(extra_obj)) = (meta.as_object_mut(), extra.as_object()) {
                for (k, v) in extra_obj {
                    if k != "enabled" {
                        obj.insert(k.clone(), v.clone());
                    }
                }
                let pid = obj.get("id").and_then(|i| i.as_str()).unwrap_or(&id).to_string();
                obj.insert("enabled".into(), json!(!disabled.contains(&pid)));
            }
        }
    }
    meta
}

#[tauri::command]
pub fn stuart_list_plugins() -> Value {
    let settings = load_settings_migrated();
    let disabled: Vec<String> = settings
        .get("plugins_disabled")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut found = vec![];
    let roots = [plugins_dir(), exe_dir().join("plugins")];
    for root in roots {
        if !root.exists() {
            continue;
        }
        if let Ok(rd) = fs::read_dir(&root) {
            let mut paths: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("js"))
                .collect();
            paths.sort();
            for p in paths {
                found.push(plugin_meta(&p, &disabled));
            }
        }
    }
    json!({"plugins": found, "dir": plugins_dir().to_string_lossy()})
}

#[tauri::command]
pub fn stuart_read_plugin_source(path: String) -> Value {
    let p = Path::new(&path);
    if !is_under_plugin_dir(p) {
        return json!({"error": "插件路径不在允许目录"});
    }
    match fs::read_to_string(p) {
        Ok(source) => json!({"path": path, "source": source}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_set_plugin_enabled(plugin_id: String, enabled: bool) -> Value {
    let res = modify_settings(|s| {
        let mut disabled: Vec<String> = s
            .get("plugins_disabled")
            .and_then(|d| d.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        if enabled {
            disabled.retain(|x| x != &plugin_id);
        } else if !disabled.contains(&plugin_id) {
            disabled.push(plugin_id.clone());
        }
        disabled.sort();
        disabled.dedup();
        if let Some(obj) = s.as_object_mut() {
            obj.insert("plugins_disabled".into(), json!(disabled));
        }
        Ok(())
    });
    match res {
        Ok(s) => {
            let disabled = s.get("plugins_disabled").cloned().unwrap_or(json!([]));
            json!({"ok": true, "disabled": disabled})
        }
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_import_wallpaper(b64: String, name: Option<String>) -> Value {
    const WALLPAPER_MAX: usize = 12 * 1024 * 1024;
    let payload = b64.split(',').next_back().unwrap_or("");
    if payload.len() > WALLPAPER_MAX {
        return json!({"error": "壁纸过大（>12MB）"});
    }
    let raw = B64.decode(payload).unwrap_or_default();
    if raw.len() > 10 * 1024 * 1024 {
        return json!({"error": "壁纸过大（>10MB）"});
    }
    let dir = wallpapers_dir();
    let safe = name.unwrap_or_else(|| "wallpaper.png".into());
    let safe: String = safe
        .chars()
        .filter(|c| c.is_alphanumeric() || "._- ".contains(*c))
        .collect();
    let file = dir.join(if safe.is_empty() {
        "wallpaper.png".into()
    } else {
        safe
    });
    if fs::write(&file, &raw).is_err() {
        return json!({"error": "写入壁纸失败"});
    }
    json!({
        "ok": true,
        "path": file.to_string_lossy(),
        "uri": path_to_file_uri(&file),
        "colors": ["#f5f5f5", "#ffffff", "#333333", "#1a1a1a", "#555555"]
    })
}

#[tauri::command]
pub fn stuart_get_wallpaper() -> Value {
    let wp = load_settings_migrated();
    wp.get("wallpaper").cloned().unwrap_or_else(|| json!({}))
}

#[tauri::command]
pub fn stuart_clear_wallpaper() -> Value {
    let res = modify_settings(|s| {
        if let Some(obj) = s.as_object_mut() {
            obj.insert("wallpaper".into(), json!({}));
            if obj.get("theme").and_then(|t| t.as_str()) == Some("wallpaper") {
                obj.insert("theme".into(), json!("light"));
            }
        }
        Ok(())
    });
    match res {
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_export_html(html: String, suggested_name: Option<String>) -> Value {
    // Frontend prefers dialog plugin; this command is a write fallback when path is known.
    let name = export_safe_name(&suggested_name.unwrap_or_else(|| "export.html".into()));
    let path = data_dir().join("exports").join(&name);
    match atomic_write_file(&path, html.as_bytes()) {
        Ok(()) => json!({"ok": true, "path": path.to_string_lossy()}),
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_open_welcome() -> Value {
    if let Some(cand) = find_sample("欢迎使用 StuartMD.md") {
        return stuart_read_file(cand.to_string_lossy().to_string());
    }
    json!({
        "path": null,
        "name": "欢迎使用 StuartMD.md",
        "kind": "markdown",
        "welcome": true,
        "content": "# StuartMD\n\n轻量 Markdown 阅读与编辑器。\n\n**项目仓库：** https://github.com/ghostLLC/StuartMD\n\n**当前版本：** 2.9.10\n\n## 能做什么\n\n- 读文档：美化排版、公式、表格、代码高亮\n- 写笔记：阅读 / 分栏 / 源码，点击段落直接编辑\n- 飞书式交互：块手柄、选中浮动栏、块菜单；双击代码/公式/图表进源码编辑\n- 撤销重做：Ctrl+Z / Ctrl+Y\n- 看 PDF：标注批注\n- 多窗口、主题、多语言\n",
        "size": 0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atomic_write_file_basic_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("stuart_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file_path = dir.join("test_atomic.txt");

        // 1. Initial write
        let content1 = b"Hello, StuartMD Atomic Write!";
        assert!(atomic_write_file(&file_path, content1).is_ok());
        assert_eq!(fs::read(&file_path).unwrap(), content1);

        // 2. Overwrite existing file
        let content2 = b"Updated content atomically preserved.";
        assert!(atomic_write_file(&file_path, content2).is_ok());
        assert_eq!(fs::read(&file_path).unwrap(), content2);

        // Clean up
        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir(&dir);
    }

    #[test]
    fn test_atomic_write_file_relative_path() {
        let test_name = format!(".~temp_rel_test_{}.txt", std::process::id());
        let rel_path = PathBuf::from(&test_name);
        let content = b"relative path test";
        assert!(atomic_write_file(&rel_path, content).is_ok());
        assert_eq!(fs::read(&rel_path).unwrap(), content);
        let _ = fs::remove_file(&rel_path);
    }

    #[test]
    fn test_url_safety_rules() {
        let valid_urls = [
            "https://github.com/ghostLLC/StuartMD",
            "http://example.com/page?query=123#anchor",
        ];
        for u in valid_urls {
            let lower = u.to_ascii_lowercase();
            assert!(lower.starts_with("http://") || lower.starts_with("https://"));
            assert!(!u.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '`' || c == ' ' || c == '\r' || c == '\n'));
            assert!(url::Url::parse(u).is_ok());
        }

        let dangerous_urls = [
            "https://example.com\" --disable-web-security",
            "https://example.com'`whoami`",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "https://example.com/has space/test",
            "https://example.com/test\r\nevil",
        ];
        for u in dangerous_urls {
            let lower = u.to_ascii_lowercase();
            let is_http = lower.starts_with("http://") || lower.starts_with("https://");
            let has_bad_chars = u.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '`' || c == ' ' || c == '\r' || c == '\n');
            let is_rejected = !is_http || has_bad_chars || url::Url::parse(u).is_err();
            assert!(is_rejected, "URL should be rejected: {}", u);
        }
    }
}
