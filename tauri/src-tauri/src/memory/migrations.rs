use fs2::FileExt;
use rusqlite::{Connection, DatabaseName, TransactionBehavior};
use std::fs::OpenOptions;
use std::path::Path;
use uuid::Uuid;

pub const SCHEMA_VERSION: i64 = 4;

pub fn migrate(conn: &mut Connection, path: Option<&Path>) -> Result<(), String> {
    let migration_lock = if let Some(parent) = path.and_then(Path::parent) {
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true)
            .open(parent.join("data_migration.lock")).map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => break,
                Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                    if std::time::Instant::now() >= deadline { return Err("等待数据库迁移锁超时".into()); }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => return Err(format!("取得数据库迁移锁失败：{error}")),
            }
        }
        Some(file)
    } else { None };
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("数据库结构读取失败：{e}"))?;
    if version > SCHEMA_VERSION {
        return Err(format!("数据库结构 {version} 高于支持版本 {SCHEMA_VERSION}，已停止写入"));
    }
    let check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("数据库完整性检查失败：{e}"))?;
    if check != "ok" { return Err(format!("数据库完整性检查失败：{check}")); }
    if version == SCHEMA_VERSION { return Ok(()); }
    let existing: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_sessions')",
        [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if existing {
        if let Some(path) = path {
            let backup = path.with_extension(format!("schema-{version}-{}.backup.db", Uuid::new_v4()));
            conn.backup(DatabaseName::Main, &backup, None)
                .map_err(|e| format!("数据库一致性备份失败：{e}"))?;
            let backup_conn = Connection::open(&backup).map_err(|e| e.to_string())?;
            let check: String = backup_conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if check != "ok" { return Err(format!("数据库备份完整性检查失败：{check}")); }
        }
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            session_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS chat_messages (
            message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, timestamp INTEGER NOT NULL, anchor_file TEXT, anchor_line INTEGER,
            FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE);
         CREATE TABLE IF NOT EXISTS organic_memories (
            memory_id TEXT PRIMARY KEY, tier INTEGER NOT NULL, category TEXT NOT NULL,
            content TEXT NOT NULL, confidence REAL NOT NULL, created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS legacy_memory_imports (
            fingerprint TEXT PRIMARY KEY, source_path TEXT NOT NULL, original_content TEXT NOT NULL,
            imported_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS context_records (
            request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE);
         CREATE TABLE IF NOT EXISTS context_summaries (
            summary_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model_spec_id TEXT NOT NULL,
            summary_json TEXT NOT NULL, source_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            FOREIGN KEY(session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE);
         CREATE TABLE IF NOT EXISTS document_paths (
            document_id TEXT PRIMARY KEY, path TEXT NOT NULL);"
    ).map_err(|e| e.to_string())?;
    for (table, name, declaration) in [
        ("chat_sessions", "document_id", "TEXT"),
        ("chat_sessions", "document_path", "TEXT"),
        ("chat_messages", "request_id", "TEXT"),
        ("chat_messages", "document_id", "TEXT"),
        ("chat_messages", "completion_status", "TEXT NOT NULL DEFAULT 'Completed'"),
        ("chat_messages", "source_hash", "TEXT"),
        ("chat_messages", "source_anchor", "TEXT"),
        ("chat_messages", "sequence", "INTEGER NOT NULL DEFAULT 0"),
        ("organic_memories", "scope", "TEXT NOT NULL DEFAULT 'global'"),
        ("organic_memories", "workspace_id", "TEXT"),
        ("organic_memories", "document_id", "TEXT"),
        ("organic_memories", "preference_key", "TEXT"),
        ("organic_memories", "version", "INTEGER NOT NULL DEFAULT 1"),
        ("organic_memories", "source_message_id", "TEXT"),
        ("organic_memories", "source_anchor", "TEXT"),
        ("organic_memories", "confirmed", "INTEGER NOT NULL DEFAULT 0"),
        ("organic_memories", "superseded_by", "TEXT"),
        ("organic_memories", "request_id", "TEXT"),
    ] {
        let mut statement = tx.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
        let names = statement.query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        drop(statement);
        if !names.iter().any(|column| column == name) {
            tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {declaration}"))
                .map_err(|e| e.to_string())?;
        }
    }
    tx.execute_batch(
        "INSERT OR REPLACE INTO document_paths(document_id,path)
            SELECT document_id,document_path FROM chat_sessions
            WHERE document_id IS NOT NULL AND document_path IS NOT NULL ORDER BY updated_at;
         INSERT OR IGNORE INTO document_paths(document_id,path)
            SELECT document_id,json_extract(source_anchor,'$.path') FROM organic_memories
            WHERE document_id IS NOT NULL AND json_valid(source_anchor)
            AND json_type(source_anchor,'$.path')='text';
         UPDATE chat_sessions SET created_at=created_at*1000 WHERE created_at<100000000000;
         UPDATE chat_sessions SET updated_at=updated_at*1000 WHERE updated_at<100000000000;
         UPDATE chat_messages SET timestamp=timestamp*1000 WHERE timestamp<100000000000;
         UPDATE organic_memories SET created_at=created_at*1000 WHERE created_at<100000000000;
         UPDATE organic_memories SET last_accessed_at=last_accessed_at*1000 WHERE last_accessed_at<100000000000;
         UPDATE chat_messages SET sequence=rowid WHERE sequence=0;
         CREATE INDEX IF NOT EXISTS idx_msg_session ON chat_messages(session_id,sequence);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_request_role ON chat_messages(request_id,role)
            WHERE request_id IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_request ON organic_memories(request_id,preference_key)
            WHERE request_id IS NOT NULL AND preference_key IS NOT NULL;
         CREATE VIRTUAL TABLE IF NOT EXISTS fts_chat_messages USING fts5(message_id UNINDEXED, content, tokenize='trigram');
         CREATE VIRTUAL TABLE IF NOT EXISTS fts_organic_memories USING fts5(memory_id UNINDEXED, content, tokenize='trigram');
         DROP TRIGGER IF EXISTS trg_msg_ai; DROP TRIGGER IF EXISTS trg_msg_ad; DROP TRIGGER IF EXISTS trg_msg_au;
         DROP TRIGGER IF EXISTS trg_mem_ai; DROP TRIGGER IF EXISTS trg_mem_ad; DROP TRIGGER IF EXISTS trg_mem_au;
         CREATE TRIGGER trg_msg_ai AFTER INSERT ON chat_messages BEGIN
            INSERT INTO fts_chat_messages(message_id,content) VALUES(new.message_id,new.content); END;
         CREATE TRIGGER trg_msg_ad AFTER DELETE ON chat_messages BEGIN
            DELETE FROM fts_chat_messages WHERE message_id=old.message_id; END;
         CREATE TRIGGER trg_msg_au AFTER UPDATE ON chat_messages BEGIN
            DELETE FROM fts_chat_messages WHERE message_id=old.message_id;
            INSERT INTO fts_chat_messages(message_id,content) VALUES(new.message_id,new.content); END;
         CREATE TRIGGER trg_mem_ai AFTER INSERT ON organic_memories BEGIN
            INSERT INTO fts_organic_memories(memory_id,content) VALUES(new.memory_id,new.content); END;
         CREATE TRIGGER trg_mem_ad AFTER DELETE ON organic_memories BEGIN
            DELETE FROM fts_organic_memories WHERE memory_id=old.memory_id; END;
         CREATE TRIGGER trg_mem_au AFTER UPDATE ON organic_memories BEGIN
            DELETE FROM fts_organic_memories WHERE memory_id=old.memory_id;
            INSERT INTO fts_organic_memories(memory_id,content) VALUES(new.memory_id,new.content); END;
         DELETE FROM fts_chat_messages;
         INSERT INTO fts_chat_messages(message_id,content) SELECT message_id,content FROM chat_messages;
         DELETE FROM fts_organic_memories;
         INSERT INTO fts_organic_memories(memory_id,content) SELECT memory_id,content FROM organic_memories;
         PRAGMA user_version=4;"
    ).map_err(|e| e.to_string())?;
    let violations: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if violations != 0 { return Err(format!("数据库迁移存在 {violations} 个外键错误")); }
    tx.commit().map_err(|e| e.to_string())?;
    drop(migration_lock);
    Ok(())
}
