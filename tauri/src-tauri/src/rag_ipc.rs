// tauri/src-tauri/src/rag_ipc.rs
//! StuartMD RAG Tauri IPC Gateway
//! Bridges frontend requests to the local RAG subsystem.
//! Implements:
//! - stuart_rag_set_workspace
//! - stuart_rag_query
//! - stuart_rag_get_status

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::rag::{
    execute_rrf_fusion, resolve_query_weights, search_fts5_bm25,
    RagState, RagStatus, RagStorage,
};

/// Workspace configuration response compatible with both VaultMeta and RagStatus contracts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSetWorkspaceResponse {
    pub status: String,
    pub doc_count: usize,
    pub document_count: usize,
    pub chunk_count: usize,
    pub last_indexed: u64,
    pub model_id: String,
    pub embedding_dim: usize,
    pub schema_version: String,
}

/// Optional structured search request argument
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchRequest {
    pub vault_root: Option<String>,
    pub query: String,
    pub top_k: Option<usize>,
}

/// Hit payload returned to frontend and L3 context pyramid
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHitPayload {
    pub chunk_id: String,
    pub rel_path: String,
    pub heading_path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub page_number: Option<usize>,
    pub bounding_box: Option<String>,
    pub content: String,
    pub rrf_score: f32,
    pub deep_link: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_rank: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bm25_rank: Option<usize>,
}

#[allow(dead_code)]
pub type RrfRankedChunk = RagHitPayload;

/// Configure or switch the active workspace/vault for local RAG retrieval
#[tauri::command]
pub async fn stuart_rag_set_workspace(
    state: State<'_, RagState>,
    workspace_root: Option<String>,
    vault_path: Option<String>,
) -> Result<RagSetWorkspaceResponse, String> {
    let path_str = workspace_root
        .or(vault_path)
        .ok_or_else(|| "Workspace root path is required".to_string())?;

    let root_path = PathBuf::from(&path_str);
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!("Workspace directory does not exist or is not a folder: {}", path_str));
    }

    let canonical_root = root_path.canonicalize().map_err(|e| e.to_string())?;
    let stuart_dir = canonical_root.join(".stuart");
    if !stuart_dir.exists() {
        std::fs::create_dir_all(&stuart_dir)
            .map_err(|e| format!("Failed to create .stuart directory: {}", e))?;
    }

    let db_path = stuart_dir.join("rag.db");
    let active_model_cfg = state.embedding_engine.get_active_config().await;

    // Read configured parameters or use defaults
    let mut storage_cfg = {
        let guard = state.config.read().map_err(|e| e.to_string())?;
        guard.clone()
    };
    storage_cfg.db_path = db_path;
    storage_cfg.model_id = active_model_cfg.model_id.clone();
    storage_cfg.embedding_dim = active_model_cfg.dimension;

    // Open read/write separated storage (Dedicated Writer + r2d2 pool)
    let storage = RagStorage::open(storage_cfg)
        .map_err(|e| format!("Failed to open RAG storage: {}", e))?;
    let storage_arc = Arc::new(storage);

    // Read current vault stats
    let meta = storage_arc.get_vault_meta()?;

    let response = RagSetWorkspaceResponse {
        status: if meta.chunk_count > 0 { "ready".to_string() } else { "idle".to_string() },
        doc_count: meta.document_count,
        document_count: meta.document_count,
        chunk_count: meta.chunk_count,
        last_indexed: meta.last_indexed,
        model_id: meta.model_id,
        embedding_dim: meta.embedding_dim,
        schema_version: meta.schema_version,
    };

    // Update shared state
    {
        let mut ws_guard = state.workspace_root.write().map_err(|e| e.to_string())?;
        *ws_guard = Some(canonical_root);
    }
    {
        let mut st_guard = state.storage.write().map_err(|e| e.to_string())?;
        *st_guard = Some(storage_arc);
    }
    state.update_status(|s| {
        s.status = response.status.clone();
        s.doc_count = response.doc_count;
        s.chunk_count = response.chunk_count;
        s.last_indexed = response.last_indexed;
    });

    log::info!(
        "[RAG IPC] Workspace configured: '{}' (docs={}, chunks={})",
        path_str,
        response.doc_count,
        response.chunk_count
    );

    Ok(response)
}

