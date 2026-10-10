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
    assert_eq!(records[0].tier, 2);
    assert_eq!(records[0].category, "decision");
    let conn = rusqlite::Connection::open(path).unwrap();
    let count = |term: &str| conn.query_row(
        "SELECT COUNT(*) FROM fts_organic_memories WHERE fts_organic_memories MATCH ?1",
        [term], |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(count("moonlight"), 1);
    assert_eq!(count("starlight"), 0);
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
