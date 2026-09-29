// tauri/src-tauri/src/rag/storage.rs
//! StuartMD RAG Storage Subsystem
//! Dedicated Writer + r2d2 Reader Pool (DEF-CONC-01), SQLite WAL mode,
//! dynamic vec0 virtual table dimension, cascade delete triggers,
//! and Windows handle drop auto-healing (DEF-CONC-07).

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use log::{error, info, warn};
use r2d2::Pool;
use rusqlite::{params, Connection, Result as SqlResult, Error as SqlError};

use super::config::{
    ChunkInsertPayload, ChunkQueryResult, DocumentRecord, StorageConfig, VaultMeta,
};

/// Vector KNN search hit
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VectorHit {
    pub chunk_id: String,
    pub distance: f32, // Cosine distance [0.0, 2.0], 0.0 is identical
}

/// FTS5 BM25 search hit
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FtsHit {
    pub chunk_id: String,
    pub rank: usize, // 1-based ranking position
    pub score: f64,  // FTS5 BM25 score (negative value, more negative = more relevant)
}

/// Custom r2d2 connection manager for SQLite reader pool
#[derive(Debug)]
pub struct SqliteConnectionManager {
    path: PathBuf,
    busy_timeout_ms: u64,
    cache_size: i64,
}

impl SqliteConnectionManager {
    pub fn new<P: Into<PathBuf>>(path: P, busy_timeout_ms: u64, cache_size: i64) -> Self {
        Self {
            path: path.into(),
            busy_timeout_ms,
            cache_size,
        }
    }
}

impl r2d2::ManageConnection for SqliteConnectionManager {
    type Connection = Connection;
    type Error = SqlError;

    fn connect(&self) -> Result<Self::Connection, Self::Error> {
        let conn = Connection::open(&self.path)?;

        // Configure connection PRAGMAs for read-only pool (DEF-CONC-01 & DEF-CONC-02)
        let pragma_sql = format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = {};
             PRAGMA query_only = ON;
             PRAGMA cache_size = {};",
            self.busy_timeout_ms, self.cache_size
        );
        conn.execute_batch(&pragma_sql)?;
        Ok(conn)
    }

    fn is_valid(&self, conn: &mut Self::Connection) -> Result<(), Self::Error> {
        conn.execute_batch("SELECT 1;")
    }

    fn has_broken(&self, _conn: &mut Self::Connection) -> bool {
        false
    }
}

/// Core RAG storage handle implementing Dedicated Writer + r2d2 Reader Pool (DEF-CONC-01)
pub struct RagStorage {
    writer: Arc<Mutex<Connection>>,
    reader_pool: Pool<SqliteConnectionManager>,
    config: StorageConfig,
}