/// Execute hybrid RRF retrieval (dense vector + trigram FTS5)
#[tauri::command]
pub async fn stuart_rag_query(
    state: State<'_, RagState>,
    query: Option<String>,
    top_k: Option<usize>,
    request: Option<RagSearchRequest>,
) -> Result<Vec<RagHitPayload>, String> {
    let query_raw = query
        .or_else(|| request.as_ref().map(|r| r.query.clone()))
        .unwrap_or_default();
    let query_trimmed = query_raw.trim();
    if query_trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let top_k_val = top_k
        .or_else(|| request.and_then(|r| r.top_k))
        .unwrap_or(10)
        .clamp(1, 50);

    let storage = state.get_storage()?;
    let reader = storage.get_reader()?;

    // 1. Dynamic query classification
    let (w_vec, w_bm25) = resolve_query_weights(query_trimmed);

    // 2. Vector search channel
    let mut vector_hits: Vec<(String, usize)> = Vec::new();
    if w_vec > 0.0 {
        if let Ok(query_vec) = state.embedding_engine.embed_query(query_trimmed).await {
            if let Ok(raw_vec_results) = storage.search_vector_knn(&reader, &query_vec, 50) {
                for (rank_0, hit) in raw_vec_results.into_iter().enumerate() {
                    vector_hits.push((hit.chunk_id, rank_0 + 1));
                }
            }
        }
    }

    // 3. Sparse trigram FTS5 channel
    let mut bm25_hits: Vec<(String, usize)> = Vec::new();
    if w_bm25 > 0.0 {
        if let Ok(raw_fts_results) = search_fts5_bm25(&reader, query_trimmed, 50) {
            for (chunk_id, rank_1, _score) in raw_fts_results {
                bm25_hits.push((chunk_id, rank_1));
            }
        }
    }

    // 4. Reciprocal Rank Fusion (k=60, DEF-06 zero filtering and tie-breaking)
    let fused = execute_rrf_fusion(&vector_hits, &bm25_hits, w_vec, w_bm25, top_k_val);
    if fused.is_empty() {
        return Ok(Vec::new());
    }

    // 5. Hydrate chunks with outline metadata and deep links
    let chunk_ids: Vec<String> = fused.iter().map(|f| f.chunk_id.clone()).collect();
    let chunk_details = storage.get_chunks_by_ids(&chunk_ids)?;
    let chunk_map: HashMap<String, _> = chunk_details
        .into_iter()
        .map(|c| (c.chunk_id.clone(), c))
        .collect();

    let mut hydrated_hits = Vec::with_capacity(fused.len());
    for cand in fused {
        if let Some(chunk) = chunk_map.get(&cand.chunk_id) {
            let deep_link = if let Some(p) = chunk.page_number {
                format!("stuart://anchor?file={}&page={}", urlencoding::encode(&chunk.rel_path), p)
            } else if let (Some(s), Some(e)) = (chunk.start_line, chunk.end_line) {
                format!("stuart://anchor?file={}&line={}&end={}", urlencoding::encode(&chunk.rel_path), s, e)
            } else {
                format!("stuart://anchor?file={}", urlencoding::encode(&chunk.rel_path))
            };

            hydrated_hits.push(RagHitPayload {
                chunk_id: cand.chunk_id,
                rel_path: chunk.rel_path.clone(),
                heading_path: chunk.heading_path.clone(),
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                page_number: chunk.page_number,
                bounding_box: chunk.bounding_box.clone(),
                content: chunk.content.clone(),
                rrf_score: cand.rrf_score,
                deep_link,
                vector_rank: cand.vector_rank,
                bm25_rank: cand.bm25_rank,
            });
        }
    }

    Ok(hydrated_hits)
}

/// Retrieve current RAG subsystem status and stats
#[tauri::command]
pub async fn stuart_rag_get_status(
    state: State<'_, RagState>,
) -> Result<RagStatus, String> {
    if let Ok(storage) = state.get_storage() {
        if let Ok(meta) = storage.get_vault_meta() {
            state.update_status(|s| {
                s.doc_count = meta.document_count;
                s.chunk_count = meta.chunk_count;
                s.last_indexed = meta.last_indexed;
                if s.status == "idle" && meta.chunk_count > 0 {
                    s.status = "ready".to_string();
                }
            });
        }
    }
    let status_guard = state.status.read().map_err(|e| e.to_string())?;
    Ok(status_guard.clone())
}

/// Trigger asynchronous incremental workspace synchronization
#[tauri::command]
pub async fn stuart_rag_sync_workspace(
    app: tauri::AppHandle,
    state: State<'_, RagState>,
) -> Result<crate::rag::IndexSummary, String> {
    use std::sync::atomic::Ordering;
    use tauri::Emitter;

    let root = {
        let ws_guard = state.workspace_root.read().map_err(|e| e.to_string())?;
        ws_guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "No workspace configured. Please select a workspace folder first.".to_string())?
    };
    let storage = state.get_storage()?;
    let embedding_engine = state.embedding_engine.clone();
    let config = {
        let guard = state.config.read().map_err(|e| e.to_string())?;
        guard.clone()
    };
    let cancel_flag = state.cancel_flag.clone();
    cancel_flag.store(false, Ordering::Relaxed);

    state.update_status(|s| {
        s.status = "indexing".to_string();
    });

    let app_clone = app.clone();
    let progress_callback = move |progress: crate::rag::IndexProgress| {
        let _ = app_clone.emit("rag-sync-progress", &progress);
    };

    let summary = crate::rag::sync_vault_pipeline(
        &root,
        &storage,
        &embedding_engine,
        &config,
        &cancel_flag,
        progress_callback,
    )
    .await?;

    if let Ok(meta) = storage.get_vault_meta() {
        state.update_status(|s| {
            s.status = "ready".to_string();
            s.doc_count = meta.document_count;
            s.chunk_count = meta.chunk_count;
            s.last_indexed = meta.last_indexed;
        });
    }

    Ok(summary)
}

/// Cancel ongoing workspace indexing pipeline
#[tauri::command]
pub fn stuart_rag_cancel_sync(
    state: State<'_, RagState>,
) -> Result<bool, String> {
    state.cancel_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    state.update_status(|s| {
        s.status = "idle".to_string();
    });
    Ok(true)
}
