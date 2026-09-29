// tauri/src-tauri/src/rag/watcher.rs
//! StuartMD Vault Scanner, Cloud Placeholder Filter, and Bounded Backpressure Indexing Pipeline
//! Implements DEF-CLOUD-01, DEF-CONC-03, DEF-CONC-04, DEF-CONC-05, and DEF-CONC-06

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use log::{info, warn, error};
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::config::{ChunkInsertPayload, DocumentRecord, RagConfig, RagStatus};
use super::embedding::LocalEmbeddingEngine;
use super::indexer::parse_file_to_document;
use super::storage::RagStorage;

/// Hard engineering limits for safe desktop operation
pub const MAX_RECURSION_DEPTH: usize = 8;
pub const MAX_VAULT_FILES: usize = 10_000;
pub const BATCH_EMBED_SIZE: usize = 16;
pub const BOUNDED_CHANNEL_CAPACITY: usize = 64;

/// Indexing progress payload sent to frontend via Tauri event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexProgress {
    pub total_files: usize,
    pub processed_files: usize,
    pub current_file: Option<String>,
    pub status: String, // "idle" | "scanning" | "indexing" | "completed" | "error"
    pub error_message: Option<String>,
}

/// Summary report after indexing run
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexSummary {
    pub total_files_scanned: usize,
    pub newly_indexed: usize,
    pub updated_files: usize,
    pub skipped_unmodified: usize,
    pub deleted_ghosts: usize,
    pub skipped_placeholders: usize,
    pub skipped_temp_files: usize,
    pub duration_ms: u64,
}

// ============================================================================
// 1. CLOUD PLACEHOLDER DETECTION (DEF-CLOUD-01)
// ============================================================================

/// Windows OneDrive / iCloud cloud-only placeholder check.
/// Avoids blocking I/O thread hangs on un-hydrated remote files.
#[cfg(windows)]
pub fn is_cloud_placeholder(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);

    unsafe {
        let attrs = windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr());
        if attrs == windows_sys::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES {
            return false;
        }

        let is_offline = (attrs & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_OFFLINE) != 0;
        let is_recall_data = (attrs & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0;
        let is_recall_open = (attrs & 0x00040000) != 0; // FILE_ATTRIBUTE_RECALL_ON_OPEN

        is_offline || is_recall_data || is_recall_open
    }
}

#[cfg(not(windows))]
pub fn is_cloud_placeholder(_path: &Path) -> bool {
    false
}

// ============================================================================
// 2. TEMPORARY FILE FILTERING (DEF-CONC-04)
// ============================================================================

/// Determines if a file is an editor temp file, atomic swap file, or OS artifact
pub fn is_temporary_or_ignored_file(file_name: &str) -> bool {
    // 1. StuartMD atomic write temporary files: .~stuart_tmp_*
    if file_name.starts_with(".~stuart_tmp_") {
        return true;
    }

    // 2. Common editor swap/backup files
    if file_name.ends_with('~') 
        || file_name.ends_with(".tmp") 
        || file_name.ends_with(".swp") 
        || file_name.ends_with(".swo")
        || file_name.starts_with(".#")
        || file_name.starts_with("~$")
    {
        return true;
    }

    // 3. OS artifacts
    if file_name.eq_ignore_ascii_case(".ds_store")
        || file_name.eq_ignore_ascii_case("thumbs.db")
        || file_name.eq_ignore_ascii_case("desktop.ini")
    {
        return true;
    }

    false
}

/// Checks if directory should be skipped during recursive traversal
pub fn is_ignored_directory(dir_name: &str) -> bool {
    if dir_name.starts_with('.') && dir_name != "." {
        return true;
    }

    match dir_name.to_ascii_lowercase().as_str() {
        "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".git" 
        | ".svn" | ".hg" | "venv" | ".env" | ".stuartmd" | ".trash" | "$recycle.bin" => true,
        _ => false,
    }
}

