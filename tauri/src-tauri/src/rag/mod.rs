// tauri/src-tauri/src/rag/mod.rs
//! StuartMD Pure Local Multilingual RAG Subsystem
//! Central facade managing lifecycle, shared thread-safe state (RagState),
//! and public exports.

#![allow(unused_imports, dead_code)]

pub mod config;
pub mod embedding;
pub mod fts;
pub mod hybrid_search;
pub mod indexer;
pub mod storage;
pub mod watcher;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

pub use self::config::{
    ChunkInsertPayload, ChunkQueryResult, DocumentRecord, RagChunk, RagConfig, RagDocument,
    RagStatus, RagStatusResponse, RagVaultMeta, StorageConfig, VaultMeta,
};
pub use self::embedding::{EmbeddingError, LocalEmbeddingEngine, ModelConfig};
pub use self::fts::{escape_fts5_query, search_fts5_bm25};
pub use self::hybrid_search::{
    execute_rrf_fusion, resolve_query_weights, HybridSearchResult,
};
pub use self::indexer::{parse_file_to_document, ParsedDocument, PdfTextBlock};
pub use self::storage::{FtsHit, RagStorage, VectorHit};
pub use self::watcher::{
    is_cloud_placeholder, is_temporary_or_ignored_file, scan_workspace_files, sync_vault_pipeline,
    IndexProgress, IndexSummary,
};

/// Tauri application-level thread-safe shared state for RAG subsystem
pub struct RagState {
    /// Active vault / workspace physical root directory
    pub workspace_root: Arc<RwLock<Option<PathBuf>>>,
    /// Read/Write separated storage handle (Dedicated Writer + Reader Connection Pool)
    pub storage: Arc<RwLock<Option<Arc<RagStorage>>>>,
    /// Local multilingual ONNX embedding engine
    pub embedding_engine: Arc<LocalEmbeddingEngine>,
    /// Status and statistics cache
    pub status: Arc<RwLock<RagStatus>>,
    /// RAG subsystem configuration
    pub config: Arc<RwLock<RagConfig>>,
    /// Cancellation flag for background indexing pipeline
    pub cancel_flag: Arc<AtomicBool>,
}

impl RagState {
    /// Initializes unbound RAG state
    pub fn new() -> Self {
        Self {
            workspace_root: Arc::new(RwLock::new(None)),
            storage: Arc::new(RwLock::new(None)),
            embedding_engine: Arc::new(LocalEmbeddingEngine::new()),
            status: Arc::new(RwLock::new(RagStatus {
                status: "idle".to_string(),
                doc_count: 0,
                chunk_count: 0,
                last_indexed: 0,
            })),
            config: Arc::new(RwLock::new(RagConfig::default())),
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Retrieve active storage handle or return an error if workspace not set
    pub fn get_storage(&self) -> Result<Arc<RagStorage>, String> {
        let guard = self.storage.read().map_err(|e| e.to_string())?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "No active workspace configured. RAG database is not loaded.".to_string())
    }

    /// Update status cache safely
    pub fn update_status<F>(&self, mutator: F)
    where
        F: FnOnce(&mut RagStatus),
    {
        if let Ok(mut lock) = self.status.write() {
            mutator(&mut lock);
        }
    }
}

impl Default for RagState {
    fn default() -> Self {
        Self::new()
    }
}
