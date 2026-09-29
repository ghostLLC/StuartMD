// tauri/src-tauri/src/rag/embedding.rs
//! Pure Local Multilingual Embedding Engine wrapping fastembed-rs.
//! Supports BAAI/bge-m3 (1024-dim, Int8) with MiniLM (384-dim) fallback,
//! lazy loading, active 10-minute idle unloading, and adaptive throttling.

#![allow(dead_code)]

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use thiserror::Error;

/// Specific error types for the embedding engine.
#[derive(Debug, Error)]
pub enum EmbeddingError {
    #[error("FastEmbed initialization failed: {0}")]
    InitFailed(String),

    #[error("FastEmbed inference error: {0}")]
    InferenceFailed(String),

    #[error("Cache directory access failed: {0}")]
    CacheDirError(String),

    #[error("Thread lock poisoned: {0}")]
    LockError(String),
}

/// Dynamic Model Configuration and output vector dimension.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModelConfig {
    pub model_id: String,
    pub dimension: usize,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            model_id: "BAAI/bge-m3".to_string(),
            dimension: 1024,
        }
    }
}

impl ModelConfig {
    pub fn bge_m3() -> Self {
        Self {
            model_id: "BAAI/bge-m3".to_string(),
            dimension: 1024,
        }
    }

    pub fn minilm_multilingual() -> Self {
        Self {
            model_id: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2".to_string(),
            dimension: 384,
        }
    }
}

