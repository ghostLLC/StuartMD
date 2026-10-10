use super::*;
use std::fs;

fn directory() -> std::path::PathBuf {
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace = if workspace.ends_with("src-tauri") || workspace.ends_with("native-documents") { workspace.parent().unwrap().parent().unwrap() } else { workspace.as_path() };
    let path = workspace.join("tests/native-artifacts/doc-completion").join(format!("document-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn request(read: &DocumentReadResult, text: &str, revision: u64) -> SaveRequest {
    SaveRequest {
        operation_id: uuid::Uuid::new_v4().to_string(), document_id: read.document_id.clone(), editor_revision: revision,
        target_path: read.path.clone().unwrap(), expected_disk_revision: read.disk_revision.clone(),
        payload: SavePayload::TextEdits { encoding: read.encoding.clone().unwrap(), bom: read.bom,
            source_edits: vec![SourceEdit { from: 0, to: read.source.as_ref().unwrap().encode_utf16().count(), inserted_text: text.into() }] },
    }
}

#[test]
fn actual_encodings_preserve_original_bytes_and_reject_unrepresentable_characters() {
    let directory = directory();
    let service = DocumentService::new(directory.join("data")).unwrap();
    for (name, bom) in [("utf-8", false), ("utf-8", true), ("utf-16le", true), ("utf-16be", true), ("gbk", false), ("gb18030", false)] {
        let bytes = encoding::encode("中文\r\nHello\n终点", name, bom).unwrap();
        let path = directory.join(format!("{}-{}.md", name, bom));
        fs::write(&path, &bytes).unwrap();
        let mut read = service.read("main", &path).unwrap();
        if read.source.is_none() { read = service.confirm_encoding("main", &read.document_id, name).unwrap(); }
        let mut unchanged = request(&read, read.source.as_ref().unwrap(), 1);
        unchanged.payload = SavePayload::TextEdits { encoding: name.into(), bom, source_edits: vec![] };
        assert_eq!(service.save("main", unchanged).unwrap().result, SaveStatus::Saved);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        if name == "gbk" {
            let current = service.read("main", &path).unwrap();
            let current = service.confirm_encoding("main", &current.document_id, "gbk").unwrap();
            assert!(service.save("main", request(&current, "新增😀", 2)).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn stale_disk_revision_retains_base_local_and_external_content() {
    let directory = directory();
    let path = directory.join("document.md");
    fs::write(&path, "基础内容").unwrap();
    let service = DocumentService::new(directory.join("data")).unwrap();
    let read = service.read("main", &path).unwrap();
    fs::write(&path, "外部内容").unwrap();
    let result = service.save("main", request(&read, "本地内容", 1)).unwrap();
    assert_eq!(result.result, SaveStatus::Conflict);
    let conflict = result.conflict.unwrap();
    assert_eq!(conflict.base_bytes, "基础内容".as_bytes());
    assert_eq!(conflict.local_bytes, "本地内容".as_bytes());
    assert_eq!(conflict.external_bytes, "外部内容".as_bytes());
    assert_eq!(fs::read_to_string(path).unwrap(), "外部内容");
    assert_eq!(service.save_operations().unwrap()[0].stage, "Conflict");
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn restarted_save_recovery_reads_verified_versions_and_copies_exact_bytes() {
    let directory=directory();let data=directory.join("data");let path=directory.join("恢复文档.md");
    let base=encoding::encode("基础正文\r\n😀","utf-16le",true).unwrap();fs::write(&path,&base).unwrap();
    let service=DocumentService::new(data.clone()).unwrap();let read=service.read("main",&path).unwrap();
    let external=encoding::encode("外部正文\r\n😀","utf-16le",true).unwrap();fs::write(&path,&external).unwrap();
    let conflict=service.save("main",request(&read,"本地正文\r\n😀",1)).unwrap();service.flush().unwrap();drop(service);
    let restarted=DocumentService::new(data).unwrap();
    for (version,expected) in [("base",base),("external",external),("local",encoding::encode("本地正文\r\n😀","utf-16le",true).unwrap())] {
        let actual=restarted.save_operation_read(&conflict.operation_id,version,None).unwrap();assert_eq!(actual.bytes,expected);assert!(actual.source.unwrap().contains("正文\r\n😀"));
        let target=directory.join(format!("{version}.md"));let copied=restarted.save_operation_copy("recovery-window",&conflict.operation_id,version,&target).unwrap();assert_eq!(copied.result,SaveStatus::Saved);assert_eq!(fs::read(&target).unwrap(),expected);
        assert!(restarted.save_operation_copy("recovery-window",&conflict.operation_id,version,&target).is_err());
    }
    let operation=restarted.save_operations().unwrap().into_iter().find(|operation|operation.operation_id==conflict.operation_id).unwrap();
    fs::write(&operation.local_path,b"incomplete").unwrap();assert!(restarted.save_operation_read(&conflict.operation_id,"local",None).is_err());
    drop(restarted);fs::remove_dir_all(directory).unwrap();
}

#[test]
fn utf16_edits_preserve_mixed_newlines_and_validate_surrogate_boundaries() {
    let directory = directory();
    let path = directory.join("document.md");
    let original = "甲\r\n😀\n乙\r\n\r\n";
    fs::write(&path, original).unwrap();
    let service = DocumentService::new(directory.join("data")).unwrap();
    let read = service.read("main", &path).unwrap();
    let mut edit = request(&read, "", 1);
    edit.payload = SavePayload::TextEdits { encoding: "utf-8".into(), bom: false, source_edits: vec![SourceEdit { from: 3, to: 4, inserted_text: "坏".into() }] };
    assert!(service.save("main", edit).is_err());
    let mut edit = request(&read, "", 1);
    edit.payload = SavePayload::TextEdits { encoding: "utf-8".into(), bom: false, source_edits: vec![SourceEdit { from: 3, to: 5, inserted_text: "新😀".into() }] };
    assert_eq!(service.save("main", edit).unwrap().result, SaveStatus::Saved);
    assert_eq!(fs::read_to_string(path).unwrap(), "甲\r\n新😀\n乙\r\n\r\n");
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn real_sqlite_journal_restores_empty_untitled_and_newer_edits_after_save() {
    let directory = directory();
    let data = directory.join("data");
    let service = DocumentService::new(data.clone()).unwrap();
    let read = service.new_document("main").unwrap();
    for (revision, source) in [(1, "已有正文"), (2, "")] {
        service.write_journal("main", JournalSnapshot { document_id: read.document_id.clone(), revision, source: source.into(), path: None, title: "未保存文档".into(), source_edits: vec![] }).unwrap();
    }
    assert!(service.write_journal("main", JournalSnapshot { document_id: read.document_id.clone(), revision: 1, source: "迟到内容".into(), path: None, title: "未保存文档".into(), source_edits: vec![] }).is_err());
    service.flush().unwrap();
    drop(service);
    let restarted = DocumentService::new(data).unwrap();
    let restored = restarted.restore("new-window", &read.document_id).unwrap();
    assert_eq!(restored.source, "");
    assert_eq!(restored.entry.revision, 2);
    assert!(restored.entry.path.is_none());
    assert_eq!(restarted.journal_list().unwrap().len(), 1);
    restarted.discard(&read.document_id).unwrap();
    assert!(restarted.journal_list().unwrap().is_empty());
    drop(restarted);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn legacy_drafts_import_is_idempotent_and_preserves_orphan_source() {
    let directory = directory();
    let data = directory.join("data");
    fs::create_dir_all(data.join("drafts")).unwrap();
    let legacy = data.join("drafts/unknown-path.md");
    fs::write(&legacy, "旧草稿\r\n完整正文").unwrap();
    let service = DocumentService::new(data.clone()).unwrap();
    assert_eq!(service.import_legacy(&[]).unwrap(), 1);
    assert_eq!(service.import_legacy(&[]).unwrap(), 0);
    let entries = service.journal_list().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(service.journal_read(&entries[0].document_id).unwrap().source, "旧草稿\r\n完整正文");
    assert!(legacy.exists());
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn older_save_preserves_newer_draft_and_save_as_identity() {
    let directory = directory();
    let path = directory.join("original.md");
    let destination = directory.join("saved-as.md");
    fs::write(&path, "原文").unwrap();
    let service = DocumentService::new(directory.join("data")).unwrap();
    let read = service.read("main", &path).unwrap();
    service.write_journal("main", JournalSnapshot { document_id: read.document_id.clone(), revision: 2, source: "保存期间继续编辑".into(), path: read.path.clone(), title: "实际文档".into(), source_edits: vec![] }).unwrap();
    let mut captured = request(&read, "保存快照", 1);
    captured.target_path = destination.to_string_lossy().into_owned();
    captured.expected_disk_revision = DiskRevision::absent();
    assert_eq!(service.save("main", captured).unwrap().result, SaveStatus::Saved);
    let journal = service.journal_read(&read.document_id).unwrap();
    assert_eq!(journal.source, "保存期间继续编辑");
    assert_eq!(journal.entry.revision, 2);
    assert_eq!(journal.entry.persisted_revision, 1);
    assert_eq!(journal.entry.path, Some(identity::canonical_target(&destination).unwrap().to_string_lossy().into_owned()));
    assert_eq!(service.journal_list().unwrap().len(), 1);
    assert_eq!(fs::read_to_string(path).unwrap(), "原文");
    assert_eq!(fs::read_to_string(destination).unwrap(), "保存快照");
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn annotation_json_export_preserves_source_document_identity_and_unsaved_draft() {
    let directory = directory();
    let target = directory.join("source.md");
    let sidecar = directory.join("annotations.json");
    fs::write(&target, "原文\r\n").unwrap();
    let service = DocumentService::new(directory.join("data")).unwrap();
    let read = service.read("window", &target).unwrap();
    service.write_journal("window", JournalSnapshot { document_id: read.document_id.clone(), revision: 1, source: "待保存原文\r\n".into(), path: read.path.clone(), title: "原文".into(), source_edits: vec![] }).unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({"items": [], "sourceDiskRevision": read.disk_revision})).unwrap();
    let result = service.save("window", SaveRequest { operation_id: uuid::Uuid::new_v4().to_string(), document_id: read.document_id.clone(), editor_revision: 1, target_path: sidecar.to_string_lossy().into_owned(), expected_disk_revision: DiskRevision::absent(), payload: SavePayload::ValidatedBytes { validation_hash: identity::sha256(&bytes), bytes, producer: "json-annotations".into() } }).unwrap();
    assert_eq!(result.result, SaveStatus::Saved);
    let source = service.snapshot_for_window("window", &read.document_id).unwrap();
    assert_eq!(source.path, read.path);
    assert_eq!(source.source, "待保存原文\r\n");
    assert_eq!(service.journal_list().unwrap().len(), 1);
    assert_eq!(fs::read_to_string(target).unwrap(), "原文\r\n");
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn save_as_retains_journal_captured_before_target_change() {
    let directory = directory();
    let target = directory.join("original.md");
    let destination = directory.join("save-as.md");
    fs::write(&target, "原文").unwrap();
    let service = DocumentService::new(directory.join("data")).unwrap();
    let read = service.read("window", &target).unwrap();
    let mut saved = request(&read, "保存正文", 1);
    saved.target_path = destination.to_string_lossy().into_owned();
    saved.expected_disk_revision = DiskRevision::absent();
    service.save("window", saved).unwrap();
    service.write_journal("window", JournalSnapshot { document_id: read.document_id.clone(), revision: 2, source: "随后输入正文".into(), path: read.path.clone(), title: "原文".into(), source_edits: vec![] }).unwrap();
    let recovered = service.journal_read(&read.document_id).unwrap();
    assert_eq!(recovered.entry.path, Some(identity::display_path(&identity::canonical_target(&destination).unwrap())));
    assert_eq!(recovered.source, "随后输入正文");
    assert_eq!(recovered.entry.persisted_revision, 1);
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}