impl RagStorage {
    /// Open or create the RAG storage database with crash auto-healing
    pub fn open(config: StorageConfig) -> Result<Self, String> {
        // Register sqlite-vec auto-extension once globally
        static VEC_INIT: std::sync::Once = std::sync::Once::new();
        VEC_INIT.call_once(|| {
            unsafe {
                rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                    sqlite_vec::sqlite3_vec_init as *const ()
                )));
            }
        });

        // Ensure parent directory exists
        if let Some(parent) = config.db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create storage dir: {}", e))?;
        }

        // Perform health check and attempt open
        match Self::try_open(&config) {
            Ok(storage) => Ok(storage),
            Err(e) => {
                warn!("[RagStorage] Database open failed or corrupt: {}. Initiating auto-heal...", e);
                Self::heal_and_reopen(&config)
            }
        }
    }

    /// Internal attempt to open writer connection, check schema integrity, and initialize pool
    fn try_open(config: &StorageConfig) -> Result<Self, String> {
        let mut writer_conn = Connection::open(&config.db_path)
            .map_err(|e| format!("Connection::open error: {}", e))?;

        // Execute mandatory WAL and timeout PRAGMAs (DEF-CONC-02)
        let pragma_sql = format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = {};
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA cache_size = {};
             PRAGMA mmap_size = {};",
            config.busy_timeout_ms, config.cache_size, config.mmap_size
        );
        writer_conn
            .execute_batch(&pragma_sql)
            .map_err(|e| format!("PRAGMA init error: {}", e))?;

        // Integrity check
        let integrity_check: String = writer_conn
            .query_row("PRAGMA quick_check(1);", [], |row| row.get(0))
            .map_err(|e| format!("Quick check query failed: {}", e))?;
        if integrity_check != "ok" {
            return Err(format!("SQLite quick_check failed: {}", integrity_check));
        }

        // Initialize DDL schema
        Self::init_schema(&mut writer_conn, config)?;

        // Initialize reader connection pool (DEF-CONC-01)
        let manager = SqliteConnectionManager::new(
            &config.db_path,
            config.busy_timeout_ms,
            config.cache_size,
        );
        let reader_pool = Pool::builder()
            .max_size(config.reader_pool_size)
            .connection_timeout(Duration::from_millis(config.busy_timeout_ms))
            .build(manager)
            .map_err(|e| format!("Failed to create r2d2 reader pool: {}", e))?;

        Ok(Self {
            writer: Arc::new(Mutex::new(writer_conn)),
            reader_pool,
            config: config.clone(),
        })
    }

    /// Initialize full DDL: relational, trigram FTS5, dynamic vec0, and cascade triggers
    fn init_schema(conn: &mut Connection, config: &StorageConfig) -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| format!("Transaction error: {}", e))?;

        // 1. Metadata table
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS rag_vault_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).map_err(|e| format!("Create rag_vault_meta error: {}", e))?;

        // Read or insert embedding_dim & model_id
        let mut meta_dim: Option<usize> = None;
        {
            let mut stmt = tx.prepare("SELECT value FROM rag_vault_meta WHERE key = 'embedding_dim'")
                .map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let val_str: String = row.get(0).map_err(|e| e.to_string())?;
                meta_dim = val_str.parse().ok();
            }
        }

        if let Some(existing_dim) = meta_dim {
            if existing_dim != config.embedding_dim {
                warn!(
                    "[RagStorage] Vault dimension mismatch: existing={}, requested={}",
                    existing_dim, config.embedding_dim
                );
            }
        } else {
            tx.execute(
                "INSERT OR REPLACE INTO rag_vault_meta VALUES ('model_id', ?1)",
                params![&config.model_id],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO rag_vault_meta VALUES ('embedding_dim', ?1)",
                params![config.embedding_dim.to_string()],
            ).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO rag_vault_meta VALUES ('schema_version', '1')",
                [],
            ).map_err(|e| e.to_string())?;
        }

        // 2. Document & Chunks Relational Tables + Trigram FTS5 + Triggers
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS rag_documents (
                doc_id TEXT PRIMARY KEY,
                rel_path TEXT UNIQUE NOT NULL,
                file_format TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_mtime INTEGER NOT NULL,
                indexed_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rag_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                heading_path TEXT NOT NULL,
                start_line INTEGER,
                end_line INTEGER,
                page_number INTEGER,
                bounding_box TEXT,
                char_offset INTEGER NOT NULL,
                char_length INTEGER NOT NULL,
                content TEXT NOT NULL,
                token_count INTEGER NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES rag_documents(doc_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
            CREATE INDEX IF NOT EXISTS idx_rag_chunks_heading ON rag_chunks(heading_path);

            -- FTS5 Full-Text Virtual Table with native trigram tokenizer
            CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                heading_path,
                content,
                tokenize = 'trigram'
            );

            -- Automatic synchronization triggers
            CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
                INSERT INTO rag_chunks_fts(chunk_id, heading_path, content)
                VALUES (new.chunk_id, new.heading_path, new.content);
            END;

            CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
                DELETE FROM rag_chunks_fts WHERE chunk_id = old.chunk_id;
            END;"
        ).map_err(|e| format!("Create relational and FTS tables error: {}", e))?;

        // 3. Dynamic sqlite-vec virtual table
        let vec_ddl = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
                chunk_id text,
                embedding float[{}] distance_metric=cosine
            );
            CREATE VIEW IF NOT EXISTS rag_chunks_vec AS SELECT chunk_id, embedding FROM vec_chunks;",
            config.embedding_dim
        );
        tx.execute_batch(&vec_ddl).map_err(|e| format!("Create vec_chunks error: {}", e))?;

        tx.commit().map_err(|e| format!("Schema commit error: {}", e))?;
        Ok(())
    }

    /// Windows-safe crash auto-heal: drop handles, isolate files, recreate fresh DB (DEF-CONC-07)
    fn heal_and_reopen(config: &StorageConfig) -> Result<Self, String> {
        let db_path = &config.db_path;

        // Ensure handles are completely dropped in current process
        std::thread::sleep(Duration::from_millis(30));

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // 1. Rename corrupted database
        if db_path.exists() {
            let corrupt_db = db_path.with_extension(format!("db.corrupt.{}", timestamp));
            if let Err(e) = std::fs::rename(db_path, &corrupt_db) {
                error!("[RagStorage] Failed to rename corrupt database: {}", e);
                return Err(format!("Auto-heal failed to isolate database file: {}", e));
            }
            info!("[RagStorage] Moved corrupt database to {:?}", corrupt_db);
        }

        // 2. Rename or purge WAL / SHM
        let wal_path = db_path.with_extension("db-wal");
        if wal_path.exists() {
            let corrupt_wal = db_path.with_extension(format!("db-wal.corrupt.{}", timestamp));
            let _ = std::fs::rename(&wal_path, &corrupt_wal);
        }
        let shm_path = db_path.with_extension("db-shm");
        if shm_path.exists() {
            let _ = std::fs::remove_file(&shm_path);
        }

        // 3. Retry opening clean database
        Self::try_open(config)
    }

    /// Check out an independent read connection from the pool (P95 < 15ms SLA, DEF-CONC-01)
    pub fn get_reader(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>, String> {
        self.reader_pool.get().map_err(|e| format!("Reader pool error: {}", e))
    }

    /// Execute atomic batch insertion of a document and its chunks
    pub fn insert_document_batch(
        &self,
        doc: DocumentRecord,
        chunks: Vec<ChunkInsertPayload>,
    ) -> Result<(), String> {
        let mut conn = self.writer.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 1. Insert or replace document record
        tx.execute(
            "INSERT OR REPLACE INTO rag_documents 
             (doc_id, rel_path, file_format, content_hash, file_size, file_mtime, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                doc.doc_id,
                doc.rel_path,
                doc.file_format,
                doc.content_hash,
                doc.file_size as i64,
                doc.file_mtime,
                doc.indexed_at
            ],
        ).map_err(|e| format!("Insert document error: {}", e))?;

        // 2. Clear previous chunks and vectors for this document
        tx.execute(
            "DELETE FROM vec_chunks WHERE chunk_id IN (SELECT chunk_id FROM rag_chunks WHERE doc_id = ?1)",
            params![doc.doc_id],
        ).map_err(|e| format!("Delete old vectors error: {}", e))?;

        tx.execute(
            "DELETE FROM rag_chunks WHERE doc_id = ?1",
            params![doc.doc_id],
        ).map_err(|e| format!("Delete old chunks error: {}", e))?;

        // 3. Insert chunks and vectors
        for chunk in chunks {
            tx.execute(
                "INSERT INTO rag_chunks 
                 (chunk_id, doc_id, chunk_index, heading_path, start_line, end_line,
                  page_number, bounding_box, char_offset, char_length, content, token_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    chunk.chunk_id,
                    chunk.doc_id,
                    chunk.chunk_index as i64,
                    chunk.heading_path,
                    chunk.start_line.map(|v| v as i64),
                    chunk.end_line.map(|v| v as i64),
                    chunk.page_number.map(|v| v as i64),
                    chunk.bounding_box,
                    chunk.char_offset as i64,
                    chunk.char_length as i64,
                    chunk.content,
                    chunk.token_count as i64,
                ],
            ).map_err(|e| format!("Insert chunk error: {}", e))?;

            // If embedding vector is provided, serialize as little-endian float bytes (D * 4 bytes)
            if let Some(ref emb) = chunk.embedding {
                let vector_bytes: Vec<u8> = emb.iter().flat_map(|v| v.to_le_bytes()).collect();
                tx.execute(
                    "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?1, ?2)",
                    params![chunk.chunk_id, vector_bytes],
                ).map_err(|e| format!("Insert vector error: {}", e))?;
            }
        }

        tx.commit().map_err(|e| format!("Batch commit error: {}", e))?;
        Ok(())
    }

    /// Delete document and cascade delete all chunks, FTS entries, and vectors
    pub fn delete_document(&self, rel_path: &str) -> Result<bool, String> {
        let mut conn = self.writer.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // Remove vector entries
        tx.execute(
            "DELETE FROM vec_chunks WHERE chunk_id IN (
                SELECT c.chunk_id FROM rag_chunks c
                JOIN rag_documents d ON c.doc_id = d.doc_id
                WHERE d.rel_path = ?1
            )",
            params![rel_path],
        ).map_err(|e| format!("Delete vectors error: {}", e))?;

        // Delete document (cascades to rag_chunks and triggers rag_chunks_fts deletion)
        let rows_affected = tx.execute(
            "DELETE FROM rag_documents WHERE rel_path = ?1",
            params![rel_path],
        ).map_err(|e| format!("Delete document error: {}", e))?;

        tx.commit().map_err(|e| format!("Delete commit error: {}", e))?;
        Ok(rows_affected > 0)
    }

    /// Perform Vector KNN cosine search via reader pool
    pub fn search_knn(&self, query_vector: &[f32], top_k: usize) -> Result<Vec<VectorHit>, String> {
        let conn = self.get_reader()?;
        self.search_vector_knn(&conn, query_vector, top_k)
    }

    /// Perform Vector KNN cosine search with a specific connection
    pub fn search_vector_knn(
        &self,
        conn: &Connection,
        query_vector: &[f32],
        top_k: usize,
    ) -> Result<Vec<VectorHit>, String> {
        let vector_bytes: Vec<u8> = query_vector.iter().flat_map(|v| v.to_le_bytes()).collect();

        let mut stmt = conn.prepare(
            "SELECT chunk_id, distance
             FROM vec_chunks
             WHERE embedding MATCH ?1 AND k = ?2
             ORDER BY distance ASC",
        ).map_err(|e| format!("Prepare KNN error: {}", e))?;

        let hits = stmt.query_map(params![vector_bytes, top_k as i64], |row| {
            Ok(VectorHit {
                chunk_id: row.get(0)?,
                distance: row.get(1)?,
            })
        }).map_err(|e| format!("Query KNN error: {}", e))?
        .filter_map(SqlResult::ok)
        .collect();

        Ok(hits)
    }

    /// Perform Full-Text BM25 search with trigram tokenizer via reader pool
    pub fn search_bm25(&self, raw_query: &str, limit: usize) -> Result<Vec<FtsHit>, String> {
        let conn = self.get_reader()?;
        let hits = super::fts::search_fts5_bm25(&conn, raw_query, limit)
            .map_err(|e| format!("BM25 query error: {}", e))?;

        Ok(hits
            .into_iter()
            .map(|(chunk_id, rank, score)| FtsHit {
                chunk_id,
                rank,
                score,
            })
            .collect())
    }

    /// Fetch full chunk details by chunk IDs via reader pool
    pub fn get_chunks_by_ids(&self, chunk_ids: &[String]) -> Result<Vec<ChunkQueryResult>, String> {
        if chunk_ids.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.get_reader()?;
        let placeholders = chunk_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT c.chunk_id, c.doc_id, d.rel_path, c.chunk_index, c.heading_path,
                    c.start_line, c.end_line, c.page_number, c.bounding_box,
                    c.char_offset, c.char_length, c.content, c.token_count
             FROM rag_chunks c
             JOIN rag_documents d ON c.doc_id = d.doc_id
             WHERE c.chunk_id IN ({})",
            placeholders
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Prepare chunk fetch error: {}", e))?;
        let rusqlite_params = rusqlite::params_from_iter(chunk_ids.iter());

        let results = stmt.query_map(rusqlite_params, |row| {
            Ok(ChunkQueryResult {
                chunk_id: row.get(0)?,
                doc_id: row.get(1)?,
                rel_path: row.get(2)?,
                chunk_index: row.get::<_, i64>(3)? as usize,
                heading_path: row.get(4)?,
                start_line: row.get::<_, Option<i64>>(5)?.map(|v| v as usize),
                end_line: row.get::<_, Option<i64>>(6)?.map(|v| v as usize),
                page_number: row.get::<_, Option<i64>>(7)?.map(|v| v as usize),
                bounding_box: row.get(8)?,
                char_offset: row.get::<_, i64>(9)? as usize,
                char_length: row.get::<_, i64>(10)? as usize,
                content: row.get(11)?,
                token_count: row.get::<_, i64>(12)? as usize,
                embedding: None,
            })
        }).map_err(|e| format!("Fetch chunks error: {}", e))?
        .filter_map(SqlResult::ok)
        .collect();

        Ok(results)
    }

    /// Retrieve vault overview statistics
    pub fn get_vault_meta(&self) -> Result<VaultMeta, String> {
        let conn = self.get_reader()?;
        let doc_count: usize = conn
            .query_row("SELECT count(*) FROM rag_documents", [], |r| r.get::<_, i64>(0))
            .map(|v| v as usize)
            .unwrap_or(0);
        let chunk_count: usize = conn
            .query_row("SELECT count(*) FROM rag_chunks", [], |r| r.get::<_, i64>(0))
            .map(|v| v as usize)
            .unwrap_or(0);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Ok(VaultMeta {
            model_id: self.config.model_id.clone(),
            embedding_dim: self.config.embedding_dim,
            schema_version: "1".to_string(),
            document_count: doc_count,
            chunk_count,
            last_indexed: now_ms,
        })
    }

    /// Retrieve all indexed documents for incremental sync (rel_path, content_hash, file_mtime)
    pub fn get_all_documents(&self) -> Result<Vec<(String, String, i64)>, String> {
        let conn = self.get_reader()?;
        let mut stmt = conn
            .prepare("SELECT rel_path, content_hash, file_mtime FROM rag_documents")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(SqlResult::ok)
            .collect();
        Ok(rows)
    }
}
