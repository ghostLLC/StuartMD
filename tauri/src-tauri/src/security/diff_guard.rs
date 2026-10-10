// tauri/src-tauri/src/security/diff_guard.rs
//! StuartMD Zero-Silent-Overwrite Gatekeeper & Visual Diff Review Engine
//! Implements strict visual diff generation, conflict detection, generational token verification,
//! and atomic overwrite approval barrier.

#![allow(dead_code)]

use std::path::Path;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use similar::{ChangeTag, TextDiff};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use crate::document::{DocumentService, DiskRevision, SavePayload, SaveRequest, SaveResult, SaveStatus, SourceEdit};

#[derive(Clone)]
struct WriteApproval {
    owner: String,
    document_id: String,
    path: String,
    editor_revision: u64,
    disk_revision: DiskRevision,
    original_hash: String,
    proposal_hash: String,
}
static APPROVALS: LazyLock<Mutex<HashMap<String, WriteApproval>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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
    pub document_id: String,
    pub approval_id: String,
    pub proposal_hash: String,
    pub disk_revision: Option<DiskRevision>,
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
        document_id: String::new(),
        approval_id: String::new(),
        proposal_hash: crate::document::identity::sha256(proposed_content.as_bytes()),
        disk_revision: Some(crate::document::identity::read_disk(p)?.0),
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

    let service = DocumentService::new(crate::fs_api::data_dir())?;
    let read = service.read("trusted-diff", p)?;
    let result = service.save("trusted-diff", SaveRequest {
        operation_id: uuid::Uuid::new_v4().to_string(), document_id: read.document_id,
        editor_revision: expected_rev, target_path: original_path.into(), expected_disk_revision: read.disk_revision,
        payload: SavePayload::TextEdits { encoding: read.encoding.ok_or("文档编码尚未确认")?, bom: read.bom,
            source_edits: vec![SourceEdit { from: 0, to: current_disk_content.encode_utf16().count(), inserted_text: final_content.into() }] },
    })?;
    if result.result == SaveStatus::Conflict { return Err("Conflict detected: 保存过程中原文件发生变化，内容已经保留".into()); }

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

    let service = DocumentService::new(crate::fs_api::data_dir())?;
    let read = service.new_document("trusted-note")?;
    let result = service.save("trusted-note", SaveRequest { operation_id: uuid::Uuid::new_v4().to_string(), document_id: read.document_id,
        editor_revision: 1, target_path: note_path.to_string_lossy().into_owned(), expected_disk_revision: DiskRevision::absent(),
        payload: SavePayload::TextEdits { encoding: "utf-8".into(), bom: false, source_edits: vec![SourceEdit { from: 0, to: 0, inserted_text: note_content.into() }] } })?;
    if result.result == SaveStatus::Conflict { return Err("伴读笔记目标已经存在，请选择新的文件名".into()); }

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
    window: tauri::WebviewWindow,
    service: tauri::State<'_, DocumentService>,
    document_id: String,
    original_path: String,
    proposed_content: String,
    current_rev: u64,
) -> Result<DiffPayload, String> {
    let canonical = crate::fs_api::ensure_window_read_allowed(&window, &original_path)?;
    let snapshot = service.snapshot_for_window(window.label(), &document_id)?;
    if snapshot.revision != current_rev { return Err("AI 修改预览的编辑版本已经变化".into()); }
    if snapshot.kind != "markdown" || snapshot.path.as_deref().map(Path::new).map(crate::document::identity::canonical_target).transpose()?.as_ref() != Some(&canonical) { return Err("AI 修改目标与文档身份不一致".into()); }
    let disk_revision = crate::document::identity::read_disk(&canonical)?.0;
    if !disk_revision.same_content_and_identity(&snapshot.disk_revision) { return Err("AI 修改预览前磁盘内容已经变化，请检查保存冲突".into()); }
    let mut payload = preview_diff_core(&original_path, &proposed_content, current_rev)?;
    let approval_id = uuid::Uuid::new_v4().to_string();
    let original_hash = compute_sha1_hash(&snapshot.source);
    payload.document_id = document_id.clone();
    payload.approval_id = approval_id.clone();
    payload.original_hash = original_hash.clone();
    payload.disk_revision = Some(disk_revision.clone());
    APPROVALS.lock().map_err(|_| "AI 修改确认记录锁损坏")?.insert(approval_id, WriteApproval { owner: window.label().into(), document_id, path: original_path, editor_revision: current_rev, disk_revision, original_hash, proposal_hash: payload.proposal_hash.clone() });
    Ok(payload)
}

