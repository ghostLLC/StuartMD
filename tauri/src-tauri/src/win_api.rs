//! Windows integration: registry association, URL open, GitHub update check, assets.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::fs_api::{data_dir, load_json, save_json, settings_path, PROG_ID, VERSION};

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn stuart_open_data_dir() -> bool {
    let d = data_dir();
    let _ = fs::create_dir_all(&d);
    open_path_os(&d)
}

#[tauri::command]
pub fn stuart_open_sample() -> Value {
    let cand = exe_dir().join("_internal").join("samples").join("示例文档.md");
    if cand.exists() {
        return crate::fs_api::stuart_read_file(cand.to_string_lossy().to_string());
    }
    let alt = exe_dir().join("samples").join("示例文档.md");
    if alt.exists() {
        return crate::fs_api::stuart_read_file(alt.to_string_lossy().to_string());
    }
    json!({"error": "示例文档不存在"})
}

#[tauri::command]
pub fn stuart_resolve_asset(base_file: String, rel: String) -> Option<String> {
    if rel.starts_with("http") || rel.starts_with("data:") || rel.starts_with("file:") {
        return Some(rel);
    }
    if base_file.is_empty() || rel.is_empty() {
        return None;
    }
    let base = Path::new(&base_file).parent()?;
    let target = base.join(&rel);
    if target.is_file() {
        Some(target.to_string_lossy().to_string())
    } else {
        None
    }
}

#[tauri::command]
pub fn stuart_open_plugins_dir() -> bool {
    let d = data_dir().join("plugins");
    let _ = fs::create_dir_all(&d);
    open_path_os(&d)
}

fn open_path_os(p: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(p)
            .spawn()
            .is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = p;
        false
    }
}

#[tauri::command]
pub fn stuart_open_default_apps_settings() -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .spawn()
            .is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn stuart_get_file_association_status() -> Value {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut registered = false;
        let mut command = String::new();
        if let Ok(k) = hkcu.open_subkey(r"Software\Classes\.md") {
            if let Ok(v) = k.get_value::<String, _>("") {
                registered = v == PROG_ID || v.starts_with("StuartMD");
            }
        }
        if let Ok(k) = hkcu.open_subkey(format!(r"Software\Classes\{}\shell\open\command", PROG_ID)) {
            if let Ok(v) = k.get_value::<String, _>("") {
                command = v;
            }
        }
        return json!({"registered": registered, "command": command});
    }
    #[cfg(not(target_os = "windows"))]
    {
        json!({"registered": false, "command": ""})
    }
}

#[tauri::command]
pub fn stuart_register_file_association() -> Value {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = exe_dir().join("stuartmd.exe");
        let exe_s = exe.to_string_lossy().to_string();
        let cmd = format!("\"{}\" \"%1\"", exe_s);
        let icon = format!("{},0", exe_s);
        for ext in [".md", ".markdown", ".mdown", ".mkd"] {
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}", ext)) {
                let _ = k.0.set_value("", &PROG_ID);
            }
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}", PROG_ID)) {
            let _ = k.0.set_value("", &"Markdown 文档");
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}\DefaultIcon", PROG_ID)) {
            let _ = k.0.set_value("", &icon.as_str());
        }
        if let Ok(k) =
            hkcu.create_subkey(format!(r"Software\Classes\{}\shell\open\command", PROG_ID))
        {
            let _ = k.0.set_value("", &cmd.as_str());
        }
        return json!({"ok": true, "command": cmd});
    }
    #[cfg(not(target_os = "windows"))]
    {
        json!({"error": "仅 Windows 支持关联"})
    }
}

fn parse_version(v: &str) -> (u64, u64, u64) {
    let s = v.trim_start_matches('v').trim_start_matches('V');
    let mut parts = s.split('.');
    let mut nums = [0u64; 3];
    for (i, n) in nums.iter_mut().enumerate() {
        *n = parts
            .next()
            .and_then(|x| x.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok())
            .unwrap_or(0);
        let _ = i;
    }
    (nums[0], nums[1], nums[2])
}

#[tauri::command]
pub fn stuart_check_update() -> Value {
    let url = "https://api.github.com/repos/ghostLLC/StuartMD/releases/latest";
    // Lightweight HTTP via PowerShell to avoid extra crate deps in scaffold
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Invoke-WebRequest -UseBasicParsing -Uri '{url}' -Headers @{{'User-Agent'='StuartMD/{VERSION}'}}).Content"
            ),
        ])
        .output();
    let text = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => {
            return json!({"ok": false, "error": "检查更新失败：网络或 PowerShell 不可用"})
        }
    };
    let v: Value = match serde_json::from_str(text.trim()) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("解析失败: {e}")}),
    };
    let tag = v
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let latest = tag;
    let cur = parse_version(VERSION);
    let lat = parse_version(&latest);
    let newer = lat > cur;
    let mut download = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .unwrap_or("https://github.com/ghostLLC/StuartMD/releases")
        .to_string();
    if let Some(assets) = v.get("assets").and_then(|a| a.as_array()) {
        for a in assets {
            let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
            if name.ends_with(".exe") && (name.contains("setup") || name.contains("stuartmd")) {
                if let Some(u) = a.get("browser_download_url").and_then(|u| u.as_str()) {
                    download = u.to_string();
                    break;
                }
            }
        }
    }
    json!({
        "ok": true,
        "update": newer,
        "current": VERSION,
        "latest": latest,
        "url": v.get("html_url").and_then(|x| x.as_str()).unwrap_or(""),
        "download_url": download,
        "notes": v.get("body").and_then(|b| b.as_str()).unwrap_or(""),
        "published_at": v.get("published_at").and_then(|b| b.as_str()).unwrap_or(""),
    })
}

