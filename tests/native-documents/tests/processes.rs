#[path = "../../../tauri/src-tauri/src/document/mod.rs"]
mod document;

use document::{DocumentService, JournalSnapshot, SavePayload, SaveRequest, SaveResult, SaveStatus, SourceEdit};
use std::fs;
use std::process::Command;

#[test]
fn independent_real_processes_detect_stale_save_and_preserve_all_versions() {
    let directory = std::env::temp_dir().join(format!("stuart-processes-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let target = directory.join("shared.md");
    let data = directory.join("data");
    fs::write(&target, "BASE!").unwrap();
    let service = DocumentService::new(data.clone()).unwrap();
    let first = service.read("first-window", &target).unwrap();
    let second = service.read("second-window", &target).unwrap();
    for (read, owner, local) in [(&first, "first-window", "FIRST"), (&second, "second-window", "OTHER")] {
        service.write_journal(owner, JournalSnapshot { document_id: read.document_id.clone(), revision: 1, source: local.into(), path: read.path.clone(), title: "共享文件".into(), source_edits: vec![] }).unwrap();
    }
    let mut results = Vec::new();
    for (index, read, local) in [(1, &first, "FIRST"), (2, &second, "OTHER")] {
        let request = SaveRequest { operation_id: uuid::Uuid::new_v4().to_string(), document_id: read.document_id.clone(), editor_revision: 1, target_path: read.path.clone().unwrap(), expected_disk_revision: read.disk_revision.clone(), payload: SavePayload::TextEdits { encoding: "utf-8".into(), bom: false, source_edits: vec![SourceEdit { from: 0, to: 5, inserted_text: local.into() }] } };
        let request_file = directory.join(format!("request-{index}.json"));
        fs::write(&request_file, serde_json::to_vec(&request).unwrap()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_stuart-document-verification")).arg("save").arg(&data).arg(&read.document_id).arg(request_file).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        results.push(serde_json::from_slice::<SaveResult>(&output.stdout).unwrap());
    }
    assert_eq!(results[0].result, SaveStatus::Saved);
    assert_eq!(results[1].result, SaveStatus::Conflict);
    let conflict = results[1].conflict.as_ref().unwrap();
    assert_eq!(conflict.base_bytes, b"BASE!");
    assert_eq!(conflict.local_bytes, b"OTHER");
    assert_eq!(conflict.external_bytes, b"FIRST");
    assert_eq!(fs::read(&target).unwrap(), b"FIRST");
    assert!(service.journal_list().unwrap().iter().any(|entry| entry.document_id == second.document_id));
    drop(service);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn actual_denied_directory_write_preserves_document_and_recovery_content() {
    let workspace=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory=workspace.join("tests/native-artifacts").join(format!("permissions-{}",uuid::Uuid::new_v4()));
    let target_dir=directory.join("documents");fs::create_dir_all(&target_dir).unwrap();let target=target_dir.join("actual.md");
    fs::write(&target,"原始正文").unwrap();let service=DocumentService::new(directory.join("data")).unwrap();let read=service.read("permissions",&target).unwrap();
    let access=|deny:bool| {
        let mut command=Command::new("pwsh.exe");command.arg("-NoProfile").arg("-File").arg(workspace.join("tests/native-documents/write-access.ps1")).arg("-Directory").arg(&target_dir);
        if deny {command.arg("-Deny");}
        let output=command.output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    };
    access(true);
    let saved=service.save("permissions",SaveRequest {operation_id:uuid::Uuid::new_v4().to_string(),document_id:read.document_id,editor_revision:1,target_path:read.path.unwrap(),expected_disk_revision:read.disk_revision,
        payload:SavePayload::TextEdits {encoding:"utf-8".into(),bom:false,source_edits:vec![SourceEdit {from:0,to:4,inserted_text:"本地修改".into()}]}});
    access(false);
    assert!(saved.is_err_and(|error|error.contains("拒绝访问") || error.contains("Access is denied")),"实际写入没有产生权限错误");
    assert_eq!(fs::read_to_string(&target).unwrap(),"原始正文");
    let operation=service.save_operations().unwrap().remove(0);assert_eq!(service.save_operation_read(&operation.operation_id,"local",None).unwrap().source.unwrap(),"本地修改");
    drop(service);fs::remove_dir_all(directory).unwrap();
}

#[test]
fn terminating_real_save_process_retains_durable_draft_and_rejects_incomplete_versions() {
    let workspace=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory=workspace.join("tests/native-artifacts").join(format!("process-crash-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&directory).unwrap();
    let target=directory.join("actual.md");let data=directory.join("data");let base="原始内容\r\n".repeat(250_000);let local="本地修改\r\n".repeat(250_000);
    fs::write(&target,&base).unwrap();let service=DocumentService::new(data.clone()).unwrap();let read=service.read("crash-owner",&target).unwrap();
    service.write_journal("crash-owner",JournalSnapshot {document_id:read.document_id.clone(),revision:1,source:local.clone(),path:read.path.clone(),title:"进程终止验证".into(),source_edits:vec![]}).unwrap();service.flush().unwrap();
    let request=SaveRequest {operation_id:uuid::Uuid::new_v4().to_string(),document_id:read.document_id.clone(),editor_revision:1,target_path:read.path.clone().unwrap(),expected_disk_revision:read.disk_revision,
        payload:SavePayload::TextEdits {encoding:"utf-8".into(),bom:false,source_edits:vec![SourceEdit {from:0,to:base.encode_utf16().count(),inserted_text:local.clone()}]}};
    let request_file=directory.join("request.json");fs::write(&request_file,serde_json::to_vec(&request).unwrap()).unwrap();
    let mut worker=Command::new(env!("CARGO_BIN_EXE_stuart-document-verification")).arg("save").arg(&data).arg(&read.document_id).arg(&request_file).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(30);
    let stage=loop {
        if let Some(operation)=service.save_operations().unwrap().into_iter().find(|operation|operation.operation_id==request.operation_id) {
            if operation.stage!="Saved" {worker.kill().unwrap();break operation.stage;}
        }
        if worker.try_wait().unwrap().is_some() {panic!("实际保存进程在观察到中间阶段前已经结束");}
        if std::time::Instant::now()>deadline {worker.kill().unwrap();panic!("保存阶段观察超时");}
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    assert!(!worker.wait().unwrap().success());drop(service);
    let restarted=DocumentService::new(data).unwrap();assert_eq!(restarted.restore("restarted",&read.document_id).unwrap().source,local);
    assert_eq!(fs::read_to_string(&target).unwrap(),base);
    let operation=restarted.save_operations().unwrap().into_iter().find(|operation|operation.operation_id==request.operation_id).unwrap();
    for version in ["base","local"] {
        let expected=if version=="base" {base.as_bytes()}else{local.as_bytes()};
        let stored=std::path::Path::new(if version=="base" {&operation.base_path}else{&operation.local_path});
        let complete=match fs::read(stored) {Ok(bytes)=>bytes==expected,Err(error) if error.kind()==std::io::ErrorKind::NotFound=>false,Err(error)=>panic!("无法读取实际恢复文件：{error}")};
        let result=restarted.save_operation_read(&request.operation_id,version,None);
        if complete {assert_eq!(result.unwrap().bytes,expected);}else{assert!(result.is_err(),"不完整的保存内容被接受");}
    }
    println!("实际终止阶段：{stage}，重启恢复版本：{}",operation.stage);
    drop(restarted);fs::remove_dir_all(directory).unwrap();
}
