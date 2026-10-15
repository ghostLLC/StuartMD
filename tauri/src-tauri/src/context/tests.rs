use super::model_spec::ProviderModelSpec;
use super::service::{check_final_budget, count_local, ChatMessage};
use serde_json::json;
use std::path::PathBuf;

fn provider(resource: &str) -> ProviderModelSpec {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/tokenizers").join(resource);
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../../resources/tokenizers-manifest.json")).unwrap();
    let archive = manifest["archives"].as_array().unwrap().iter().find(|entry| entry["id"] == resource).unwrap();
    ProviderModelSpec::from_provider(&json!({"id":"deepseek","model":"deepseek-flash","token_counting":{
        "method":"local-tokenizer","context_window":1000000,"max_output_tokens":393216,"protocol_reserve":256,
        "tokenizer_artifact":directory.join("tokenizer.json"),"tokenizer_hash":archive["files"]["tokenizer.json"],
        "chat_template":directory.join("tokenizer_config.json"),"chat_template_hash":archive["files"]["tokenizer_config.json"],
        "bos_token":"<｜begin▁of▁sentence｜>","eos_token":"<｜end▁of▁sentence｜>"
    }})).unwrap()
}

#[test]
fn official_tokenizer_templates_count_chinese_emoji_and_completed_reasoning() {
    let messages = vec![
        ChatMessage::text("system","完整解释公开样本。"),
        ChatMessage::text("user","中文与 English 😀，保留全部选区。"),
        ChatMessage::text("assistant","<think>处理公开资料</think>已经完成。"),
        ChatMessage::text("user","最新更正：保留否定关系。"),
    ];
    for resource in ["deepseek-v3", "deepseek-v4"] {
        let count = count_local(&provider(resource), &messages).unwrap();
        assert!(count > 20 && count < 100, "{resource}: {count}");
    }
}

#[test]
fn counting_configuration_rejects_nonfinite_reserve_and_output_above_window() {
    let mut spec = provider("deepseek-v4");
    spec.estimate_safety_ratio = f64::NAN;
    assert!(spec.validate().is_err());
    spec.estimate_safety_ratio = 0.0;
    spec.max_output_tokens = spec.context_window + 1;
    assert!(spec.validate().is_err());
}

#[test]
fn final_message_budget_includes_requested_output_and_protocol_reserve() {
    check_final_budget(300, 100, 100, 500).unwrap();
    assert!(check_final_budget(301, 100, 100, 500).unwrap_err().starts_with("ContextTooLarge"));
    assert!(check_final_budget(1, 1, 0, 0).is_err());
    assert!(check_final_budget(usize::MAX, 1, 1, usize::MAX).is_err());
}

fn actual_document_request(text: &str) -> super::service::RequestContext {
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/native-artifacts/context-sources").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&artifacts).unwrap();
    let path = artifacts.join("实际材料.md");
    std::fs::write(&path,text).unwrap();
    let documents = crate::document::DocumentService::new(artifacts.join("documents")).unwrap();
    let read = documents.read("source-verification",&path).unwrap();
    let snapshot = documents.snapshot_for_window("source-verification",&read.document_id).unwrap();
    super::service::RequestContext {
        request_id:uuid::Uuid::new_v4().to_string(),session_id:uuid::Uuid::new_v4().to_string(),window_id:"source-verification".into(),
        document_key:Some(crate::document::DocumentService::document_key(&snapshot).unwrap()),
        input:super::service::ContextInput {editor_revision:snapshot.revision,source_hash:snapshot.content_hash.clone(),..Default::default()},
        document:Some(snapshot),messages:vec![ChatMessage::text("user","请解释实际正文。")],pdf_source:None,workspace_sources:vec![],resolved_sources:vec![],settings:json!({"use_saved_memories":false}),
    }
}

