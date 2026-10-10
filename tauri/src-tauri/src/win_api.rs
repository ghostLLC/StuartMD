//! Windows integration: registry association, URL open, GitHub update check, assets.
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::fs_api::{
    data_dir, exe_dir, load_settings_migrated, modify_settings,
    path_to_file_uri, wallpapers_dir, PROG_ID, PROG_ID_PDF, VERSION,
};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[tauri::command]
pub fn stuart_exit_app(app: tauri::AppHandle) {
    println!("[Lifecycle] 前端多标签检查完成，批准应用安全退出");
    app.exit(0);
}

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
pub fn stuart_open_sample(window: tauri::WebviewWindow) -> Value {
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
            let disp = cand.to_string_lossy().to_string();
            // App-shipped samples are trusted content; grant then read.
            if let Err(error) = crate::fs_api::register_window_path(&window, &disp) { return json!({"error":error}); }
            return crate::fs_api::read_file_trusted(&disp);
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

/// Local-path validation for shell reveal (M3): existing local paths only —
/// reject UNC (`\\server`), device namespaces (`\\?\`, `\\.\`), URLs, and any
/// `:` that is not a drive-letter separator (blocks NTLM hash leaks / ADS).
fn reveal_local_path(raw: &str) -> Result<PathBuf, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("路径为空".into());
    }
    if s.chars().any(|c| c == '\0' || c.is_control()) {
        return Err("路径包含非法控制字符".into());
    }
    let norm = s.replace('/', "\\");
    if norm.starts_with("\\\\") {
        return Err("拒绝 UNC / 设备路径".into());
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("file:")
        || lower.starts_with("ftp:")
    {
        return Err("拒绝 URL 形式路径".into());
    }
    // Only a drive-letter colon is allowed ("C:" at index 1).
    for (i, c) in s.char_indices() {
        if c == ':' && i != 1 {
            return Err("路径含非法 ':'".into());
        }
    }
    if s.contains(':') {
        let b = s.as_bytes();
        if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
            return Err("非法盘符路径".into());
        }
    }
    let p = Path::new(s);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("路径无法规范化: {e}"))?;
    let cs = canon.to_string_lossy();
    if cs.starts_with("\\\\?\\UNC\\") {
        return Err("拒绝网络共享路径".into());
    }
    Ok(canon)
}

