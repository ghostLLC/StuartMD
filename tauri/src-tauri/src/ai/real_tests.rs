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
        settings["ai"]["use_saved_memories"] = json!(false);
        settings["ai"]["learning_policy"] = json!("off");
        Ok(())
    }).unwrap();
    let initial=super::configuration::load_ai_configuration().unwrap();
    let connection_config=initial.ai.providers.iter().find(|p|p.r#type=="deepseek" && p.key_set).unwrap().clone();
    let mut saved=super::configuration::update_config(super::configuration::AiConfigChange::SaveProviderModels{connection:super::configuration::ConnectionInput{id:Some(connection_config.id.clone()),provider_type:connection_config.r#type.clone(),region:connection_config.region.clone(),label:connection_config.label.clone(),base_url:None,enabled:Some(true)},models:["deepseek-flash","deepseek-v4-pro"].into_iter().map(|name|super::configuration::ModelInput{model_id:name.into(),display_name:None,thinking:Some("off".into()),max_output_tokens:Some(8192),token_counting:None,overrides:json!({})}).collect(),api_key:None},&initial.settings_revision,false).unwrap();
    let ids:Vec<_>=saved.ai.models.iter().filter(|m|m.provider_id==connection_config.id && ["deepseek-flash","deepseek-v4-pro"].contains(&m.model_id.as_str())).map(|m|m.id.clone()).collect();
    for id in &ids {let mut model=saved.ai.models.iter().find(|m|m.id==*id).unwrap().clone();model.thinking="off".into();model.max_output_tokens=8192;saved=super::configuration::update_config(super::configuration::AiConfigChange::EditModel{model},&saved.settings_revision,false).unwrap();}
    let flash=saved.ai.models.iter().find(|m|m.provider_id==connection_config.id && m.model_id=="deepseek-flash").unwrap().id.clone();
    let pro=saved.ai.models.iter().find(|m|m.provider_id==connection_config.id && m.model_id=="deepseek-v4-pro").unwrap().id.clone();
    saved=super::configuration::update_config(super::configuration::AiConfigChange::SelectModel{model_id:flash.clone()},&saved.settings_revision,false).unwrap();
    let config = serde_json::to_value(&saved.ai).unwrap();
    let captured=super::configuration::capture_request_model(&flash,&saved.settings_revision).unwrap();
    let provider = captured.model.provider_value().unwrap();
    let key = captured.key;
    let connection = crate::ai_chat::test_provider_connection(&connection_config.id, CancellationToken::new()).await.unwrap();
    assert!(connection["models"].as_array().unwrap().contains(&provider["model"]));

    let file = directory.join("公开验收文档.md");
    std::fs::write(&file, "# StuartMD 验收\r\n\r\n文档决定：仅验收 DeepSeek。约束：禁止删除用户文件。😀\n最新更正：欢迎文档使用 StuartMD 名称。\n待解决问题：确认 PDF 标注能够重新打开。\n").unwrap();
    let documents = crate::document::DocumentService::new(directory.join("documents")).unwrap();
    let opened = documents.read("provider-verification", &file).unwrap();
    let snapshot = documents.snapshot_for_window("provider-verification", &opened.document_id).unwrap();
    let document_key = crate::document::DocumentService::document_key(&snapshot).unwrap();
    let archive = crate::memory::get_archive_storage().unwrap();
    let request_id=uuid::Uuid::new_v4().to_string();
    let question="按照当前文档，用中文说明验收的服务商、禁止操作、最新更正及待解决问题，保留软件名称 StuartMD。";
    let intent=crate::memory::RequestIntent{request_id:request_id.clone(),turn_id:None,session_id:None,expected_session_version:0,draft_id:None,draft_version:0,target:crate::memory::ConversationTarget{document_key:Some(document_key.clone()),workspace_key:None,runtime_document_id:Some(opened.document_id.clone()),window_id:"provider-verification".into()},question:question.into(),scope:"document".into(),selection:None,reading_anchor:None,explicit_sources:vec![],settings_revision:crate::ai_chat::settings_revision().unwrap(),editor_revision:snapshot.revision,source_hash:snapshot.content_hash.clone()};
    let accepted=archive.begin_turn(&intent).unwrap();let session=accepted.session.clone();
    archive.add_message(crate::memory::ChatArchiveMessage{message_id:uuid::Uuid::new_v4().to_string(),session_id:session.session_id.clone(),role:"user".into(),content:question.into(),timestamp:crate::memory::sqlite_archive::now_millis(),request_id:Some(request_id.clone()),document_id:Some(opened.document_id.clone()),completion_status:"Completed".into(),source_hash:Some(snapshot.content_hash.clone()),source_anchor:Some(json!({"documentKey":document_key,"workspaceKey":null})),turn_id:Some(accepted.turn.turn_id.clone()),attempt_no:accepted.attempt_no,..Default::default()}).unwrap();
    let request = RequestContext {
        request_id, session_id: session.session_id.clone(), window_id: "provider-verification".into(),
        input: ContextInput { editor_revision: snapshot.revision, source_hash: snapshot.content_hash.clone(), scope: "document".into(), ..Default::default() },
        document: Some(snapshot), document_key: Some(document_key), settings: config.clone(), workspace_sources: Vec::new(), resolved_sources: Vec::new(),
        messages: vec![ChatMessage::text("user",question)], pdf_source: None,
    };
    let budget = assemble_for_request(&provider, &key, request.clone(), 512, CancellationToken::new()).await.unwrap();
    assert!(budget.messages.iter().any(|message| message.content.contains("禁止删除用户文件")));
    let mut context_record=json!({"validated":budget,"sources":budget.source_anchors,"config":config});
    archive.record_context(&request.request_id,&session.session_id,&context_record).unwrap();
    let mut answer = String::new();
    let mut chunks = 0;
    let usage = stream_completion(&provider, &key, &budget, Some("fast"), CancellationToken::new(), |piece| { chunks += 1; answer.push_str(piece); if chunks==1 {let latest=super::configuration::load_ai_configuration()?;super::configuration::update_config(super::configuration::AiConfigChange::SelectModel{model_id:pro.clone()},&latest.settings_revision,false)?;}Ok(()) }).await.unwrap();
    assert!(chunks > 1);
    assert!(answer.contains("DeepSeek") && answer.contains("StuartMD"), "实际回答缺少文档来源：{answer}");
    let assistant=crate::memory::ChatArchiveMessage {
        message_id: uuid::Uuid::new_v4().to_string(), session_id: session.session_id.clone(), role: "assistant".into(), content: answer.clone(),
        timestamp: crate::memory::sqlite_archive::now_millis(), request_id: Some(request.request_id.clone()), document_id: Some(opened.document_id),
        completion_status: "Completed".into(), source_hash: Some(request.document.as_ref().unwrap().content_hash.clone()),source_anchor:Some(json!({"documentKey":request.document_key,"workspaceKey":null,"sources":budget.source_anchors,"assistantMessage":usage["assistant_message"]})),turn_id:Some(accepted.turn.turn_id.clone()),attempt_no:accepted.attempt_no,..Default::default()
    };
    archive.add_message(assistant.clone()).unwrap();context_record["usage"]=usage.clone();
    archive.record_context(&request.request_id,&session.session_id,&context_record).unwrap();
    assert_eq!(archive.request_record(&request.request_id).unwrap()["context"]["config"]["active_model_id"],flash);
    let next=super::configuration::load_ai_configuration().unwrap();assert_eq!(next.ai.active_model_id.as_deref(),Some(pro.as_str()));
    let next=super::configuration::capture_request_model(&pro,&next.settings_revision).unwrap();assert_eq!(next.model.model.model_id,"deepseek-v4-pro");
    archive.set_request_actual_usage(&request.request_id,"provider-verification",&usage).unwrap();
    let session=archive.finish_attempt(&request.request_id,"provider-verification","Completed",None).unwrap();
    let stored=archive.get_completed_messages(&session.session_id).unwrap();assert_eq!(stored.len(),2);assert_eq!(stored[1].content,answer);
    let conversation=archive.conversation_page(Some(&intent.target),Some(&session.session_id),None).unwrap();
    assert_eq!(conversation.turns.len(),1);assert_eq!(conversation.turns[0].current_request_id.as_deref(),Some(request.request_id.as_str()));
    assert_eq!(conversation.messages.len(),2);
    let source_id=budget.source_anchors[0]["sourceId"].as_str().unwrap();
    assert_eq!(archive.archived_source(source_id,&request.request_id).unwrap(),budget.source_anchors[0]);
    archive.set_request_learning_status(&request.request_id,"provider-verification","Running",None).unwrap();
    let (candidates,learning_usage,learning_budget)=super::companion::generate_learning_candidates(&provider,&key,&assistant,&context_record,&session,&config,"provider-verification",CancellationToken::new()).await.unwrap();
    assert!(!candidates.is_empty());assert!(candidates.len()<=3);
    archive.record_learning_usage(&request.request_id,"provider-verification",&json!({"usage":learning_usage,"validated":learning_budget})).unwrap();
    let edits=candidates.iter().map(|candidate|crate::memory::MemoryEdit{content:candidate.content.clone(),category:candidate.category.clone(),scope:candidate.scope.clone(),workspace_key:None,document_key:if candidate.scope=="document"{request.document_key.clone()}else{None},preference_key:None,pinned:false,source_message_id:Some(assistant.message_id.clone()),source_request_id:Some(request.request_id.clone()),source_anchor:Some(json!({"sourceIds":candidate.source_ids,"sources":context_record["sources"]}))}).collect::<Vec<_>>();
    let learned=archive.save_learning_batch(&request.request_id,"provider-verification",&edits).unwrap();
    archive.set_request_learning_status(&request.request_id,"provider-verification","Completed",None).unwrap();
    assert_eq!(learned["memories"].as_array().unwrap().len()+learned["proposals"].as_array().unwrap().len(),candidates.len());
    for memory in learned["memories"].as_array().unwrap(){assert_eq!(memory["approvalKind"],"automatic");assert!(["concept","knowledge","glossary"].contains(&memory["category"].as_str().unwrap()));}
    for proposal in learned["proposals"].as_array().unwrap(){assert_eq!(proposal["status"],"Pending");}
    assert_eq!(archive.request_record(&request.request_id).unwrap()["status"],"Completed");
    assert!(assemble_for_request(&provider, &key, request.clone(), usize::MAX, CancellationToken::new()).await.unwrap_err().starts_with("InvalidTokenBudget"));

    let sources=archive.get_completed_messages(&session.session_id).unwrap();
    let summary = summarize_history(&provider, &key, &sources, CancellationToken::new()).await.unwrap();
    assert!(!summary.decisions.is_empty() && !summary.constraints.is_empty() && !summary.corrections.is_empty() && !summary.open_questions.is_empty());

    let cancel = CancellationToken::new();
    let mut cancel_chunks = 0;
    let cancelled = stream_completion(&provider, &key, &budget, Some("fast"), cancel.clone(), |_| { cancel_chunks += 1; cancel.cancel(); Ok(()) }).await.unwrap_err();
    assert!(cancel_chunks > 0 && cancelled.contains("取消"));

    let mut verified=vec![];
    for id in [&flash,&pro] {
        let current=super::configuration::load_ai_configuration().unwrap();
        let result=super::model_validation::verify_model(id,&current.settings_revision,CancellationToken::new()).await.unwrap();
        let status=result["status"].clone();verified.push(result);
        let evidence_dir=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/validation/{}",env!("CARGO_PKG_VERSION")));
        std::fs::create_dir_all(&evidence_dir).unwrap();std::fs::write(evidence_dir.join("actual-model-verification.json"),serde_json::to_vec_pretty(&verified).unwrap()).unwrap();
        assert_eq!(status,"Passed","实际模型回答验证没有通过");
    }
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
        "summary":summary,"cancelChunks":cancel_chunks,"disabledChunks":disabled_chunks,"learningCandidates":candidates,"learningUsage":learning_usage,"learningBudget":learning_budget,"learned":learned,"passed":true});
    let evidence_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../docs/validation/{}",env!("CARGO_PKG_VERSION")));
    std::fs::create_dir_all(&evidence_dir).unwrap();
    std::fs::write(evidence_dir.join("actual-deepseek.json"), serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
}
