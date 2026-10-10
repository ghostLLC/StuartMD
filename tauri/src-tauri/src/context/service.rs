use super::{compressor::StructuredSummary,model_spec::{verified_resource,ProviderModelSpec}};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::collections::HashMap;
use std::sync::{Arc,Mutex,OnceLock};
use tokio_util::sync::CancellationToken;

#[derive(Debug,Clone,Serialize,Deserialize,PartialEq)]
pub struct ChatMessage { pub role: String, pub content: String }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSelection {
    pub document_id: String,
    pub revision: u64,
    pub kind: String,
    pub quote: String,
    pub from: Option<usize>,
    pub to: Option<usize>,
    pub block_index: Option<usize>,
    pub page: Option<usize>,
    #[serde(default)]
    pub rects: Vec<[f32; 4]>,
    pub file_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeSourceRef {
    pub chunk_id: String,
    pub workspace_id: String,
    pub index_generation: String,
    pub index_status: String,
    #[serde(default)]
    pub rrf_score: f32,
    #[serde(default)]
    pub partial_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInput {
    pub editor_revision: u64,
    pub source_hash: String,
    pub selection: Option<ContextSelection>,
    #[serde(default = "neighborhood_scope")]
    pub scope: String,
    pub workspace_root: Option<String>,
    pub page: Option<usize>,
    #[serde(default)]
    pub knowledge_sources: Vec<KnowledgeSourceRef>,
}

fn neighborhood_scope() -> String { "neighborhood".into() }

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: String,
    pub session_id: String,
    pub window_id: String,
    pub document: crate::document::DocumentContextSnapshot,
    pub messages: Vec<ChatMessage>,
    pub input: ContextInput,
    pub pdf_source: Option<crate::rag::pdf_extract::PdfContent>,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ValidatedContext {
    pub messages: Vec<ChatMessage>, pub prompt_tokens: usize, pub requested_output_tokens: usize,
    pub protocol_reserve: usize, pub context_window: usize, pub count_method: String,
    pub messages_hash: String, pub model_spec_id: String, pub settings_revision: String,
    pub document_id: String, pub session_id: String, pub window_id: String,
    pub used_memory_ids: Vec<String>, pub omitted_sources: Vec<String>,
    pub summaries: Vec<StructuredSummary>,
    pub source_anchors: Vec<Value>,
}

static TOKENIZERS: OnceLock<Mutex<HashMap<String,Arc<tokenizers::Tokenizer>>>> = OnceLock::new();

fn hash_json(value: &impl Serialize) -> Result<String,String> {
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)))
}

pub fn ensure_enabled(cancellation: &CancellationToken) -> Result<Value,String> {
    if cancellation.is_cancelled() { return Err("Cancelled".into()); }
    let settings = crate::fs_api::load_settings_migrated();
    if crate::ai_chat::load_ai_settings().get("enabled").and_then(Value::as_bool) != Some(true) { return Err("AIDisabled".into()); }
    Ok(settings)
}

pub async fn count_messages(spec: &ProviderModelSpec, api_key: &str, messages: &[ChatMessage], cancellation: &CancellationToken) -> Result<usize,String> {
    spec.validate()?;
    ensure_enabled(cancellation)?;
    match spec.count_method.as_str() {
        "local-tokenizer" => {
            let spec = spec.clone();
            let messages = messages.to_vec();
            let work = tokio::task::spawn_blocking(move || count_local(&spec,&messages));
            tokio::select! { _ = cancellation.cancelled() => Err("Cancelled".into()),
                result = work => result.map_err(|e| format!("TokenCountingUnavailable：计数任务终止：{e}"))? }
        }
        "kimi-estimate" | "qwen-provider" | "glm-provider" => {
            if api_key.is_empty() { return Err("TokenCountingUnavailable：服务商计数缺少凭据".into()); }
            let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
            ensure_enabled(cancellation)?;
            let work = async {
                let body = if spec.count_method == "qwen-provider" { json!({"model":spec.model_id,"input":{"messages":messages},"parameters":{}}) }
                    else { json!({"model":spec.model_id,"messages":messages}) };
                let response = client.post(spec.count_endpoint.as_deref().ok_or("计数地址缺失")?)
                    .bearer_auth(api_key).json(&body).send().await
                    .map_err(|e| format!("TokenCountingUnavailable：服务商计数连接失败：{}",e.without_url()))?;
                let status = response.status();
                if !status.is_success() { return Err(format!("TokenCountingUnavailable：服务商计数返回 HTTP {status}")); }
                let value: Value = response.json().await.map_err(|e| format!("计数响应 JSON 无效：{e}"))?;
                let field = match spec.count_method.as_str() { "qwen-provider"=>"/usage/input_tokens","glm-provider"=>"/usage/prompt_tokens",_=>"/data/total_tokens" };
                value.pointer(field).and_then(Value::as_u64).and_then(|count| usize::try_from(count).ok()).ok_or_else(||format!("TokenCountingUnavailable：计数响应缺少 {field}"))
            };
            tokio::select! { _ = cancellation.cancelled() => Err("Cancelled".into()), result = work => result }
        }
        _ => Err("TokenCountingUnavailable".into()),
    }
}