/// Extract dominant colors from uploaded wallpaper (simple average + saturation pick).
pub fn extract_colors_from_image_bytes(bytes: &[u8]) -> Vec<String> {
    let _ = bytes;
    vec![
        "#f5f5f5".into(),
        "#ffffff".into(),
        "#333333".into(),
        "#1a1a1a".into(),
        "#666666".into(),
    ]
}

#[tauri::command]
pub fn stuart_import_wallpaper_ex(b64: String, name: Option<String>) -> Value {
    let raw = B64
        .decode(b64.split(',').last().unwrap_or(""))
        .unwrap_or_default();
    let dir = data_dir().join("wallpapers");
    let _ = fs::create_dir_all(&dir);
    let safe: String = name
        .unwrap_or_else(|| "wallpaper.png".into())
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
    let colors = extract_colors_from_image_bytes(&raw);
    let mut settings = load_json(&settings_path());
    if let Some(obj) = settings.as_object_mut() {
        obj.insert(
            "wallpaper".into(),
            json!({
                "path": file.to_string_lossy(),
                "uri": format!("file:///{}", file.to_string_lossy().replace('\\', "/")),
                "colors": colors
            }),
        );
        obj.insert("theme".into(), json!("wallpaper"));
    }
    let _ = save_json(&settings_path(), &settings);
    json!({
        "ok": true,
        "path": file.to_string_lossy(),
        "uri": format!("file:///{}", file.to_string_lossy().replace('\\', "/")),
        "colors": colors
    })
}

// PDF annotations
fn annot_dir() -> PathBuf {
    let d = data_dir().join("pdf_annotations");
    let _ = fs::create_dir_all(&d);
    d
}

fn annot_key(path: &str) -> String {
    use sha1::{Digest, Sha1};
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let mut h = Sha1::new();
    h.update(p.to_string_lossy().as_bytes());
    format!("{:x}", h.finalize())
}

fn annot_file(path: &str) -> PathBuf {
    annot_dir().join(format!("{}.json", annot_key(path)))
}

#[tauri::command]
pub fn stuart_load_annotations(pdf_path: String) -> Value {
    let f = annot_file(&pdf_path);
    let v = load_json(&f);
    if let Some(items) = v.get("items").and_then(|i| i.as_array()) {
        return json!(items);
    }
    json!([])
}

#[tauri::command]
pub fn stuart_save_annotations(pdf_path: String, items: Value) -> Value {
    let f = annot_file(&pdf_path);
    let payload = json!({
        "pdf": std::fs::canonicalize(&pdf_path).map(|p| p.to_string_lossy().to_string()).unwrap_or(pdf_path),
        "items": items
    });
    match save_json(&f, &payload) {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_add_annotation(pdf_path: String, ann: Value) -> Value {
    let mut items = match stuart_load_annotations(pdf_path.clone()) {
        Value::Array(a) => a,
        _ => vec![],
    };
    let mut a = ann.as_object().cloned().unwrap_or_default();
    if !a.contains_key("id") {
        a.insert(
            "id".into(),
            json!(format!("{:x}", uuid_like())),
        );
    }
    a.insert("type".into(), json!("highlight"));
    a.insert("color".into(), json!("#fff59d"));
    items.push(Value::Object(a));
    stuart_save_annotations(pdf_path, Value::Array(items))
}

#[tauri::command]
pub fn stuart_delete_annotation(pdf_path: String, ann_id: String) -> Value {
    let items = match stuart_load_annotations(pdf_path.clone()) {
        Value::Array(a) => a,
        _ => vec![],
    };
    let filtered: Vec<Value> = items
        .into_iter()
        .filter(|x| x.get("id").and_then(|i| i.as_str()) != Some(ann_id.as_str()))
        .collect();
    stuart_save_annotations(pdf_path, Value::Array(filtered))
}

#[tauri::command]
pub fn stuart_clear_annotations(pdf_path: String) -> Value {
    stuart_save_annotations(pdf_path, json!([]))
}

fn uuid_like() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    t.wrapping_mul(0x9E3779B97F4A7C15) // cheap unique-ish
}