#[tauri::command]
pub fn stuart_companion_apply_diff(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, DocumentService>,
    document_id: String,
    approval_id: String,
    original_path: String,
    final_content: String,
    expected_rev: u64,
    expected_hash: String,
) -> Result<SaveResult, String> {
    let approval = APPROVALS.lock().map_err(|_| "AI 修改确认记录锁损坏")?.get(&approval_id).cloned().ok_or("AI 修改缺少有效确认凭据")?;
    if approval.owner != window.label() || approval.document_id != document_id || approval.path != original_path || approval.editor_revision != expected_rev || approval.original_hash != expected_hash || approval.proposal_hash != crate::document::identity::sha256(final_content.as_bytes()) { return Err("AI 修改确认凭据与目标、版本或正文不一致".into()); }
    let current = service.snapshot_for_window(window.label(), &document_id)?;
    if current.revision != expected_rev || compute_sha1_hash(&current.source) != expected_hash { return Err("AI 修改确认期间文档已经编辑，请重新检查差异".into()); }
    crate::fs_api::ensure_window_write_allowed(&window, &original_path)?;
    let state = service.state(window.label(), &document_id)?;
    let result = service.save(window.label(), SaveRequest { operation_id: uuid::Uuid::new_v4().to_string(), document_id, editor_revision: expected_rev + 1, target_path: original_path, expected_disk_revision: approval.disk_revision,
        payload: SavePayload::TextEdits { encoding: state.encoding.ok_or("文档编码尚未确认")?, bom: state.bom, source_edits: vec![SourceEdit { from: 0, to: state.source.ok_or("文档编码尚未确认")?.encode_utf16().count(), inserted_text: final_content }] } })?;
    APPROVALS.lock().map_err(|_| "AI 修改确认记录锁损坏")?.remove(&approval_id);
    Ok(result)
}

#[tauri::command]
pub fn stuart_companion_save_note(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, DocumentService>,
    original_path: String,
    note_content: String,
    custom_suffix: Option<String>,
) -> Result<CompanionNoteResult, String> {
    let original = crate::fs_api::ensure_window_read_allowed(&window, &original_path)?;
    let suffix = custom_suffix.as_deref().unwrap_or("ai-notes.md");
    if suffix.contains(['/', '\\']) || !suffix.ends_with(".md") { return Err("伴读笔记后缀必须为当前目录中的 Markdown 文件名".into()); }
    let stem = original.file_stem().and_then(|stem| stem.to_str()).ok_or("原文件名无效")?;
    let target = original.with_file_name(format!("{stem}.{suffix}"));
    crate::fs_api::register_window_path(&window, &crate::document::identity::display_path(&target))?;
    let read = service.new_document(window.label())?;
    let result = service.save(window.label(), SaveRequest { operation_id: uuid::Uuid::new_v4().to_string(), document_id: read.document_id, editor_revision: 1, target_path: crate::document::identity::display_path(&target), expected_disk_revision: DiskRevision::absent(), payload: SavePayload::TextEdits { encoding: "utf-8".into(), bom: false, source_edits: vec![SourceEdit { from: 0, to: 0, inserted_text: note_content }] } })?;
    if result.result == SaveStatus::Conflict { return Err("伴读笔记目标已经存在，请选择新的文件名".into()); }
    Ok(CompanionNoteResult { ok: true, note_path: crate::document::identity::display_path(&target), original_path, message: "伴读笔记已经保存".into() })
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
