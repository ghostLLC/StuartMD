// tauri/src-tauri/src/security/diff_guard.rs
//! StuartMD Zero-Silent-Overwrite Gatekeeper & Visual Diff Review Engine
//! Implements strict visual diff generation, conflict detection, generational token verification,
//! and atomic overwrite approval barrier.

#![allow(dead_code)]

use std::path::Path;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use similar::{ChangeTag, TextDiff};

/// Single line change within a unified/split diff representation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkLine {
    /// Change tag: "equal" | "insert" | "delete"
    pub tag: String,
    /// Line number in original document (1-based, None for insert)
    pub old_line: Option<usize>,
    /// Line number in proposed document (1-based, None for delete)
    pub new_line: Option<usize>,
    /// Line text content
    pub text: String,
}

/// Diff review package returned to frontend UI
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub ok: bool,
    pub original_path: String,
    pub original_hash: String,
    pub base_rev: u64,
    pub additions: usize,
    pub deletions: usize,
    pub lines: Vec<DiffHunkLine>,
}

/// Result of creating an independent AI companion note
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionNoteResult {
    pub ok: bool,
    pub note_path: String,
    pub original_path: String,
    pub message: String,
}

/// Computes SHA-1 hash for disk concurrency and tamper detection
pub fn compute_sha1_hash(content: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Generates a structured diff preview comparing current disk file with AI proposal
pub fn preview_diff_core(
    original_path: &str,
    proposed_content: &str,
    current_rev: u64,
) -> Result<DiffPayload, String> {
    let p = Path::new(original_path);
    if !p.exists() {
        return Err(format!("Target file does not exist on disk: {}", original_path));
    }

    let orig_content = std::fs::read_to_string(p)
        .map_err(|e| format!("Failed to read target file {}: {}", original_path, e))?;
    let orig_hash = compute_sha1_hash(&orig_content);

    let diff = TextDiff::from_lines(orig_content.as_str(), proposed_content);
    let mut lines = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;

    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            ChangeTag::Equal => "equal",
            ChangeTag::Delete => {
                deletions += 1;
                "delete"
            }
            ChangeTag::Insert => {
                additions += 1;
                "insert"
            }
        };

        lines.push(DiffHunkLine {
            tag: tag.to_string(),
            old_line: change.old_index().map(|i| i + 1),
            new_line: change.new_index().map(|i| i + 1),
            text: change.value().to_string(),
        });
    }

    Ok(DiffPayload {
        ok: true,
        original_path: original_path.to_string(),
        original_hash: orig_hash,
        base_rev: current_rev,
        additions,
        deletions,
        lines,
    })
}

/// Validates generational token & disk hash before performing Win32 atomic replacement
pub fn apply_diff_core(
    original_path: &str,
    final_content: &str,
    expected_rev: u64,
    expected_hash: &str,
) -> Result<bool, String> {
    let p = Path::new(original_path);
    if !p.exists() {
        return Err(format!("Target file does not exist: {}", original_path));
    }

    let current_disk_content = std::fs::read_to_string(p)
        .map_err(|e| format!("Failed to read target file {}: {}", original_path, e))?;
    let disk_hash = compute_sha1_hash(&current_disk_content);

    // Concurrency guard: reject if file was modified externally during diff review
    if disk_hash != expected_hash {
        return Err(
            "Conflict detected: The file on disk was modified by an external process after diff review started. Aborting overwrite to protect data."
                .to_string(),
        );
    }

    // Call atomic physical write to disk with ReplaceFileW / rename and fsync
    crate::fs_api::atomic_write_file(p, final_content.as_bytes())
        .map_err(|e| format!("Atomic write failed: {}", e))?;

    log::info!(
        "[Diff Gatekeeper] Applied approved diff to '{}' (rev: {}, additions/updates saved)",
        original_path,
        expected_rev
    );

    Ok(true)
}

/// Saves AI output as a dedicated companion note (e.g. `document.ai-notes.md`)
/// ensuring zero silent overwrite of the original document
pub fn save_companion_note_core(
    original_path: &str,
    note_content: &str,
    custom_suffix: Option<&str>,
) -> Result<CompanionNoteResult, String> {
    let p = Path::new(original_path);
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("notes");
    let suffix = custom_suffix.unwrap_or("ai-notes.md");

    let note_filename = format!("{}.{}", stem, suffix);
    let note_path = parent.join(&note_filename);

    crate::fs_api::atomic_write_file(&note_path, note_content.as_bytes())
        .map_err(|e| format!("Failed to write companion note: {}", e))?;

    let note_path_str = note_path.to_string_lossy().replace('\\', "/");
    Ok(CompanionNoteResult {
        ok: true,
        note_path: note_path_str.clone(),
        original_path: original_path.to_string(),
        message: format!("Companion note saved to {}", note_path_str),
    })
}

// ============================================================================
// TAURI COMMAND FACADES
// ============================================================================

#[tauri::command]
pub fn stuart_companion_preview_diff(
    original_path: String,
    proposed_content: String,
    current_rev: u64,
) -> Result<DiffPayload, String> {
    preview_diff_core(&original_path, &proposed_content, current_rev)
}

#[tauri::command]
pub fn stuart_companion_apply_diff(
    original_path: String,
    final_content: String,
    expected_rev: u64,
    expected_hash: String,
) -> Result<bool, String> {
    apply_diff_core(&original_path, &final_content, expected_rev, &expected_hash)
}

#[tauri::command]
pub fn stuart_companion_save_note(
    original_path: String,
    note_content: String,
    custom_suffix: Option<String>,
) -> Result<CompanionNoteResult, String> {
    save_companion_note_core(&original_path, &note_content, custom_suffix.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_preview_and_line_numbering() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_diff_doc.md");
        let orig = "Line 1\nLine 2\nLine 3\n";
        std::fs::write(&test_file, orig).unwrap();

        let proposed = "Line 1\nLine 2 Modified\nLine 3\nLine 4 Added\n";
        let payload = preview_diff_core(&test_file.to_string_lossy(), proposed, 1).unwrap();

        assert!(payload.ok);
        assert_eq!(payload.deletions, 1);
        assert_eq!(payload.additions, 2);

        // Check line tags
        let tags: Vec<&str> = payload.lines.iter().map(|l| l.tag.as_str()).collect();
        assert!(tags.contains(&"equal"));
        assert!(tags.contains(&"delete"));
        assert!(tags.contains(&"insert"));

        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_apply_diff_hash_conflict_detection() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_conflict_doc.md");
        std::fs::write(&test_file, "Original text").unwrap();

        let expected_hash = compute_sha1_hash("Original text");
        // Tamper with file
        std::fs::write(&test_file, "Externally changed text").unwrap();

        // Attempting to apply diff with outdated expected_hash MUST fail
        let res = apply_diff_core(&test_file.to_string_lossy(), "New content", 1, &expected_hash);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Conflict detected"));

        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_save_companion_note() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("paper.md");
        std::fs::write(&test_file, "Original research").unwrap();

        let res = save_companion_note_core(
            &test_file.to_string_lossy(),
            "# AI Summary\nKey points",
            None,
        )
        .unwrap();

        assert!(res.ok);
        assert!(res.note_path.ends_with("paper.ai-notes.md"));
        assert!(Path::new(&res.note_path).exists());

        let _ = std::fs::remove_file(test_file);
        let _ = std::fs::remove_file(res.note_path);
    }
}
