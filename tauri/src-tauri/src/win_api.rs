//! Windows integration: registry association, URL open, GitHub update check, assets.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::fs_api::{
    data_dir, exe_dir, load_json, load_settings_migrated, path_to_file_uri, save_json,
    settings_path, wallpapers_dir, PROG_ID, PROG_ID_PDF, VERSION,
};

pub fn open_path_os(p: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(p).spawn().is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = p;
        false
    }
}

#[tauri::command]
pub fn stuart_open_data_dir() -> bool {
    let d = data_dir();
    let _ = fs::create_dir_all(&d);
    open_path_os(&d)
}

#[tauri::command]
pub fn stuart_open_sample() -> Value {
    let exe = exe_dir();
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidates = [
        exe.join("samples").join("示例文档.md"),
        exe.join("_internal").join("samples").join("示例文档.md"),
        exe.join("resources").join("samples").join("示例文档.md"),
        cwd.join("samples").join("示例文档.md"),
        cwd.join("..").join("samples").join("示例文档.md"),
        cwd.join("..").join("..").join("samples").join("示例文档.md"),
    ];
    for cand in candidates {
        if cand.is_file() {
            return crate::fs_api::stuart_read_file(cand.to_string_lossy().to_string());
        }
    }
    json!({
        "path": null,
        "name": "示例文档.md",
        "kind": "markdown",
        "content": include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../samples/示例文档.md")),
        "size": 0
    })
}

