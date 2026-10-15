use super::{ChatArchiveMessage, MemoryArchiveStorage, OrganicMemoryItem};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

fn database() -> PathBuf {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/native-artifacts/memory-context-completion")
        .join(format!("memory-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    directory.join("archive.db")
}

#[test]
fn project_audit_two_sessions_can_be_created_in_one_second() {
    let storage = Arc::new(MemoryArchiveStorage::open(database()).unwrap());
    let mut workers = Vec::new();
    for _ in 0..10 {
        let storage = storage.clone();
        workers.push(std::thread::spawn(move || {
            (0..10).map(|_| storage.create_session("阅读讨论", None).unwrap().session_id)
                .collect::<Vec<_>>()
        }));
    }
    let ids: HashSet<_> = workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect();
    assert_eq!(ids.len(), 100);
    assert_eq!(storage.list_sessions().unwrap().len(), 100);
    assert!(ids.iter().all(|id| uuid::Uuid::parse_str(id).unwrap().get_version_num() == 4));
}

#[test]
fn project_audit_memory_search_index_tracks_content_updates() {
    let path = database();
    let storage = MemoryArchiveStorage::open(&path).unwrap();
    let mut item = OrganicMemoryItem {
        memory_id: "reading-preference".into(), tier: 3,
        category: "preference".into(), content: "starlight reading preference".into(),
        confidence: 1.0, pinned: true, scope: "global".into(),
        confirmed: true, version: 1, ..Default::default()
    };
    storage.upsert_organic_memory(item.clone()).unwrap();
    item.content = "moonlight reading preference".into();
    item.tier = 2;
    item.category = "decision".into();
    storage.upsert_organic_memory(item.clone()).unwrap();
    let records = storage.list_organic_memories(None).unwrap();
    assert_eq!(records[0].content, item.content);
    assert_eq!(records[0].tier, 3);
    assert_eq!(records[0].category, "decision");
    let conn = rusqlite::Connection::open(path).unwrap();
    let count = |term: &str| conn.query_row(
        "SELECT COUNT(*) FROM fts_organic_memories WHERE fts_organic_memories MATCH ?1",
        [term], |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(count("moonlight"), 1);
    assert_eq!(count("starlight"), 1);
    let effective=storage.effective_target_memories(None,None,"reading",true).unwrap();
    assert_eq!(effective.len(),1);
    assert_eq!(effective[0].content,item.content);
}

#[test]
fn request_message_is_idempotent_and_partial_answers_are_excluded() {
    let storage = MemoryArchiveStorage::open(database()).unwrap();
    let session = storage.create_session("问答", None).unwrap();
    let mut message = ChatArchiveMessage {
        session_id: session.session_id.clone(), role: "assistant".into(),
        content: "实际回答".into(), request_id: Some("request-one".into()),
        completion_status: "Completed".into(), ..Default::default()
    };
    storage.add_message(message.clone()).unwrap();
    storage.add_message(message.clone()).unwrap();
    message.request_id = Some("request-two".into());
    message.completion_status = "Cancelled".into();
    storage.add_message(message).unwrap();
    assert_eq!(storage.get_session_messages(&session.session_id).unwrap().len(), 2);
    assert_eq!(storage.get_completed_messages(&session.session_id).unwrap().len(), 1);
}

#[test]
fn preferences_follow_scope_confirmation_and_latest_version() {
    let storage = MemoryArchiveStorage::open(database()).unwrap();
    let item = |id: &str, scope: &str, workspace: Option<&str>, version: u64, confirmed: bool| {
        OrganicMemoryItem { memory_id: id.into(), tier: 3, category: "preference".into(),
            content: id.into(), confidence: 1.0, scope: scope.into(),
            workspace_id: workspace.map(str::to_owned), preference_key: Some("tone".into()),
            version, confirmed, ..Default::default() }
    };
    storage.upsert_organic_memory(item("old", "global", None, 1, true)).unwrap();
    storage.upsert_organic_memory(item("new", "global", None, 2, true)).unwrap();
    storage.upsert_organic_memory(item("pending", "global", None, 3, false)).unwrap();
    storage.upsert_organic_memory(item("other", "workspace", Some("other"), 1, true)).unwrap();
    let effective = storage.effective_memories(Some("current"), None).unwrap();
    assert_eq!(effective.len(), 1);
    assert_eq!(effective[0].memory_id, "new");
}

#[test]
fn corrupt_database_returns_error_and_preserves_bytes() {
    let path = database();
    let content = b"invalid sqlite file";
    std::fs::write(&path, content).unwrap();
    assert!(MemoryArchiveStorage::open(&path).is_err());
    assert_eq!(std::fs::read(path).unwrap(), content);
}

#[test]
fn confirmed_preference_has_one_deterministic_latest_version() {
    let storage = MemoryArchiveStorage::open(database()).unwrap();
    for id in ["first-confirmation", "second-confirmation"] {
        storage.upsert_organic_memory(OrganicMemoryItem {
            memory_id: id.into(), tier: 3, category: "preference".into(), content: id.into(),
            confidence: 1.0, scope: "global".into(), preference_key: Some("response-tone".into()),
            version: 1, last_accessed_at: 1791590400000, confirmed: true, ..Default::default()
        }).unwrap();
    }
    let effective = storage.effective_memories(None, None).unwrap();
    assert_eq!(effective.len(), 1);
    assert_eq!(effective[0].memory_id, "second-confirmation");
}

#[test]
fn repeated_learning_request_rejects_changed_scope_and_source() {
    let storage = MemoryArchiveStorage::open(database()).unwrap();
    let original = OrganicMemoryItem {
        memory_id: "original-memory".into(), tier: 3, category: "preference".into(),
        content: "完整解释全部选区。".into(), confidence: 1.0, scope: "global".into(),
        preference_key: Some("reading-style".into()), request_id: Some("learning-request".into()),
        confirmed: true, ..Default::default()
    };
    storage.upsert_organic_memory(original.clone()).unwrap();
    let mut repeated = original.clone();
    repeated.memory_id = "repeated-memory".into();
    storage.upsert_organic_memory(repeated.clone()).unwrap();
    assert_eq!(storage.list_organic_memories(None).unwrap().len(), 1);
    repeated.scope = "document".into();
    repeated.document_id = Some("different-document".into());
    repeated.source_anchor = Some(serde_json::json!({"path":"different.md"}));
    assert!(storage.upsert_organic_memory(repeated).is_err());
    assert_eq!(storage.list_organic_memories(None).unwrap()[0].scope, "global");
}

#[test]
fn legacy_markdown_import_preserves_each_list_item_and_original_source() {
    let path = database();
    let markdown = path.with_file_name("user_profile.md");
    let original = "# 阅读档案\n\n- 解释需要完整正文。\n- 最新更正：保留否定关系。\n\n```python\nprint('示例')\n```\n";
    std::fs::write(&markdown, original).unwrap();
    let storage = MemoryArchiveStorage::open(&path).unwrap();
    assert_eq!(storage.import_legacy_markdown(&markdown).unwrap(), 4);
    assert_eq!(storage.import_legacy_markdown(&markdown).unwrap(), 0);
    let items = storage.list_organic_memories(None).unwrap();
    assert!(items.iter().any(|item| item.content == "解释需要完整正文。"));
    assert!(items.iter().any(|item| item.content == "最新更正：保留否定关系。"));
    assert!(items.iter().all(|item| !item.confirmed && item.source_anchor.is_some()));
    assert!(storage.effective_memories(None, None).unwrap().is_empty());
    let conn = rusqlite::Connection::open(&path).unwrap();
    let archived: String = conn.query_row("SELECT original_content FROM legacy_memory_imports", [], |row| row.get(0)).unwrap();
    assert_eq!(archived, original);
}

#[test]
fn legacy_database_migration_keeps_keys_creates_verified_backup_and_is_idempotent() {
    let path = database();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE chat_sessions(session_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE chat_messages(message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,timestamp INTEGER NOT NULL,anchor_file TEXT,anchor_line INTEGER,FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE);
        CREATE TABLE organic_memories(memory_id TEXT PRIMARY KEY,tier INTEGER NOT NULL,category TEXT NOT NULL,content TEXT NOT NULL,confidence REAL NOT NULL,created_at INTEGER NOT NULL,last_accessed_at INTEGER NOT NULL,access_count INTEGER NOT NULL,pinned INTEGER NOT NULL DEFAULT 0);
        CREATE VIRTUAL TABLE fts_chat_messages USING fts5(message_id UNINDEXED,content,tokenize='trigram');
        CREATE VIRTUAL TABLE fts_organic_memories USING fts5(memory_id UNINDEXED,content,tokenize='trigram');
        INSERT INTO chat_sessions VALUES('sess_1728000000','旧会话',NULL,1728000000,1728000001);
        INSERT INTO chat_messages VALUES('msg_1728000001','sess_1728000000','assistant','历史中文完整正文',1728000001,'sample.md',3);
        INSERT INTO organic_memories VALUES('mem_1728000001',3,'preference','保留原始记忆内容',0.8,1728000001,1728000001,2,1);
        INSERT INTO fts_chat_messages VALUES('msg_1728000001','过期全文记录');
        INSERT INTO fts_organic_memories VALUES('mem_1728000001','过期记忆记录');").unwrap();
    drop(conn);
    for _ in 0..2 {
        let storage = MemoryArchiveStorage::open(&path).unwrap();
        let sessions = storage.list_sessions().unwrap();
        assert_eq!(sessions[0].session_id, "sess_1728000000");
        assert_eq!(sessions[0].created_at, 1728000000000);
        let messages = storage.get_session_messages("sess_1728000000").unwrap();
        assert_eq!(messages[0].message_id, "msg_1728000001");
        assert_eq!(messages[0].timestamp, 1728000001000);
        assert_eq!(storage.search_messages("历史中文", 10).unwrap().len(), 1);
        assert!(storage.search_messages("过期全文", 10).unwrap().is_empty());
    }
    let backups: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap()
        .map(|entry| entry.unwrap().path()).filter(|file| file.to_string_lossy().ends_with("backup.db")).collect();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(&backups[0]).unwrap();
    let check: String = backup.query_row("PRAGMA integrity_check", [], |row| row.get(0)).unwrap();
    assert_eq!(check, "ok");
    let timestamp: i64 = backup.query_row("SELECT timestamp FROM chat_messages", [], |row| row.get(0)).unwrap();
    assert_eq!(timestamp, 1728000001);
    let current = rusqlite::Connection::open(&path).unwrap();
    let violations: i64 = current.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).unwrap();
    assert_eq!(violations, 0);
}

#[test]
#[ignore]
fn archive_subprocess_creates_real_sessions() {
    let path = std::env::var_os("STUART_MEMORY_CONCURRENT_DB").expect("子进程数据库路径缺失");
    let storage = MemoryArchiveStorage::open(path).unwrap();
    for _ in 0..10 { storage.create_session("跨进程阅读会话", None).unwrap(); }
}

#[test]
fn independent_processes_create_one_hundred_unique_sessions() {
    let path = database();
    drop(MemoryArchiveStorage::open(&path).unwrap());
    let executable = std::env::current_exe().unwrap();
    let mut children: Vec<_> = (0..10).map(|_| std::process::Command::new(&executable)
        .args(["--ignored", "--exact", "memory::tests::archive_subprocess_creates_real_sessions", "--test-threads=1"])
        .env("STUART_MEMORY_CONCURRENT_DB", &path)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).spawn().unwrap()).collect();
    for child in children.drain(..) {
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    let storage = MemoryArchiveStorage::open(&path).unwrap();
    let sessions = storage.list_sessions().unwrap();
    assert_eq!(sessions.len(), 100);
    let unique: HashSet<_> = sessions.iter().map(|session| &session.session_id).collect();
    assert_eq!(unique.len(), 100);
}

fn companion_target(path:&std::path::Path)->super::ConversationTarget {
    std::fs::write(path,"# 实际阅读文档\n\n保留文档归属与引用。\n").unwrap();
    super::ConversationTarget{document_key:Some(format!("file:{}",crate::document::identity::display_path(&crate::document::identity::canonical_target(path).unwrap()))),workspace_key:None,runtime_document_id:Some("registered-document".into()),window_id:"reading-window".into()}
}

fn intent(target:super::ConversationTarget)->super::RequestIntent {
    use sha2::{Digest,Sha256};
    let content=std::fs::read_to_string(target.document_key.as_ref().unwrap().strip_prefix("file:").unwrap()).unwrap();
    super::RequestIntent{request_id:uuid::Uuid::new_v4().to_string(),turn_id:None,session_id:None,expected_session_version:0,draft_id:None,draft_version:0,target,question:"说明文档归属与引用。".into(),scope:"document".into(),selection:None,reading_anchor:None,explicit_sources:vec![],settings_revision:"actual-settings-revision".into(),editor_revision:1,source_hash:format!("{:x}",Sha256::digest(content.as_bytes()))}
}

fn archive_answer(storage:&MemoryArchiveStorage,request:&super::RequestIntent,accepted:&super::AcceptedTurn,status:&str)->ChatArchiveMessage {
    let message=ChatArchiveMessage{message_id:uuid::Uuid::new_v4().to_string(),session_id:accepted.session.session_id.clone(),role:"assistant".into(),content:"编辑记忆时保留原始文档与真实引用。".into(),request_id:Some(request.request_id.clone()),document_id:request.target.document_key.clone(),completion_status:status.into(),source_anchor:Some(serde_json::json!({"documentKey":request.target.document_key,"excerpt":"保留文档归属与引用。"})),..Default::default()};
    storage.add_message(message.clone()).unwrap();message
}

#[test]
fn companion_deleted_current_session_clears_binding_and_preserves_unsent_draft() {
    let path=database();let storage=MemoryArchiveStorage::open(&path).unwrap();let target=companion_target(&path.with_extension("md"));let mut request=intent(target.clone());
    let accepted=storage.begin_turn(&request).unwrap();
    storage.save_draft(super::ConversationDraft{draft_id:uuid::Uuid::new_v4().to_string(),target:target.clone(),session_id:Some(accepted.session.session_id.clone()),question:"尚未发送的下一问题".into(),scope:"document".into(),selection:None,reading_anchor:None,explicit_sources:vec![],view_state:serde_json::json!({"page":"chat"}),draft_version:0,updated_at:0,partial_confirmed:false,partial_acknowledgement:None},0).unwrap();
    assert_eq!(storage.begin_session_deletion(&accepted.session.session_id,accepted.session.session_version,&target.window_id).unwrap(),Some(request.request_id.clone()));
    assert!(storage.complete_session_deletion(&accepted.session.session_id,&target.window_id,false).is_err());
    archive_answer(&storage,&request,&accepted,"Cancelled");storage.finish_attempt(&request.request_id,&target.window_id,"Cancelled",None).unwrap();
    storage.complete_session_deletion(&accepted.session.session_id,&target.window_id,false).unwrap();
    let draft=storage.get_draft(&target,None).unwrap().unwrap();assert_eq!(draft.question,"尚未发送的下一问题");assert!(draft.session_id.is_none());
    request.session_id=Some(accepted.session.session_id.clone());request.expected_session_version=accepted.session.session_version;request.request_id=uuid::Uuid::new_v4().to_string();assert!(storage.begin_turn(&request).is_err());
    request.session_id=None;request.expected_session_version=0;request.draft_id=Some(draft.draft_id.clone());request.draft_version=draft.draft_version;
    let next=storage.begin_turn(&request).unwrap();assert_ne!(next.session.session_id,accepted.session.session_id);
}

#[test]
fn companion_memory_owner_version_key_and_ask_confirmation_preserve_real_sources() {
    let path=database();let storage=MemoryArchiveStorage::open(&path).unwrap();let target=companion_target(&path.with_extension("md"));let request=intent(target.clone());let accepted=storage.begin_turn(&request).unwrap();let message=archive_answer(&storage,&request,&accepted,"Completed");storage.finish_attempt(&request.request_id,&target.window_id,"Completed",None).unwrap();
    let mut edit=super::MemoryEdit{content:message.content.clone(),category:"preference".into(),scope:"document".into(),workspace_key:None,document_key:target.document_key.clone(),preference_key:Some("answer-style".into()),pinned:false,source_message_id:Some(message.message_id.clone()),source_request_id:message.request_id.clone(),source_anchor:message.source_anchor.clone()};
    let proposal=storage.create_memory_proposal(&edit,0).unwrap();assert!(storage.effective_target_memories(None,target.document_key.as_deref(),"文档",true).unwrap().is_empty());
    let original=storage.confirm_proposal(&proposal.proposal_id,1,&edit).unwrap();assert_eq!(original.approval_kind,"user");assert_eq!(storage.get_proposal(&proposal.proposal_id).unwrap().status,"Confirmed");
    edit.content="必须保留完整的原始文档归属。".into();edit.preference_key=Some("reading-style".into());edit.pinned=true;
    let current=storage.save_memory(Some(&original.record_id),1,&edit,"user").unwrap();assert_eq!(current.record_id,original.record_id);assert_ne!(current.memory_id,original.memory_id);assert_eq!(current.version,2);assert_eq!(current.document_id,original.document_id);assert_eq!(current.source_anchor,original.source_anchor);
    assert!(storage.save_memory(Some(&original.record_id),1,&edit,"user").is_err());
    let effective=storage.effective_target_memories(None,target.document_key.as_deref(),"文档",true).unwrap();assert_eq!(effective.len(),1);assert_eq!(effective[0].memory_id,current.memory_id);
    let history=storage.list_organic_memories(None).unwrap();assert_eq!(history.len(),2);assert!(history.iter().any(|item|item.memory_id==original.memory_id && item.content==original.content));
    let source=storage.get_memory_source(&current.record_id).unwrap();assert_eq!(source["sources"][0]["sourceMessageId"],message.message_id);assert_eq!(source["sources"][0]["excerpt"],message.content);
    let session=storage.get_session(&accepted.session.session_id).unwrap();storage.begin_session_deletion(&session.session_id,session.session_version,&target.window_id).unwrap();storage.complete_session_deletion(&session.session_id,&target.window_id,false).unwrap();
    let source=storage.get_memory_source(&current.record_id).unwrap();assert_eq!(source["sources"][0]["sourceDeleted"],true);assert_eq!(source["sources"][0]["excerpt"],message.content);assert_eq!(storage.memory_by_record(&current.record_id).unwrap().version,2);
}

#[test]
fn companion_archived_source_lookup_uses_request_and_source_identity() {
    let path=database();let storage=MemoryArchiveStorage::open(&path).unwrap();let target=companion_target(&path.with_extension("md"));let request=intent(target);let accepted=storage.begin_turn(&request).unwrap();
    let document=std::fs::read_to_string(path.with_extension("md")).unwrap();
    storage.record_context(&request.request_id,&accepted.session.session_id,&serde_json::json!({"sources":[{"sourceId":"actual-document","kind":"document","excerpt":document}]})).unwrap();
    assert_eq!(storage.archived_source("actual-document",&request.request_id).unwrap()["excerpt"],document);
    assert!(storage.archived_source("unknown-source",&request.request_id).is_err());assert!(storage.archived_source("actual-document","unknown-request").is_err());
    std::fs::remove_file(path.with_extension("md")).unwrap();
    assert_eq!(storage.archived_source("actual-document",&request.request_id).unwrap()["excerpt"],document);
    assert_eq!(storage.conversation_page(None,Some(&accepted.session.session_id),None).unwrap().session.unwrap().session_id,accepted.session.session_id);
}

#[test]
fn companion_production_archive_consistent_copy_preserves_content_and_keys() {
    let source=dirs::config_dir().unwrap().join("StuartMD").join("chat_archive.db");
    let original=rusqlite::Connection::open_with_flags(&source,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let original_version:i64=original.query_row("PRAGMA user_version",[],|r|r.get(0)).unwrap();
    let destination=database();original.backup(rusqlite::DatabaseName::Main,&destination,None).unwrap();drop(original);
    let before=rusqlite::Connection::open(&destination).unwrap();
    let capture=|conn:&rusqlite::Connection,sql:&str| {let mut statement=conn.prepare(sql).unwrap();statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap()};
    let messages=capture(&before,"SELECT message_id,content FROM chat_messages ORDER BY message_id");let memories=capture(&before,"SELECT memory_id,content FROM organic_memories ORDER BY memory_id");
    let message_sources=capture(&before,"SELECT message_id,json_array(request_id,document_id,source_hash,source_anchor,completion_status) FROM chat_messages ORDER BY message_id");
    let memory_sources=capture(&before,"SELECT memory_id,json_array(source_message_id,request_id,source_anchor,confirmed,superseded_by) FROM organic_memories ORDER BY memory_id");
    let contexts=capture(&before,"SELECT request_id,record_json FROM context_records ORDER BY request_id");
    drop(before);
    drop(MemoryArchiveStorage::open(&destination).unwrap());drop(MemoryArchiveStorage::open(&destination).unwrap());
    let after=rusqlite::Connection::open(&destination).unwrap();assert_eq!(capture(&after,"SELECT message_id,content FROM chat_messages ORDER BY message_id"),messages);assert_eq!(capture(&after,"SELECT memory_id,content FROM organic_memories ORDER BY memory_id"),memories);
    assert_eq!(capture(&after,"SELECT message_id,json_array(request_id,document_id,source_hash,source_anchor,completion_status) FROM chat_messages ORDER BY message_id"),message_sources);
    assert_eq!(capture(&after,"SELECT memory_id,json_array(source_message_id,request_id,source_anchor,confirmed,superseded_by) FROM organic_memories ORDER BY memory_id"),memory_sources);
    assert_eq!(capture(&after,"SELECT request_id,record_json FROM context_records ORDER BY request_id"),contexts);
    assert_eq!(after.query_row("SELECT COUNT(*) FROM memory_records r WHERE NOT EXISTS(SELECT 1 FROM organic_memories m WHERE m.record_id=r.record_id AND m.version=r.current_version)",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(after.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),5);assert_eq!(after.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");assert_eq!(after.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    println!("生产结构版本={}；验证结构版本=5；一致性副本路径={}；消息数量={}；记忆版本数量={}",original_version,destination.display(),messages.len(),memories.len());
}

#[test]
fn companion_deletion_abort_and_learning_ownership_preserve_completed_answer() {
    let path=database();let storage=MemoryArchiveStorage::open(&path).unwrap();let target=companion_target(&path.with_extension("md"));let request=intent(target.clone());let accepted=storage.begin_turn(&request).unwrap();
    archive_answer(&storage,&request,&accepted,"Completed");let session=storage.finish_attempt(&request.request_id,&target.window_id,"Completed",None).unwrap();
    storage.set_request_learning_status(&request.request_id,"restored-window","Running",None).unwrap();
    assert!(storage.set_request_learning_status(&request.request_id,"restored-window","Running",None).is_err());
    assert!(storage.begin_session_deletion(&session.session_id,session.session_version,&target.window_id).is_err());
    assert_eq!(storage.begin_session_deletion(&session.session_id,session.session_version,"restored-window").unwrap(),Some(request.request_id.clone()));
    assert_eq!(storage.session_active_requests(&session.session_id,"restored-window").unwrap(),vec![request.request_id.clone()]);
    assert!(storage.complete_session_deletion(&session.session_id,"restored-window",false).is_err());
    assert!(storage.abort_session_deletion(&session.session_id,"other-window").is_err());
    storage.abort_session_deletion(&session.session_id,"restored-window").unwrap();
    assert_eq!(storage.get_session(&session.session_id).unwrap().deletion_state,"active");
    storage.record_learning_usage(&request.request_id,"restored-window",&serde_json::json!({"prompt_tokens":20,"completion_tokens":8})).unwrap();
    assert!(storage.set_request_learning_status(&request.request_id,"other-window","Cancelled",None).is_err());
    storage.set_request_learning_status(&request.request_id,"restored-window","Cancelled",None).unwrap();
    let record=storage.request_record(&request.request_id).unwrap();assert_eq!(record["status"],"Completed");assert_eq!(record["learningStatus"],"Cancelled");assert_eq!(record["learningUsage"]["prompt_tokens"],20);
    assert!(storage.set_request_learning_status(&request.request_id,"restored-window","Running",None).is_err());
    let page=storage.conversation_page(Some(&target),Some(&session.session_id),None).unwrap();assert_eq!(page.learning_actions[0]["status"],"Cancelled");assert_eq!(page.messages[0].completion_status,"Completed");
}

#[test]
fn companion_manual_memory_retains_original_user_entry_and_full_versions() {
    let storage=MemoryArchiveStorage::open(database()).unwrap();
    let mut edit=super::MemoryEdit{content:"详细说明完整依据。".into(),category:"preference".into(),scope:"global".into(),workspace_key:None,document_key:None,preference_key:Some("answer-style".into()),pinned:true,source_message_id:None,source_request_id:None,source_anchor:Some(serde_json::json!({"createdBy":"manual-confirmation"}))};
    let original=storage.save_memory(None,0,&edit,"user").unwrap();
    edit.content="逐项说明完整依据。".into();let current=storage.save_memory(Some(&original.record_id),original.version,&edit,"user").unwrap();
    let source=storage.get_memory_source(&current.record_id).unwrap();assert_eq!(source["sources"][0]["excerpt"],original.content);assert_eq!(source["sources"][0]["sourceDeleted"],false);
    let versions=storage.memory_versions(&current.record_id).unwrap();assert_eq!(versions.len(),2);assert_eq!(versions[0].version,2);assert_eq!(versions[1].content,original.content);
    assert!(storage.save_memory(None,0,&edit,"automatic").is_err());
}

#[test]
fn companion_first_save_moves_persistent_owners_and_save_as_preserves_original_owner() {
    let path=database();let storage=MemoryArchiveStorage::open(&path).unwrap();let file_target=companion_target(&path.with_extension("md"));let mut request=intent(file_target.clone());
    let document_id=uuid::Uuid::new_v4().to_string();let mut draft_target=file_target.clone();draft_target.runtime_document_id=Some(document_id.clone());draft_target.document_key=Some(format!("draft:{document_id}"));request.target=draft_target.clone();
    let accepted=storage.begin_turn(&request).unwrap();let message=archive_answer(&storage,&request,&accepted,"Completed");storage.finish_attempt(&request.request_id,&draft_target.window_id,"Completed",None).unwrap();
    let edit=super::MemoryEdit{content:"保留首次保存后的归属。".into(),category:"knowledge".into(),scope:"document".into(),workspace_key:None,document_key:draft_target.document_key.clone(),preference_key:None,pinned:false,source_message_id:Some(message.message_id.clone()),source_request_id:message.request_id.clone(),source_anchor:message.source_anchor.clone()};
    let memory=storage.save_memory(None,0,&edit,"user").unwrap();
    let mut draft=storage.save_draft(super::ConversationDraft{draft_id:uuid::Uuid::new_v4().to_string(),target:draft_target.clone(),session_id:Some(accepted.session.session_id.clone()),question:"正在编辑的未发送正文。".into(),scope:"document".into(),selection:None,reading_anchor:None,explicit_sources:vec![],view_state:serde_json::json!({"page":"chat"}),draft_version:0,updated_at:0,partial_confirmed:false,partial_acknowledgement:None},0).unwrap();
    let original_draft=draft.clone();let original_session=storage.get_session(&accepted.session.session_id).unwrap();
    let original_path=path.with_extension("md");storage.update_document_path(&document_id,original_path.to_str().unwrap()).unwrap();
    let key=file_target.document_key.as_deref().unwrap();assert_eq!(storage.get_session(&accepted.session.session_id).unwrap().document_key.as_deref(),Some(key));assert_eq!(storage.memory_by_record(&memory.record_id).unwrap().document_id.as_deref(),Some(key));
    draft.question.push_str("还有刚刚输入的内容。");let saved=storage.save_draft_after_first_save(draft.clone(),draft.draft_version,key).unwrap();
    assert_eq!(saved.draft_version,3);assert_eq!(saved.question,draft.question);assert_eq!(saved.target.document_key.as_deref(),Some(key));
    let restored=storage.get_draft(&saved.target,Some(&accepted.session.session_id)).unwrap().unwrap();assert_eq!(restored.question,draft.question);assert_eq!(restored.draft_version,3);
    let saved_session=storage.get_session(&accepted.session.session_id).unwrap();
    let evidence=serde_json::json!({"before":{"session":original_session,"draft":original_draft,"turns":[accepted.turn],"messages":[message],"learningActions":[]},"savedDraft":saved,"after":{"session":saved_session,"draft":restored,"turns":[accepted.turn],"messages":[message],"learningActions":[]}});
    let directory=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/validation/{}",env!("CARGO_PKG_VERSION")));std::fs::create_dir_all(&directory).unwrap();
    let output=directory.join("conversation-draft.json");
    std::fs::write(output,serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    let other=path.with_file_name("另存文档.md");std::fs::write(&other,"# 另存文档\n").unwrap();storage.update_document_path(&document_id,other.to_str().unwrap()).unwrap();
    let session=storage.get_session(&accepted.session.session_id).unwrap();assert_eq!(session.document_key.as_deref(),Some(key));assert_eq!(session.document_path.as_deref(),key.strip_prefix("file:"));assert_eq!(storage.memory_by_record(&memory.record_id).unwrap().document_id.as_deref(),Some(key));
    assert_eq!(storage.get_message(&message.message_id).unwrap().source_anchor,message.source_anchor);
}

#[test]
#[ignore]
fn companion_restart_subprocess_leaves_real_interrupted_operations() {
    let path=PathBuf::from(std::env::var_os("STUART_COMPANION_RESTART_DB").expect("重启验证数据库路径缺失"));
    let archive=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/native-artifacts/providers-443cb100-f28c-4dc4-a859-d62cf6df8170/chat_archive.db");
    let original=rusqlite::Connection::open_with_flags(archive,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    original.backup(rusqlite::DatabaseName::Main,&path,None).unwrap();original.backup(rusqlite::DatabaseName::Main,path.with_extension("learning.db"),None).unwrap();drop(original);
    let storage=MemoryArchiveStorage::open(&path).unwrap();
    let conn=rusqlite::Connection::open(&path).unwrap();
    let mut statement=conn.prepare("SELECT a.request_id,a.intent_json FROM request_attempts a JOIN chat_messages m ON m.request_id=a.request_id AND m.role='assistant' WHERE a.status='Completed' AND a.finished_at IS NOT NULL AND a.intent_json IS NOT NULL ORDER BY a.started_at").unwrap();
    let completed=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();drop(statement);
    assert!(!completed.is_empty(),"真实 DeepSeek 归档缺少已完成请求");
    let archived_request=&completed[0].0;let learning_request=archived_request;
    let mut request:super::RequestIntent=serde_json::from_str(&completed[0].1).unwrap();
    let source_path=std::path::Path::new(request.target.document_key.as_deref().unwrap().strip_prefix("file:").unwrap());
    let documents=crate::document::DocumentService::new(path.parent().unwrap().join("documents")).unwrap();
    let opened=documents.read("restart-reading-window",source_path).unwrap();
    let snapshot=documents.snapshot_for_window("restart-reading-window",&opened.document_id).unwrap();
    documents.validate_context_snapshot("restart-reading-window",&snapshot.document_id,snapshot.revision,&snapshot.content_hash).unwrap();
    request.target=super::ConversationTarget{document_key:Some(crate::document::DocumentService::document_key(&snapshot).unwrap()),workspace_key:None,runtime_document_id:Some(snapshot.document_id.clone()),window_id:"restart-reading-window".into()};
    request.request_id=uuid::Uuid::new_v4().to_string();request.session_id=None;request.turn_id=None;request.expected_session_version=0;request.draft_version=0;request.draft_id=None;request.editor_revision=snapshot.revision;request.source_hash=snapshot.content_hash.clone();
    let preparing=storage.begin_turn(&request).unwrap();
    storage.record_context(&request.request_id,&preparing.session.session_id,&serde_json::json!({"sources":[{"kind":"document","excerpt":snapshot.source,"anchor":{"path":snapshot.path,"revision":snapshot.revision,"sourceHash":snapshot.content_hash}}]})).unwrap();
    storage.add_message(ChatArchiveMessage{session_id:preparing.session.session_id.clone(),role:"user".into(),content:request.question.clone(),request_id:Some(request.request_id.clone()),document_id:request.target.document_key.clone(),completion_status:"Completed".into(),source_hash:Some(snapshot.content_hash.clone()),..Default::default()}).unwrap();
    storage.begin_session_deletion(&preparing.session.session_id,preparing.session.session_version,&request.target.window_id).unwrap();
    let mut streaming_request=request.clone();streaming_request.request_id=uuid::Uuid::new_v4().to_string();streaming_request.target.window_id="restart-streaming-window".into();
    let streaming=storage.begin_turn(&streaming_request).unwrap();storage.update_attempt_phase(&streaming_request.request_id,&streaming_request.target.window_id,"Streaming").unwrap();
    let learning_storage=MemoryArchiveStorage::open(path.with_extension("learning.db")).unwrap();
    let learning_record=learning_storage.request_record(learning_request).unwrap();let learning_owner=learning_record["learningWindowId"].as_str().unwrap();
    let learning_conn=rusqlite::Connection::open(path.with_extension("learning.db")).unwrap();
    // 在另一份真实副本中保留整理内容和实际用量，重现整理终态提交之前的中断位置。
    learning_conn.execute("UPDATE request_attempts SET learning_status='Running',learning_error=NULL WHERE request_id=?1",[learning_request]).unwrap();
    let learning_session=learning_storage.get_session(learning_record["sessionId"].as_str().unwrap()).unwrap();
    learning_storage.begin_session_deletion(&learning_session.session_id,learning_session.session_version,learning_owner).unwrap();
    // 在真实归档副本中重现助手正文已提交、请求终态尚未提交的中断位置。
    conn.execute("UPDATE request_attempts SET status='Streaming',phase='Streaming',finished_at=NULL WHERE request_id=?1",[archived_request]).unwrap();
    let capture=|sql:&str| {let mut statement=conn.prepare(sql).unwrap();statement.query_map([],|row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()};
    let messages=capture("SELECT json_array(message_id,session_id,role,content,timestamp,request_id,document_id,completion_status,source_hash,source_anchor,sequence,turn_id,attempt_no) FROM chat_messages ORDER BY message_id");
    let memories=capture("SELECT json_array(memory_id,content,source_message_id,request_id,source_anchor,version,confirmed,superseded_by) FROM organic_memories ORDER BY memory_id");
    let contexts=capture("SELECT json_array(request_id,session_id,record_json) FROM context_records ORDER BY request_id");
    let evidence=serde_json::json!({"preparingRequest":request,"preparing":preparing,"streamingRequest":streaming_request,"streaming":streaming,"archivedRequestId":archived_request,"learningRequestId":learning_request,"learningSession":learning_session,"learningRecord":learning_record,"learningMessages":learning_storage.get_session_messages(&learning_session.session_id).unwrap(),"learningMemories":learning_storage.list_organic_memories(None).unwrap(),"messages":messages,"memories":memories,"contexts":contexts});
    std::fs::write(path.with_extension("restart.json"),serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    std::process::exit(0);
}

#[test]
fn companion_restart_recovers_requests_learning_and_deletion_without_changing_archives() {
    let path=database();let executable=std::env::current_exe().unwrap();
    let output=std::process::Command::new(executable).args(["--ignored","--exact","memory::tests::companion_restart_subprocess_leaves_real_interrupted_operations","--test-threads=1"]).env("STUART_COMPANION_RESTART_DB",&path).output().unwrap();
    assert!(output.status.success(),"{}\n{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
    let evidence:serde_json::Value=serde_json::from_slice(&std::fs::read(path.with_extension("restart.json")).unwrap()).unwrap();
    let request:super::RequestIntent=serde_json::from_value(evidence["preparingRequest"].clone()).unwrap();
    let streaming:super::RequestIntent=serde_json::from_value(evidence["streamingRequest"].clone()).unwrap();
    let storage=MemoryArchiveStorage::open(&path).unwrap();
    let mut resend=request.clone();resend.request_id=uuid::Uuid::new_v4().to_string();
    assert!(storage.begin_turn(&resend).unwrap_err().contains("活动请求"));
    let archived_request=evidence["archivedRequestId"].as_str().unwrap();let learning_request=evidence["learningRequestId"].as_str().unwrap();
    let learning_storage=MemoryArchiveStorage::open(path.with_extension("learning.db")).unwrap();
    assert_eq!(storage.request_record(archived_request).unwrap()["status"],"Streaming");assert_eq!(learning_storage.request_record(learning_request).unwrap()["learningStatus"],"Running");
    assert_eq!(storage.get_session(evidence["preparing"]["session"]["sessionId"].as_str().unwrap()).unwrap().deletion_state,"deleting");
    storage.recover_interrupted_operations().unwrap();
    learning_storage.recover_interrupted_operations().unwrap();
    assert_eq!(storage.request_record(&request.request_id).unwrap()["status"],"Failed");
    assert_eq!(storage.request_record(&streaming.request_id).unwrap()["status"],"Failed");
    assert_eq!(storage.request_record(archived_request).unwrap()["status"],"Completed");
    let learning=learning_storage.request_record(learning_request).unwrap();assert_eq!(learning["status"],"Completed");assert_eq!(learning["learningStatus"],"Cancelled");assert_eq!(learning["learningUsage"],evidence["learningRecord"]["learningUsage"]);assert!(learning["learningError"].as_str().unwrap().contains("应用退出"));
    assert_eq!(serde_json::to_value(learning_storage.get_session_messages(learning["sessionId"].as_str().unwrap()).unwrap()).unwrap(),evidence["learningMessages"]);
    assert_eq!(serde_json::to_value(learning_storage.list_organic_memories(None).unwrap()).unwrap(),evidence["learningMemories"]);
    let conn=rusqlite::Connection::open(&path).unwrap();
    for (key,sql) in [
        ("messages","SELECT json_array(message_id,session_id,role,content,timestamp,request_id,document_id,completion_status,source_hash,source_anchor,sequence,turn_id,attempt_no) FROM chat_messages WHERE request_id NOT IN (SELECT request_id FROM request_attempts WHERE error=?1) OR role<>'assistant' ORDER BY message_id"),
        ("memories","SELECT json_array(memory_id,content,source_message_id,request_id,source_anchor,version,confirmed,superseded_by) FROM organic_memories ORDER BY memory_id"),
        ("contexts","SELECT json_array(request_id,session_id,record_json) FROM context_records ORDER BY request_id")
    ] {
        let mut statement=conn.prepare(sql).unwrap();let rows=if key=="messages" {statement.query_map(["应用退出导致请求中断，尚未归档助手回答。"],|row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()}else{statement.query_map([],|row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap()};
        assert_eq!(serde_json::to_value(rows).unwrap(),evidence[key]);
    }
    for interrupted in [&request,&streaming] {
        let record=storage.request_record(&interrupted.request_id).unwrap();assert!(record["error"].as_str().unwrap().contains("应用退出"));
        let session=storage.get_session(record["sessionId"].as_str().unwrap()).unwrap();assert_eq!(session.deletion_state,"active");
        let messages=storage.get_session_messages(&session.session_id).unwrap();let answer=messages.iter().find(|message|message.role=="assistant").unwrap();assert!(answer.content.is_empty());assert_eq!(answer.completion_status,"Failed");assert!(answer.source_anchor.as_ref().unwrap()["interruptionReason"].as_str().unwrap().contains("应用退出"));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM request_attempts WHERE request_id=?1 AND finished_at IS NOT NULL",[&interrupted.request_id],|row|row.get::<_,u64>(0)).unwrap(),1);
    }
    let archived_before=storage.request_record(archived_request).unwrap();let learning_before=learning_storage.request_record(learning_request).unwrap();let sessions_before=storage.list_sessions().unwrap();let learning_sessions_before=learning_storage.list_sessions().unwrap();
    storage.recover_interrupted_operations().unwrap();learning_storage.recover_interrupted_operations().unwrap();assert_eq!(storage.request_record(archived_request).unwrap(),archived_before);assert_eq!(learning_storage.request_record(learning_request).unwrap(),learning_before);assert_eq!(storage.list_sessions().unwrap(),sessions_before);assert_eq!(learning_storage.list_sessions().unwrap(),learning_sessions_before);
    let resent=storage.begin_turn(&resend).unwrap();assert_ne!(resent.session.session_id,evidence["preparing"]["session"]["sessionId"].as_str().unwrap());
    let streaming_session=storage.request_record(&streaming.request_id).unwrap()["sessionId"].as_str().unwrap().to_owned();let session=storage.get_session(&streaming_session).unwrap();
    let mut retry=streaming.clone();retry.request_id=uuid::Uuid::new_v4().to_string();retry.session_id=Some(session.session_id.clone());retry.turn_id=Some(evidence["streaming"]["turn"]["turnId"].as_str().unwrap().into());retry.expected_session_version=session.session_version;
    let retried=storage.begin_turn(&retry).unwrap();assert_eq!(retried.attempt_no,2);assert_eq!(retried.turn.turn_id,retry.turn_id.unwrap());
    let preparing_session=evidence["preparing"]["session"]["sessionId"].as_str().unwrap();let session=storage.get_session(preparing_session).unwrap();assert_eq!(storage.begin_session_deletion(preparing_session,session.session_version,"restarted-delete-window").unwrap(),None);assert!(storage.complete_session_deletion(preparing_session,"restarted-delete-window",false).unwrap());
    let session_id=learning_before["sessionId"].as_str().unwrap();let session=learning_storage.get_session(session_id).unwrap();assert_eq!(session.deletion_state,"active");assert_eq!(learning_storage.begin_session_deletion(session_id,session.session_version,"restarted-delete-window").unwrap(),None);learning_storage.abort_session_deletion(session_id,"restarted-delete-window").unwrap();
    assert_eq!(conn.query_row("PRAGMA integrity_check",[],|row|row.get::<_,String>(0)).unwrap(),"ok");assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|row|row.get::<_,u64>(0)).unwrap(),0);
    println!("重启恢复数据库={}；已归档消息数量={}；真实记忆版本数量={}；已验证相同窗口重新发送、原问题重试、删除以及完成正文保留",path.display(),evidence["messages"].as_array().unwrap().len(),evidence["memories"].as_array().unwrap().len());
}
