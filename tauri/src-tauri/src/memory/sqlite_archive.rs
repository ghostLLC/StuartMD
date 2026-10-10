use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use pulldown_cmark::{Event, Options, Parser, TagEnd};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use super::{evolution::should_evict_memory, migrations, models::*};

pub struct MemoryArchiveStorage { conn: Arc<Mutex<Connection>> }

pub fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("系统时间早于 Unix 时间").as_millis() as u64
}

const MEMORY_COLUMNS: &str = "memory_id,tier,category,content,confidence,created_at,last_accessed_at,access_count,pinned,scope,workspace_id,document_id,preference_key,version,source_message_id,source_anchor,confirmed,superseded_by,request_id";

impl MemoryArchiveStorage {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        let mut conn = Connection::open(path).map_err(|e| format!("会话数据库打开失败：{e}"))?;
        conn.execute_batch("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        migrations::migrate(&mut conn, Some(path))?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    pub fn create_session(&self, title: &str, workspace_root: Option<&str>) -> Result<ChatSession, String> {
        self.create_document_session(title, workspace_root, None, None)
    }

    pub fn create_document_session(&self, title: &str, workspace_root: Option<&str>, document_id: Option<&str>, document_path: Option<&str>) -> Result<ChatSession, String> {
        let session_id = Uuid::new_v4().to_string();
        let now = now_millis();
        self.conn.lock().map_err(|e| e.to_string())?.execute(
            "INSERT INTO chat_sessions(session_id,title,workspace_root,created_at,updated_at,document_id,document_path) VALUES(?1,?2,?3,?4,?4,?5,?6)",
            params![session_id,title,workspace_root,now as i64,document_id,document_path]).map_err(|e| e.to_string())?;
        Ok(ChatSession { session_id, title: title.into(), workspace_root: workspace_root.map(str::to_owned),
            created_at: now, updated_at: now, message_count: 0, document_id: document_id.map(str::to_owned),
            document_path: document_path.map(str::to_owned) })
    }

