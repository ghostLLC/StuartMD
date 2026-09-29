// tauri/src-tauri/src/rag/config.rs
//! StuartMD RAG Configuration and Core Domain Data Structures
//! Defines RagVaultMeta, RagDocument, RagChunk, RagStatus, and RagConfig.

#![allow(dead_code)]

use std::path::PathBuf;
use serde::{Deserialize, Serialize};

/// Vault metadata and model registry record stored in SQLite
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagVaultMeta {
    pub model_id: String,
    pub embedding_dim: usize,
    pub schema_version: String,
    pub document_count: usize,
    pub chunk_count: usize,
    pub last_indexed: u64,
}

pub type VaultMeta = RagVaultMeta;

/// Document registration record
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagDocument {
    pub doc_id: String,       // SHA-256 hex string of normalized rel_path
    pub rel_path: String,     // Relative path within vault (e.g. "notes/paper.md")
    pub file_format: String,  // "md" | "pdf" | "txt" | "epub" | "code"
    pub content_hash: String, // Full file content SHA-256 hash
    pub file_size: u64,       // File size in bytes
    pub file_mtime: i64,      // Modification time in epoch milliseconds
    pub indexed_at: i64,      // Indexing timestamp in epoch milliseconds
}

pub type DocumentRecord = RagDocument;

/// Chunk data structure containing relational metadata, positioning, and text content
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagChunk {
    pub chunk_id: String,             // Format: "{doc_id}_{chunk_index}"
    pub doc_id: String,               // Foreign key to rag_documents(doc_id)
    #[serde(default)]
    pub rel_path: String,             // Relative path within vault
    pub chunk_index: usize,           // 0-based index within document
    pub heading_path: String,         // Outline breadcrumb: "# Title > ## Section"
    pub start_line: Option<usize>,    // 1-based Markdown start line
    pub end_line: Option<usize>,      // 1-based Markdown end line
    pub page_number: Option<usize>,   // 1-based PDF page number
    pub bounding_box: Option<String>, // PDF coordinates JSON "[x0, y0, x1, y1]"
    pub char_offset: usize,           // Character start offset
    pub char_length: usize,           // Character length
    pub content: String,              // Plain text content of chunk
    pub token_count: usize,           // Estimated token count
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,  // Dense vector embedding
}

pub type ChunkInsertPayload = RagChunk;
pub type ChunkQueryResult = RagChunk;

/// RAG knowledge base operational status and summary statistics
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RagStatus {
    /// Operational status: "idle" | "indexing" | "ready" | "error"
    pub status: String,
    /// Number of indexed documents
    pub doc_count: usize,
    /// Total number of indexed chunks
    pub chunk_count: usize,
    /// Last indexing timestamp in epoch milliseconds
    pub last_indexed: u64,
}

pub type RagStatusResponse = RagStatus;

/// Global configuration for RAG storage, embedding model, and indexing limits
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagConfig {
    /// Path to SQLite database file (e.g. `<vault_root>/.stuart/rag.db`)
    pub db_path: PathBuf,
    /// Embedding dimension (e.g. 1024 for BGE-M3, 384 for MiniLM)
    pub embedding_dim: usize,
    /// Embedding model identifier (e.g. "BAAI/bge-m3")
    pub model_id: String,
    /// Lock contention busy wait in milliseconds (DEF-CONC-02: default 5000)
    pub busy_timeout_ms: u64,
    /// Number of pooled reader connections (DEF-CONC-01: default 4)
    pub reader_pool_size: u32,
    /// Maximum memory-mapped I/O size in bytes (default 32MB: 33554432)
    pub mmap_size: i64,
    /// SQLite page cache size in KiB (negative means KiB, default -2048 = 2MB)
    pub cache_size: i64,
    /// Target chunk size in characters/tokens (default 512)
    pub chunk_size: usize,
    /// Chunk overlap in characters/tokens (default 64)
    pub chunk_overlap: usize,
    /// Maximum number of files in vault before circuit breaker (default 10,000)
    pub max_vault_files: usize,
    /// Maximum folder recursion depth (default 8)
    pub max_vault_depth: usize,
    /// Directory blacklist names to exclude from indexing
    pub blacklisted_dirs: Vec<String>,
}

pub type StorageConfig = RagConfig;

impl Default for RagConfig {
    fn default() -> Self {
        Self {
            db_path: PathBuf::from(".stuart/rag.db"),
            embedding_dim: 1024,
            model_id: "BAAI/bge-m3".to_string(),
            busy_timeout_ms: 5000,
            reader_pool_size: 4,
            mmap_size: 33554432, // 32MB
            cache_size: -2048,   // 2MB
            chunk_size: 512,
            chunk_overlap: 64,
            max_vault_files: 10000,
            max_vault_depth: 8,
            blacklisted_dirs: vec![
                ".git".to_string(),
                "node_modules".to_string(),
                "target".to_string(),
                ".stuart".to_string(),
                "dist".to_string(),
                "build".to_string(),
                ".vscode".to_string(),
                ".idea".to_string(),
            ],
        }
    }
}