#[tauri::command]
pub fn stuart_resolve_asset(base_file: String, rel: String) -> Option<String> {
    if rel.starts_with("http") || rel.starts_with("data:") || rel.starts_with("file:") {
        return Some(rel);
    }
    if base_file.is_empty() || rel.is_empty() {
        return None;
    }
    // Reject traversal / absolute escapes from markdown image paths
    if rel.contains("..") || rel.starts_with('/') || rel.starts_with('\\') || rel.contains(':') {
        return None;
    }
    let base = Path::new(&base_file).parent()?;
    let target = base.join(&rel);
    let target_c = target.canonicalize().ok()?;
    let base_c = base.canonicalize().ok()?;
    if !target_c.starts_with(&base_c) {
        return None;
    }
    if target_c.is_file() {
        Some(path_to_file_uri(&target_c))
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

#[tauri::command]
pub fn stuart_reveal_in_explorer(path: Option<String>) -> bool {
    let target = path.unwrap_or_else(|| exe_dir().to_string_lossy().to_string());
    let p = Path::new(&target);
    #[cfg(target_os = "windows")]
    {
        if p.is_file() {
            Command::new("explorer")
                .args(["/select,", &target])
                .spawn()
                .is_ok()
        } else {
            open_path_os(p)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        open_path_os(p)
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
        let mut md_registered = false;
        let mut pdf_registered = false;
        let mut command = String::new();
        if let Ok(k) = hkcu.open_subkey(r"Software\Classes\.md") {
            if let Ok(v) = k.get_value::<String, _>("") {
                md_registered = v == PROG_ID || v.starts_with("StuartMD");
            }
        }
        if let Ok(k) = hkcu.open_subkey(r"Software\Classes\.pdf\OpenWithProgids") {
            if let Ok(_) = k.get_raw_value(PROG_ID_PDF) {
                pdf_registered = true;
            }
        }
        if let Ok(k) = hkcu.open_subkey(r"Software\Classes\Applications\stuartmd.exe\SupportedTypes") {
            if let Ok(_) = k.get_raw_value(".pdf") {
                pdf_registered = true;
            }
        }
        if let Ok(k) = hkcu.open_subkey(format!(r"Software\Classes\{}\shell\open\command", PROG_ID)) {
            if let Ok(v) = k.get_value::<String, _>("") {
                command = v;
            }
        }
        return json!({
            "registered": md_registered,
            "md": md_registered,
            "pdf": pdf_registered,
            "command": command
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        json!({"registered": false, "md": false, "pdf": false, "command": ""})
    }
}

#[tauri::command]
pub fn stuart_register_file_association() -> Value {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = std::env::current_exe().unwrap_or_else(|_| exe_dir().join("stuartmd.exe"));
        let exe_s = exe.to_string_lossy().to_string();
        let cmd = format!("\"{}\" \"%1\"", exe_s);
        let icon = format!("{},0", exe_s);

        // Markdown: claim as primary handler for md-like types
        for ext in [".md", ".markdown", ".mdown", ".mkd"] {
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}", ext)) {
                let _ = k.0.set_value("", &PROG_ID);
            }
        }
        // Optional: also appear under .txt Open-with without stealing default
        if let Ok((k, _)) = hkcu.create_subkey(r"Software\Classes\.txt\OpenWithProgids") {
            let _ = k.set_value(PROG_ID, &"");
        }

        if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}", PROG_ID)) {
            let _ = k.0.set_value("", &"Markdown 文档 (StuartMD)");
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}\DefaultIcon", PROG_ID)) {
            let _ = k.0.set_value("", &icon.as_str());
        }
        if let Ok(k) =
            hkcu.create_subkey(format!(r"Software\Classes\{}\shell\open\command", PROG_ID))
        {
            let _ = k.0.set_value("", &cmd.as_str());
        }

        // PDF: Open-with only — do NOT overwrite the system default PDF handler
        if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}", PROG_ID_PDF)) {
            let _ = k.0.set_value("", &"PDF 文档 (StuartMD)");
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}\DefaultIcon", PROG_ID_PDF)) {
            let _ = k.0.set_value("", &icon.as_str());
        }
        if let Ok(k) = hkcu
            .create_subkey(format!(r"Software\Classes\{}\shell\open\command", PROG_ID_PDF))
        {
            let _ = k.0.set_value("", &cmd.as_str());
        }
        if let Ok((k, _)) = hkcu.create_subkey(r"Software\Classes\.pdf\OpenWithProgids") {
            let _ = k.set_value(PROG_ID_PDF, &"");
        }

        // Applications\<exe> — classic "Open with" list entry (md + pdf)
        let app_key = r"Software\Classes\Applications\stuartmd.exe";
        if let Ok(k) = hkcu.create_subkey(app_key) {
            let _ = k.0.set_value("", &"StuartMD");
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"{}\DefaultIcon", app_key)) {
            let _ = k.0.set_value("", &icon.as_str());
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"{}\shell\open\command", app_key)) {
            let _ = k.0.set_value("", &cmd.as_str());
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"{}\SupportedTypes", app_key)) {
            for ext in [
                ".md", ".markdown", ".mdown", ".mkd", ".txt", ".pdf",
            ] {
                let _ = k.0.set_value(ext, &"");
            }
        }

        // App Paths so Win+R / shell can launch StuartMD
        if let Ok(k) = hkcu.create_subkey(
            r"Software\Microsoft\Windows\CurrentVersion\App Paths\stuartmd.exe",
        ) {
            let _ = k.0.set_value("", &exe_s.as_str());
            let _ = k.0.set_value("Path", &exe_dir().to_string_lossy().as_ref());
        }

        // Do NOT spawn cmd/ie4uinit here — it flashes a console window on every boot.
        // Registry writes are enough for Explorer "Open with" after a refresh.

        return json!({"ok": true, "command": cmd, "pdf": true, "md": true});
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
    for n in nums.iter_mut() {
        *n = parts
            .next()
            .and_then(|x| {
                x.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .ok()
            })
            .unwrap_or(0);
    }
    (nums[0], nums[1], nums[2])
}

#[tauri::command]
pub fn stuart_check_update() -> Value {
    let url = "https://api.github.com/repos/ghostLLC/StuartMD/releases/latest";
    #[cfg(target_os = "windows")]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        &format!(
            "(Invoke-WebRequest -UseBasicParsing -Uri '{url}' -Headers @{{'User-Agent'='StuartMD/{VERSION}'}}).Content"
        ),
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output();
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
    let latest = v
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
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
            let name = a
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_lowercase();
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

