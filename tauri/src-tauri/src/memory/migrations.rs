use fs2::FileExt;
use rusqlite::{Connection, DatabaseName, TransactionBehavior};
use sha2::{Digest,Sha256};
use std::fs::OpenOptions;
use std::path::Path;
use uuid::Uuid;

pub const SCHEMA_VERSION: i64 = 5;

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
    if version == SCHEMA_VERSION {
        verify_companion(conn)?;
        return Ok(());
    }
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
    let original_payload=archive_payload_digest(&tx)?;
    migrate_companion(&tx)?;
    if archive_payload_digest(&tx)?!=original_payload {return Err("数据库迁移的原始正文、确认状态或来源发生变化".into());}
    verify_companion(&tx)?;
    let violations: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if violations != 0 { return Err(format!("数据库迁移存在 {violations} 个外键错误")); }
    tx.commit().map_err(|e| e.to_string())?;
    drop(migration_lock);
    Ok(())
}

fn archive_payload_digest(conn:&Connection)->Result<(u64,String),String> {
    let mut digest=Sha256::new();let mut count=0u64;
    for sql in [
        "SELECT json_array(message_id,session_id,role,content,request_id,document_id,completion_status,source_hash,source_anchor) FROM chat_messages ORDER BY message_id",
        "SELECT json_array(memory_id,content,source_message_id,source_anchor,confirmed,superseded_by,request_id) FROM organic_memories ORDER BY memory_id",
        "SELECT json_array(request_id,session_id,record_json) FROM context_records ORDER BY request_id",
    ] {
        let mut statement=conn.prepare(sql).map_err(|e|e.to_string())?;
        let rows=statement.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
        for row in rows {let value=row.map_err(|e|e.to_string())?;digest.update((value.len() as u64).to_le_bytes());digest.update(value.as_bytes());count+=1;}
    }
    Ok((count,format!("{:x}",digest.finalize())))
}