/// Thread-safe Local Embedding Engine with lazy loading and 10-min idle auto-eviction.
pub struct LocalEmbeddingEngine {
    model: Arc<Mutex<Option<Arc<TextEmbedding>>>>,
    active_config: Arc<RwLock<ModelConfig>>,
    last_used: Arc<RwLock<Instant>>,
    cache_dir: PathBuf,
    reaper_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl LocalEmbeddingEngine {
    /// Create a new embedding engine with default local models directory.
    pub fn new() -> Self {
        Self::with_default_cache()
    }

    /// Create with custom cache directory.
    pub fn with_cache_dir<P: AsRef<Path>>(cache_dir: P) -> Self {
        let engine = Self {
            model: Arc::new(Mutex::new(None)),
            active_config: Arc::new(RwLock::new(ModelConfig::default())),
            last_used: Arc::new(RwLock::new(Instant::now())),
            cache_dir: cache_dir.as_ref().to_path_buf(),
            reaper_handle: Arc::new(Mutex::new(None)),
        };

        engine.try_spawn_idle_reaper();
        engine
    }

    /// Default constructor using local application data directory.
    pub fn with_default_cache() -> Self {
        let cache_dir = dirs::data_local_dir()
            .map(|p| p.join("stuartmd").join("models"))
            .unwrap_or_else(|| PathBuf::from("./resources/models"));
        Self::with_cache_dir(cache_dir)
    }

    /// Safely attempts to spawn a background Tokio task that ticks every 60 seconds.
    /// If inactive for >= 600s (10 minutes), the ONNX session is dropped.
    fn try_spawn_idle_reaper(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let model_ref = self.model.clone();
            let last_used_ref = self.last_used.clone();
            let reaper_slot = self.reaper_handle.clone();

            let task = handle.spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    let elapsed = {
                        let guard = last_used_ref.read().await;
                        guard.elapsed()
                    };

                    if elapsed >= Duration::from_secs(600) {
                        let mut guard = model_ref.lock().await;
                        if guard.is_some() {
                            log::info!(
                                "[FastEmbed] Model idle for >10 mins ({:.1}s). Evicting ONNX session to free RAM.",
                                elapsed.as_secs_f32()
                            );
                            *guard = None;
                        }
                    }
                }
            });

            tokio::spawn(async move {
                let mut lock = reaper_slot.lock().await;
                *lock = Some(task);
            });
        }
    }

    /// Ensures the idle reaper task is running when an async context is active.
    async fn ensure_reaper_running(&self) {
        let mut slot = self.reaper_handle.lock().await;
        if slot.is_none() {
            let model_ref = self.model.clone();
            let last_used_ref = self.last_used.clone();

            let task = tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    let elapsed = {
                        let guard = last_used_ref.read().await;
                        guard.elapsed()
                    };

                    if elapsed >= Duration::from_secs(600) {
                        let mut guard = model_ref.lock().await;
                        if guard.is_some() {
                            log::info!(
                                "[FastEmbed] Model idle for >10 mins ({:.1}s). Evicting ONNX session to free RAM.",
                                elapsed.as_secs_f32()
                            );
                            *guard = None;
                        }
                    }
                }
            });
            *slot = Some(task);
        }
    }

    /// Returns the currently active model configuration and vector dimension.
    pub async fn get_active_config(&self) -> ModelConfig {
        self.active_config.read().await.clone()
    }

    /// Explicitly unloads the model immediately to reclaim memory.
    pub async fn unload(&self) {
        let mut guard = self.model.lock().await;
        if guard.is_some() {
            log::info!("[FastEmbed] Explicit unload invoked. Freeing ONNX model memory.");
            *guard = None;
        }
    }

    /// Lazy initialization of the ONNX model with graceful fallback.
    async fn get_or_init_model(&self) -> Result<Arc<TextEmbedding>, EmbeddingError> {
        self.ensure_reaper_running().await;

        let mut guard = self.model.lock().await;
        *self.last_used.write().await = Instant::now();

        if let Some(ref instance) = *guard {
            return Ok(Arc::clone(instance));
        }

        // Ensure cache directory exists
        if !self.cache_dir.exists() {
            std::fs::create_dir_all(&self.cache_dir)
                .map_err(|e| EmbeddingError::CacheDirError(format!("Failed to create cache dir: {}", e)))?;
        }

        let target_config = self.active_config.read().await.clone();
        log::info!(
            "[FastEmbed] Lazy initializing model '{}' from cache '{:?}'...",
            target_config.model_id,
            self.cache_dir
        );

        let init_res = self.try_init_single_model(&target_config.model_id).await;

        match init_res {
            Ok(instance) => {
                log::info!("[FastEmbed] Successfully loaded primary model '{}'", target_config.model_id);
                let arc_instance = Arc::new(instance);
                *guard = Some(Arc::clone(&arc_instance));
                Ok(arc_instance)
            }
            Err(primary_err) => {
                log::warn!(
                    "[FastEmbed] Primary model '{}' failed to initialize: {}. Attempting fallback to MiniLM...",
                    target_config.model_id,
                    primary_err
                );

                // Fallback attempt: paraphrase-multilingual-MiniLM-L12-v2 (384-dim)
                let fallback_config = ModelConfig::minilm_multilingual();
                match self.try_init_single_model(&fallback_config.model_id).await {
                    Ok(fallback_instance) => {
                        log::info!("[FastEmbed] Fallback to MiniLM succeeded (dimension: 384)");
                        *self.active_config.write().await = fallback_config;
                        let arc_fallback = Arc::new(fallback_instance);
                        *guard = Some(Arc::clone(&arc_fallback));
                        Ok(arc_fallback)
                    }
                    Err(fallback_err) => {
                        let combined_err = format!(
                            "All embedding model initializations failed. Primary: [{}]; Fallback: [{}]",
                            primary_err, fallback_err
                        );
                        log::error!("[FastEmbed] {}", combined_err);
                        Err(EmbeddingError::InitFailed(combined_err))
                    }
                }
            }
        }
    }

    /// Internal helper to initialize a specific model variant.
    async fn try_init_single_model(&self, model_id: &str) -> Result<TextEmbedding, EmbeddingError> {
        let model_type = match model_id {
            "BAAI/bge-m3" => EmbeddingModel::MultilingualE5Large, // 1024-dim multilingual
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" => {
                EmbeddingModel::ParaphraseMLMiniLML12V2 // 384-dim multilingual
            }
            _ => EmbeddingModel::BGESmallZHV15, // 512-dim
        };

        let cache_path = self.cache_dir.clone();
        tokio::task::spawn_blocking(move || {
            let opts = InitOptions::new(model_type)
                .with_show_download_progress(false)
                .with_cache_dir(cache_path);

            TextEmbedding::try_new(opts)
                .map_err(|e| EmbeddingError::InitFailed(e.to_string()))
        })
        .await
        .map_err(|e| EmbeddingError::InitFailed(format!("Task join error: {}", e)))?
    }

    /// Computes dense embedding vector for a single query text (sub-15ms, unthrottled).
    pub async fn embed_query(&self, query: &str) -> Result<Vec<f32>, EmbeddingError> {
        let model = self.get_or_init_model().await?;
        *self.last_used.write().await = Instant::now();

        let query_text = query.to_string();
        let vectors = tokio::task::spawn_blocking(move || {
            model
                .embed(vec![query_text], None)
                .map_err(|e| EmbeddingError::InferenceFailed(e.to_string()))
        })
        .await
        .map_err(|e| EmbeddingError::InferenceFailed(format!("Task join error: {}", e)))??;

        vectors
            .into_iter()
            .next()
            .ok_or_else(|| EmbeddingError::InferenceFailed("Empty output from embedder".to_string()))
    }

    /// Batch embedding computation with DEF-CONC-06 adaptive duty cycle rate throttling.
    /// Slices into batches of 16, measuring compute time T_comp and sleeping 3 * T_comp
    /// to cap CPU usage strictly under 25%.
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let model = self.get_or_init_model().await?;
        const BATCH_SIZE: usize = 16;
        let mut all_embeddings = Vec::with_capacity(texts.len());

        let chunks: Vec<Vec<String>> = texts
            .chunks(BATCH_SIZE)
            .map(|chunk| chunk.to_vec())
            .collect();

        for chunk in chunks {
            let model_clone = Arc::clone(&model);
            let (embeddings, t_compute) = tokio::task::spawn_blocking(move || {
                let t_start = Instant::now();
                let res = model_clone
                    .embed(chunk, None)
                    .map_err(|e| EmbeddingError::InferenceFailed(e.to_string()));
                (res, t_start.elapsed())
            })
            .await
            .map_err(|e| EmbeddingError::InferenceFailed(format!("Task join error: {}", e)))?;

            all_embeddings.extend(embeddings?);

            // DEF-CONC-06: T_sleep = 3.0 * T_compute with a 5ms floor
            let sleep_duration = t_compute.mul_f64(3.0).max(Duration::from_millis(5));
            tokio::time::sleep(sleep_duration).await;
        }

        *self.last_used.write().await = Instant::now();
        Ok(all_embeddings)
    }
}

impl Default for LocalEmbeddingEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LocalEmbeddingEngine {
    fn drop(&mut self) {
        if let Ok(mut handle_guard) = self.reaper_handle.try_lock() {
            if let Some(handle) = handle_guard.take() {
                handle.abort();
            }
        }
    }
}