/// Dominant colors are extracted on the JS canvas side; keep a neutral fallback here.
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
    const WALLPAPER_MAX: usize = 12 * 1024 * 1024;
    let payload = b64.split(',').last().unwrap_or("");
    if payload.len() > WALLPAPER_MAX {
        return json!({"error": "壁纸过大（>12MB）"});
    }
    let raw = B64.decode(payload).unwrap_or_default();
    if raw.is_empty() {
        return json!({"error": "壁纸数据无效"});
    }
    if raw.len() > 10 * 1024 * 1024 {
        return json!({"error": "壁纸过大（>10MB）"});
    }
    let dir = wallpapers_dir();
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
    let uri = path_to_file_uri(&file);
    let mut settings = load_settings_migrated();
    if let Some(obj) = settings.as_object_mut() {
        obj.insert(
            "wallpaper".into(),
            json!({
                "path": file.to_string_lossy(),
                "uri": uri,
                "colors": colors
            }),
        );
        obj.insert("theme".into(), json!("wallpaper"));
    }
    let _ = save_json(&settings_path(), &settings);
    json!({
        "ok": true,
        "path": file.to_string_lossy(),
        "uri": uri,
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

pub fn load_annotations_for(p: &Path) -> Value {
    let f = annot_file(&p.to_string_lossy());
    let v = load_json(&f);
    if let Some(items) = v.get("items").and_then(|i| i.as_array()) {
        return json!(items);
    }
    json!([])
}

#[tauri::command]
pub fn stuart_load_annotations(pdf_path: String) -> Value {
    load_annotations_for(Path::new(&pdf_path))
}

#[tauri::command]
pub fn stuart_save_annotations(pdf_path: String, items: Value) -> Value {
    let f = annot_file(&pdf_path);
    let payload = json!({
        "pdf": std::fs::canonicalize(&pdf_path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(pdf_path),
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
        a.insert("id".into(), json!(format!("{:x}", uuid_like())));
    }
    if !a.contains_key("type") {
        a.insert("type".into(), json!("highlight"));
    }
    if !a.contains_key("color") {
        a.insert("color".into(), json!("#fff59d"));
    }
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

/// Write sidecar annotations into the PDF as native /Highlight + /Text
/// (readable by WPS, Edge, Acrobat). If the original is read-only, saves
/// a sibling `<name>.annotated.pdf`.
#[tauri::command]
pub fn stuart_export_pdf_annotations(pdf_path: String, items: Value) -> Value {
    use lopdf::dictionary;
    use lopdf::{Document, Object};

    fn real(v: f64) -> Object {
        Object::Real(v as f32)
    }
    fn obj_num(o: &Object) -> Option<f64> {
        match o {
            Object::Real(x) => Some(*x as f64),
            Object::Integer(i) => Some(*i as f64),
            _ => None,
        }
    }
    fn rgb_for(id: &str) -> [f32; 3] {
        match id {
            "green" => [0.47, 0.78, 0.51],
            "blue" => [0.39, 0.67, 0.90],
            "pink" => [0.94, 0.59, 0.71],
            "orange" => [0.98, 0.71, 0.35],
            "purple" => [0.71, 0.59, 0.90],
            "gray" => [0.63, 0.63, 0.63],
            _ => [1.0, 0.91, 0.23],
        }
    }

    let src = Path::new(&pdf_path);
    if !src.is_file() {
        return json!({"error": "PDF 不存在"});
    }
    let arr = match items {
        Value::Array(a) => a,
        _ => vec![],
    };
    if arr.is_empty() {
        return json!({"error": "没有标注可写入"});
    }

    let mut doc = match Document::load(src) {
        Ok(d) => d,
        Err(e) => return json!({"error": format!("打开 PDF 失败: {e}")}),
    };
    let _ = doc.decompress();

    let pages = doc.get_pages();
    if pages.is_empty() {
        return json!({"error": "无法解析 PDF 页面"});
    }

    fn media_size(doc: &Document, page_id: (u32, u16)) -> (f64, f64) {
        if let Ok(Object::Dictionary(dict)) = doc.get_object(page_id) {
            if let Ok(Object::Array(mb)) = dict.get(b"MediaBox") {
                let nums: Vec<f64> = mb.iter().filter_map(obj_num).collect();
                if nums.len() >= 4 {
                    return ((nums[2] - nums[0]).abs(), (nums[3] - nums[1]).abs());
                }
            }
        }
        (595.0, 842.0)
    }

    let mut created = 0usize;
    for item in &arr {
        let Some(obj) = item.as_object() else { continue };
        let page_num = obj.get("page").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
        let Some(&page_id) = pages.get(&page_num) else { continue };
        let (pw, ph) = media_size(&doc, page_id);
        let kind = obj.get("type").and_then(|t| t.as_str()).unwrap_or("highlight");
        let comment = obj
            .get("comment")
            .and_then(|c| c.as_str())
            .or_else(|| obj.get("text").and_then(|t| t.as_str()))
            .unwrap_or("");
        let color_id = obj.get("color").and_then(|c| c.as_str()).unwrap_or("yellow");
        let rgb = rgb_for(color_id);
        let color_arr = vec![
            Object::Real(rgb[0]),
            Object::Real(rgb[1]),
            Object::Real(rgb[2]),
        ];

        let mut new_refs: Vec<Object> = Vec::new();

        if let Some(rects) = obj.get("rects").and_then(|r| r.as_array()) {
            for r in rects {
                let Some(r) = r.as_object() else { continue };
                let x = r.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = r.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let w = r.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = r.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let x0 = x * pw;
                let x1 = (x + w) * pw;
                let y_top = ph - y * ph;
                let y_bot = ph - (y + h) * ph;
                let (rx0, rx1) = if x0 <= x1 { (x0, x1) } else { (x1, x0) };
                let (ry0, ry1) = if y_bot <= y_top {
                    (y_bot, y_top)
                } else {
                    (y_top, y_bot)
                };
                let mut dict = dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Highlight",
                    "Rect" => Object::Array(vec![real(rx0), real(ry0), real(rx1), real(ry1)]),
                    "QuadPoints" => Object::Array(vec![
                        real(x0), real(y_top),
                        real(x1), real(y_top),
                        real(x0), real(y_bot),
                        real(x1), real(y_bot),
                    ]),
                    "C" => Object::Array(color_arr.clone()),
                    "CA" => Object::Real(0.4),
                    "F" => Object::Integer(4),
                };
                if !comment.is_empty() {
                    dict.set("Contents", Object::string_literal(comment.as_bytes()));
                }
                let id = doc.add_object(Object::Dictionary(dict));
                new_refs.push(Object::Reference(id));
                created += 1;
            }
        }

        // Sticky-note comment (always attach when comment text exists)
        if !comment.is_empty() {
            let nx = obj
                .get("rects")
                .and_then(|r| r.as_array())
                .and_then(|a| a.first())
                .and_then(|r| r.as_object())
                .and_then(|o| o.get("x").and_then(|v| v.as_f64()))
                .unwrap_or(0.08);
            let ny = obj
                .get("rects")
                .and_then(|r| r.as_array())
                .and_then(|a| a.first())
                .and_then(|r| r.as_object())
                .and_then(|o| o.get("y").and_then(|v| v.as_f64()))
                .unwrap_or(0.08);
            let px = nx * pw + 2.0;
            let py = ph - ny * ph - 18.0;
            let dict = dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => Object::Array(vec![
                    real(px),
                    real(py),
                    real(px + 16.0),
                    real(py + 16.0),
                ]),
                "Contents" => Object::string_literal(comment.as_bytes()),
                "Name" => "Comment",
                "C" => Object::Array(color_arr.clone()),
                "F" => Object::Integer(4),
            };
            let id = doc.add_object(Object::Dictionary(dict));
            new_refs.push(Object::Reference(id));
            created += 1;
            let _ = kind; // comments always exported
        }

        if new_refs.is_empty() {
            continue;
        }

        // Merge page /Annots
        let mut existing: Vec<Object> = Vec::new();
        if let Ok(Object::Dictionary(page_dict)) = doc.get_object(page_id) {
            if let Ok(annots) = page_dict.get(b"Annots") {
                match annots {
                    Object::Array(a) => existing = a.clone(),
                    Object::Reference(id) => {
                        if let Ok(Object::Array(a)) = doc.get_object(*id) {
                            existing = a.clone();
                        }
                    }
                    _ => {}
                }
            }
        }
        existing.extend(new_refs);
        if let Ok(Object::Dictionary(page_dict)) = doc.get_object_mut(page_id) {
            page_dict.set("Annots", Object::Array(existing));
        }
    }

    if created == 0 {
        return json!({"error": "未能生成批注对象"});
    }

    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "out".into());
    let tmp = src.with_extension("stuart-annot.tmp.pdf");
    if let Err(e) = doc.save(&tmp) {
        return json!({"error": format!("保存失败: {e}")});
    }
    // Prefer overwrite original; fall back to sibling annotated file
    let final_path = match fs::rename(&tmp, src) {
        Ok(()) => src.to_path_buf(),
        Err(_) => {
            let alt = src.with_file_name(format!("{stem}.annotated.pdf"));
            match fs::rename(&tmp, &alt) {
                Ok(()) => alt,
                Err(e) => return json!({"error": format!("写入文件失败: {e}")}),
            }
        }
    };

    json!({
        "ok": true,
        "created": created,
        "path": final_path.to_string_lossy()
    })
}

fn uuid_like() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    t.wrapping_mul(0x9E3779B97F4A7C15)
}
