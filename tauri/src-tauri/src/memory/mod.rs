// tauri/src-tauri/src/memory/mod.rs
//! StuartMD Organic 3-Tier Memory Subsystem & SQLite Chat Archive Facade

#![allow(unused_imports, dead_code)]

pub mod evolution;
pub mod models;
pub mod sqlite_archive;

use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

pub use evolution::{compute_effective_importance, should_evict_memory};
pub use models::{ChatArchiveMessage, ChatSession, MemorySearchHit, OrganicMemoryItem};
pub use sqlite_archive::MemoryArchiveStorage;

static ARCHIVE_STORAGE: OnceLock<Arc<MemoryArchiveStorage>> = OnceLock::new();

pub fn get_archive_storage() -> Arc<MemoryArchiveStorage> {
    ARCHIVE_STORAGE
        .get_or_init(|| {
            let db_path = crate::fs_api::data_dir().join("chat_archive.db");
            Arc::new(
                MemoryArchiveStorage::open(&db_path)
                    .unwrap_or_else(|e| {
                        log::error!("[Memory] Failed to open disk archive: {}. Falling back to memory.", e);
                        MemoryArchiveStorage::open_in_memory().unwrap()
                    })
            )
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
    let storage = get_archive_storage();
    storage.create_session(&title, workspace_root.as_deref())
}

#[tauri::command]
pub fn stuart_session_list() -> Result<Vec<ChatSession>, String> {
    let storage = get_archive_storage();
    storage.list_sessions()
}

#[tauri::command]
pub fn stuart_session_get_messages(session_id: String) -> Result<Vec<ChatArchiveMessage>, String> {
    let storage = get_archive_storage();
    storage.get_session_messages(&session_id)
}

#[tauri::command]
pub fn stuart_session_add_message(msg: ChatArchiveMessage) -> Result<bool, String> {
    let storage = get_archive_storage();
    storage.add_message(msg)?;
    Ok(true)
}

#[tauri::command]
pub fn stuart_session_delete(session_id: String) -> Result<bool, String> {
    let storage = get_archive_storage();
    storage.delete_session(&session_id)
}

#[tauri::command]
pub fn stuart_session_search(query: String, limit: Option<usize>) -> Result<Vec<MemorySearchHit>, String> {
    let storage = get_archive_storage();
    storage.search_messages(&query, limit.unwrap_or(20))
}

#[tauri::command]
pub fn stuart_organic_memory_upsert(item: OrganicMemoryItem) -> Result<bool, String> {
    let storage = get_archive_storage();
    storage.upsert_organic_memory(item)?;
    Ok(true)
}

#[tauri::command]
pub fn stuart_organic_memory_list(tier: Option<u8>) -> Result<Vec<OrganicMemoryItem>, String> {
    let storage = get_archive_storage();
    storage.list_organic_memories(tier)
}

#[tauri::command]
pub fn stuart_organic_memory_evolve() -> Result<usize, String> {
    let storage = get_archive_storage();
    storage.evolve_and_prune()
}