pub fn count_local(spec: &ProviderModelSpec, messages: &[ChatMessage]) -> Result<usize,String> {
    spec.validate()?;
    let tokenizer_path = spec.tokenizer_artifact.as_ref().ok_or("tokenizer 路径缺失")?;
    let tokenizer_hash = spec.tokenizer_hash.as_deref().ok_or("tokenizer 指纹缺失")?;
    let tokenizer_bytes = verified_resource(tokenizer_path,tokenizer_hash)?;
    let template_bytes = verified_resource(spec.chat_template.as_ref().ok_or("消息模板缺失")?,spec.chat_template_hash.as_deref().ok_or("消息模板指纹缺失")?)?;
    let template_resource = std::str::from_utf8(&template_bytes).map_err(|e| e.to_string())?;
    let template_config: Option<Value> = if spec.chat_template.as_ref().and_then(|path|path.extension()).is_some_and(|extension|extension=="json") {
        Some(serde_json::from_str(template_resource).map_err(|e|format!("分词器模板配置无效：{e}"))?)
    } else { None };
    let template = if let Some(config) = &template_config { config.get("chat_template").and_then(Value::as_str).ok_or("分词器配置缺少 chat_template")? }
        else { template_resource };
    let tokenizer = {
        let mut cache = TOKENIZERS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|e| e.to_string())?;
        if let Some(tokenizer) = cache.get(tokenizer_hash) { tokenizer.clone() }
        else {
            let mut tokenizer = tokenizers::Tokenizer::from_bytes(tokenizer_bytes).map_err(|e| format!("tokenizer 加载失败：{e}"))?;
            tokenizer.with_truncation(None).map_err(|e| e.to_string())?;
            tokenizer.with_padding(None);
            let tokenizer = Arc::new(tokenizer);
            cache.insert(tokenizer_hash.into(),tokenizer.clone());
            tokenizer
        }
    };
    let mut environment = minijinja::Environment::new();
    environment.set_undefined_behavior(minijinja::UndefinedBehavior::Strict);
    environment.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
    environment.add_function("raise_exception",|message: String| -> Result<String,minijinja::Error> {
        Err(minijinja::Error::new(minijinja::ErrorKind::InvalidOperation,message))
    });
    environment.add_template("chat",template).map_err(|e| format!("真实消息模板加载失败：{e}"))?;
    let rendered = environment.get_template("chat").map_err(|e| e.to_string())?.render(minijinja::context!{
        messages => messages,add_generation_prompt => true,bos_token => spec.bos_token,eos_token => spec.eos_token,
        tools => Value::Null,documents => Value::Null
    }).map_err(|e| format!("真实消息模板执行失败：{e}"))?;
    tokenizer.encode(rendered,false).map(|encoded| encoded.len()).map_err(|e| format!("真实分词失败：{e}"))
}

struct OptionalSource { id: String, message: ChatMessage, priority: usize, memory_id: Option<String>, anchor: Option<Value> }

