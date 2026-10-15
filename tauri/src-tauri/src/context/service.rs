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
pub struct PdfSelectionSegment {
    pub page: usize,
    pub quote: String,
    pub rects: Vec<[f32; 4]>,
    pub file_fingerprint: String,
}

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
    #[serde(default)]
    pub segments: Vec<PdfSelectionSegment>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextInput {
    pub editor_revision: u64,
    pub source_hash: String,
    pub selection: Option<ContextSelection>,
    #[serde(default = "document_scope")]
    pub scope: String,
    pub workspace_root: Option<String>,
    pub page: Option<usize>,
    #[serde(default)]
    pub knowledge_sources: Vec<KnowledgeSourceRef>,
    pub reading_anchor: Option<super::sources::ReadingAnchor>,
    #[serde(default)]
    pub explicit_sources: Vec<super::sources::SourceInput>,
    #[serde(default)]
    pub partial_confirmed: bool,
    pub index_generation: Option<String>,
    pub coverage_hash: Option<String>,
}

fn document_scope() -> String { "document".into() }

impl Default for ContextInput {
    fn default() -> Self {
        Self {editor_revision:0,source_hash:String::new(),selection:None,scope:document_scope(),workspace_root:None,page:None,knowledge_sources:Vec::new(),reading_anchor:None,explicit_sources:Vec::new(),partial_confirmed:false,index_generation:None,coverage_hash:None}
    }
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: String,
    pub session_id: String,
    pub window_id: String,
    pub document: Option<crate::document::DocumentContextSnapshot>,
    pub document_key: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub input: ContextInput,
    pub pdf_source: Option<crate::rag::pdf_extract::PdfContent>,
    pub workspace_sources: Vec<super::sources::SourceRef>,
    pub resolved_sources: Vec<super::sources::SourceRef>,
    pub settings: Value,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ValidatedContext {
    pub messages: Vec<ChatMessage>, pub prompt_tokens: usize, pub requested_output_tokens: usize,
    pub protocol_reserve: usize, pub context_window: usize, pub count_method: String,
    pub messages_hash: String, pub model_spec_id: String, pub settings_revision: String,
    pub document_id: Option<String>, pub session_id: String, pub window_id: String,
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

pub async fn assemble_for_request(provider: &Value, api_key: &str, request: RequestContext, max_output_tokens: usize, cancellation: CancellationToken) -> Result<ValidatedContext,String> {
    assemble_for_request_with_stage(provider,api_key,request,max_output_tokens,cancellation,|_|Ok(())).await
}

pub async fn assemble_for_request_with_stage<F>(provider: &Value, api_key: &str, request: RequestContext, max_output_tokens: usize, cancellation: CancellationToken, mut stage: F) -> Result<ValidatedContext,String>
where F: FnMut(&str) -> Result<(),String> {
    let document_id=request.document.as_ref().map(|document|document.document_id.clone()); let session_id=&request.session_id; let window_id=&request.window_id;
    stage("PreparingSources")?;
    super::sources::validate_request(&request)?;
    let mut messages=request.messages.clone();
    if messages.is_empty() || messages.iter().any(|message| !["user","assistant","system"].contains(&message.role.as_str())) {
        return Err("上下文消息缺失或角色无效".into());
    }
    ensure_enabled(&cancellation)?;
    let settings = &request.settings;
    let settings_revision = hash_json(settings)?;
    let spec = ProviderModelSpec::from_provider(provider)?;
    if settings.get("token_counting_invalidations").and_then(Value::as_object).is_some_and(|records|records.contains_key(&spec.identity().expect("模型计数身份无效"))) { return Err("TokenCountingMismatch：模型计数配置已经失效，请验证并保存新的计数配置".into()); }
    if max_output_tokens == 0 || max_output_tokens > spec.max_output_tokens || max_output_tokens >= spec.context_window { return Err("InvalidTokenBudget：输出预留超过模型限制".into()); }
    let mut used_memory_ids = Vec::new();
    let use_memory = settings.get("use_saved_memories").and_then(Value::as_bool).unwrap_or(true);
    let sources = super::sources::prepare_materials(&request,use_memory)?;
    let (mut mandatory,mut optional): (Vec<_>,Vec<_>) = sources.into_iter().partition(|source|source.mandatory);
    for source in &mut mandatory {
        source.used=true;
        messages.insert(0,source.message());
        if let Some(id)=&source.memory_id {used_memory_ids.push(id.clone());}
    }
    let mut source_anchors=Vec::new();
    stage("Counting")?;
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
                stage("Summarizing")?;
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
                stage("Counting")?;
                prompt_tokens = count_messages(&spec,api_key,&messages,&cancellation).await?;
                protocol_reserve = spec.protocol_reserve.checked_add((prompt_tokens as f64 * spec.estimate_safety_ratio).ceil() as usize).ok_or("预算整数溢出")?;
            }
        }
    }
    check_final_budget(prompt_tokens,max_output_tokens,protocol_reserve,spec.context_window).map_err(|error|format!("{error}。必要材料：{}",mandatory.iter().map(|source|source.title.as_str()).collect::<Vec<_>>().join("、")))?;
    optional.sort_by_key(|source|if source.kind=="memory" {8} else {2});
    if !optional.is_empty() {
        let candidate_for=|length:usize|optional[..length].iter().map(|source|source.message()).chain(messages.iter().cloned()).collect::<Vec<_>>();
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
        for (index,mut source) in optional.into_iter().enumerate() {
            if index<length {
                source.used=true;
                if let Some(id)=&source.memory_id {used_memory_ids.push(id.clone());}
            } else {omitted_sources.push(source.source_id.clone());}
            source_anchors.push(serde_json::to_value(source).map_err(|error|error.to_string())?);
        }
    }
    for source in mandatory {source_anchors.push(serde_json::to_value(source).map_err(|error|error.to_string())?);}
    if super::sources::normalize_scope(&request.input.scope)?=="workspace" && !source_anchors.iter().any(|source|source["used"]==true && source["kind"]=="knowledge") {return Err("ContextTooLarge：工作区知识材料没有能够进入模型容量的实际片段".into());}
    ensure_enabled(&cancellation)?;
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
        let mut body=json!({"model":spec.model_id,"messages":messages,"stream":false,"max_tokens":output,"response_format":{"type":"json_object"}});
        if spec.provider_id=="deepseek" {body["thinking"]=json!({"type":"disabled"});}
        if spec.provider_id=="qwen" {body["enable_thinking"]=json!(false);}
        if spec.provider_id=="glm" && (spec.model_id.starts_with("glm-4.5") || spec.model_id.starts_with("glm-4.6") || spec.model_id.starts_with("glm-4.7")) {body["thinking"]=json!({"type":"disabled"});}
        let response = client.post(format!("{}/chat/completions",base.trim_end_matches('/'))).bearer_auth(api_key)
            .json(&body).send().await.map_err(|e|format!("摘要连接失败：{}",e.without_url()))?;
        if !response.status().is_success() { return Err(format!("摘要请求返回 HTTP {}",response.status())); }
        let value: Value = response.json().await.map_err(|e|e.to_string())?;
        if value.pointer("/choices/0/finish_reason").and_then(Value::as_str)!=Some("stop") {return Err("历史摘要没有完整生成".into());}
        let actual=value.pointer("/usage/prompt_tokens").and_then(Value::as_u64).ok_or("历史摘要缺少实际usage")? as usize;
        let completed=value.pointer("/usage/completion_tokens").and_then(Value::as_u64).ok_or("历史摘要缺少实际输出usage")? as usize;
        if actual>count.saturating_add(reserve) {return Err("TokenCountingMismatch：历史摘要实际计数超过预留".into());}
        if completed>output {return Err("历史摘要实际输出超过已经预留的容量".into());}
        check_final_budget(actual,output,0,spec.context_window)?;
        let content = value.pointer("/choices/0/message/content").and_then(Value::as_str).ok_or("摘要响应缺少正文")?;
        let summary: StructuredSummary = serde_json::from_str(content).map_err(|e|format!("结构摘要格式无效：{e}"))?;
        summary.validate(&originals)?;
        ensure_enabled(&cancellation)?;
        Ok(summary)
    };
    tokio::select! { _ = cancellation.cancelled() => Err("Cancelled".into()),result = work => result }
}