#[test]
fn no_selection_keeps_complete_actual_document_and_capacity_requirements() {
    let text = "文档开头😀\r\n\r\n# 当前章节\r\n\r\n实际正文\r\n\r\n- 列表内容\r\n\r\n| 表格 |\r\n| --- |\r\n| 全部保留 |\r\n\r\n```rust\r\nlet actual = 17;\r\n```\r\n\r\n## 子章节\r\n继续保留\r\n\r\n# 下一章节\r\n最终正文。";
    let request = actual_document_request(text);
    let parts = super::sources::prepare_materials(&request,false).unwrap();
    assert_eq!(parts.len(),1);
    assert_eq!(parts[0].excerpt,text);
    assert!(parts[0].mandatory);
    assert_eq!(parts[0].anchor["sourceHash"],request.document.as_ref().unwrap().content_hash);
    assert_eq!(parts[0].anchor["fileFingerprint"],crate::rag::model_registry::file_sha256(std::path::Path::new(request.document.as_ref().unwrap().path.as_ref().unwrap())).unwrap());
    let messages:Vec<_> = parts.iter().map(super::sources::SourceRef::message).chain(request.messages.iter().cloned()).collect();
    let count = count_local(&provider("deepseek-v4"),&messages).unwrap();
    assert!(check_final_budget(count,64,256,count+319).is_err());
    assert_eq!(messages[0].content.matches("最终正文。").count(),1);
    assert_eq!(super::sources::normalize_scope("neighborhood").unwrap(),"document");
}

#[test]
fn repeated_actual_selection_reference_merges_and_expired_source_stops() {
    let mut request = actual_document_request("# 实际文档\n\n😀同一项资料\n\n结尾正文");
    let document = request.document.as_ref().unwrap();
    let from = "# 实际文档\n\n".encode_utf16().count();
    let to = from + "😀同一项资料".encode_utf16().count();
    let selection = super::service::ContextSelection {document_id:document.document_id.clone(),revision:document.revision,kind:document.kind.clone(),quote:"😀同一项资料".into(),from:Some(from),to:Some(to),..Default::default()};
    request.input.explicit_sources = vec![
        super::sources::SourceInput {input_id:"reference-one".into(),kind:"selection".into(),selection:Some(selection.clone()),..Default::default()},
        super::sources::SourceInput {input_id:"reference-two".into(),kind:"selection".into(),selection:Some(selection.clone()),..Default::default()},
    ];
    let parts = super::sources::prepare_materials(&request,false).unwrap();
    assert_eq!(parts.len(),2);
    let selected = parts.iter().find(|source|source.kind=="selection").unwrap();
    assert_eq!(selected.input_ids.len(),2);
    assert!(selected.mandatory);
    request.input.explicit_sources[0].selection.as_mut().unwrap().revision += 1;
    assert!(super::sources::prepare_materials(&request,false).unwrap_err().contains("版本"));
    request.input.explicit_sources.clear();
    request.input.scope="selection".into();
    request.input.selection=Some(selection);
    request.input.selection.as_mut().unwrap().quote="过期的资料".into();
    assert!(super::sources::prepare_materials(&request,false).unwrap_err().contains("不一致"));
}

#[test]
fn explicit_selection_from_another_actual_document_retains_its_own_identity() {
    let mut source_request=actual_document_request("来自引用文档的😀真实正文");
    let document=source_request.document.as_ref().unwrap();
    let selection=super::service::ContextSelection{document_id:document.document_id.clone(),revision:document.revision,kind:document.kind.clone(),quote:document.source.clone(),from:Some(0),to:Some(document.source.encode_utf16().count()),..Default::default()};
    let mut target_request=actual_document_request("当前提问文档的完整正文");
    source_request.request_id=target_request.request_id.clone();
    let input=super::sources::SourceInput{input_id:"actual-other-document".into(),kind:"selection".into(),selection:Some(selection.clone()),..Default::default()};
    target_request.input.explicit_sources.push(input.clone());
    assert!(super::sources::prepare_materials(&target_request,false).is_err());
    let mut source=super::sources::selection_source(&source_request,&selection).unwrap();source.input_ids.push(input.input_id);
    target_request.resolved_sources.push(source);
    let material=super::sources::prepare_materials(&target_request,false).unwrap();
    let reference=material.iter().find(|source|source.kind=="selection").unwrap();
    assert_eq!(reference.excerpt,document.source);assert_eq!(reference.anchor["documentId"],document.document_id);
    assert_eq!(reference.anchor["sourceHash"],document.content_hash);
    target_request.input.explicit_sources[0].selection.as_mut().unwrap().quote="其他内容".into();
    assert!(super::sources::prepare_materials(&target_request,false).unwrap_err().contains("不同"));
}

