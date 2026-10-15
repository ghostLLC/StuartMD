// tauri/src-tauri/src/memory/mod.rs
//! StuartMD Organic 3-Tier Memory Subsystem & SQLite Chat Archive Facade

#![allow(unused_imports, dead_code)]

pub mod evolution;
pub mod migrations;
pub mod models;
pub mod sqlite_archive;
pub mod session_service;
pub mod learning;

use std::sync::{Arc, OnceLock};

pub use evolution::{compute_effective_importance, should_evict_memory};
pub use models::{ChatArchiveMessage, ChatSession, MemorySearchHit, OrganicMemoryItem};
pub use sqlite_archive::MemoryArchiveStorage;
pub use models::{ConversationTarget,ConversationDraft,RequestIntent,AcceptedTurn,MemoryEdit,MemoryProposal,SessionFilter,Page,ConversationPage,SessionSummary};

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
    if session.document_key.is_none() && session.document_path.is_none() && session.document_id.is_none() {
        if session.workspace_key.is_none() {return Err("会话没有可恢复的文档或工作区来源".into());}
        return Ok(serde_json::json!({"session":session,"kind":"workspace"}));
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

fn check_target(window:&tauri::WebviewWindow,service:&crate::document::DocumentService,target:&ConversationTarget)->Result<(),String> {
    if target.window_id!=window.label() {return Err("会话窗口身份无效".into());}
    session_service::validate_target(target)?;
    if let Some(id)=&target.runtime_document_id {
        let document=service.snapshot_for_window(window.label(),id)?;
        if target.document_key.as_deref()!=Some(&crate::document::DocumentService::document_key(&document)?) {return Err("会话文档身份与实际文档不同".into());}
    } else if target.document_key.is_some() {return Err("文档目标缺少当前窗口注册身份".into());}
    if let Some(root)=&target.workspace_key {crate::fs_api::ensure_window_read_allowed(window,root)?;}Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SessionOptions {
    #[serde(default)] filter:Option<SessionFilter>,
    #[serde(default)] scope:Option<String>,
    #[serde(default)] document_key:Option<String>,
    #[serde(default)] workspace_key:Option<String>,
    #[serde(default)] query:String,
    #[serde(default)] cursor:Option<String>,
    #[serde(default)] limit:Option<usize>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct MemoryOptions {
    #[serde(default)] scope:Option<String>,
    #[serde(default)] document_key:Option<String>,
    #[serde(default)] workspace_key:Option<String>,
    #[serde(default)] category:Option<String>,
    #[serde(default)] preference_key:Option<String>,
    #[serde(default)] status:Option<String>,
    #[serde(default)] query:String,
    #[serde(default)] cursor:Option<String>,
    #[serde(default)] limit:Option<usize>,
}

fn emit_change(window:&tauri::WebviewWindow,event:&str,value:serde_json::Value)->Result<(),String> {
    use tauri::{Emitter,Manager};
    window.app_handle().emit(event,value).map_err(|e|e.to_string())
}

fn check_edit_access(window:&tauri::WebviewWindow,edit:&MemoryEdit)->Result<(),String> {
    if let Some(root)=&edit.workspace_key {crate::fs_api::ensure_window_read_allowed(window,root)?;}
    if let Some(key)=&edit.document_key {
        if let Some(path)=key.strip_prefix("file:") {crate::fs_api::ensure_window_read_allowed(window,path)?;}
        else if !key.starts_with("draft:") {return Err("记忆文档持久身份无效".into());}
    }
    Ok(())
}

fn check_record_access(_window:&tauri::WebviewWindow,item:&OrganicMemoryItem)->Result<(),String> {
    if item.record_id.is_empty() {return Err("记忆缺少当前用户归档中的稳定身份".into());}
    Ok(())
}

#[tauri::command]
pub fn stuart_companion_save_draft(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,draft:ConversationDraft,expected_draft_version:u64)->Result<ConversationDraft,String> {
    if draft.target.window_id!=window.label() {return Err("草稿窗口身份无效".into());}
    session_service::validate_target(&draft.target)?;
    if let Some(root)=&draft.target.workspace_key {crate::fs_api::ensure_window_read_allowed(&window,root)?;}
    let storage=get_archive_storage()?;
    let saved=if let Some(id)=&draft.target.runtime_document_id {
        let document=service.snapshot_for_window(window.label(),id)?;
        let actual=crate::document::DocumentService::document_key(&document)?;
        if draft.target.document_key.as_deref()==Some(&actual) {storage.save_draft(draft,expected_draft_version)?}
        else if draft.target.document_key.as_deref()==Some(format!("draft:{id}").as_str()) && actual.starts_with("file:") {storage.save_draft_after_first_save(draft,expected_draft_version,&actual)?}
        else if let Some(path)=draft.target.document_key.as_deref().and_then(|key|key.strip_prefix("file:")) {
            let original=crate::fs_api::ensure_window_read_allowed(&window,path)?;
            if format!("file:{}",crate::document::identity::display_path(&original))!=draft.target.document_key.as_deref().ok_or("草稿原始文档身份缺失")? {return Err("草稿原始文档路径需要规范身份".into());}
            storage.save_draft(draft,expected_draft_version)?
        }else{return Err("草稿文档身份与实际文档不同".into());}
    }else {check_target(&window,&service,&draft.target)?;storage.save_draft(draft,expected_draft_version)?};
    emit_change(&window,"draftChanged",serde_json::json!({"draftId":saved.draft_id,"draftVersion":saved.draft_version}))?;Ok(saved)
}

#[tauri::command]
pub fn stuart_companion_get_conversation(window:tauri::WebviewWindow,service:tauri::State<'_,crate::document::DocumentService>,session_id:Option<String>,cursor:Option<serde_json::Value>,target:Option<ConversationTarget>)->Result<ConversationPage,String> {
    if let Some(target)=&target {check_target(&window,&service,target)?;}
    let cursor=cursor.map(|value|match value {serde_json::Value::String(value)=>value.parse::<u64>().map_err(|e|e.to_string()),serde_json::Value::Number(value)=>value.as_u64().ok_or("会话游标无效".into()),_=>Err("会话游标无效".into())}).transpose()?;
    let page=get_archive_storage()?.conversation_page(target.as_ref(),session_id.as_deref(),cursor)?;
    Ok(page)
}

#[tauri::command]
pub fn stuart_companion_list_sessions(options:serde_json::Value)->Result<Page<SessionSummary>,String> {
    let options:SessionOptions=serde_json::from_value(options).map_err(|e|e.to_string())?;
    let filter=options.filter.unwrap_or(SessionFilter{scope:options.scope.unwrap_or("target".into()),document_key:options.document_key,workspace_key:options.workspace_key});
    get_archive_storage()?.list_session_page(&filter,&options.query,options.cursor.as_deref(),options.limit.unwrap_or(30))
}

#[tauri::command]
pub fn stuart_companion_rename_session(window:tauri::WebviewWindow,session_id:String,expected_session_version:u64,title:String)->Result<ChatSession,String> {
    let session=get_archive_storage()?.rename_session(&session_id,expected_session_version,&title)?;
    emit_change(&window,"conversationChanged",serde_json::json!({"sessionId":session_id,"sessionVersion":session.session_version}))?;Ok(session)
}

#[tauri::command]
pub fn stuart_companion_save_memory(window:tauri::WebviewWindow,record_id:Option<String>,expected_version:u64,edit:MemoryEdit)->Result<OrganicMemoryItem,String> {
    if let Some(id)=&record_id {
        let previous=get_archive_storage()?.memory_by_record(id)?;check_record_access(&window,&previous)?;
        if edit.scope!=previous.scope || edit.document_key!=previous.document_id || edit.workspace_key!=previous.workspace_id {check_edit_access(&window,&edit)?;}
    }else{check_edit_access(&window,&edit)?;}
    let item=get_archive_storage()?.save_memory(record_id.as_deref(),expected_version,&edit,"user")?;
    emit_change(&window,"memoryChanged",serde_json::json!({"recordId":item.record_id,"version":item.version}))?;Ok(item)
}

#[tauri::command]
pub fn stuart_companion_delete_memory(window:tauri::WebviewWindow,record_id:String,expected_version:u64)->Result<bool,String> {
    check_record_access(&window,&get_archive_storage()?.memory_by_record(&record_id)?)?;
    get_archive_storage()?.delete_memory_record(&record_id,expected_version)?;
    emit_change(&window,"memoryChanged",serde_json::json!({"recordId":record_id,"version":expected_version,"status":"deleted"}))?;Ok(true)
}

#[tauri::command]
pub fn stuart_companion_list_memories(options:serde_json::Value)->Result<Page<OrganicMemoryItem>,String> {
    let options:MemoryOptions=serde_json::from_value(options).map_err(|e|e.to_string())?;
    if options.status.as_deref().is_some_and(|s|s!="active" && s!="Active") {return Err("记忆列表状态无效".into());}
    get_archive_storage()?.list_memory_page_filtered(options.scope.as_deref(),options.workspace_key.as_deref(),options.document_key.as_deref(),options.category.as_deref(),options.preference_key.as_deref(),&options.query,options.cursor.as_deref(),options.limit.unwrap_or(30))
}

#[tauri::command]
pub fn stuart_companion_create_memory_proposal(window:tauri::WebviewWindow,edit:serde_json::Value)->Result<MemoryProposal,String> {
    let edit:MemoryEdit=serde_json::from_value(edit).map_err(|e|e.to_string())?;
    check_edit_access(&window,&edit)?;
    let storage=get_archive_storage()?;
    let ordinal=storage.next_proposal_ordinal(edit.source_request_id.as_deref().ok_or("候选缺少来源请求")?)?;
    let proposal=storage.create_memory_proposal(&edit,ordinal)?;
    emit_change(&window,"memoryChanged",serde_json::json!({"proposalId":proposal.proposal_id,"proposalVersion":proposal.proposal_version,"status":proposal.status}))?;Ok(proposal)
}

#[tauri::command]
pub fn stuart_companion_list_memory_proposals(options:serde_json::Value)->Result<Page<MemoryProposal>,String> {
    let options:MemoryOptions=serde_json::from_value(options).map_err(|e|e.to_string())?;
    get_archive_storage()?.list_proposals_filtered(options.scope.as_deref(),options.workspace_key.as_deref(),options.document_key.as_deref(),options.category.as_deref(),&options.query,options.cursor.as_deref(),options.limit.unwrap_or(30))
}

#[tauri::command]
pub fn stuart_companion_update_memory_proposal(window:tauri::WebviewWindow,proposal_id:String,expected_proposal_version:u64,mut edit:serde_json::Value)->Result<MemoryProposal,String> {
    let status=edit.as_object_mut().ok_or("候选编辑内容无效")?.remove("status");
    let discard=status.as_ref().and_then(serde_json::Value::as_str)==Some("Discarded");
    if status.is_some() && !discard {return Err("候选编辑状态无效".into());}
    let edit:MemoryEdit=serde_json::from_value(edit).map_err(|e|e.to_string())?;check_edit_access(&window,&edit)?;
    let proposal=get_archive_storage()?.update_proposal(&proposal_id,expected_proposal_version,&edit,discard)?;
    emit_change(&window,"memoryChanged",serde_json::json!({"proposalId":proposal.proposal_id,"proposalVersion":proposal.proposal_version,"status":proposal.status}))?;Ok(proposal)
}

#[tauri::command]
pub fn stuart_companion_confirm_memory(window:tauri::WebviewWindow,proposal_id:String,expected_proposal_version:u64,edit:MemoryEdit)->Result<OrganicMemoryItem,String> {
    check_edit_access(&window,&edit)?;
    let item=get_archive_storage()?.confirm_proposal(&proposal_id,expected_proposal_version,&edit)?;
    emit_change(&window,"memoryChanged",serde_json::json!({"recordId":item.record_id,"version":item.version,"proposalId":proposal_id}))?;Ok(item)
}

#[tauri::command]
pub fn stuart_companion_get_memory_source(window:tauri::WebviewWindow,record_id:String)->Result<serde_json::Value,String> {
    check_record_access(&window,&get_archive_storage()?.memory_by_record(&record_id)?)?;
    get_archive_storage()?.get_memory_source(&record_id)
}

#[tauri::command]
pub fn stuart_companion_get_memory_versions(window:tauri::WebviewWindow,record_id:String)->Result<Vec<OrganicMemoryItem>,String> {
    check_record_access(&window,&get_archive_storage()?.memory_by_record(&record_id)?)?;
    get_archive_storage()?.memory_versions(&record_id)
}