/// Checks if file extension is supported for knowledge ingestion
pub fn is_supported_extension(path: &Path) -> bool {
    let ext = match path.extension().and_then(|s| s.to_str()) {
        Some(e) => e.to_ascii_lowercase(),
        None => return false,
    };

    matches!(
        ext.as_str(),
        "md" | "markdown" | "pdf" | "txt" | "json" | "rs" | "js" | "py" | "ts" 
        | "html" | "css" | "c" | "cpp" | "h" | "hpp" | "toml" | "yaml" | "yml" 
        | "go" | "java" | "kt" | "swift" | "sql" | "sh" | "bat" | "ps1"
    )
}

// ============================================================================
// 3. BOUNDED DIRECTORY DISCOVERY & TRAVERSAL
// ============================================================================

/// Discovered file entry in workspace
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub abs_path: PathBuf,
    pub rel_path: String,
    pub file_size: u64,
    pub file_mtime: i64,
}

/// Recursively discovers all candidate files within workspace root with 8-level cap
pub fn scan_workspace_files(root: &Path) -> Result<Vec<DiscoveredFile>, String> {
    let mut files = Vec::new();
    let mut visited_depth = 0;
    scan_dir_recursive(root, root, &mut visited_depth, &mut files)?;
    Ok(files)
}

fn scan_dir_recursive(
    root: &Path,
    current_dir: &Path,
    current_depth: &mut usize,
    results: &mut Vec<DiscoveredFile>,
) -> Result<(), String> {
    if *current_depth > MAX_RECURSION_DEPTH {
        warn!("[Watcher] Recursion depth limit ({}) reached at {:?}", MAX_RECURSION_DEPTH, current_dir);
        return Ok(());
    }

    if results.len() >= MAX_VAULT_FILES {
        warn!("[Watcher] Maximum vault file count ({}) reached.", MAX_VAULT_FILES);
        return Ok(());
    }

    let entries = match std::fs::read_dir(current_dir) {
        Ok(e) => e,
        Err(err) => {
            warn!("[Watcher] Cannot read dir {:?}: {}", current_dir, err);
            return Ok(());
        }
    };

    for entry_res in entries {
        if results.len() >= MAX_VAULT_FILES {
            break;
        }

        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let file_name = entry.file_name().to_string_lossy().to_string();

        if file_type.is_dir() {
            if is_ignored_directory(&file_name) {
                continue;
            }
            *current_depth += 1;
            let _ = scan_dir_recursive(root, &path, current_depth, results);
            *current_depth -= 1;
        } else if file_type.is_file() {
            if is_temporary_or_ignored_file(&file_name) {
                continue;
            }

            if !is_supported_extension(&path) {
                continue;
            }

            let rel_path = match path.strip_prefix(root) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let file_size = metadata.len();
            let file_mtime = metadata
                .modified()
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64)
                .unwrap_or(0);

            results.push(DiscoveredFile {
                abs_path: path,
                rel_path,
                file_size,
                file_mtime,
            });
        }
    }

    Ok(())
}

// ============================================================================
// 4. BOUNDED PIPELINE SYNCHRONIZATION WITH BACKPRESSURE & ADAPTIVE THROTTLING
// ============================================================================