fn validate_focus(request: &RequestContext) -> Result<(),String> {
    if request.document.revision != request.input.editor_revision || request.document.content_hash != request.input.source_hash { return Err("上下文来源版本已经失效".into()); }
    if !["full","neighborhood"].contains(&request.input.scope.as_str()) { return Err("上下文范围无效".into()); }
    if let Some(selection) = &request.input.selection {
        if selection.document_id != request.document.document_id || selection.revision != request.document.revision || selection.kind != request.document.kind || selection.quote.trim().is_empty() { return Err("选区身份或版本无效".into()); }
        if selection.kind == "markdown" {
            if let (Some(from),Some(to)) = (selection.from,selection.to) {
                let source = request.document.source.replace("\r\n","\n").replace('\r',"\n");
                let units: Vec<u16> = source.encode_utf16().collect();
                if from > to || to > units.len() { return Err("选区范围超出正文".into()); }
                let actual = String::from_utf16(&units[from..to]).map_err(|error|error.to_string())?;
                if actual != selection.quote { return Err("选区文字与当前正文不一致".into()); }
            } else {
                let visible = pulldown_cmark::Parser::new_ext(&request.document.source,pulldown_cmark::Options::all()).filter_map(|event|match event { pulldown_cmark::Event::Text(text)|pulldown_cmark::Event::Code(text) => Some(text.into_string()),pulldown_cmark::Event::SoftBreak|pulldown_cmark::Event::HardBreak => Some("\n".into()),_=>None }).collect::<Vec<_>>().join("");
                let normalized = |value:&str|value.split_whitespace().collect::<String>();
                if !normalized(&visible).contains(&normalized(&selection.quote)) { return Err("选区文字没有对应的实际正文来源".into()); }
            }
        } else if selection.kind == "pdf" {
            let source = request.pdf_source.as_ref().ok_or("PDF上下文缺少实际页面内容")?;
            if selection.file_fingerprint.as_deref() != Some(source.source_hash.as_str()) || source.source_hash != request.document.content_hash { return Err("PDF来源指纹已经变化".into()); }
            let page = source.pages.iter().find(|page|Some(page.page_number)==selection.page).ok_or("PDF选区页码无效")?;
            if selection.rects.iter().any(|rect|rect.iter().any(|value|!value.is_finite())||rect[0]>=rect[2]||rect[1]>=rect[3]) { return Err("PDF选区矩形无效".into()); }
            let visible = page.blocks.iter().map(|block|block.text.as_str()).collect::<String>();
            let normalized = |value:&str|value.split_whitespace().collect::<String>();
            if !normalized(&visible).contains(&normalized(&selection.quote)) { return Err("PDF选区缺少可核验的页面文字来源".into()); }
        } else { return Err("选区文档类型无效".into()); }
    }
    Ok(())
}

fn document_sources(request: &RequestContext) -> Result<Vec<OptionalSource>,String> {
    let mut parts = Vec::new();
    if request.document.kind == "markdown" {
        if request.input.scope == "full" {
            parts.push(OptionalSource {id:"document:full".into(),message:ChatMessage {role:"system".into(),content:format!("引用资料，文档完整正文：\n{}",request.document.source)},priority:0,memory_id:None,anchor:Some(json!({"documentId":request.document.document_id,"sourceHash":request.document.content_hash,"revision":request.document.revision,"path":request.document.path}))});
        } else {
            let mut blocks = Vec::new();
            let mut headings = Vec::new();
            for (event,range) in pulldown_cmark::Parser::new_ext(&request.document.source,pulldown_cmark::Options::all()).into_offset_iter() {
                if let pulldown_cmark::Event::Start(tag) = event {
                    if matches!(tag,pulldown_cmark::Tag::Paragraph|pulldown_cmark::Tag::CodeBlock(_)|pulldown_cmark::Tag::Table(_)|pulldown_cmark::Tag::Heading {..}) { blocks.push(range.clone()); }
                    if matches!(tag,pulldown_cmark::Tag::Heading {..}) { headings.push(request.document.source[range].to_owned()); }
                }
            }
            let quote = request.input.selection.as_ref().map(|selection|selection.quote.as_str()).unwrap_or("");
            let focus = blocks.iter().position(|range|!quote.is_empty()&&request.document.source[range.clone()].contains(quote)).or_else(||request.input.selection.as_ref().and_then(|selection|selection.block_index).filter(|index|*index<blocks.len()));
            if let Some(index) = focus {
                for block in index.saturating_sub(1)..=(index+1).min(blocks.len().saturating_sub(1)) {
                    let range = blocks[block].clone();
                    parts.push(OptionalSource {id:format!("document:block:{block}"),message:ChatMessage {role:"system".into(),content:format!("引用资料，文档段落：\n{}",&request.document.source[range.clone()])},priority:if block==index {1}else {3},memory_id:None,anchor:Some(json!({"documentId":request.document.document_id,"sourceHash":request.document.content_hash,"byteRange":[range.start,range.end]}))});
                }
            }
            for (index,heading) in headings.into_iter().enumerate() { parts.push(OptionalSource {id:format!("document:heading:{index}"),message:ChatMessage {role:"system".into(),content:format!("文档标题来源：\n{heading}")},priority:5,memory_id:None,anchor:None}); }
        }
    } else if request.document.kind == "pdf" {
        let source = request.pdf_source.as_ref().ok_or("PDF上下文缺少实际页面来源")?;
        if source.source_hash != request.document.content_hash { return Err("PDF页面来源指纹不一致".into()); }
        if source.pages.iter().any(|page|page.needs_review) {return Err("PDF上下文包含需要复核的文字识别页面，请检查来源后选择可核验的文字或页面".into());}
        let selected_page = request.input.selection.as_ref().and_then(|selection|selection.page).or(request.input.page);
        for page in &source.pages {
            for (index,block) in page.blocks.iter().enumerate() {
                parts.push(OptionalSource {id:format!("pdf:page:{}:block:{index}",page.page_number),message:ChatMessage {role:"system".into(),content:format!("PDF第{}页实际正文：\n{}",page.page_number,block.text)},priority:if Some(page.page_number)==selected_page {1}else {4},memory_id:None,anchor:Some(json!({"path":request.document.path,"sourceHash":source.source_hash,"page":page.page_number,"pageBox":page.page_box,"rotation":page.rotation,"rects":block.rects,"method":block.method,"confidence":block.confidence}))});
            }
        }
    }
    Ok(parts)
}