#[tauri::command]
pub fn stuart_reveal_in_explorer(path: Option<String>) -> bool {
    let target = path.unwrap_or_else(|| exe_dir().to_string_lossy().to_string());
    let canon = match reveal_local_path(&target) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[Shell] reveal_in_explorer rejected: {e} ({target})");
            return false;
        }
    };
    #[cfg(target_os = "windows")]
    {
        // explorer /select, only for existing files; plain open for directories.
        if canon.is_file() {
            let arg = format!("/select,{}", canon.to_string_lossy());
            Command::new("explorer").arg(&arg).spawn().is_ok()
        } else if canon.is_dir() {
            open_path_os(&canon)
        } else {
            false
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        open_path_os(&canon)
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
        let icon_app = format!("{},0", exe_s);
        // Distinct file-type icons shipped beside the exe (resources)
        let icon_dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_else(exe_dir);
        let icon_md_path = icon_dir.join("file-md.ico");
        let icon_pdf_path = icon_dir.join("file-pdf.ico");
        let icon_md = if icon_md_path.is_file() {
            format!("{},0", icon_md_path.to_string_lossy())
        } else {
            icon_app.clone()
        };
        let icon_pdf = if icon_pdf_path.is_file() {
            format!("{},0", icon_pdf_path.to_string_lossy())
        } else {
            icon_app.clone()
        };

        // Markdown: claim as primary handler for md-like types
        for ext in [".md", ".markdown", ".mdown", ".mkd"] {
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}", ext)) {
                let _ = k.0.set_value("", &PROG_ID);
            }
            // Extension-level DefaultIcon — Explorer sometimes ignores ProgId icon
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}\DefaultIcon", ext)) {
                let _ = k.0.set_value("", &icon_md.as_str());
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
            let _ = k.0.set_value("", &icon_md.as_str());
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
            let _ = k.0.set_value("", &icon_pdf.as_str());
        }
        if let Ok(k) = hkcu
            .create_subkey(format!(r"Software\Classes\{}\shell\open\command", PROG_ID_PDF))
        {
            let _ = k.0.set_value("", &cmd.as_str());
        }
        if let Ok(k) = hkcu.create_subkey(r"Software\Classes\.pdf\OpenWithProgids") {
            let _ = k.0.set_value(PROG_ID_PDF, &"");
        }
        // Explorer uses .pdf DefaultIcon / default ProgId icon (often MSEdgePDF).
        // Write extension-level DefaultIcon so the distinct StuartMD PDF type icon shows.
        // Windows often binds .pdf to ProgId "PDF" (created by installer).
        // Paint type icons on every known PDF ProgId so Explorer does not
        // fall back to stuartmd.exe,0 (application icon).
        for pdf_prog in ["PDF", "pdffile", "StuartMD.PDF"] {
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}\DefaultIcon", pdf_prog)) {
                let _ = k.0.set_value("", &icon_pdf.as_str());
            }
        }
        // Windows often binds .pdf to ProgId "PDF" (created by installer).
        // Paint type icons on every known PDF ProgId so Explorer does not
        // fall back to stuartmd.exe,0 (application icon).
        for pdf_prog in ["PDF", "pdffile", "StuartMD.PDF"] {
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\Classes\{}\DefaultIcon", pdf_prog)) {
                let _ = k.0.set_value("", &icon_pdf.as_str());
            }
        }
        if let Ok(k) = hkcu.create_subkey(r"Software\Classes\.pdf\DefaultIcon") {
            let _ = k.0.set_value("", &icon_pdf.as_str());
        }
        if hkcu.open_subkey("Software\\Classes\\MSEdgePDF").is_ok() {
            if let Ok(k) = hkcu.create_subkey(r"Software\Classes\MSEdgePDF\DefaultIcon") {
                let _ = k.0.set_value("", &icon_pdf.as_str());
            }
        }
        if hkcu.open_subkey("Software\\Classes\\MSEdgePDF").is_ok() {
            if let Ok(k) = hkcu.create_subkey(r"Software\Classes\MSEdgePDF\DefaultIcon") {
                let _ = k.0.set_value("", &icon_pdf.as_str());
            }
        }

        // Applications\<exe> — classic "Open with" list entry (md + pdf)
        let app_key = r"Software\Classes\Applications\stuartmd.exe";
        if let Ok(k) = hkcu.create_subkey(app_key) {
            let _ = k.0.set_value("", &"StuartMD");
        }
        if let Ok(k) = hkcu.create_subkey(format!(r"{}\DefaultIcon", app_key)) {
            let _ = k.0.set_value("", &icon_app.as_str());
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

        {
            use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNF_IDLIST};
            const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000u32 as i32;
            unsafe {
                SHChangeNotify(
                    SHCNE_ASSOCCHANGED,
                    SHCNF_IDLIST,
                    std::ptr::null(),
                    std::ptr::null(),
                );
            }
        }
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
    // L5: in-process HTTPS via ureq — never shell out to PowerShell.
    let ua = format!("StuartMD/{VERSION}");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(12))
        .timeout_read(std::time::Duration::from_secs(30))
        .user_agent(&ua)
        .build();
    let text = match agent.get(url).call() {
        Ok(r) => match r.into_string() {
            Ok(s) => s,
            Err(e) => {
                return json!({"ok": false, "error": format!("检查更新失败：读取响应失败 {e}")})
            }
        },
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            return json!({
                "ok": false,
                "error": format!("检查更新失败：HTTP {code}"),
                "body": body.chars().take(200).collect::<String>()
            });
        }
        Err(e) => {
            return json!({"ok": false, "error": format!("检查更新失败：网络错误 {e}")})
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
    let payload = b64.split(',').next_back().unwrap_or("");
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
    let res = modify_settings(|settings| {
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
        Ok(())
    });
    if let Err(e) = res {
        return json!({"error": e});
    }
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
    fs::create_dir_all(&d).expect("创建PDF批注目录失败");
    d
}