    pub fn list_sessions(&self) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare(
            "SELECT s.session_id,s.title,s.workspace_root,s.created_at,s.updated_at,(SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.session_id),s.document_id,s.document_path FROM chat_sessions s ORDER BY s.updated_at DESC,s.rowid DESC")
            .map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| Ok(ChatSession { session_id: row.get(0)?, title: row.get(1)?,
            workspace_root: row.get(2)?, created_at: row.get(3)?, updated_at: row.get(4)?, message_count: row.get(5)?,
            document_id: row.get(6)?, document_path: row.get(7)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn delete_session(&self, id: &str) -> Result<bool, String> {
        Ok(self.conn.lock().map_err(|e| e.to_string())?.execute("DELETE FROM chat_sessions WHERE session_id=?1", [id]).map_err(|e| e.to_string())? > 0)
    }

    pub fn get_session(&self, id: &str) -> Result<ChatSession, String> {
        self.list_sessions()?.into_iter().find(|session| session.session_id == id).ok_or("会话不存在".into())
    }

    pub fn rebind_session(&self, id: &str, document: &crate::document::DocumentContextSnapshot) -> Result<ChatSession, String> {
        let session = self.get_session(id)?;
        match (&session.document_path, &document.path) {
            (Some(previous), Some(current)) => {
                if crate::document::identity::canonical_target(Path::new(previous))? != crate::document::identity::canonical_target(Path::new(current))? {
                    return Err("会话所属文档与当前文档路径不同".into());
                }
            }
            (None, None) if session.document_id.as_deref() == Some(&document.document_id) => {}
            _ => return Err("未保存文档的会话需要恢复对应草稿".into()),
        }
        self.conn.lock().map_err(|error| error.to_string())?.execute("UPDATE chat_sessions SET document_id=?1,document_path=?2 WHERE session_id=?3", params![document.document_id,document.path,id]).map_err(|error|error.to_string())?;
        self.get_session(id)
    }

    pub fn update_document_path(&self, document_id: &str, path: &str) -> Result<(), String> {
        let canonical = crate::document::identity::canonical_target(Path::new(path))?;
        let path = crate::document::identity::display_path(&canonical);
        let mut conn = self.conn.lock().map_err(|error|error.to_string())?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
        tx.execute("INSERT INTO document_paths(document_id,path) VALUES(?1,?2) ON CONFLICT(document_id) DO UPDATE SET path=excluded.path",params![document_id,path]).map_err(|error|error.to_string())?;
        tx.execute("UPDATE chat_sessions SET document_path=?1 WHERE document_id=?2",params![path,document_id]).map_err(|error|error.to_string())?;
        tx.commit().map_err(|error|error.to_string())?;
        Ok(())
    }

    pub fn record_context(&self, request_id: &str, session_id: &str, record: &serde_json::Value) -> Result<(), String> {
        self.conn.lock().map_err(|error|error.to_string())?.execute("INSERT INTO context_records(request_id,session_id,record_json,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(request_id) DO UPDATE SET record_json=excluded.record_json",params![request_id,session_id,serde_json::to_string(record).map_err(|error|error.to_string())?,now_millis() as i64]).map_err(|error|error.to_string())?;
        Ok(())
    }

    pub fn record_summary(&self, session_id: &str, model_spec_id: &str, summary: &crate::context::compressor::StructuredSummary, sources: &[ChatArchiveMessage]) -> Result<(), String> {
        self.conn.lock().map_err(|error|error.to_string())?.execute("INSERT INTO context_summaries(summary_id,session_id,model_spec_id,summary_json,source_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![Uuid::new_v4().to_string(),session_id,model_spec_id,serde_json::to_string(summary).map_err(|error|error.to_string())?,serde_json::to_string(sources).map_err(|error|error.to_string())?,now_millis() as i64]).map_err(|error|error.to_string())?;
        Ok(())
    }

    pub fn add_message(&self, mut msg: ChatArchiveMessage) -> Result<(), String> {
        if !["user","assistant","system"].contains(&msg.role.as_str()) { return Err("消息角色无效".into()); }
        if !["Completed","Cancelled","Failed"].contains(&msg.completion_status.as_str()) { return Err("消息完成状态无效".into()); }
        if msg.message_id.is_empty() { msg.message_id = Uuid::new_v4().to_string(); }
        if msg.timestamp == 0 { msg.timestamp = now_millis(); }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        if let Some(request_id) = &msg.request_id {
            let previous: Option<(String,String,String)> = tx.query_row(
                "SELECT session_id,content,completion_status FROM chat_messages WHERE request_id=?1 AND role=?2",
                params![request_id,msg.role], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|e| e.to_string())?;
            if let Some(previous) = previous {
                if previous != (msg.session_id.clone(),msg.content.clone(),msg.completion_status.clone()) {
                    return Err("重复请求消息内容或完成状态冲突".into());
                }
                return Ok(());
            }
        }
        let sequence: i64 = tx.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM chat_messages WHERE session_id=?1", [&msg.session_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO chat_messages(message_id,session_id,role,content,timestamp,anchor_file,anchor_line,request_id,document_id,completion_status,source_hash,source_anchor,sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![msg.message_id,msg.session_id,msg.role,msg.content,msg.timestamp as i64,msg.anchor_file,msg.anchor_line.map(|v| v as i64),msg.request_id,msg.document_id,msg.completion_status,msg.source_hash,msg.source_anchor.map(|v| v.to_string()),sequence]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE chat_sessions SET updated_at=?1 WHERE session_id=?2", params![now_millis() as i64,msg.session_id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn get_session_messages(&self, id: &str) -> Result<Vec<ChatArchiveMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare("SELECT message_id,session_id,role,content,timestamp,anchor_file,anchor_line,request_id,document_id,completion_status,source_hash,source_anchor,sequence FROM chat_messages WHERE session_id=?1 ORDER BY sequence,timestamp,message_id").map_err(|e| e.to_string())?;
        let rows = statement.query_map([id], |row| {
            Ok(ChatArchiveMessage { message_id: row.get(0)?,session_id: row.get(1)?,role: row.get(2)?,content: row.get(3)?,timestamp: row.get(4)?,anchor_file: row.get(5)?,anchor_line: row.get(6)?,request_id: row.get(7)?,document_id: row.get(8)?,completion_status: row.get(9)?,source_hash: row.get(10)?,source_anchor: json_column(row,11)?,sequence: row.get(12)? })
        }).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_completed_messages(&self, id: &str) -> Result<Vec<ChatArchiveMessage>, String> {
        let messages = self.get_session_messages(id)?;
        let completed: std::collections::HashSet<_> = messages.iter().filter(|message|message.role=="assistant" && message.completion_status=="Completed").filter_map(|message|message.request_id.as_deref()).map(str::to_owned).collect();
        Ok(messages.into_iter().filter(|message| message.completion_status == "Completed" && message.request_id.as_ref().is_none_or(|id|completed.contains(id))).collect())
    }

    pub fn search_messages(&self, query: &str, limit: usize) -> Result<Vec<MemorySearchHit>, String> {
        let escaped = crate::rag::escape_fts5_query(query);
        if escaped.is_empty() { return Ok(Vec::new()); }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare("SELECT m.message_id,m.role,m.content,m.timestamp,bm25(fts_chat_messages) FROM fts_chat_messages f JOIN chat_messages m ON m.message_id=f.message_id WHERE fts_chat_messages MATCH ?1 ORDER BY bm25(fts_chat_messages),m.timestamp DESC LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![escaped,limit.min(1000) as i64], |row| Ok(MemorySearchHit { entity_id: row.get(0)?,entity_type:"message".into(),title_or_role:row.get(1)?,snippet:row.get(2)?,timestamp:row.get(3)?,rank_score:row.get(4)? })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn upsert_organic_memory(&self, mut item: OrganicMemoryItem) -> Result<(), String> {
        if item.memory_id.is_empty() { item.memory_id = Uuid::new_v4().to_string(); }
        if item.scope.is_empty() { item.scope = match item.tier { 1 => "workspace", 2 => "document", _ => "global" }.into(); }
        if !["global","workspace","document"].contains(&item.scope.as_str()) { return Err("记忆作用范围无效".into()); }
        if item.scope == "workspace" && item.workspace_id.is_none() { return Err("工作区记忆缺少工作区编号".into()); }
        if item.scope == "document" && item.document_id.is_none() { return Err("文档记忆缺少文档编号".into()); }
        if !item.confidence.is_finite() || !(0.0..=1.0).contains(&item.confidence) { return Err("记忆置信度无效".into()); }
        if item.created_at == 0 { item.created_at = now_millis(); }
        if item.last_accessed_at == 0 { item.last_accessed_at = now_millis(); }
        if item.version == 0 { item.version = 1; }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        if let (Some(request),Some(key)) = (&item.request_id,&item.preference_key) {
            let previous = tx.query_row(&format!("SELECT {MEMORY_COLUMNS} FROM organic_memories WHERE request_id=?1 AND preference_key=?2"),params![request,key],map_memory_row).optional().map_err(|e| e.to_string())?;
            if let Some(previous) = previous {
                if previous.content != item.content || previous.scope != item.scope || previous.workspace_id != item.workspace_id
                    || previous.document_id != item.document_id || previous.category != item.category || previous.tier != item.tier
                    || previous.source_message_id != item.source_message_id || previous.source_anchor != item.source_anchor {
                    return Err("重复请求记忆正文、作用范围或来源冲突".into());
                }
                if previous.memory_id != item.memory_id { return Ok(()); }
            }
        }
        let sql = format!("INSERT INTO organic_memories({MEMORY_COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19) ON CONFLICT(memory_id) DO UPDATE SET tier=excluded.tier,category=excluded.category,content=excluded.content,confidence=excluded.confidence,last_accessed_at=excluded.last_accessed_at,access_count=excluded.access_count,pinned=excluded.pinned,scope=excluded.scope,workspace_id=excluded.workspace_id,document_id=excluded.document_id,preference_key=excluded.preference_key,version=excluded.version,source_message_id=excluded.source_message_id,source_anchor=excluded.source_anchor,confirmed=excluded.confirmed,superseded_by=excluded.superseded_by,request_id=excluded.request_id");
        tx.execute(&sql,params![item.memory_id,item.tier,item.category,item.content,item.confidence,item.created_at as i64,item.last_accessed_at as i64,item.access_count,item.pinned,item.scope,item.workspace_id,item.document_id,item.preference_key,item.version as i64,item.source_message_id,item.source_anchor.map(|v| v.to_string()),item.confirmed,item.superseded_by,item.request_id]).map_err(|e| e.to_string())?;
        if item.confirmed {
            if let Some(key) = &item.preference_key {
                tx.execute("UPDATE organic_memories SET superseded_by=?1 WHERE preference_key=?2 AND scope=?3 AND workspace_id IS ?4 AND document_id IS ?5 AND confirmed=1 AND (version<?6 OR (version=?6 AND rowid<(SELECT rowid FROM organic_memories WHERE memory_id=?1))) AND memory_id<>?1",
                    params![item.memory_id,key,item.scope,item.workspace_id,item.document_id,item.version as i64]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn list_organic_memories(&self, tier: Option<u8>) -> Result<Vec<OrganicMemoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM organic_memories WHERE (?1 IS NULL OR tier=?1) ORDER BY pinned DESC,last_accessed_at DESC,version DESC,memory_id")).map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![tier],map_memory_row).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn effective_memories(&self, workspace: Option<&str>, document: Option<&str>) -> Result<Vec<OrganicMemoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM organic_memories m WHERE confirmed=1 AND superseded_by IS NULL AND (scope='global' OR (scope='workspace' AND workspace_id=?1) OR (scope='document' AND document_id=?2 AND (workspace_id IS NULL OR workspace_id=?1))) AND (preference_key IS NULL OR NOT EXISTS(SELECT 1 FROM organic_memories n WHERE n.confirmed=1 AND n.superseded_by IS NULL AND n.preference_key=m.preference_key AND n.scope=m.scope AND n.workspace_id IS m.workspace_id AND n.document_id IS m.document_id AND (n.version>m.version OR (n.version=m.version AND n.rowid>m.rowid)))) ORDER BY pinned DESC,last_accessed_at DESC,version DESC,memory_id")).map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![workspace,document],map_memory_row).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn effective_document_memories(&self, workspace: Option<&str>, document_id: &str, path: Option<&str>) -> Result<Vec<OrganicMemoryItem>, String> {
        let mut document_ids = std::collections::HashSet::from([document_id.to_owned()]);
        if let Some(path) = path {
            let canonical = crate::document::identity::canonical_target(Path::new(path))?;
            let conn = self.conn.lock().map_err(|error|error.to_string())?;
            let mut statement = conn.prepare("SELECT document_id,path FROM document_paths").map_err(|error|error.to_string())?;
            let aliases = statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|error|error.to_string())?;
            for alias in aliases {
                let (id, stored_path) = alias.map_err(|error|error.to_string())?;
                if !Path::new(&stored_path).is_file() { continue; }
                if crate::document::identity::canonical_target(Path::new(&stored_path))? == canonical { document_ids.insert(id); }
            }
        }
        let scope_matches = |stored: Option<&str>, current: Option<&str>| -> Result<bool,String> {
            match (stored,current) {
                (Some(stored),Some(current)) if Path::new(stored).is_absolute() && Path::new(current).is_absolute() => {
                    if !Path::new(stored).is_dir() { return Ok(false); }
                    Ok(crate::document::identity::canonical_target(Path::new(stored))? == crate::document::identity::canonical_target(Path::new(current))?)
                }
                _ => Ok(stored == current),
            }
        };
        let mut selected = Vec::new();
        for item in self.list_organic_memories(None)? {
            if !item.confirmed || item.superseded_by.is_some() { continue; }
            let applicable = match item.scope.as_str() {
                "global" => true,
                "workspace" => workspace.is_some() && scope_matches(item.workspace_id.as_deref(),workspace)?,
                "document" => item.document_id.as_ref().is_some_and(|id|document_ids.contains(id)) && (item.workspace_id.is_none() || scope_matches(item.workspace_id.as_deref(),workspace)?),
                _ => return Err("记忆作用范围无效".into()),
            };
            if applicable { selected.push(item); }
        }
        selected.sort_by(|left,right|right.version.cmp(&left.version).then(right.created_at.cmp(&left.created_at)).then(right.memory_id.cmp(&left.memory_id)));
        let mut preferences = std::collections::HashSet::new();
        selected.retain(|item|item.preference_key.as_ref().is_none_or(|key|preferences.insert((item.scope.clone(),key.clone()))));
        selected.sort_by(|left,right|right.pinned.cmp(&left.pinned).then(right.last_accessed_at.cmp(&left.last_accessed_at)));
        Ok(selected)
    }

    pub fn search_memories(&self, query: &str, limit: usize) -> Result<Vec<OrganicMemoryItem>, String> {
        let escaped = crate::rag::escape_fts5_query(query);
        if escaped.is_empty() { return Ok(Vec::new()); }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM organic_memories WHERE memory_id IN(SELECT memory_id FROM fts_organic_memories WHERE fts_organic_memories MATCH ?1 ORDER BY bm25(fts_organic_memories) LIMIT ?2) ORDER BY pinned DESC,last_accessed_at DESC")).map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![escaped,limit.min(1000) as i64],map_memory_row).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn delete_memory(&self, id: &str) -> Result<bool, String> {
        Ok(self.conn.lock().map_err(|e| e.to_string())?.execute("DELETE FROM organic_memories WHERE memory_id=?1",[id]).map_err(|e| e.to_string())? > 0)
    }

    pub fn import_legacy_markdown(&self, path: &Path) -> Result<usize, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let fingerprint = format!("{:x}",Sha256::digest(raw.as_bytes()));
        let exists: bool = self.conn.lock().map_err(|e| e.to_string())?.query_row("SELECT EXISTS(SELECT 1 FROM legacy_memory_imports WHERE fingerprint=?1)",[&fingerprint],|row| row.get(0)).map_err(|e| e.to_string())?;
        if exists { return Ok(0); }
        let mut paragraphs = Vec::new();
        let mut paragraph = String::new();
        for event in Parser::new_ext(&raw, Options::all()) {
            match event {
                Event::Text(text) | Event::Code(text) => paragraph.push_str(&text),
                Event::SoftBreak | Event::HardBreak => paragraph.push('\n'),
                Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Heading(_)) | Event::End(TagEnd::Item) | Event::End(TagEnd::CodeBlock) => {
                    if !paragraph.trim().is_empty() { paragraphs.push(std::mem::take(&mut paragraph)); }
                }
                _ => {}
            }
        }
        if !paragraph.trim().is_empty() { paragraphs.push(paragraph); }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let inserted = tx.execute("INSERT INTO legacy_memory_imports(fingerprint,source_path,original_content,imported_at) VALUES(?1,?2,?3,?4) ON CONFLICT(fingerprint) DO NOTHING",params![fingerprint,path.to_string_lossy(),raw,now_millis() as i64]).map_err(|e| e.to_string())?;
        if inserted == 0 { return Ok(0); }
        for (index, content) in paragraphs.iter().enumerate() {
            let anchor = serde_json::json!({"path":path,"sha256":fingerprint,"paragraph":index});
            tx.execute("INSERT INTO organic_memories(memory_id,tier,category,content,confidence,created_at,last_accessed_at,access_count,pinned,scope,version,source_anchor,confirmed) VALUES(?1,3,'legacy',?2,0.5,?3,?3,0,0,'global',1,?4,0)",params![Uuid::new_v4().to_string(),content,now_millis() as i64,anchor.to_string()]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(paragraphs.len())
    }

    pub fn evolve_and_prune(&self) -> Result<usize, String> {
        let memories = self.list_organic_memories(None)?;
        let mut removed = 0;
        for memory in memories {
            if !memory.confirmed && memory.category != "legacy" && should_evict_memory(&memory,now_millis()) {
                removed += usize::from(self.delete_memory(&memory.memory_id)?);
            }
        }
        Ok(removed)
    }
}

fn json_column(row: &rusqlite::Row, index: usize) -> rusqlite::Result<Option<serde_json::Value>> {
    row.get::<_,Option<String>>(index)?.map(|value| serde_json::from_str(&value).map_err(|e| rusqlite::Error::FromSqlConversionFailure(index,rusqlite::types::Type::Text,Box::new(e)))).transpose()
}

fn map_memory_row(row: &rusqlite::Row) -> rusqlite::Result<OrganicMemoryItem> {
    Ok(OrganicMemoryItem { memory_id:row.get(0)?,tier:row.get(1)?,category:row.get(2)?,content:row.get(3)?,confidence:row.get(4)?,created_at:row.get(5)?,last_accessed_at:row.get(6)?,access_count:row.get(7)?,pinned:row.get(8)?,scope:row.get(9)?,workspace_id:row.get(10)?,document_id:row.get(11)?,preference_key:row.get(12)?,version:row.get(13)?,source_message_id:row.get(14)?,source_anchor:json_column(row,15)?,confirmed:row.get(16)?,superseded_by:row.get(17)?,request_id:row.get(18)? })
}