#[test]
fn actual_pdf_cross_page_selection_preserves_and_checks_every_page() {
    let workspace=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let path=workspace.join("tests/fixtures/pdf/layout-and-ocr.pdf");
    let native=workspace.join("resources/native");
    let artifacts=workspace.join("tests/native-artifacts/context-pdf-selection").join(uuid::Uuid::new_v4().to_string());
    let documents=crate::document::DocumentService::new(artifacts.join("documents")).unwrap();
    let read=documents.read_binary("pdf-selection-verification",&path).unwrap();
    let document=documents.snapshot_for_window("pdf-selection-verification",&read.document_id).unwrap();
    let pdf=crate::rag::pdf_extract::extract_pdf_selection(&path,&native,&std::sync::atomic::AtomicBool::new(false),&[1,2,3,4]).unwrap();
    assert_eq!(pdf.pages.iter().map(|page|page.page_number).collect::<Vec<_>>(),vec![1,2,3,4]);
    let segments:Vec<_>=pdf.pages.iter().map(|page|super::service::PdfSelectionSegment {
        page:page.page_number,quote:page.blocks.iter().map(|block|block.text.as_str()).collect::<Vec<_>>().join("\n"),
        rects:page.blocks.iter().flat_map(|block|block.rects.clone()).collect(),file_fingerprint:pdf.source_hash.clone(),
    }).collect();
    let selection=super::service::ContextSelection {
        document_id:document.document_id.clone(),revision:document.revision,kind:"pdf".into(),
        quote:segments.iter().map(|segment|segment.quote.as_str()).collect::<Vec<_>>().join("\n"),
        page:Some(segments[0].page),rects:segments[0].rects.clone(),file_fingerprint:Some(pdf.source_hash.clone()),segments,
        ..Default::default()
    };
    let mut request=super::service::RequestContext {
        request_id:uuid::Uuid::new_v4().to_string(),session_id:uuid::Uuid::new_v4().to_string(),window_id:"pdf-selection-verification".into(),
        document_key:Some(crate::document::DocumentService::document_key(&document).unwrap()),
        input:super::service::ContextInput {editor_revision:document.revision,source_hash:document.content_hash.clone(),scope:"selection".into(),selection:Some(selection.clone()),..Default::default()},
        document:Some(document),messages:vec![ChatMessage::text("user","解释全部选中页面。")],
        pdf_source:Some(pdf.clone()),workspace_sources:vec![],resolved_sources:vec![],settings:json!({"use_saved_memories":false}),
    };
    let material=super::sources::prepare_materials(&request,false).unwrap();
    assert_eq!(material.len(),1);
    assert!(material[0].mandatory);
    assert_eq!(material[0].excerpt,selection.quote);
    let anchors=material[0].anchor["segments"].as_array().unwrap();
    assert_eq!(anchors.len(),4);
    for (index,anchor) in anchors.iter().enumerate() {
        assert_eq!(anchor["page"],index+1);
        assert_eq!(anchor["quote"],selection.segments[index].quote);
        assert_eq!(anchor["fileFingerprint"],pdf.source_hash);
        assert_eq!(anchor["rects"],json!(selection.segments[index].rects));
        assert_eq!(anchor["pageBox"],json!(pdf.pages[index].page_box));
        assert_eq!(anchor["rotation"],pdf.pages[index].rotation);
    }
    let mut invalid=selection.clone();invalid.segments.remove(1);
    assert!(super::sources::selection_source(&request,&invalid).unwrap_err().contains("连续"));
    let mut invalid=selection.clone();invalid.segments.pop();
    assert!(super::sources::selection_source(&request,&invalid).unwrap_err().contains("完整选区"));
    let mut invalid=selection.clone();invalid.segments[1].file_fingerprint="expired".into();
    assert!(super::sources::selection_source(&request,&invalid).unwrap_err().contains("指纹"));
    let mut invalid=selection.clone();invalid.segments[1].rects=vec![[0.,0.,10.,10.]];
    assert!(super::sources::selection_source(&request,&invalid).unwrap_err().contains("实际坐标"));
    let mut invalid=selection.clone();invalid.segments[1].rects=vec![pdf.pages[1].blocks[0].rects[0]];
    assert!(super::sources::selection_source(&request,&invalid).unwrap_err().contains("实际坐标"));
    let mut invalid=selection.clone();invalid.segments.clear();
    assert!(super::sources::selection_source(&request,&invalid).unwrap_err().contains("逐页"));
    request.pdf_source.as_mut().unwrap().pages.remove(2);
    assert!(super::sources::selection_source(&request,&selection).unwrap_err().contains("第 3 页"));
    request.pdf_source=Some(pdf);
    request.input.scope="document".into();request.input.selection=None;
    let mut reference=material[0].clone();reference.input_ids.push("actual-cross-page-reference".into());
    request.input.explicit_sources.push(super::sources::SourceInput {input_id:"actual-cross-page-reference".into(),kind:"selection".into(),selection:Some(selection.clone()),..Default::default()});
    request.resolved_sources.push(reference);
    request.input.scope="workspace".into();request.input.workspace_root=Some(workspace.to_string_lossy().into_owned());
    let explicit=super::sources::prepare_sources(&request).unwrap();
    assert_eq!(explicit.len(),1);assert_eq!(explicit[0].excerpt,selection.quote);assert_eq!(explicit[0].anchor["segments"].as_array().unwrap().len(),4);
    assert!(crate::rag::pdf_extract::extract_pdf_selection(&path,&native,&std::sync::atomic::AtomicBool::new(false),&[]).is_err());
    assert!(crate::rag::pdf_extract::extract_pdf_selection(&path,&native,&std::sync::atomic::AtomicBool::new(false),&[1,3]).is_err());
    assert!(crate::rag::pdf_extract::extract_pdf_selection(&path,&native,&std::sync::atomic::AtomicBool::new(false),&[9]).is_err());
    std::fs::create_dir_all(&artifacts).unwrap();
    std::fs::write(artifacts.join("actual-cross-page-source.json"),serde_json::to_vec_pretty(&material[0]).unwrap()).unwrap();
}

