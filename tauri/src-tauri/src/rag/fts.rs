// tauri/src-tauri/src/rag/fts.rs
//! SQLite FTS5 Sparse Retrieval with Native Trigram Tokenizer
//! Provides crash-proof query sanitization, BM25 weight alignment (0.0, 3.0, 1.0),
//! and 1-based rank extraction for RRF fusion.

use rusqlite::{params, Connection, Result};

/// Sanitizes and escapes arbitrary raw user input for FTS5 trigram literal phrase matching.
///
/// Prevents all SQLite syntax errors (unmatched quotes, dangling operators like AND/OR/NOT,
/// pseudo-column filters with colons, unbalanced parentheses, glob wildcards, and null bytes).
pub fn escape_fts5_query(raw_query: &str) -> String {
    // 1. Filter null bytes and non-whitespace control characters
    let sanitized: String = raw_query
        .chars()
        .filter(|&c| c != '\0' && (!c.is_control() || c == '\t' || c == '\n' || c == '\r'))
        .collect();

    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        return "\"\"".to_string();
    }

    // 2. Escape all internal double quotes by doubling them ("" -> """")
    // and enclose the entire query in double quotes to force literal phrase evaluation.
    let escaped = trimmed.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

/// Executes FTS5 BM25 search over `rag_chunks_fts`.
///
/// # Arguments
/// - `conn`: SQLite database connection (pooled reader)
/// - `raw_query`: Raw query text from user
/// - `limit`: Maximum candidates to recall (typically 50)
///
/// # Returns
/// - Vector of `(chunk_id, 1_based_rank, bm25_score)`
pub fn search_fts5_bm25(
    conn: &Connection,
    raw_query: &str,
    limit: usize,
) -> Result<Vec<(String, usize, f64)>> {
    let safe_query = escape_fts5_query(raw_query);
    if safe_query == "\"\"" {
        return Ok(Vec::new());
    }

    // Crucial weight mapping alignment:
    // Virtual table columns: (chunk_id UNINDEXED, heading_path, content)
    // Corresponding weights: chunk_id=0.0, heading_path=3.0, content=1.0
    // Secondary tie-breaker by chunk_id ASC guarantees deterministic results.
    let mut stmt = conn.prepare(
        "SELECT 
            chunk_id,
            bm25(rag_chunks_fts, 0.0, 3.0, 1.0) AS rank_score
         FROM rag_chunks_fts
         WHERE rag_chunks_fts MATCH ?1
         ORDER BY rank_score ASC, chunk_id ASC
         LIMIT ?2"
    )?;

    let rows = stmt.query_map(params![safe_query, limit as i64], |row| {
        let chunk_id: String = row.get(0)?;
        let score: f64 = row.get(1)?;
        Ok((chunk_id, score))
    })?;

    let mut results = Vec::new();
    for (idx, r) in rows.enumerate() {
        let (chunk_id, score) = r?;
        // 1-based rank idx + 1 for RRF formula
        results.push((chunk_id, idx + 1, score));
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escape_fts5_query_edge_cases() {
        assert_eq!(escape_fts5_query(""), "\"\"");
        assert_eq!(escape_fts5_query("   "), "\"\"");
        assert_eq!(escape_fts5_query("normal query"), "\"normal query\"");
        assert_eq!(
            escape_fts5_query("query with \"unmatched quotes"),
            "\"query with \"\"unmatched quotes\""
        );
        assert_eq!(
            escape_fts5_query("C++ AND OR NOT (broken syntax))"),
            "\"C++ AND OR NOT (broken syntax))\""
        );
        assert_eq!(
            escape_fts5_query("path/to/file.rs:42"),
            "\"path/to/file.rs:42\""
        );
        assert_eq!(escape_fts5_query("*glob* AND ?"), "\"*glob* AND ?\"");
        assert_eq!(
            escape_fts5_query("null\0byte injection"),
            "\"nullbyte injection\""
        );
        assert_eq!(
            escape_fts5_query("special #$%^&@!{}[]\\|"),
            "\"special #$%^&@!{}[]\\|\""
        );
    }

    #[test]
    fn test_in_memory_fts5_trigram_execution() {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                heading_path,
                content,
                tokenize = 'trigram'
            );
            INSERT INTO rag_chunks_fts VALUES ('c1', 'Title Heading', 'Hello world from StuartMD');
            INSERT INTO rag_chunks_fts VALUES ('c2', 'Section Two', '倒数排名融合算法在大模型知识库检索中的工程落地实践');
            INSERT INTO rag_chunks_fts VALUES ('c3', 'Code Ref', 'pub fn stuart_open_url(url: &str) -> Result<()>');"
        ).expect("init tables");

        // Chinese 3-gram query
        let hits_zh = search_fts5_bm25(&conn, "倒数排名", 10).expect("query zh");
        assert_eq!(hits_zh.len(), 1);
        assert_eq!(hits_zh[0].0, "c2");
        assert_eq!(hits_zh[0].1, 1);

        // Code identifier query
        let hits_code = search_fts5_bm25(&conn, "stuart_open_url", 10).expect("query code");
        assert_eq!(hits_code.len(), 1);
        assert_eq!(hits_code[0].0, "c3");

        // Adversarial query that would crash without escaping
        let hits_adv = search_fts5_bm25(&conn, "query with \"unmatched AND OR (broken", 10).expect("query adv");
        assert_eq!(hits_adv.len(), 0);
    }
}