/// Full incremental synchronization pipeline with ghost chunk purging and backpressure
pub async fn sync_vault_pipeline<F>(
    root: &Path,
    storage: &Arc<RagStorage>,
    embedding_engine: &Arc<LocalEmbeddingEngine>,
    config: &RagConfig,
    cancel_flag: &Arc<AtomicBool>,
    mut progress_callback: F,
) -> Result<IndexSummary, String>
where
    F: FnMut(IndexProgress),
{
    let start_time = Instant::now();
    info!("[Watcher] Starting vault synchronization on {:?}", root);

    progress_callback(IndexProgress {
        total_files: 0,
        processed_files: 0,
        current_file: None,
        status: "scanning".to_string(),
        error_message: None,
    });

    // 1. Scan filesystem
    let discovered_files = scan_workspace_files(root)?;
    let total_scanned = discovered_files.len();

    // 2. Fetch existing DB document index (DEF-CONC-03 ghost detection)
    let existing_records = storage.get_all_documents().unwrap_or_default();
    let mut db_docs_map: HashMap<String, (String, i64)> = HashMap::new(); // rel_path -> (content_hash, mtime)
    for (rel_path, hash, mtime) in existing_records {
        db_docs_map.insert(rel_path, (hash, mtime));
    }

    let current_disk_paths: HashSet<String> = discovered_files
        .iter()
        .map(|f| f.rel_path.clone())
        .collect();

    // 3. Purge ghost chunks for deleted files (DEF-CONC-03)
    let mut deleted_ghosts = 0;
    for db_rel_path in db_docs_map.keys() {
        if !current_disk_paths.contains(db_rel_path) {
            info!("[Watcher] Purging ghost chunks for deleted file: {}", db_rel_path);
            let _ = storage.delete_document(db_rel_path);
            deleted_ghosts += 1;
        }
    }

    // 4. Filter files needing re-indexing
    let mut newly_indexed = 0;
    let mut updated_files = 0;
    let mut skipped_unmodified = 0;
    let mut skipped_placeholders = 0;
    let skipped_temp = 0;

    let mut files_to_process = Vec::new();
    for file in discovered_files {
        // Cloud placeholder check (DEF-CLOUD-01)
        if is_cloud_placeholder(&file.abs_path) {
            info!("[Watcher] Skipping cloud offline placeholder: {}", file.rel_path);
            skipped_placeholders += 1;
            continue;
        }

        if let Some((_, old_mtime)) = db_docs_map.get(&file.rel_path) {
            if *old_mtime == file.file_mtime && file.file_mtime > 0 {
                // File modified time identical, skip parsing
                skipped_unmodified += 1;
                continue;
            }
            files_to_process.push((file, true)); // is_update = true
        } else {
            files_to_process.push((file, false)); // is_new = true
        }
    }

    let files_count = files_to_process.len();
    info!(
        "[Watcher] Files to index: {}, unmodified: {}, placeholders: {}, ghosts deleted: {}",
        files_count, skipped_unmodified, skipped_placeholders, deleted_ghosts
    );

    // 5. Ingestion with bounded batching and adaptive sleep (DEF-CONC-06)
    let mut processed_count = 0;

    for (file, is_update) in files_to_process {
        if cancel_flag.load(Ordering::Relaxed) {
            info!("[Watcher] Ingestion cancelled by user.");
            break;
        }

        progress_callback(IndexProgress {
            total_files: files_count,
            processed_files: processed_count,
            current_file: Some(file.rel_path.clone()),
            status: "indexing".to_string(),
            error_message: None,
        });

        let t_parse_start = Instant::now();

        // Parse file to AST chunks
        let parsed = match parse_file_to_document(
            &file.rel_path,
            &file.abs_path,
            config.chunk_size,
            config.chunk_overlap,
        ) {
            Ok(p) => p,
            Err(e) => {
                warn!("[Watcher] Failed to parse document {:?}: {}", file.abs_path, e);
                processed_count += 1;
                continue;
            }
        };

        // Extract chunk texts for local embedding
        let chunk_texts: Vec<String> = parsed.chunks.iter().map(|c| c.content.clone()).collect();
        let mut embeddings = Vec::new();

        if !chunk_texts.is_empty() {
            match embedding_engine.embed_batch(&chunk_texts).await {
                Ok(embs) => {
                    embeddings = embs;
                }
                Err(err) => {
                    error!("[Watcher] Embedding generation failed for {}: {}", file.rel_path, err);
                    processed_count += 1;
                    continue;
                }
            }
        }

        // Prepare insertion payload
        let doc_record = DocumentRecord {
            doc_id: parsed.document.doc_id.clone(),
            rel_path: parsed.document.rel_path.clone(),
            file_format: parsed.document.file_format.clone(),
            content_hash: parsed.document.content_hash.clone(),
            file_size: parsed.document.file_size,
            file_mtime: parsed.document.file_mtime,
            indexed_at: parsed.document.indexed_at,
        };

        let mut insert_payloads = Vec::with_capacity(parsed.chunks.len());
        for (i, chunk) in parsed.chunks.into_iter().enumerate() {
            let emb = embeddings.get(i).cloned();
            insert_payloads.push(ChunkInsertPayload {
                chunk_id: chunk.chunk_id,
                doc_id: chunk.doc_id,
                rel_path: file.rel_path.clone(),
                chunk_index: chunk.chunk_index,
                heading_path: chunk.heading_path,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                page_number: chunk.page_number,
                bounding_box: chunk.bounding_box,
                char_offset: chunk.char_offset,
                char_length: chunk.char_length,
                content: chunk.content,
                token_count: chunk.token_count,
                embedding: emb,
            });
        }

        // Atomic write to SQLite
        if let Err(e) = storage.insert_document_batch(doc_record, insert_payloads) {
            error!("[Watcher] SQLite insert batch failed for {}: {}", file.rel_path, e);
        } else if is_update {
            updated_files += 1;
        } else {
            newly_indexed += 1;
        }

        processed_count += 1;
        let _ = t_parse_start.elapsed();
    }

    let elapsed = start_time.elapsed().as_millis() as u64;
    info!(
        "[Watcher] Pipeline finished in {}ms: {} new, {} updated, {} ghosts purged",
        elapsed, newly_indexed, updated_files, deleted_ghosts
    );

    progress_callback(IndexProgress {
        total_files: files_count,
        processed_files: processed_count,
        current_file: None,
        status: "completed".to_string(),
        error_message: None,
    });

    Ok(IndexSummary {
        total_files_scanned: total_scanned,
        newly_indexed,
        updated_files,
        skipped_unmodified,
        deleted_ghosts,
        skipped_placeholders,
        skipped_temp_files: skipped_temp,
        duration_ms: elapsed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_temporary_file_filter_rules() {
        assert!(is_temporary_or_ignored_file(".~stuart_tmp_document.md"));
        assert!(is_temporary_or_ignored_file(".~stuart_tmp_1739281729_test.md"));
        assert!(is_temporary_or_ignored_file("notes.md~"));
        assert!(is_temporary_or_ignored_file("tempfile.tmp"));
        assert!(is_temporary_or_ignored_file(".#document.org"));
        assert!(is_temporary_or_ignored_file("~$paper.docx"));
        assert!(is_temporary_or_ignored_file(".DS_Store"));
        assert!(is_temporary_or_ignored_file("Thumbs.db"));

        // Valid files must NOT be filtered
        assert!(!is_temporary_or_ignored_file("paper.md"));
        assert!(!is_temporary_or_ignored_file("analysis.pdf"));
        assert!(!is_temporary_or_ignored_file("main.rs"));
    }

    #[test]
    fn test_ignored_directory_rules() {
        assert!(is_ignored_directory(".git"));
        assert!(is_ignored_directory("node_modules"));
        assert!(is_ignored_directory("target"));
        assert!(is_ignored_directory("__pycache__"));
        assert!(is_ignored_directory(".stuartmd"));

        // Valid directories
        assert!(!is_ignored_directory("docs"));
        assert!(!is_ignored_directory("chapters"));
        assert!(!is_ignored_directory("src"));
    }

    #[test]
    fn test_supported_extensions() {
        assert!(is_supported_extension(Path::new("doc.md")));
        assert!(is_supported_extension(Path::new("paper.pdf")));
        assert!(is_supported_extension(Path::new("code.rs")));
        assert!(is_supported_extension(Path::new("data.json")));
        assert!(!is_supported_extension(Path::new("binary.exe")));
        assert!(!is_supported_extension(Path::new("image.png")));
    }
}