fn knowledge_sources(request: &RequestContext) -> Result<Vec<OptionalSource>,String> {
    if request.input.knowledge_sources.is_empty() { return Ok(Vec::new()); }
    let root = crate::fs_api::ensure_dir_allowed(request.input.workspace_root.as_deref().ok_or("知识来源缺少授权工作区")?)?;
    let id = crate::rag::generation::workspace_id(&root);
    let catalog = rusqlite::Connection::open_with_flags(root.join(".stuart/index_catalog.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error|error.to_string())?;
    let (generation,status,database,parser):(String,String,String,u32) = catalog.query_row("SELECT g.id,g.status,g.database_path,g.parser_version FROM current_generation c JOIN generations g ON g.id=c.generation_id WHERE c.singleton=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|error|error.to_string())?;
    if parser != crate::rag::generation::PARSER_VERSION || !["Ready","Partial"].contains(&status.as_str()) { return Err("知识索引尚未形成可用的实际来源".into()); }
    let database_path = std::fs::canonicalize(database).map_err(|error|error.to_string())?;
    if !database_path.starts_with(root.join(".stuart/indices")) { return Err("知识数据库位置超出当前工作区".into()); }
    let connection = rusqlite::Connection::open_with_flags(database_path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error|error.to_string())?;
    let mut parts = Vec::new();
    let mut references = request.input.knowledge_sources.clone(); references.sort_by(|left,right|right.rrf_score.total_cmp(&left.rrf_score));
    for (rank,reference) in references.into_iter().enumerate() {
        if reference.workspace_id != id || reference.index_generation != generation || reference.index_status != status { return Err("知识命中所属工作区或索引代际已经变化".into()); }
        if status=="Partial" && !reference.partial_confirmed { return Err("引用部分索引前需要确认未完成的文件范围".into()); }
        let (content,path,hash,page,bounds,start,end):(String,String,String,Option<usize>,Option<String>,Option<usize>,Option<usize>)=connection.query_row("SELECT c.content,d.rel_path,d.content_hash,c.page_number,c.bounding_box,c.start_line,c.end_line FROM rag_chunks c JOIN rag_documents d ON d.doc_id=c.doc_id WHERE c.chunk_id=?1",[&reference.chunk_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))).map_err(|error|error.to_string())?;
        let source = std::fs::canonicalize(root.join(&path)).map_err(|error|error.to_string())?;
        if !source.starts_with(&root)||crate::rag::model_registry::file_sha256(&source)?!=hash { return Err("知识来源文件已经变化，请等待重新建立索引".into()); }
        let bounds:Option<Value>=bounds.map(|bounds|serde_json::from_str(&bounds).map_err(|error|error.to_string())).transpose()?;
        parts.push(OptionalSource {id:reference.chunk_id.clone(),message:ChatMessage {role:"system".into(),content:format!("引用资料，来源{path}{}：\n{content}",page.map(|page|format!("第{page}页")).unwrap_or_default())},priority:2+rank,memory_id:None,anchor:Some(json!({"chunkId":reference.chunk_id,"workspaceId":id,"indexGeneration":generation,"indexStatus":status,"sourceHash":hash,"path":crate::fs_api::display_path(&source),"page":page,"bounds":bounds,"startLine":start,"endLine":end}))});
    }
    Ok(parts)
}

pub async fn assemble_for_request(provider: &Value, api_key: &str, request: RequestContext, max_output_tokens: usize, cancellation: CancellationToken) -> Result<ValidatedContext,String> {
    let document_id=&request.document.document_id; let session_id=&request.session_id; let window_id=&request.window_id;
    if document_id.is_empty() || session_id.is_empty() || window_id.is_empty() { return Err("上下文缺少文档、会话或窗口编号".into()); }
    validate_focus(&request)?;
    let mut messages=request.messages.clone();
    if messages.is_empty() || messages.iter().any(|message| !["user","assistant","system"].contains(&message.role.as_str())) {
        return Err("上下文消息缺失或角色无效".into());
    }
    let settings = ensure_enabled(&cancellation)?;
    let settings_revision = hash_json(&crate::ai_chat::load_ai_settings())?;
    let spec = ProviderModelSpec::from_provider(provider)?;
    if settings.pointer("/ai/token_counting_invalidations").and_then(Value::as_object).is_some_and(|records|records.contains_key(&spec.identity().expect("模型计数身份无效"))) { return Err("TokenCountingMismatch：模型计数配置已经失效，请验证并保存新的计数配置".into()); }
    if max_output_tokens == 0 || max_output_tokens > spec.max_output_tokens || max_output_tokens >= spec.context_window { return Err("InvalidTokenBudget：输出预留超过模型限制".into()); }
    let mut used_memory_ids = Vec::new();
    let mut optional=document_sources(&request)?;
    optional.extend(knowledge_sources(&request)?);
    let mut source_anchors=Vec::new();
    if request.input.scope=="full" {
        let mut remaining=Vec::new();
        for source in optional {
            if source.id=="document:full" || source.id.starts_with("pdf:page:") {
                messages.insert(0,source.message);
                if let Some(anchor)=source.anchor {source_anchors.push(anchor);}
            } else {remaining.push(source);}
        }
        optional=remaining;
    }
    if settings.pointer("/ai/memory_mode").and_then(Value::as_str) != Some("off") {
        let workspace = request.input.workspace_root.as_deref();
        let memories = crate::memory::get_archive_storage()?.effective_document_memories(workspace,document_id,request.document.path.as_deref())?;
        for memory in memories {
            let message=ChatMessage {role:"system".into(),content:format!("用户已经确认的适用记忆：\n{}",serde_json::to_string(&memory).map_err(|error|error.to_string())?)};
            if memory.pinned || ["preference","decision"].contains(&memory.category.as_str()) {used_memory_ids.push(memory.memory_id);messages.insert(0,message);}
            else {optional.push(OptionalSource {id:memory.memory_id.clone(),message,priority:8,memory_id:Some(memory.memory_id),anchor:memory.source_anchor});}
        }
    }
    let mut prompt_tokens = count_messages(&spec,api_key,&messages,&cancellation).await?;
    let mut protocol_reserve = spec.protocol_reserve.checked_add((prompt_tokens as f64 * spec.estimate_safety_ratio).ceil() as usize).ok_or("预算整数溢出")?;
    let mut summaries = Vec::new();
    let mut omitted_sources = Vec::new();
    if check_final_budget(prompt_tokens,max_output_tokens,protocol_reserve,spec.context_window).is_err() {
        let history = crate::memory::get_archive_storage()?.get_completed_messages(session_id)?;
        if history.len() > 2 {
            let older = &history[..history.len()-2];
            let replaceable: Vec<_> = older.iter().filter(|source|messages.iter().any(|message|message.role==source.role && message.content==source.content)).collect();
            if !replaceable.is_empty() {
                let summary = summarize_history(provider,api_key,older,cancellation.clone()).await?;
                for source in replaceable {
                    if let Some(index) = messages.iter().position(|message|message.role==source.role && message.content==source.content) {
                        messages.remove(index);
                        omitted_sources.push(source.message_id.clone());
                    }
                }
                messages.insert(0,ChatMessage {role:"system".into(),content:format!("已核验原文来源的历史摘要：\n{}",serde_json::to_string(&summary).map_err(|e|e.to_string())?)});
                crate::memory::get_archive_storage()?.record_summary(session_id,&spec.identity()?,&summary,older)?;
                summaries.push(summary);
                prompt_tokens = count_messages(&spec,api_key,&messages,&cancellation).await?;
                protocol_reserve = spec.protocol_reserve.checked_add((prompt_tokens as f64 * spec.estimate_safety_ratio).ceil() as usize).ok_or("预算整数溢出")?;
            }
        }
    }
    check_final_budget(prompt_tokens,max_output_tokens,protocol_reserve,spec.context_window)?;
    optional.sort_by_key(|source|source.priority);
    if !optional.is_empty() {
        let candidate_for=|length:usize|optional[..length].iter().map(|source|source.message.clone()).chain(messages.iter().cloned()).collect::<Vec<_>>();
        let mut length=optional.len();
        let mut candidate=candidate_for(length);
        let mut count=count_messages(&spec,api_key,&candidate,&cancellation).await?;
        let reserve_for=|count:usize|spec.protocol_reserve.checked_add((count as f64*spec.estimate_safety_ratio).ceil() as usize).ok_or("预算整数溢出");
        if check_final_budget(count,max_output_tokens,reserve_for(count)?,spec.context_window).is_err() {
            let mut low=0;let mut high=length;
            while low+1<high {
                let middle=(low+high)/2;
                let count=count_messages(&spec,api_key,&candidate_for(middle),&cancellation).await?;
                if check_final_budget(count,max_output_tokens,reserve_for(count)?,spec.context_window).is_ok() {low=middle;} else {high=middle;}
            }
            length=low;candidate=candidate_for(length);
            count=count_messages(&spec,api_key,&candidate,&cancellation).await?;
        }
        protocol_reserve=reserve_for(count)?;
        check_final_budget(count,max_output_tokens,protocol_reserve,spec.context_window)?;
        messages=candidate;prompt_tokens=count;
        for (index,source) in optional.into_iter().enumerate() {
            if index<length {
                if let Some(id)=source.memory_id {used_memory_ids.push(id);}
                if let Some(anchor)=source.anchor {source_anchors.push(anchor);}
            } else {omitted_sources.push(source.id);}
        }
    }
    let current_settings = ensure_enabled(&cancellation)?;
    let _ = current_settings;
    if hash_json(&crate::ai_chat::load_ai_settings())? != settings_revision { return Err("SettingsChanged：上下文组装期间设置已经变化".into()); }
    Ok(ValidatedContext {messages_hash:hash_json(&messages)?,model_spec_id:spec.identity()?,messages,prompt_tokens,
        requested_output_tokens:max_output_tokens,protocol_reserve,context_window:spec.context_window,count_method:spec.count_method,
        settings_revision,document_id:document_id.clone(),session_id:session_id.clone(),window_id:window_id.clone(),used_memory_ids,omitted_sources,summaries,source_anchors})
}

pub fn check_final_budget(prompt: usize, output: usize, reserve: usize, window: usize) -> Result<(),String> {
    if window == 0 || output == 0 { return Err("InvalidTokenBudget：上下文及输出限制必须大于零".into()); }
    let total = prompt.checked_add(output).and_then(|sum|sum.checked_add(reserve)).ok_or("预算整数溢出")?;
    if total > window { return Err(format!("ContextTooLarge：输入 {prompt}，输出预留 {output}，协议预留 {reserve}，模型窗口 {window}")); }
    Ok(())
}

pub fn validate_usage(context: &ValidatedContext, actual_prompt_tokens: usize) -> Result<(),String> {
    if actual_prompt_tokens > context.prompt_tokens.saturating_add(context.protocol_reserve) {
        crate::fs_api::modify_settings(|settings| {
            let ai=settings.get_mut("ai").and_then(Value::as_object_mut).ok_or("AI设置缺失")?;
            let records=ai.entry("token_counting_invalidations").or_insert_with(||json!({})).as_object_mut().ok_or("计数失效记录类型错误")?;
            records.insert(context.model_spec_id.clone(),json!({"plannedPromptTokens":context.prompt_tokens,"protocolReserve":context.protocol_reserve,"actualPromptTokens":actual_prompt_tokens,"time":crate::memory::sqlite_archive::now_millis()}));
            Ok(())
        })?;
        return Err("TokenCountingMismatch：实际 usage 超过已验证计数及预留，该计数配置已经停止使用".into());
    }
    check_final_budget(actual_prompt_tokens,context.requested_output_tokens,0,context.context_window)
}

pub async fn summarize_history(provider: &Value, api_key: &str, sources: &[crate::memory::ChatArchiveMessage], cancellation: CancellationToken) -> Result<StructuredSummary,String> {
    if sources.is_empty() { return Err("摘要来源为空".into()); }
    if sources.iter().any(|message|message.completion_status != "Completed") { return Err("摘要来源包含未完成消息".into()); }
    let originals: HashMap<String,String> = sources.iter().map(|message|(message.message_id.clone(),message.content.clone())).collect();
    let source_json: Vec<Value> = sources.iter().map(|message|json!({"messageId":message.message_id,"role":message.role,"content":message.content})).collect();
    let instruction = "请完整提取决定、有效约束、最新修正及待解决问题。仅返回JSON对象，字段为decisions、constraints、corrections、openQuestions，每个字段为数组，每个条目含text、sources。sources每个条目包含messageId及直接来自原文的quote。保留否定和修正关系。来源未提供的内容禁止生成。";
    let messages = vec![ChatMessage {role:"system".into(),content:instruction.into()},ChatMessage {role:"user".into(),content:serde_json::to_string(&source_json).map_err(|e| e.to_string())?}];
    let spec = ProviderModelSpec::from_provider(provider)?;
    let output = 2048.min(spec.max_output_tokens);
    let count = count_messages(&spec,api_key,&messages,&cancellation).await?;
    let reserve = spec.protocol_reserve + (count as f64 * spec.estimate_safety_ratio).ceil() as usize;
    check_final_budget(count,output,reserve,spec.context_window)?;
    let base = match spec.provider_id.as_str() {
        "deepseek" => "https://api.deepseek.com/v1", "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "kimi" => "https://api.moonshot.cn/v1", "glm" => "https://open.bigmodel.cn/api/paas/v4",
        _ => provider.get("base_url").and_then(Value::as_str).ok_or("服务商地址缺失")?,
    };
    let url = url::Url::parse(base).map_err(|e| e.to_string())?;
    if url.scheme() != "https" && !(url.scheme()=="http" && ["localhost","127.0.0.1","::1"].contains(&url.host_str().unwrap_or_default())) { return Err("摘要服务商地址协议无效".into()); }
    ensure_enabled(&cancellation)?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
    let work = async {
        let response = client.post(format!("{}/chat/completions",base.trim_end_matches('/'))).bearer_auth(api_key)
            .json(&json!({"model":spec.model_id,"messages":messages,"stream":false,"max_tokens":output,"response_format":{"type":"json_object"}})).send().await.map_err(|e|format!("摘要连接失败：{}",e.without_url()))?;
        if !response.status().is_success() { return Err(format!("摘要请求返回 HTTP {}",response.status())); }
        let value: Value = response.json().await.map_err(|e|e.to_string())?;
        if value.pointer("/choices/0/finish_reason").and_then(Value::as_str)!=Some("stop") {return Err("历史摘要没有完整生成".into());}
        let actual=value.pointer("/usage/prompt_tokens").and_then(Value::as_u64).ok_or("历史摘要缺少实际usage")? as usize;
        if actual>count.saturating_add(reserve) {return Err("TokenCountingMismatch：历史摘要实际计数超过预留".into());}
        check_final_budget(actual,output,0,spec.context_window)?;
        let content = value.pointer("/choices/0/message/content").and_then(Value::as_str).ok_or("摘要响应缺少正文")?;
        let summary: StructuredSummary = serde_json::from_str(content).map_err(|e|format!("结构摘要格式无效：{e}"))?;
        summary.validate(&originals)?;
        ensure_enabled(&cancellation)?;
        Ok(summary)
    };
    tokio::select! { _ = cancellation.cancelled() => Err("Cancelled".into()),result = work => result }
}