fn annot_key(path: &str) -> String {
    use sha1::{Digest, Sha1};
    let p = std::fs::canonicalize(path).expect("PDF批注来源文件无法规范化");
    let mut h = Sha1::new();
    h.update(p.to_string_lossy().as_bytes());
    format!("{:x}", h.finalize())
}

pub(crate) fn annot_file(path: &str) -> PathBuf {
    annot_dir().join(format!("{}.json", annot_key(path)))
}

pub fn load_annotations_for(p: &Path) -> Result<Value,String> {
    let f = annot_file(&p.to_string_lossy());
    let bytes=match fs::read(&f) {Ok(bytes)=>bytes,Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(json!([])),Err(error)=>return Err(format!("读取PDF批注失败：{error}"))};
    decode_annotations(&bytes)
}
pub fn decode_annotations(bytes:&[u8])->Result<Value,String> {
    let value:Value=serde_json::from_slice(bytes).map_err(|error|format!("PDF批注JSON无效：{error}"))?;
    let items=value.get("items").and_then(Value::as_array).ok_or("PDF批注资料缺少完整数组")?;
    if items.iter().any(|item|!item.is_object() || item["id"].as_str().is_none() || item["page"].as_u64().is_none_or(|page|page==0)) {return Err("PDF批注资料缺少实际编号或页码".into());}
    Ok(json!(items))
}

#[tauri::command]
pub fn stuart_load_annotations(window:tauri::WebviewWindow,pdf_path:String) -> Result<Value,String> {
    crate::fs_api::ensure_window_read_allowed(&window,&pdf_path)?;
    load_annotations_for(Path::new(&pdf_path))
}

