// tauri/src-tauri/src/memory/sqlite_archive.rs
//! StuartMD SQLite Chat Archive & Trigram FTS5 Memory Storage

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use rusqlite::{params, Connection, Result as SqlResult};

use super::evolution::should_evict_memory;
use super::models::{ChatArchiveMessage, ChatSession, MemorySearchHit, OrganicMemoryItem};

pub struct MemoryArchiveStorage {
    conn: Arc<Mutex<Connection>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl MemoryArchiveStorage {
    /// Opens or creates SQLite archive database and sets up schema & trigram FTS
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let p = path.as_ref();
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut conn = Connection::open(p).map_err(|e| format!("Failed to open archive DB: {}", e))?;

        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;"
        ).map_err(|e| format!("Archive PRAGMA error: {}", e))?;

        Self::init_schema(&mut conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory database for testing
    pub fn open_in_memory() -> Result<Self, String> {
        let mut conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init_schema(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &mut Connection) -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_sessions (
                session_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                workspace_root TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                anchor_file TEXT,
                anchor_line INTEGER,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_msg_session ON chat_messages(session_id);

            CREATE TABLE IF NOT EXISTS organic_memories (
                memory_id TEXT PRIMARY KEY,
                tier INTEGER NOT NULL,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                confidence REAL NOT NULL,
                created_at INTEGER NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                access_count INTEGER NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0
            );

            -- Trigram FTS for instant CJK/Latin search across past discussions
            CREATE VIRTUAL TABLE IF NOT EXISTS fts_chat_messages USING fts5(
                message_id UNINDEXED,
                content,
                tokenize = 'trigram'
            );

            CREATE TRIGGER IF NOT EXISTS trg_msg_ai AFTER INSERT ON chat_messages BEGIN
                INSERT INTO fts_chat_messages(message_id, content) VALUES (new.message_id, new.content);
            END;

            CREATE TRIGGER IF NOT EXISTS trg_msg_ad AFTER DELETE ON chat_messages BEGIN
                DELETE FROM fts_chat_messages WHERE message_id = old.message_id;
            END;

            CREATE VIRTUAL TABLE IF NOT EXISTS fts_organic_memories USING fts5(
                memory_id UNINDEXED,
                content,
                tokenize = 'trigram'
            );

            CREATE TRIGGER IF NOT EXISTS trg_mem_ai AFTER INSERT ON organic_memories BEGIN
                INSERT INTO fts_organic_memories(memory_id, content) VALUES (new.memory_id, new.content);
            END;

            CREATE TRIGGER IF NOT EXISTS trg_mem_ad AFTER DELETE ON organic_memories BEGIN
                DELETE FROM fts_organic_memories WHERE memory_id = old.memory_id;
            END;"
        ).map_err(|e| format!("Schema DDL failed: {}", e))?;

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Creates a new chat session
    pub fn create_session(&self, title: &str, workspace_root: Option<&str>) -> Result<ChatSession, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_secs();
        let session_id = format!("sess_{}", now_secs());

        conn.execute(
            "INSERT INTO chat_sessions (session_id, title, workspace_root, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, title, workspace_root, now as i64, now as i64],
        ).map_err(|e| format!("Insert session failed: {}", e))?;

        Ok(ChatSession {
            session_id,
            title: title.to_string(),
            workspace_root: workspace_root.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
            message_count: 0,
        })
    }

    /// Lists all sessions sorted by updated_at descending
    pub fn list_sessions(&self) -> Result<Vec<ChatSession>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT s.session_id, s.title, s.workspace_root, s.created_at, s.updated_at,
                    (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.session_id) as msg_count
             FROM chat_sessions s
             ORDER BY s.updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            Ok(ChatSession {
                session_id: row.get(0)?,
                title: row.get(1)?,
                workspace_root: row.get(2)?,
                created_at: row.get::<_, i64>(3)? as u64,
                updated_at: row.get::<_, i64>(4)? as u64,
                message_count: row.get::<_, i64>(5)? as usize,
            })
        }).map_err(|e| e.to_string())?
        .filter_map(SqlResult::ok)
        .collect();

        Ok(rows)
    }

    /// Deletes a session and cascades to its messages and FTS indexes
    pub fn delete_session(&self, session_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let affected = conn.execute(
            "DELETE FROM chat_sessions WHERE session_id = ?1",
            params![session_id],
        ).map_err(|e| e.to_string())?;
        Ok(affected > 0)
    }

    /// Appends a message to a session and touches updated_at
    pub fn add_message(&self, msg: ChatArchiveMessage) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_secs();

        conn.execute(
            "INSERT INTO chat_messages (message_id, session_id, role, content, timestamp, anchor_file, anchor_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                msg.message_id,
                msg.session_id,
                msg.role,
                msg.content,
                msg.timestamp as i64,
                msg.anchor_file,
                msg.anchor_line.map(|v| v as i64),
            ],
        ).map_err(|e| format!("Insert message failed: {}", e))?;

        let _ = conn.execute(
            "UPDATE chat_sessions SET updated_at = ?1 WHERE session_id = ?2",
            params![now as i64, msg.session_id],
        );

        Ok(())
    }

    /// Retrieves all messages for a session
    pub fn get_session_messages(&self, session_id: &str) -> Result<Vec<ChatArchiveMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT message_id, session_id, role, content, timestamp, anchor_file, anchor_line
             FROM chat_messages
             WHERE session_id = ?1
             ORDER BY timestamp ASC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(ChatArchiveMessage {
                message_id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get::<_, i64>(4)? as u64,
                anchor_file: row.get(5)?,
                anchor_line: row.get::<_, Option<i64>>(6)?.map(|v| v as usize),
            })
        }).map_err(|e| e.to_string())?
        .filter_map(SqlResult::ok)
        .collect();

        Ok(rows)
    }

    /// Full-Text Search across past conversation messages using trigram tokenizer
    pub fn search_messages(&self, query: &str, limit: usize) -> Result<Vec<MemorySearchHit>, String> {
        let escaped = crate::rag::escape_fts5_query(query);
        if escaped.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT m.message_id, m.role, m.content, m.timestamp, bm25(fts_chat_messages) as rank
             FROM fts_chat_messages f
             JOIN chat_messages m ON f.message_id = m.message_id
             WHERE fts_chat_messages MATCH ?1
             ORDER BY rank ASC
             LIMIT ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![escaped, limit as i64], |row| {
            let content: String = row.get(2)?;
            let snippet = crate::context::safe_unicode_take(&content, 120).to_string();
            Ok(MemorySearchHit {
                entity_id: row.get(0)?,
                entity_type: "message".to_string(),
                title_or_role: row.get(1)?,
                snippet,
                timestamp: row.get::<_, i64>(3)? as u64,
                rank_score: row.get::<_, f64>(4)? as f32,
            })
        }).map_err(|e| e.to_string())?
        .filter_map(SqlResult::ok)
        .collect();

        Ok(rows)
    }

    /// Upserts organic memory item
    pub fn upsert_organic_memory(&self, item: OrganicMemoryItem) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO organic_memories 
             (memory_id, tier, category, content, confidence, created_at, last_accessed_at, access_count, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(memory_id) DO UPDATE SET
                content = excluded.content,
                confidence = excluded.confidence,
                last_accessed_at = excluded.last_accessed_at,
                access_count = organic_memories.access_count + 1,
                pinned = excluded.pinned",
            params![
                item.memory_id,
                item.tier as i64,
                item.category,
                item.content,
                item.confidence as f64,
                item.created_at as i64,
                item.last_accessed_at as i64,
                item.access_count as i64,
                if item.pinned { 1 } else { 0 },
            ],
        ).map_err(|e| format!("Upsert organic memory failed: {}", e))?;

        Ok(())
    }

    /// Lists organic memories filtered by tier
    pub fn list_organic_memories(&self, tier_filter: Option<u8>) -> Result<Vec<OrganicMemoryItem>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let sql = if tier_filter.is_some() {
            "SELECT memory_id, tier, category, content, confidence, created_at, last_accessed_at, access_count, pinned
             FROM organic_memories WHERE tier = ?1 ORDER BY last_accessed_at DESC"
        } else {
            "SELECT memory_id, tier, category, content, confidence, created_at, last_accessed_at, access_count, pinned
             FROM organic_memories ORDER BY last_accessed_at DESC"
        };

        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = if let Some(t) = tier_filter {
            stmt.query_map(params![t as i64], Self::map_memory_row)
        } else {
            stmt.query_map([], Self::map_memory_row)
        }.map_err(|e| e.to_string())?
        .filter_map(SqlResult::ok)
        .collect();

        Ok(rows)
    }

    fn map_memory_row(row: &rusqlite::Row) -> SqlResult<OrganicMemoryItem> {
        Ok(OrganicMemoryItem {
            memory_id: row.get(0)?,
            tier: row.get::<_, i64>(1)? as u8,
            category: row.get(2)?,
            content: row.get(3)?,
            confidence: row.get::<_, f64>(4)? as f32,
            created_at: row.get::<_, i64>(5)? as u64,
            last_accessed_at: row.get::<_, i64>(6)? as u64,
            access_count: row.get::<_, i64>(7)? as u32,
            pinned: row.get::<_, i64>(8)? != 0,
        })
    }

    /// Evaluates all memories under Ebbinghaus decay curve and prunes expired ones (DEF-09)
    pub fn evolve_and_prune(&self) -> Result<usize, String> {
        let now = now_secs();
        let all_memories = self.list_organic_memories(None)?;
        let mut pruned_count = 0;

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for mem in all_memories {
            if should_evict_memory(&mem, now) {
                let _ = conn.execute(
                    "DELETE FROM organic_memories WHERE memory_id = ?1",
                    params![mem.memory_id],
                );
                pruned_count += 1;
            }
        }

        Ok(pruned_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sqlite_archive_session_and_message_crud() {
        let storage = MemoryArchiveStorage::open_in_memory().unwrap();

        let session = storage.create_session("Quantum Physics Notes", Some("/vault")).unwrap();
        assert_eq!(session.title, "Quantum Physics Notes");

        let msg = ChatArchiveMessage {
            message_id: "m_1".to_string(),
            session_id: session.session_id.clone(),
            role: "user".to_string(),
            content: "What is quantum entanglement?".to_string(),
            timestamp: now_secs(),
            anchor_file: Some("notes.md".to_string()),
            anchor_line: Some(42),
        };
        storage.add_message(msg).unwrap();

        let messages = storage.get_session_messages(&session.session_id).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].anchor_line, Some(42));

        // Test trigram search
        let hits = storage.search_messages("entanglement", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity_id, "m_1");
    }

    #[test]
    fn test_organic_memory_upsert_and_fts() {
        let storage = MemoryArchiveStorage::open_in_memory().unwrap();

        let mem = OrganicMemoryItem {
            memory_id: "om_1".to_string(),
            tier: 1,
            category: "concept".to_string(),
            content: "注意力机制的核心是 Query, Key, Value 矩阵投影".to_string(),
            confidence: 0.9,
            created_at: now_secs(),
            last_accessed_at: now_secs(),
            access_count: 1,
            pinned: false,
        };
        storage.upsert_organic_memory(mem).unwrap();

        let memories = storage.list_organic_memories(Some(1)).unwrap();
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].category, "concept");
    }
}
