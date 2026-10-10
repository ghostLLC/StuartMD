use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct AppRuntime {
    startup_files: Mutex<HashMap<String, Option<String>>>,
    path_grants: Mutex<HashMap<String, HashSet<PathBuf>>>,
}

impl AppRuntime {
    pub fn register(&self, label: &str, path: Option<String>) {
        self.startup_files.lock().expect("窗口记录锁损坏").insert(label.to_owned(), path.clone());
        self.path_grants.lock().expect("窗口授权锁损坏").entry(label.to_owned()).or_default();
        if let Some(path) = path { let canonical = crate::fs_api::register_allowed_path(&path).expect("启动文档授权失败"); self.grant(label, canonical).expect("窗口启动文档授权失败"); }
        if label == "main" {
            let settings = crate::fs_api::load_settings_migrated();
            let mut paths = Vec::new();
            for entries in [settings.get("recent"), settings.pointer("/session/tabs"), settings.get("last_open_files")] {
                if let Some(entries) = entries.and_then(serde_json::Value::as_array) {
                    for entry in entries {
                        if let Some(path) = entry.as_str().or_else(|| entry.get("path").and_then(serde_json::Value::as_str)).filter(|path| !path.is_empty()) {
                            paths.push(path.to_owned());
                        }
                    }
                }
            }
            for entry in [settings.get("workspace"), settings.get("last_folder"), settings.pointer("/session/active_path")] {
                if let Some(path) = entry.and_then(serde_json::Value::as_str).filter(|path| !path.is_empty()) { paths.push(path.to_owned()); }
            }
            for path in paths { if Path::new(&path).exists() { let canonical = crate::fs_api::register_allowed_path(&path).expect("恢复窗口路径授权失败"); self.grant(label, canonical).expect("恢复窗口路径记录失败"); } }
        }
    }
    pub fn startup(&self, label: &str) -> Option<String> {
        self.startup_files.lock().expect("窗口记录锁损坏").get(label).cloned().flatten()
    }
    pub fn remove(&self, label: &str) {
        self.startup_files.lock().expect("窗口记录锁损坏").remove(label);
        self.path_grants.lock().expect("窗口授权锁损坏").remove(label);
    }
    pub fn grant(&self, label: &str, canonical: PathBuf) -> Result<(), String> {
        let mut grants = self.path_grants.lock().map_err(|_| "窗口授权锁损坏")?;
        grants.get_mut(label).ok_or("窗口身份不存在")?.insert(canonical);
        Ok(())
    }
    pub fn ensure_allowed(&self, label: &str, canonical: &Path) -> Result<(), String> {
        let grants = self.path_grants.lock().map_err(|_| "窗口授权锁损坏")?;
        let window = grants.get(label).ok_or("窗口身份不存在")?;
        if window.iter().any(|path| canonical == path || (path.is_dir() && canonical.starts_with(path))) { return Ok(()); }
        Err("当前窗口没有此路径的访问授权，请通过当前窗口打开文件或选择保存目标".into())
    }
}

pub fn create_document_window(app: &tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    if let Some(ref path) = path { crate::fs_api::register_allowed_path(path)?; }
    let label = format!("document-{}", uuid::Uuid::new_v4());
    app.state::<AppRuntime>().register(&label, path);
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("StuartMD").inner_size(1100.0, 720.0).min_inner_size(880.0, 560.0)
        .build();
    if let Err(error) = built {
        app.state::<AppRuntime>().remove(&label);
        return Err(error.to_string());
    }
    Ok(label)
}

#[tauri::command]
pub async fn stuart_close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::ai::cancel_window_and_wait(window.label()).await?;
    window.app_handle().state::<crate::document::DocumentService>().release_window(window.label())?;
    window.destroy().map_err(|error| error.to_string())
}
