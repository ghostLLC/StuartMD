use super::stream_completion;
use crate::context::service::{assemble_for_request, summarize_history, ChatMessage, ContextInput, RequestContext};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

#[tokio::test]
#[ignore = "需要当前用户的真实DeepSeek密钥和独立测试数据目录"]
async fn actual_deepseek_stream_budget_summary_cancel_and_disabled() {
    assert_eq!(std::env::var("STUART_PROVIDER_TEST").unwrap(), "deepseek");
    let directory = crate::fs_api::data_dir();
    let artifacts = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/native-artifacts").canonicalize().unwrap();
    assert!(directory.canonicalize().unwrap().starts_with(&artifacts));
    crate::fs_api::modify_settings(|settings| {
        settings["ai"]["enabled"] = json!(true);
        settings["ai"]["memory_mode"] = json!("off");
        Ok(())
    }).unwrap();
    let config = crate::ai_chat::load_ai_settings();
    let provider = crate::ai_chat::active_provider(&json!({"active_provider_id":"deepseek","providers":config["providers"]})).unwrap();
    let key = crate::ai_chat::read_api_key("deepseek").unwrap();
    let connection = crate::ai_chat::test_provider_connection("deepseek", CancellationToken::new()).await.unwrap();
    assert!(connection["models"].as_array().unwrap().contains(&provider["model"]));

    let file = directory.join("公开验收文档.md");
    std::fs::write(&file, "# StuartMD 验收\r\n\r\n文档决定：仅验收 DeepSeek。禁止删除用户文件。😀\n").unwrap();
    let documents = crate::document::DocumentService::new(directory.join("documents")).unwrap();
    let opened = documents.read("provider-verification", &file).unwrap();
    let snapshot = documents.snapshot_for_window("provider-verification", &opened.document_id).unwrap();
    let archive = crate::memory::get_archive_storage().unwrap();
    let session = archive.create_session("DeepSeek 实际接口验收", None).unwrap();
    let request = RequestContext {
        request_id: uuid::Uuid::new_v4().to_string(), session_id: session.session_id.clone(), window_id: "provider-verification".into(),
        input: ContextInput { editor_revision: snapshot.revision, source_hash: snapshot.content_hash.clone(), scope: "full".into(), ..Default::default() },
        document: snapshot, messages: vec![ChatMessage { role: "user".into(), content: "按照当前文档，用中文说明验收的服务商和禁止操作，保留软件名称 StuartMD。".into() }], pdf_source: None,
    };
    let budget = assemble_for_request(&provider, &key, request.clone(), 512, CancellationToken::new()).await.unwrap();
    assert!(budget.messages.iter().any(|message| message.content.contains("禁止删除用户文件")));
    let mut answer = String::new();
    let mut chunks = 0;
    let usage = stream_completion(&provider, &key, &budget, Some("fast"), CancellationToken::new(), |piece| { chunks += 1; answer.push_str(piece); Ok(()) }).await.unwrap();
    assert!(chunks > 1);
    assert!(answer.contains("DeepSeek") && answer.contains("StuartMD"), "实际回答缺少文档来源：{answer}");
    archive.add_message(crate::memory::ChatArchiveMessage {
        message_id: uuid::Uuid::new_v4().to_string(), session_id: session.session_id.clone(), role: "assistant".into(), content: answer.clone(),
        timestamp: crate::memory::sqlite_archive::now_millis(), request_id: Some(request.request_id.clone()), document_id: Some(opened.document_id),
        completion_status: "Completed".into(), source_hash: Some(request.document.content_hash.clone()), ..Default::default()
    }).unwrap();
    assert_eq!(archive.get_completed_messages(&session.session_id).unwrap()[0].content, answer);
    assert!(assemble_for_request(&provider, &key, request.clone(), usize::MAX, CancellationToken::new()).await.unwrap_err().starts_with("InvalidTokenBudget"));

    let sources = vec![crate::memory::ChatArchiveMessage {
        message_id: uuid::Uuid::new_v4().to_string(), role: "user".into(), content: "决定：本次仅验收 DeepSeek。约束：禁止删除用户文件。最新更正：欢迎文档使用 StuartMD 名称。待解决问题：确认 PDF 标注能够重新打开。".into(),
        completion_status: "Completed".into(), ..Default::default()
    }];
    let summary = summarize_history(&provider, &key, &sources, CancellationToken::new()).await.unwrap();
    assert!(!summary.decisions.is_empty() && !summary.constraints.is_empty() && !summary.corrections.is_empty() && !summary.open_questions.is_empty());

    let cancel = CancellationToken::new();
    let mut cancel_chunks = 0;
    let cancelled = stream_completion(&provider, &key, &budget, Some("fast"), cancel.clone(), |_| { cancel_chunks += 1; cancel.cancel(); Ok(()) }).await.unwrap_err();
    assert!(cancel_chunks > 0 && cancelled.contains("取消"));

    let probe = super::begin_probe("provider-verification").unwrap();
    let mut disabled_chunks = 0;
    let disabled = stream_completion(&provider, &key, &budget, Some("fast"), probe.cancellation.clone(), |_| {
        disabled_chunks += 1;
        crate::fs_api::modify_settings(|settings| { settings["ai"]["enabled"] = json!(false); Ok(()) })?;
        super::cancel_all();
        Ok(())
    }).await.unwrap_err();
    assert!(disabled_chunks > 0 && (disabled.contains("取消") || disabled == "AIDisabled"));
    drop(probe);
    super::cancel_all_and_wait().await.unwrap();
    assert_eq!(crate::ai_chat::test_provider_connection("deepseek", CancellationToken::new()).await.unwrap_err(), "AIDisabled");
    assert_eq!(assemble_for_request(&provider, &key, request, 512, CancellationToken::new()).await.unwrap_err(), "AIDisabled");
    let evidence = json!({"provider":"deepseek","model":provider["model"],"models":connection["models"],"streamChunks":chunks,"answer":answer,
        "answerSha256":format!("{:x}",Sha256::digest(answer.as_bytes())),"plannedPromptTokens":budget.prompt_tokens,"protocolReserve":budget.protocol_reserve,"usage":usage,
        "summary":summary,"cancelChunks":cancel_chunks,"disabledChunks":disabled_chunks,"passed":true});
    std::fs::write(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/validation/3.5.11/actual-deepseek.json"), serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
}