#[test]
fn actual_pdf_cross_page_selection_checks_cropbox_chinese_and_scanned_text() {
    let workspace=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let path=workspace.join("tests/fixtures/pdf/layout-and-ocr.pdf");
    let artifacts=workspace.join("tests/native-artifacts/context-pdf-selection").join(uuid::Uuid::new_v4().to_string());
    let documents=crate::document::DocumentService::new(artifacts.join("documents")).unwrap();
    let read=documents.read_binary("pdf-selection-verification",&path).unwrap();
    let document=documents.snapshot_for_window("pdf-selection-verification",&read.document_id).unwrap();
    for pages in [[5,6],[7,8]] {
        let pdf=crate::rag::pdf_extract::extract_pdf_selection(&path,&workspace.join("resources/native"),&std::sync::atomic::AtomicBool::new(false),&pages).unwrap();
        assert_eq!(pdf.pages.iter().map(|page|page.page_number).collect::<Vec<_>>(),pages);
        assert!(pdf.pages.iter().all(|page|!page.needs_review));
        if pages[0]==7 {assert!(pdf.pages.iter().flat_map(|page|&page.blocks).any(|block|block.method=="ocr"));}
        let segments:Vec<_>=pdf.pages.iter().map(|page|super::service::PdfSelectionSegment {
            page:page.page_number,quote:page.blocks.iter().map(|block|block.text.as_str()).collect::<Vec<_>>().join("\n"),
            rects:page.blocks.iter().flat_map(|block|block.rects.clone()).collect(),file_fingerprint:pdf.source_hash.clone(),
        }).collect();
        let selection=super::service::ContextSelection {document_id:document.document_id.clone(),revision:document.revision,kind:"pdf".into(),quote:segments.iter().map(|segment|segment.quote.as_str()).collect::<Vec<_>>().join("\n"),page:Some(segments[0].page),rects:segments[0].rects.clone(),file_fingerprint:Some(pdf.source_hash.clone()),segments,..Default::default()};
        let request=super::service::RequestContext {
            request_id:uuid::Uuid::new_v4().to_string(),session_id:uuid::Uuid::new_v4().to_string(),window_id:"pdf-selection-verification".into(),
            document_key:Some(crate::document::DocumentService::document_key(&document).unwrap()),
            input:super::service::ContextInput {editor_revision:document.revision,source_hash:document.content_hash.clone(),scope:"selection".into(),selection:Some(selection.clone()),..Default::default()},
            document:Some(document.clone()),messages:vec![ChatMessage::text("user","解释全部选中页面。")],pdf_source:Some(pdf),workspace_sources:vec![],resolved_sources:vec![],settings:json!({"use_saved_memories":false}),
        };
        let source=super::sources::selection_source(&request,&selection).unwrap();
        assert_eq!(source.excerpt,selection.quote);assert!(source.mandatory);
        assert_eq!(source.anchor["segments"].as_array().unwrap().len(),2);
        for (index,number) in pages.iter().enumerate() {assert_eq!(source.anchor["segments"][index]["page"],*number);}
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(artifacts.join(format!("actual-pages-{}-{}.json",pages[0],pages[1])),serde_json::to_vec_pretty(&source).unwrap()).unwrap();
    }
}
