// tauri/src-tauri/src/rag/hybrid_search.rs
//! Hybrid Retrieval Fusion Engine using Reciprocal Rank Fusion (RRF k=60)
//! Features Dynamic Query Classification, DEF-06 zero-score filtering,
//! and deterministic chunk_id tie-breaking.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Result entry from Hybrid RRF Search.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HybridSearchResult {
    pub chunk_id: String,
    pub rrf_score: f32,
    pub vector_rank: Option<usize>,
    pub bm25_rank: Option<usize>,
}

/// Dynamic Query Intent Classifier.
/// Returns (w_vec, w_bm25) where w_vec + w_bm25 = 1.0.
pub fn resolve_query_weights(query: &str) -> (f32, f32) {
    let q = query.trim();

    // Rule 1: Code tokens, paths, extensions, or explicit quotation marks
    if q.contains('"') || q.contains("::") || q.contains("->") || q.contains('.') || q.contains('_') {
        return (0.25, 0.75); // Favor BM25 lexical precision
    }

    // Rule 2: Natural language conceptual, reflective, or long exploratory queries
    let is_concept = q.starts_with("为什么")
        || q.starts_with("如何")
        || q.contains("原理")
        || q.contains("本质")
        || q.contains("对比");

    // CRITICAL: Must use chars().count() for Unicode code points, NOT byte length q.len()!
    if is_concept || q.chars().count() > 18 {
        return (0.70, 0.30); // Favor vector semantic similarity
    }

    // Rule 3: Balanced default state
    (0.50, 0.50)
}

