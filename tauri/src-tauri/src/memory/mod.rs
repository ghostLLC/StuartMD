// tauri/src-tauri/src/memory/mod.rs
//! StuartMD Organic 3-Tier Memory Subsystem & SQLite Chat Archive Facade

#![allow(unused_imports, dead_code)]

pub mod evolution;
pub mod migrations;
pub mod models;
pub mod sqlite_archive;

use std::sync::{Arc, OnceLock};

pub use evolution::{compute_effective_importance, should_evict_memory};
pub use models::{ChatArchiveMessage, ChatSession, MemorySearchHit, OrganicMemoryItem};
pub use sqlite_archive::MemoryArchiveStorage;

static ARCHIVE_STORAGE: OnceLock<Result<Arc<MemoryArchiveStorage>, String>> = OnceLock::new();

pub fn get_archive_storage() -> Result<Arc<MemoryArchiveStorage>, String> {
    ARCHIVE_STORAGE
        .get_or_init(|| {
            let db_path = crate::fs_api::data_dir().join("chat_archive.db");
            let storage = Arc::new(MemoryArchiveStorage::open(&db_path)?);
            let legacy = crate::fs_api::data_dir().join("ai").join("memory");
            if legacy.exists() {
                for entry in std::fs::read_dir(legacy).map_err(|e| e.to_string())? {
                    let path = entry.map_err(|e| e.to_string())?.path();
                    if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")) {
                        storage.import_legacy_markdown(&path)?;
                    }
                }
            }
            Ok(storage)
        })
        .clone()
}

// ============================================================================
// TAURI COMMAND FACADES
// ============================================================================

#[tauri::command]
pub fn stuart_session_create(
    title: String,
    workspace_root: Option<String>,
) -> Result<ChatSession, String> {
    let storage = get_archive_storage()?;
    storage.create_session(&title, workspace_root.as_deref())
}

#[tauri::command]
pub fn stuart_session_list() -> Result<Vec<ChatSession>, String> {
    let storage = get_archive_storage()?;
    storage.list_sessions()
}

#[tauri::command]
pub fn stuart_session_get_messages(session_id: String) -> Result<Vec<ChatArchiveMessage>, String> {
    let storage = get_archive_storage()?;
    storage.get_session_messages(&session_id)
}

#[tauri::command]
pub fn stuart_session_add_message(msg: ChatArchiveMessage) -> Result<bool, String> {
    let storage = get_archive_storage()?;
    storage.add_message(msg)?;
    Ok(true)
}

#[tauri::command]
pub fn stuart_session_delete(session_id: String) -> Result<bool, String> {
    let storage = get_archive_storage()?;
    storage.delete_session(&session_id)
}

#[tauri::command]
pub fn stuart_session_search(query: String, limit: Option<usize>) -> Result<Vec<MemorySearchHit>, String> {
    let storage = get_archive_storage()?;
    storage.search_messages(&query, limit.unwrap_or(20))
}

#[tauri::command]
pub fn stuart_organic_memory_upsert(item: OrganicMemoryItem) -> Result<bool, String> {
    let storage = get_archive_storage()?;
    storage.upsert_organic_memory(item)?;
    Ok(true)
}

#[tauri::command]
pub fn stuart_organic_memory_list(tier: Option<u8>) -> Result<Vec<OrganicMemoryItem>, String> {
    let storage = get_archive_storage()?;
    storage.list_organic_memories(tier)
}

#[tauri::command]
pub fn stuart_organic_memory_evolve() -> Result<usize, String> {
    let storage = get_archive_storage()?;
    storage.evolve_and_prune()
}

#[tauri::command]
pub fn stuart_session_create_document(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,title:String,workspace_root:Option<String>,document_id:String,document_path:Option<String>)->Result<ChatSession,String> {
    let document=service.snapshot_for_window(window.label(),&document_id)?;
    if document.path!=document_path {return Err("会话文档路径与实际文档不一致".into());}
    if let Some(root)=&workspace_root {crate::fs_api::ensure_window_read_allowed(&window,root)?;}
    if let Some(path)=&document.path {get_archive_storage()?.update_document_path(&document_id,path)?;}
    get_archive_storage()?.create_document_session(&title,workspace_root.as_deref(),Some(&document_id),document.path.as_deref())
}

#[tauri::command]
pub fn stuart_session_open_document(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,session_id:String)->Result<serde_json::Value,String> {
    let session=get_archive_storage()?.get_session(&session_id)?;
    if let Some(root)=&session.workspace_root {
        if !std::path::Path::new(root).is_dir() {return Err("会话所属工作区目录已经不存在".into());}
        crate::fs_api::register_window_path(&window,root)?;
    }
    if let Some(path)=&session.document_path {
        crate::fs_api::register_window_path(&window,path)?;
        let document=crate::fs_api::document_read(window,service,path.clone())?;
        Ok(serde_json::json!({"session":session,"document":document,"kind":"document"}))
    } else {
        let id=session.document_id.as_ref().ok_or("会话没有可恢复的文档来源")?;
        let draft=crate::fs_api::journal_restore(window,service,id.clone())?;
        if draft.entry.path.is_some() {return Err("会话草稿的文件关联已经变化，请从恢复列表打开对应文档".into());}
        Ok(serde_json::json!({"session":session,"document":draft,"kind":"draft"}))
    }
}

#[tauri::command]
pub fn stuart_session_rebind(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,session_id:String,document_id:String)->Result<ChatSession,String> {
    let document=service.snapshot_for_window(window.label(),&document_id)?;
    let session=get_archive_storage()?.get_session(&session_id)?;
    if let Some(root)=&session.workspace_root {crate::fs_api::ensure_window_read_allowed(&window,root)?;}
    get_archive_storage()?.rebind_session(&session_id,&document)
}

#[tauri::command]
pub fn stuart_organic_memory_search(query: String, limit: Option<usize>) -> Result<Vec<OrganicMemoryItem>, String> {
    get_archive_storage()?.search_memories(&query,limit.unwrap_or(100))
}

#[tauri::command]
pub fn stuart_organic_memory_delete(memory_id: String) -> Result<bool, String> {
    get_archive_storage()?.delete_memory(&memory_id)
}

#[tauri::command]
pub fn stuart_organic_memory_effective(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,workspace_id: Option<String>, document_id:String) -> Result<Vec<OrganicMemoryItem>, String> {
    let settings = crate::fs_api::load_settings_migrated();
    if settings.pointer("/ai/memory_mode").and_then(serde_json::Value::as_str) == Some("off") { return Ok(Vec::new()); }
    let document=service.snapshot_for_window(window.label(),&document_id)?;
    if let Some(root)=&workspace_id {crate::fs_api::ensure_window_read_allowed(&window,root)?;}
    get_archive_storage()?.effective_document_memories(workspace_id.as_deref(),&document_id,document.path.as_deref())
}

#[cfg(test)]
mod tests;