#[tauri::command]
pub fn stuart_save_annotations(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,pdf_path:String,items:Value) -> Value {
    let state=match service.state(window.label(),&document_id) {Ok(state)=>state,Err(error)=>return json!({"error":error})};
    let source=match crate::fs_api::ensure_window_read_allowed(&window,&pdf_path) {Ok(path)=>path,Err(error)=>return json!({"error":error})};
    if state.kind!="pdf" || state.path.as_ref()!=Some(&source) {return json!({"error":"PDF批注文档身份与来源路径不一致"});}
    if !items.is_array() {return json!({"error":"PDF批注需要完整数组"});}
    let f = annot_file(&pdf_path);
    let payload = json!({
        "pdf": crate::fs_api::display_path(&source),
        "items": items
    });
    let bytes=match serde_json::to_vec_pretty(&payload) {Ok(bytes)=>bytes,Err(error)=>return json!({"error":error.to_string()})};
    let expected=match service.resource_base(window.label(),&document_id,&f) {Ok(resource)=>resource.disk_revision,Err(error)=>return json!({"error":error})};
    let request=crate::document::SaveRequest {operation_id:uuid::Uuid::new_v4().to_string(),document_id,editor_revision:state.current_editor_revision,target_path:f.to_string_lossy().into_owned(),expected_disk_revision:expected,payload:crate::document::SavePayload::ValidatedBytes {validation_hash:crate::document::identity::sha256(&bytes),bytes,producer:"json-annotations".into()}};
    match service.save(window.label(),request) {
        Ok(result) => json!({"ok":result.result==crate::document::SaveStatus::Saved,"saveResult":result}),
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_add_annotation(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,pdf_path:String,ann:Value) -> Value {
    if let Err(error)=crate::fs_api::ensure_window_read_allowed(&window,&pdf_path) {return json!({"error":error});}
    let mut items = match load_annotations_for(Path::new(&pdf_path)) {
        Ok(Value::Array(a)) => a,
        Ok(_) => return json!({"error":"PDF批注格式无效"}),
        Err(error)=>return json!({"error":error}),
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
    stuart_save_annotations(window,service,document_id,pdf_path,Value::Array(items))
}

#[tauri::command]
pub fn stuart_delete_annotation(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,pdf_path:String,ann_id:String) -> Value {
    if let Err(error)=crate::fs_api::ensure_window_read_allowed(&window,&pdf_path) {return json!({"error":error});}
    let items = match load_annotations_for(Path::new(&pdf_path)) {
        Ok(Value::Array(a)) => a,
        Ok(_) => return json!({"error":"PDF批注格式无效"}),
        Err(error)=>return json!({"error":error}),
    };
    let filtered: Vec<Value> = items
        .into_iter()
        .filter(|x| x.get("id").and_then(|i| i.as_str()) != Some(ann_id.as_str()))
        .collect();
    stuart_save_annotations(window,service,document_id,pdf_path,Value::Array(filtered))
}

#[tauri::command]
pub fn stuart_clear_annotations(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,pdf_path:String) -> Value {
    stuart_save_annotations(window,service,document_id,pdf_path,json!([]))
}

#[tauri::command]
pub fn stuart_export_pdf_annotations(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,pdf_path:String,items:Value) -> Value {
    let state=match service.state(window.label(),&document_id) {Ok(state)=>state,Err(error)=>return json!({"error":error})};
    let src=match crate::fs_api::ensure_window_write_allowed(&window,&pdf_path) {Ok(path)=>path,Err(error)=>return json!({"error":error})};
    if state.kind!="pdf" || state.path.as_ref()!=Some(&src) {return json!({"error":"PDF导出身份与来源路径不一致"});}
    let annotations:Vec<crate::document::pdf_annotations::Annotation>=match serde_json::from_value(items) {Ok(items)=>items,Err(error)=>return json!({"error":format!("PDF批注格式无效：{error}")})};
    match service.save_pdf_annotations(window.label(),&document_id,&annotations) {Ok(result)=>json!({"ok":result.result==crate::document::SaveStatus::Saved,"created":annotations.len(),"path":crate::fs_api::display_path(&src),"saveResult":result}),Err(error)=>json!({"error":error})}
}

#[tauri::command]
pub fn stuart_edit_pdf_annotations(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,pdf_path:String,edits:Vec<crate::document::pdf_annotations::NativeEdit>)->Result<Value,String> {
    let state=service.state(window.label(),&document_id)?;
    let source=crate::fs_api::ensure_window_write_allowed(&window,&pdf_path)?;
    if state.kind!="pdf" || state.path.as_ref()!=Some(&source) {return Err("PDF批注身份与来源路径不一致".into());}
    let result=service.edit_pdf_annotations(window.label(),&document_id,&edits)?;
    Ok(json!({"ok":result.result==crate::document::SaveStatus::Saved,"saveResult":result}))
}

#[tauri::command]
pub fn stuart_restore_pdf_annotations(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,document_id:String,operation_id:String,version:String)->Result<Value,String> {
    let state=service.state(window.label(),&document_id)?;
    crate::fs_api::ensure_window_write_allowed(&window,&crate::document::identity::display_path(state.path.as_ref().ok_or("PDF来源路径缺失")?))?;
    let result=service.restore_pdf_history(window.label(),&document_id,&operation_id,&version)?;
    Ok(json!({"ok":result.result==crate::document::SaveStatus::Saved,"saveResult":result}))
}

#[tauri::command]
pub fn stuart_capture_window(window: tauri::WebviewWindow) -> Result<Value,String> {
    let pos = window.outer_position().map_err(|error|error.to_string())?;
    let size = window.outer_size().map_err(|error|error.to_string())?;
    let maximized = window.is_maximized().map_err(|error|error.to_string())?;
    let fullscreen = window.is_fullscreen().map_err(|error|error.to_string())?;
    let res = modify_settings(|s| {
        if let Some(obj) = s.as_object_mut() {
            obj.insert(
                "window_state".into(),
                json!({
                    "x": pos.x,
                    "y": pos.y,
                    "width": size.width,
                    "height": size.height,
                    "maximized": maximized,
                    "fullscreen": fullscreen,
                }),
            );
        }
        Ok(())
    });
    res?;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn stuart_apply_window_state(window: tauri::WebviewWindow) -> Result<Value,String> {
    let s = load_settings_migrated();
    let Some(ws) = s.get("window_state") else {
        return Ok(json!({"ok": false, "reason": "none"}));
    };
    let fullscreen = ws.get("fullscreen").and_then(|v| v.as_bool()).unwrap_or(false);
    let maximized = ws.get("maximized").and_then(|v| v.as_bool()).unwrap_or(false);
    if fullscreen {
        window.set_fullscreen(true).map_err(|error|error.to_string())?;
        return Ok(json!({"ok": true, "mode": "fullscreen"}));
    }
    if maximized {
        window.maximize().map_err(|error|error.to_string())?;
        return Ok(json!({"ok": true, "mode": "maximized"}));
    }
    let x = ws.get("x").and_then(|v| v.as_i64()).unwrap_or(-1);
    let y = ws.get("y").and_then(|v| v.as_i64()).unwrap_or(-1);

    let monitors=window.available_monitors().map_err(|error|error.to_string())?;
    let monitor=monitors.iter().find(|monitor| {
        let area=monitor.work_area();
        x>=i64::from(area.position.x) && y>=i64::from(area.position.y) && x<i64::from(area.position.x)+i64::from(area.size.width) && y<i64::from(area.position.y)+i64::from(area.size.height)
    }).cloned().or(window.current_monitor().map_err(|error|error.to_string())?).ok_or("无法取得当前窗口显示器")?;
    let area=monitor.work_area();
    let width=ws.get("width").and_then(Value::as_u64).ok_or("窗口记录缺少宽度")?.clamp(u64::from(area.size.width.min(880)),u64::from(area.size.width));
    let height=ws.get("height").and_then(Value::as_u64).ok_or("窗口记录缺少高度")?.clamp(u64::from(area.size.height.min(560)),u64::from(area.size.height));
    let x=x.clamp(i64::from(area.position.x),i64::from(area.position.x)+i64::from(area.size.width)-width as i64);
    let y=y.clamp(i64::from(area.position.y),i64::from(area.position.y)+i64::from(area.size.height)-height as i64);
    window.unmaximize().map_err(|error|error.to_string())?;
    window.set_size(PhysicalSize::new(width as u32,height as u32)).map_err(|error|error.to_string())?;
    window.set_position(PhysicalPosition::new(x as i32,y as i32)).map_err(|error|error.to_string())?;
    Ok(json!({"ok":true,"mode":"normal"}))
}

fn uuid_like() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    t.wrapping_mul(0x9E3779B97F4A7C15)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reveal_local_path_rejects_unc_urls_ads() {
        for bad in [
            "",
            "\\\\server\\share\\a.md",
            "//server/share/a.md",
            "\\\\?\\C:\\Windows\\a.md",
            "https://example.com/a.md",
            "C:\\a.md:stream",
            "C:relative\\a.md:ads",
            "C:\\nonexistent\\definitely\\missing.md",
        ] {
            assert!(
                reveal_local_path(bad).is_err(),
                "should reject: {bad:?}"
            );
        }
    }

    #[test]
    fn test_reveal_local_path_accepts_existing_local() {
        let f = std::env::temp_dir().join(format!("stuart_reveal_test_{}.txt", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        let raw = f.to_string_lossy().to_string();
        assert!(reveal_local_path(&raw).is_ok(), "should accept: {raw}");
        let _ = std::fs::remove_file(&f);
    }
}