/// Executes Reciprocal Rank Fusion (RRF) over dense vector hits and sparse BM25 hits.
///
/// Parameters:
/// - `vector_hits`: Slice of (chunk_id, 1-based rank) from vector similarity channel
/// - `bm25_hits`: Slice of (chunk_id, 1-based rank) from BM25 trigram channel
/// - `w_vec`: Weight for vector channel [0.0, 1.0]
/// - `w_bm25`: Weight for BM25 channel [0.0, 1.0]
/// - `top_n`: Maximum number of results to return
///
/// Implements DEF-06:
/// 1. Filters out candidate items with rrf_score <= 0.0
/// 2. Sorts descending by rrf_score; ties broken deterministically by chunk_id ascending
pub fn execute_rrf_fusion(
    vector_hits: &[(String, usize)],
    bm25_hits: &[(String, usize)],
    w_vec: f32,
    w_bm25: f32,
    top_n: usize,
) -> Vec<HybridSearchResult> {
    const K: f32 = 60.0;

    // Temporary accumulation: (rrf_score, Option<vec_rank>, Option<bm25_rank>)
    let mut map: HashMap<String, (f32, Option<usize>, Option<usize>)> = HashMap::new();

    // 1. Accumulate vector channel contributions
    for (id, r_vec) in vector_hits {
        let entry = map.entry(id.clone()).or_insert((0.0, None, None));
        entry.0 += w_vec / (K + (*r_vec as f32));
        entry.1 = Some(*r_vec);
    }

    // 2. Accumulate BM25 channel contributions
    for (id, r_bm) in bm25_hits {
        let entry = map.entry(id.clone()).or_insert((0.0, None, None));
        entry.0 += w_bm25 / (K + (*r_bm as f32));
        entry.2 = Some(*r_bm);
    }

    // 3. DEF-06: Filter out items with score <= 0.0 (prevents zero-weight pollution)
    let mut results: Vec<HybridSearchResult> = map
        .into_iter()
        .filter(|(_, (score, _, _))| *score > 0.0)
        .map(|(chunk_id, (rrf_score, vector_rank, bm25_rank))| HybridSearchResult {
            chunk_id,
            rrf_score,
            vector_rank,
            bm25_rank,
        })
        .collect();

    // 4. DEF-06: Sort descending by rrf_score.
    // Secondary tie-breaker: chunk_id ascending to eliminate HashMap pseudo-random iteration jitter.
    results.sort_by(|a, b| {
        b.rrf_score
            .partial_cmp(&a.rrf_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
    });

    results.truncate(top_n);
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_query_weights_rules() {
        // Rule 1: Code tokens, quotes, file paths
        assert_eq!(resolve_query_weights("stuart::fs_api::ReplaceFileW"), (0.25, 0.75));
        assert_eq!(resolve_query_weights("\"exact quote\""), (0.25, 0.75));
        assert_eq!(resolve_query_weights("config.json"), (0.25, 0.75));
        assert_eq!(resolve_query_weights("user_name"), (0.25, 0.75));
        assert_eq!(resolve_query_weights("ptr->val"), (0.25, 0.75));

        // Rule 2: Natural language questions and philosophical reflections
        assert_eq!(resolve_query_weights("为什么本地向量化需要sqlite-vec？"), (0.70, 0.30));
        assert_eq!(resolve_query_weights("如何构建混合检索流水线？"), (0.70, 0.30));
        assert_eq!(resolve_query_weights("探讨RRF算法的数学原理"), (0.70, 0.30));
        assert_eq!(resolve_query_weights("这是一个超过十八个字符的极其漫长的哲学思辨问题讨论"), (0.70, 0.30));

        // Rule 3: Balanced default
        assert_eq!(resolve_query_weights("hello world"), (0.50, 0.50));
        assert_eq!(resolve_query_weights("Rust 语言"), (0.50, 0.50));
    }

    #[test]
    fn test_rrf_asymmetric_channels() {
        let bm25_hits: Vec<(String, usize)> = (1..=5).map(|i| (format!("doc_{}", i), i)).collect();

        // Vector channel empty (out-of-vocabulary)
        let res_vec_empty = execute_rrf_fusion(&[], &bm25_hits, 0.70, 0.30, 5);
        assert_eq!(res_vec_empty.len(), 5);
        assert_eq!(res_vec_empty[0].chunk_id, "doc_1");
        assert_eq!(res_vec_empty[0].bm25_rank, Some(1));
        assert_eq!(res_vec_empty[0].vector_rank, None);
        assert!((res_vec_empty[0].rrf_score - (0.30 / 61.0)).abs() < 1e-6);

        // BM25 channel empty
        let vec_hits: Vec<(String, usize)> = (1..=5).map(|i| (format!("doc_{}", i), i)).collect();
        let res_bm_empty = execute_rrf_fusion(&vec_hits, &[], 0.70, 0.30, 5);
        assert_eq!(res_bm_empty.len(), 5);
        assert_eq!(res_bm_empty[0].chunk_id, "doc_1");
        assert_eq!(res_bm_empty[0].vector_rank, Some(1));
        assert_eq!(res_bm_empty[0].bm25_rank, None);
        assert!((res_bm_empty[0].rrf_score - (0.70 / 61.0)).abs() < 1e-6);

        // Both empty
        let res_both_empty = execute_rrf_fusion(&[], &[], 0.50, 0.50, 10);
        assert!(res_both_empty.is_empty());
    }

    #[test]
    fn test_def_06_zero_score_filtering_and_secondary_tie_breaking() {
        // Zero-score filtering when w_vec = 0.0
        let vec_only = vec![("vec_z".to_string(), 1), ("vec_a".to_string(), 2)];
        let bm_hits = vec![("bm_b".to_string(), 1), ("bm_a".to_string(), 2)];

        let res = execute_rrf_fusion(&vec_only, &bm_hits, 0.0, 1.0, 10);
        assert_eq!(res.len(), 2, "Vector-only items with score 0.0 must be filtered out");
        assert_eq!(res[0].chunk_id, "bm_b");
        assert_eq!(res[1].chunk_id, "bm_a");
        assert!(res.iter().all(|r| r.rrf_score > 0.0));

        // Deterministic secondary tie-breaker test
        let tied_hits = vec![
            ("chunk_gamma".to_string(), 1),
            ("chunk_alpha".to_string(), 1),
            ("chunk_beta".to_string(), 1),
        ];
        let res_tied = execute_rrf_fusion(&tied_hits, &[], 1.0, 0.0, 10);
        let ids: Vec<String> = res_tied.into_iter().map(|r| r.chunk_id).collect();
        assert_eq!(
            ids,
            vec!["chunk_alpha", "chunk_beta", "chunk_gamma"],
            "Tied scores must sort alphabetically by chunk_id ascending"
        );
    }
}