fn verify_companion(conn:&Connection)->Result<(),String> {
    let foreign_keys:i64=conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if foreign_keys!=0 {return Err(format!("数据库存在 {foreign_keys} 个外键错误"));}
    let versions:i64=conn.query_row("SELECT COUNT(*) FROM memory_records r WHERE r.current_version<=0 OR NOT EXISTS(SELECT 1 FROM organic_memories m WHERE m.record_id=r.record_id AND m.version=r.current_version)",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if versions!=0 {return Err(format!("数据库存在 {versions} 个记忆版本错误"));}
    let messages:i64=conn.query_row("SELECT COUNT(*) FROM chat_messages m JOIN request_attempts a ON a.request_id=m.request_id JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE t.session_id<>m.session_id OR m.turn_id IS NOT t.turn_id OR m.attempt_no<>a.attempt_no",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if messages!=0 {return Err(format!("数据库存在 {messages} 个消息请求归属错误"));}
    Ok(())
}

fn migrate_companion(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    tx.execute_batch("ALTER TABLE chat_sessions ADD COLUMN document_key TEXT;
        ALTER TABLE chat_sessions ADD COLUMN workspace_key TEXT;
        ALTER TABLE chat_sessions ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE chat_sessions ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active';
        ALTER TABLE chat_sessions ADD COLUMN deletion_owner TEXT;
        ALTER TABLE chat_messages ADD COLUMN turn_id TEXT;
        ALTER TABLE chat_messages ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE organic_memories ADD COLUMN record_id TEXT;
        ALTER TABLE organic_memories ADD COLUMN approval_kind TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE document_paths ADD COLUMN document_key TEXT;
        ALTER TABLE document_paths ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unresolved';
        DROP INDEX IF EXISTS idx_memory_request;
        CREATE INDEX idx_memory_request ON organic_memories(request_id,preference_key);
        CREATE TABLE conversation_turns(turn_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,question TEXT NOT NULL,current_request_id TEXT,created_at INTEGER NOT NULL,UNIQUE(session_id,ordinal));
        CREATE TABLE request_attempts(request_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE CASCADE,attempt_no INTEGER NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,window_id TEXT,error TEXT,started_at INTEGER NOT NULL,finished_at INTEGER,intent_json TEXT,learning_status TEXT NOT NULL DEFAULT 'NotStarted',learning_error TEXT,learning_window_id TEXT,learning_usage_json TEXT,actual_usage_json TEXT,UNIQUE(turn_id,attempt_no));
        CREATE UNIQUE INDEX active_request_session ON request_attempts(turn_id) WHERE finished_at IS NULL;
        CREATE UNIQUE INDEX active_request_window ON request_attempts(window_id) WHERE finished_at IS NULL AND window_id IS NOT NULL;
        CREATE TRIGGER active_session_request BEFORE INSERT ON request_attempts WHEN NEW.finished_at IS NULL BEGIN
            SELECT RAISE(ABORT,'会话已经存在活动请求') WHERE EXISTS(SELECT 1 FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE a.finished_at IS NULL AND t.session_id=(SELECT session_id FROM conversation_turns WHERE turn_id=NEW.turn_id)); END;
        CREATE TABLE conversation_drafts(draft_id TEXT PRIMARY KEY,document_key TEXT,workspace_key TEXT,session_id TEXT REFERENCES chat_sessions(session_id) ON DELETE SET NULL,draft_json TEXT NOT NULL,draft_version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE INDEX draft_target_session ON conversation_drafts(document_key,workspace_key,session_id,updated_at DESC);
        CREATE TABLE memory_records(record_id TEXT PRIMARY KEY,current_version INTEGER NOT NULL,status TEXT NOT NULL,scope TEXT NOT NULL,workspace_key TEXT,document_key TEXT,preference_key TEXT);
        CREATE UNIQUE INDEX effective_memory_key ON memory_records(scope,COALESCE(workspace_key,''),COALESCE(document_key,''),preference_key) WHERE status='active' AND preference_key IS NOT NULL;
        CREATE TABLE memory_sources(source_id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES memory_records(record_id),source_message_id TEXT REFERENCES chat_messages(message_id) ON DELETE SET NULL,request_id TEXT,source_anchor TEXT,source_excerpt TEXT NOT NULL,source_hash TEXT NOT NULL);
        CREATE TABLE memory_proposals(proposal_id TEXT PRIMARY KEY,source_request_id TEXT NOT NULL,source_message_id TEXT REFERENCES chat_messages(message_id) ON DELETE SET NULL,candidate_ordinal INTEGER NOT NULL,content TEXT NOT NULL,category TEXT NOT NULL,scope TEXT NOT NULL,workspace_key TEXT,document_key TEXT,proposal_version INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,source_anchor TEXT,UNIQUE(source_request_id,candidate_ordinal));
        CREATE INDEX sessions_page ON chat_sessions(updated_at DESC,session_id DESC);
        CREATE INDEX messages_turn ON chat_messages(turn_id,attempt_no,sequence);")
        .map_err(|error| error.to_string())?;
    let mut statement = tx.prepare("SELECT session_id,document_id,document_path,workspace_root FROM chat_sessions").map_err(|e|e.to_string())?;
    let sessions = statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?)))
        .map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    drop(statement);
    for (session,id,path,workspace) in sessions {
        let key = match path.as_deref() {
            Some(path) if Path::new(path).is_file() => Some(format!("file:{}",crate::document::identity::display_path(&crate::document::identity::canonical_target(Path::new(path))?))),
            None => id.as_ref().map(|id|format!("draft:{id}")),
            _ => None,
        };
        let workspace = match workspace { Some(path) if Path::new(&path).is_dir() => Some(crate::document::identity::display_path(&crate::document::identity::canonical_target(Path::new(&path))?)), _ => None };
        tx.execute("UPDATE chat_sessions SET document_key=?1,workspace_key=?2 WHERE session_id=?3",rusqlite::params![key,workspace,session]).map_err(|e|e.to_string())?;
        if let Some(id) = id { tx.execute("UPDATE document_paths SET document_key=?1,identity_status=?2 WHERE document_id=?3",rusqlite::params![key,if key.is_some(){"resolved"}else{"unresolved"},id]).map_err(|e|e.to_string())?; }
    }
    let mut statement=tx.prepare("SELECT document_id,path FROM document_paths").map_err(|e|e.to_string())?;
    let paths=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    drop(statement);
    for (id,path) in paths {
        if Path::new(&path).is_file() {
            let key=format!("file:{}",crate::document::identity::display_path(&crate::document::identity::canonical_target(Path::new(&path))?));
            tx.execute("UPDATE document_paths SET document_key=?1,identity_status='resolved' WHERE document_id=?2",rusqlite::params![key,id]).map_err(|e|e.to_string())?;
        }
    }
    tx.execute_batch("INSERT INTO conversation_turns(turn_id,session_id,ordinal,kind,question,current_request_id,created_at)
        SELECT 'legacy:'||MIN(message_id),session_id,MIN(sequence),'Question',COALESCE(MAX(CASE WHEN role='user' THEN content END),''),request_id,MIN(timestamp)
        FROM chat_messages WHERE request_id IS NOT NULL GROUP BY session_id,request_id;
        UPDATE chat_messages SET turn_id=(SELECT turn_id FROM conversation_turns t WHERE t.session_id=chat_messages.session_id AND t.current_request_id=chat_messages.request_id) WHERE request_id IS NOT NULL;
        INSERT INTO request_attempts(request_id,turn_id,attempt_no,status,phase,started_at,finished_at)
        SELECT request_id,turn_id,1,COALESCE(MAX(CASE WHEN role='assistant' THEN completion_status END),'Completed'),'Archived',MIN(timestamp),MAX(timestamp) FROM chat_messages WHERE request_id IS NOT NULL GROUP BY request_id;")
        .map_err(|e|e.to_string())?;
    let mut statement=tx.prepare("SELECT session_id,message_id,request_id,role,content,sequence,timestamp FROM chat_messages ORDER BY session_id,sequence,timestamp,message_id").map_err(|e|e.to_string())?;
    let messages=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,u64>(5)?,r.get::<_,u64>(6)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    drop(statement);
    let mut preceding:Option<(String,String)>=None;
    for (session,message,request,role,content,sequence,timestamp) in messages {
        if request.is_some() {preceding=None;continue;}
        let turn=if role=="user" || preceding.as_ref().is_none_or(|(owner,_)|owner!=&session) {
            let id=format!("legacy:{message}");
            tx.execute("INSERT INTO conversation_turns(turn_id,session_id,ordinal,kind,question,current_request_id,created_at) VALUES(?1,?2,?3,'LegacyMessages',?4,NULL,?5)",rusqlite::params![id,session,sequence,if role=="user"{content.as_str()}else{""},timestamp]).map_err(|e|e.to_string())?;
            preceding=Some((session,id.clone()));id
        }else{preceding.as_ref().ok_or("早期消息关联缺少问题身份")?.1.clone()};
        tx.execute("UPDATE chat_messages SET turn_id=?1 WHERE message_id=?2",rusqlite::params![turn,message]).map_err(|e|e.to_string())?;
    }
    let mut statement = tx.prepare("SELECT memory_id,superseded_by FROM organic_memories").map_err(|e|e.to_string())?;
    let links = statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?.collect::<Result<std::collections::HashMap<_,_>,_>>().map_err(|e|e.to_string())?;
    drop(statement);
    let mut predecessors = std::collections::HashMap::new();
    for (id,next) in &links { if let Some(next)=next { if predecessors.insert(next.clone(),id.clone()).is_some() { return Err("记忆版本链存在多个前序版本".into()); } } }
    let mut processed=std::collections::HashSet::new();
    for root in links.keys().filter(|id|!predecessors.contains_key(*id)) {
        let mut current=root.clone(); let mut version:u64=tx.query_row("SELECT version FROM organic_memories WHERE memory_id=?1",[&root],|r|r.get(0)).map_err(|e|e.to_string())?;let mut tail_exists=true;
        if version==0 {return Err("记忆版本必须大于零".into());}
        loop {
            if !processed.insert(current.clone()) {return Err("记忆版本链存在重复身份或循环".into());}
            tx.execute("UPDATE organic_memories SET record_id=?1,version=?2 WHERE memory_id=?3",rusqlite::params![root,version,current]).map_err(|e|e.to_string())?;
            match links.get(&current).and_then(Option::as_ref) { Some(next) if links.contains_key(next)=>{current=next.clone();let existing:u64=tx.query_row("SELECT version FROM organic_memories WHERE memory_id=?1",[&current],|r|r.get(0)).map_err(|e|e.to_string())?;if existing==0 {return Err("记忆版本必须大于零".into());}version=version.checked_add(1).ok_or("记忆版本超出存储范围")?.max(existing);},Some(_)=>{tail_exists=false;break;},None=>break }
        }
        tx.execute("INSERT OR IGNORE INTO memory_records SELECT ?1,version,CASE WHEN confirmed=1 AND superseded_by IS NULL AND ?2 THEN 'active' ELSE 'inactive' END,scope,workspace_id,document_id,preference_key FROM organic_memories WHERE memory_id=?3",rusqlite::params![root,tail_exists,current]).map_err(|e|e.to_string())?;
    }
    if processed.len()!=links.len() {return Err("记忆版本链存在循环".into());}
    tx.execute_batch("UPDATE memory_records SET document_key=(SELECT document_key FROM document_paths WHERE document_id=memory_records.document_key) WHERE scope='document' AND EXISTS(SELECT 1 FROM document_paths WHERE document_id=memory_records.document_key AND document_key IS NOT NULL);
        CREATE UNIQUE INDEX memory_version ON organic_memories(record_id,version);
        INSERT INTO memory_sources SELECT 'legacy:'||memory_id,record_id,(SELECT message_id FROM chat_messages WHERE message_id=source_message_id),request_id,source_anchor,COALESCE((SELECT content FROM chat_messages WHERE message_id=source_message_id),content),COALESCE(json_extract(CASE WHEN json_valid(source_anchor) THEN source_anchor ELSE '{}' END,'$.sourceHash'),'') FROM organic_memories WHERE source_anchor IS NOT NULL OR source_message_id IS NOT NULL;
        PRAGMA user_version=5;") .map_err(|e|e.to_string())?;
    let mut statement=tx.prepare("SELECT source_id,source_excerpt FROM memory_sources").map_err(|e|e.to_string())?;
    let sources=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    drop(statement);
    for (id,excerpt) in sources {
        tx.execute("UPDATE memory_sources SET source_hash=?1 WHERE source_id=?2",rusqlite::params![format!("{:x}",Sha256::digest(excerpt.as_bytes())),id]).map_err(|e|e.to_string())?;
    }
    let mut statement=tx.prepare("SELECT record_id,workspace_key FROM memory_records WHERE workspace_key IS NOT NULL").map_err(|e|e.to_string())?;
    let owners=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    drop(statement);
    for (id,path) in owners {
        if Path::new(&path).is_dir() {
            let key=crate::document::identity::display_path(&crate::document::identity::canonical_target(Path::new(&path))?);
            tx.execute("UPDATE memory_records SET workspace_key=?1 WHERE record_id=?2",rusqlite::params![key,id]).map_err(|e|e.to_string())?;
        }
    }
    let invalid:i64=tx.query_row("SELECT COUNT(*) FROM memory_records r WHERE NOT EXISTS(SELECT 1 FROM organic_memories m WHERE m.record_id=r.record_id AND m.version=r.current_version) OR (r.status='active' AND NOT EXISTS(SELECT 1 FROM organic_memories m WHERE m.record_id=r.record_id AND m.version=r.current_version AND m.confirmed=1 AND m.superseded_by IS NULL))",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if invalid!=0 {return Err(format!("记忆迁移存在 {invalid} 个版本归属错误"));}
    let invalid:i64=tx.query_row("SELECT COUNT(*) FROM chat_messages m WHERE NOT EXISTS(SELECT 1 FROM conversation_turns t WHERE t.turn_id=m.turn_id AND t.session_id=m.session_id) OR (m.request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE a.request_id=m.request_id AND t.session_id=m.session_id))",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if invalid!=0 {return Err(format!("会话迁移存在 {invalid} 个问题或请求归属错误"));}
    Ok(())
}
