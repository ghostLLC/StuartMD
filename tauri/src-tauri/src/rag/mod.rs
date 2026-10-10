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
pub mod model_registry;
pub mod generation;
pub mod storage;
pub mod watcher;

use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

pub use self::config::{
    ChunkInsertPayload, ChunkQueryResult, DocumentRecord, RagChunk, RagConfig, RagDocument,
    RagStatus, RagStatusResponse, RagVaultMeta, StorageConfig, VaultMeta,
};
pub use self::embedding::{EmbeddingError, LocalEmbeddingEngine, ModelConfig};
pub use self::fts::{escape_fts5_query, search_fts5_bm25};
pub use self::hybrid_search::{
    execute_rrf_fusion, resolve_query_weights, HybridSearchResult,
};
pub use self::indexer::{parse_file_to_document, ParsedDocument};
pub mod pdf_extract;
pub mod ocr;
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
    pub operation_lock: tokio::sync::Mutex<()>,
    pub workspaces: RwLock<HashMap<String, WorkspaceBinding>>,
    pub window_workspaces: RwLock<HashMap<String, PathBuf>>,
    pub engines: Mutex<HashMap<String, Arc<LocalEmbeddingEngine>>>,
    pub jobs: Mutex<HashMap<String, IndexJob>>,
    pub watchers: Mutex<HashMap<String, watcher::WorkspaceWatcher>>,
}

#[derive(Clone)]
pub struct IndexJob {
    pub job_id: String,
    pub cancel: Arc<AtomicBool>,
    pub finished: Arc<tokio::sync::Notify>,
    pub ended: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct WorkspaceBinding {
    pub root: PathBuf,
    pub storage: Option<Arc<RagStorage>>,
    pub generation: Option<generation::Generation>,
    pub status: RagStatus,
    pub config: RagConfig,
    pub operation: Arc<tokio::sync::Mutex<()>>,
    pub source_revision: Arc<std::sync::atomic::AtomicU64>,
    pub indexed_revision: u64,
}

impl RagState {
    /// Initializes unbound RAG state
    pub fn new() -> Self {
        Self {
            workspace_root: Arc::new(RwLock::new(None)),
            storage: Arc::new(RwLock::new(None)),
            embedding_engine: Arc::new(LocalEmbeddingEngine::new()),
            status: Arc::new(RwLock::new(RagStatus {
                status: "Uninitialized".to_string(),
                doc_count: 0,
                chunk_count: 0,
                last_indexed: 0,
                ..Default::default()
            })),
            config: Arc::new(RwLock::new(RagConfig::default())),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            operation_lock: tokio::sync::Mutex::new(()),
            workspaces: RwLock::new(HashMap::new()),
            window_workspaces: RwLock::new(HashMap::new()),
            engines: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
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
        let mut lock = self.status.write().expect("知识状态锁不可用");
        mutator(&mut lock);
    }

    pub fn engine_for(&self, model_id: &str) -> Result<Arc<LocalEmbeddingEngine>, String> {
        let spec = model_registry::model_spec(model_id)?;
        let mut engines = self.engines.lock().map_err(|error| error.to_string())?;
        Ok(engines.entry(spec.model_id.clone()).or_insert_with(|| {
            Arc::new(LocalEmbeddingEngine::for_model(&spec.model_id).expect("已经验证的模型配置无效"))
        }).clone())
    }

    pub fn begin_job(&self, workspace_id: &str) -> Result<IndexJob, String> {
        let mut jobs = self.jobs.lock().map_err(|error| error.to_string())?;
        if jobs.contains_key(workspace_id) { return Err("当前工作区知识任务尚未结束".into()); }
        let job = IndexJob {
            job_id: uuid::Uuid::new_v4().to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(tokio::sync::Notify::new()),
            ended: Arc::new(AtomicBool::new(false)),
        };
        jobs.insert(workspace_id.into(), job.clone());
        Ok(job)
    }

    pub fn finish_job(&self, workspace_id: &str, job: &IndexJob) -> Result<(), String> {
        let mut jobs = self.jobs.lock().map_err(|error| error.to_string())?;
        if !jobs.get(workspace_id).is_some_and(|active| active.job_id == job.job_id) {
            return Err("知识任务身份已经变化".into());
        }
        jobs.remove(workspace_id);
        job.ended.store(true, std::sync::atomic::Ordering::Release);
        job.finished.notify_waiters();
        Ok(())
    }
}

impl Default for RagState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod real_tests;
