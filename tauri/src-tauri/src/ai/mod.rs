use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use crate::context::service::{ChatMessage, ContextInput, RequestContext, ValidatedContext};

struct Request {
    window_id: String, document_id: String, session_id: String,
    cancellation: CancellationToken, finished: Arc<Notify>,
    seq: u64, text: String, status: String, error: Option<String>, final_hash: Option<String>,
    context: Option<ValidatedContext>, usage: Option<Value>, created_at: u64,
}
static REQUESTS: LazyLock<Mutex<HashMap<String, Request>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct Probe {window_id:String,cancellation:CancellationToken,finished:Arc<Notify>,ended:Arc<AtomicBool>}
static PROBES:LazyLock<Mutex<HashMap<String,Probe>>>=LazyLock::new(||Mutex::new(HashMap::new()));
pub struct ProbeGuard {id:String,pub cancellation:CancellationToken}
pub fn begin_probe(window_id:&str)->Result<ProbeGuard,String> {
    let cancellation=CancellationToken::new();crate::context::service::ensure_enabled(&cancellation)?;
    let id=uuid::Uuid::new_v4().to_string();
    PROBES.lock().map_err(|_|"AI验证请求锁损坏")?.insert(id.clone(),Probe {window_id:window_id.into(),cancellation:cancellation.clone(),finished:Arc::new(Notify::new()),ended:Arc::new(AtomicBool::new(false))});
    Ok(ProbeGuard {id,cancellation})
}
impl Drop for ProbeGuard {
    fn drop(&mut self) {
        let probe=PROBES.lock().expect("AI验证请求锁损坏").remove(&self.id).expect("AI验证请求记录丢失");
        probe.ended.store(true,Ordering::Release);probe.finished.notify_waiters();
    }
}

fn terminal(status: &str) -> bool { ["Completed", "Failed", "Cancelled"].contains(&status) }
pub fn cancel_window(window_id: &str) {
    for request in REQUESTS.lock().expect("AI请求锁损坏").values() {
        if request.window_id == window_id && !terminal(&request.status) { request.cancellation.cancel(); }
    }
    for probe in PROBES.lock().expect("AI验证请求锁损坏").values() {if probe.window_id==window_id {probe.cancellation.cancel();}}
}
pub fn cancel_all() {
    for request in REQUESTS.lock().expect("AI请求锁损坏").values() {
        if !terminal(&request.status) { request.cancellation.cancel(); }
    }
    for probe in PROBES.lock().expect("AI验证请求锁损坏").values() {probe.cancellation.cancel();}
}
pub async fn cancel_all_and_wait() -> Result<(), String> {
    cancel_and_wait(None).await
}
pub async fn cancel_window_and_wait(window_id:&str) -> Result<(),String> {
    cancel_and_wait(Some(window_id)).await
}
async fn cancel_and_wait(window_id:Option<&str>) -> Result<(),String> {
    let requests: Vec<_> = {
        let registry=REQUESTS.lock().map_err(|_|"AI请求锁损坏")?;
        registry.iter().filter(|(_,request)|!terminal(&request.status) && window_id.is_none_or(|owner|owner==request.window_id)).map(|(id,request)| {
            request.cancellation.cancel(); (id.clone(),request.finished.clone())
        }).collect()
    };
    let probes:Vec<_>={let registry=PROBES.lock().map_err(|_|"AI验证请求锁损坏")?;registry.values().filter(|probe|window_id.is_none_or(|owner|owner==probe.window_id)).map(|probe|{probe.cancellation.cancel();(probe.finished.clone(),probe.ended.clone())}).collect()};
    let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(30);
    for (id,finished) in requests {
        let waiting=finished.notified();tokio::pin!(waiting);waiting.as_mut().enable();
        let unfinished=REQUESTS.lock().map_err(|_|"AI请求锁损坏")?.get(&id).is_some_and(|request|!terminal(&request.status));
        if unfinished {
            tokio::time::timeout_at(deadline,waiting).await.map_err(|_|"AI请求取消确认超时")?;
        }
    }
    for (finished,ended) in probes {
        let waiting=finished.notified();tokio::pin!(waiting);waiting.as_mut().enable();
        if !ended.load(Ordering::Acquire) {tokio::time::timeout_at(deadline,waiting).await.map_err(|_|"AI验证请求取消确认超时")?;}
    }
    Ok(())
}
fn snapshot(request_id: &str, owner: &str) -> Result<Value, String> {
    let registry=REQUESTS.lock().map_err(|_|"AI请求锁损坏")?;
    let request=registry.get(request_id).ok_or("请求不存在")?;
    if request.window_id != owner { return Err("当前窗口无权访问该请求".into()); }
    Ok(json!({"requestId":request_id,"documentId":request.document_id,"sessionId":request.session_id,
        "seq":request.seq,"text":request.text,"status":request.status,"type":if terminal(&request.status){"done"}else{"snapshot"},
        "error":request.error,"finalHash":request.final_hash,"context":request.context,"usage":request.usage}))
}
fn notify_window(app:&tauri::AppHandle,window_id:&str,payload:Value)->Result<(),String> {
    if let Some(window)=app.get_webview_window(window_id) { window.emit("ai-request-event",payload).map_err(|error|error.to_string())?; }
    Ok(())
}
#[tauri::command]
pub fn stuart_ai_request_status(window:tauri::WebviewWindow,request_id:String)->Result<Value,String> { snapshot(&request_id,window.label()) }
#[tauri::command]
pub fn stuart_ai_request_cancel(window:tauri::WebviewWindow,request_id:String)->Result<Value,String> {
    snapshot(&request_id,window.label())?;
    REQUESTS.lock().map_err(|_|"AI请求锁损坏")?.get(&request_id).ok_or("请求不存在")?.cancellation.cancel();
    Ok(json!({"ok":true,"requestId":request_id}))
}

#[tauri::command]
pub fn stuart_ai_request_start(window:tauri::WebviewWindow,document_service:tauri::State<crate::document::DocumentService>,
    request_id:String,provider_id:Option<String>,model:Option<String>,messages:Value,thinking:Option<String>,
    max_output_tokens:Option<usize>,document_id:String,session_id:String,context_input:ContextInput)->Result<Value,String> {
    crate::context::service::ensure_enabled(&CancellationToken::new())?;
    uuid::Uuid::parse_str(&request_id).map_err(|_|"AI请求编号必须是UUID")?;
    document_service.validate_context_snapshot(window.label(),&document_id,context_input.editor_revision,&context_input.source_hash)?;
    let document=document_service.snapshot_for_window(window.label(),&document_id)?;
    if let Some(root)=&context_input.workspace_root {crate::fs_api::ensure_window_read_allowed(&window,root)?;}
    let session=crate::memory::get_archive_storage()?.get_session(&session_id)?;
    if session.document_id.as_deref()!=Some(&document_id) || session.workspace_root!=context_input.workspace_root {return Err("请求文档或工作区与会话所属范围不一致".into());}
    let cfg=crate::ai_chat::load_ai_settings();
    let pid=provider_id.or_else(||cfg["active_provider_id"].as_str().map(str::to_owned)).ok_or("未配置AI服务商")?;
    let mut provider=crate::ai_chat::active_provider(&json!({"active_provider_id":pid,"providers":cfg["providers"]}))?;
    if provider["enabled"].as_bool()!=Some(true) {return Err("当前AI服务商未启用".into());}
    if let Some(model)=model {provider["model"]=json!(model);}
    let key=crate::ai_chat::read_api_key(&pid)?;
    let messages:Vec<ChatMessage>=serde_json::from_value(messages).map_err(|error|error.to_string())?;
    if messages.last().is_none_or(|message|message.role!="user" || message.content.trim().is_empty()) {return Err("AI请求缺少当前完整问题".into());}
    let completed=crate::memory::get_archive_storage()?.get_completed_messages(&session_id)?;
    for message in messages.iter().take(messages.len()-1).filter(|message|message.role!="system") {
        if !completed.iter().any(|stored|stored.role==message.role && stored.content==message.content) {return Err("会话历史缺少实际完成消息来源".into());}
    }
    let max_output=max_output_tokens.or_else(||cfg["max_output_tokens"].as_u64().map(|number|number as usize)).ok_or("未配置输出Token预算")?;
    let cancellation=CancellationToken::new();
    let owner=window.label().to_owned();
    let request=Request {window_id:owner.clone(),document_id:document_id.clone(),session_id:session_id.clone(),cancellation:cancellation.clone(),finished:Arc::new(Notify::new()),seq:0,text:String::new(),status:"Preparing".into(),error:None,final_hash:None,context:None,usage:None,created_at:crate::memory::sqlite_archive::now_millis()};
    {
        let mut registry=REQUESTS.lock().map_err(|_|"AI请求锁损坏")?;
        if registry.contains_key(&request_id) {return Err("AI请求编号已存在".into());}
        if registry.values().any(|request|request.window_id==owner && !terminal(&request.status)) {return Err("当前窗口的AI请求尚未结束".into());}
        if registry.len()>=512 {
            let mut old:Vec<_>=registry.iter().filter(|(_,request)|terminal(&request.status)).map(|(id,request)|(id.clone(),request.created_at)).collect();old.sort_by_key(|item|item.1);
            for (id,_) in old.into_iter().take(256) {registry.remove(&id);}
        }
        registry.insert(request_id.clone(),request);
    }
    let app=window.app_handle().clone();let rid=request_id.clone();
    let source_anchor=json!({"documentId":document_id,"path":document.path,"revision":document.revision,"sourceHash":document.content_hash,"selection":context_input.selection});
    let request_context=RequestContext {request_id:rid.clone(),session_id:session_id.clone(),window_id:owner.clone(),document,messages,input:context_input,pdf_source:None};
    tauri::async_runtime::spawn(async move {
        let result=run(&app,&owner,&rid,&provider,&key,request_context,max_output,thinking,cancellation.clone()).await;
        let (mut status,mut error)=match result {Ok(())=>("Completed".to_owned(),None),Err(error) if cancellation.is_cancelled()=>("Cancelled".to_owned(),Some(error)),Err(error)=>("Failed".to_owned(),Some(error))};
        let current=snapshot(&rid,&owner).expect("AI请求记录丢失");let text=current["text"].as_str().expect("AI正文类型错误").to_owned();
        let saved=crate::memory::get_archive_storage().and_then(|storage|storage.add_message(crate::memory::ChatArchiveMessage {
            message_id:uuid::Uuid::new_v4().to_string(),session_id:session_id.clone(),role:"assistant".into(),content:text.clone(),timestamp:crate::memory::sqlite_archive::now_millis(),anchor_file:source_anchor["path"].as_str().map(str::to_owned),anchor_line:None,
            request_id:Some(rid.clone()),document_id:Some(document_id.clone()),completion_status:status.clone(),source_hash:source_anchor["sourceHash"].as_str().map(str::to_owned),source_anchor:Some(source_anchor),sequence:0,
        }));
        if let Err(failure)=saved {status="Failed".into();error=Some(format!("保存回答失败：{failure}"));}
        let finished={let mut registry=REQUESTS.lock().expect("AI请求锁损坏");let request=registry.get_mut(&rid).expect("AI请求记录丢失");request.seq+=1;request.status=status;request.error=error;request.final_hash=Some(format!("{:x}",Sha256::digest(text.as_bytes())));request.finished.clone()};
        finished.notify_waiters();
        notify_window(&app,&owner,snapshot(&rid,&owner).expect("AI请求记录丢失")).expect("发送AI完成事件失败");
    });
    Ok(json!({"ok":true,"requestId":request_id}))
}

async fn run(app:&tauri::AppHandle,owner:&str,rid:&str,provider:&Value,key:&str,mut request:RequestContext,max_output:usize,thinking:Option<String>,cancellation:CancellationToken)->Result<(),String> {
    if request.document.kind=="pdf" {
        let path=std::path::PathBuf::from(request.document.path.as_ref().ok_or("PDF上下文来源路径缺失")?);
        let native=if cfg!(debug_assertions) {std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/native")}else {app.path().resource_dir().map_err(|error|error.to_string())?.join("native")};
        let page=request.input.selection.as_ref().and_then(|selection|selection.page).or(request.input.page);let full=request.input.scope=="full";
        let cancelled=Arc::new(AtomicBool::new(false));let worker_cancelled=cancelled.clone();
        let mut extraction=tokio::task::spawn_blocking(move ||if full {crate::rag::pdf_extract::extract_pdf(&path,&native,&worker_cancelled)}else {crate::rag::pdf_extract::extract_pdf_context(&path,&native,&worker_cancelled,page.ok_or("PDF上下文缺少当前页码")?)});
        request.pdf_source=Some(tokio::select! {_=cancellation.cancelled()=> {cancelled.store(true,Ordering::Release);match extraction.await.map_err(|error|error.to_string())? {Ok(_)=>{},Err(error) if error=="Cancelled"=>{},Err(error)=>return Err(error)};return Err("已取消生成".into());},result=&mut extraction=>result.map_err(|error|error.to_string())??});
    }
    let budget=crate::context::service::assemble_for_request(provider,key,request.clone(),max_output,cancellation.clone()).await?;
    crate::context::service::ensure_enabled(&cancellation)?;
    app.state::<crate::document::DocumentService>().validate_context_snapshot(owner,&request.document.document_id,request.input.editor_revision,&request.input.source_hash)?;
    let storage=crate::memory::get_archive_storage()?;
    storage.record_context(rid,&request.session_id,&serde_json::to_value(&budget).map_err(|error|error.to_string())?)?;
    REQUESTS.lock().map_err(|_|"AI请求锁损坏")?.get_mut(rid).ok_or("AI请求记录丢失")?.context=Some(budget.clone());
    let question=request.messages.last().ok_or("当前问题缺失")?;
    storage.add_message(crate::memory::ChatArchiveMessage {message_id:uuid::Uuid::new_v4().to_string(),session_id:request.session_id.clone(),role:"user".into(),content:question.content.clone(),timestamp:crate::memory::sqlite_archive::now_millis(),anchor_file:request.document.path.clone(),anchor_line:None,request_id:Some(rid.into()),document_id:Some(request.document.document_id.clone()),completion_status:"Completed".into(),source_hash:Some(request.document.content_hash.clone()),source_anchor:Some(json!({"selection":request.input.selection,"documentRevision":request.document.revision})),sequence:0})?;
    let usage=stream_completion(provider,key,&budget,thinking.as_deref(),cancellation,|piece| {
        let payload={let mut registry=REQUESTS.lock().map_err(|_|"AI请求锁损坏")?;let request=registry.get_mut(rid).ok_or("AI请求记录丢失")?;request.status="Streaming".into();request.seq+=1;request.text.push_str(piece);json!({"requestId":rid,"documentId":request.document_id,"sessionId":request.session_id,"seq":request.seq,"type":"delta","text":piece,"status":request.status})};
        notify_window(app,owner,payload)
    }).await?;
    storage.record_context(rid,&request.session_id,&json!({"validated":budget,"usage":usage}))?;
    REQUESTS.lock().map_err(|_|"AI请求锁损坏")?.get_mut(rid).ok_or("AI请求记录丢失")?.usage=Some(usage);
    Ok(())
}

pub async fn stream_completion(provider:&Value,key:&str,budget:&ValidatedContext,thinking:Option<&str>,cancellation:CancellationToken,mut delta:impl FnMut(&str)->Result<(),String>)->Result<Value,String> {
    crate::context::service::ensure_enabled(&cancellation)?;
    let (base,_)=crate::ai_chat::effective_base_url(provider)?;
    let mut body=json!({"model":provider["model"],"messages":budget.messages,"stream":true,"stream_options":{"include_usage":true},"max_tokens":budget.requested_output_tokens});
    let mode=thinking.unwrap_or("balanced");
    if !["fast","balanced","deep"].contains(&mode) {return Err("AI思考模式无效".into());}
    if provider["id"].as_str()==Some("deepseek") {
        if mode=="fast" {body["thinking"]=json!({"type":"disabled"});}
        if mode=="deep" {body["thinking"]=json!({"type":"enabled"});body["reasoning_effort"]=json!("high");}
    } else if provider["id"].as_str()==Some("qwen") {
        if mode=="fast" {body["enable_thinking"]=json!(false);}
        if mode=="deep" {body["enable_thinking"]=json!(true);}
    } else if provider["id"].as_str()==Some("glm") && provider["model"].as_str().is_some_and(|model|model.starts_with("glm-4.5")||model.starts_with("glm-4.6")||model.starts_with("glm-4.7")) {
        if mode=="fast" {body["thinking"]=json!({"type":"disabled"});}
        if mode=="deep" {body["thinking"]=json!({"type":"enabled"});}
    }
    let client=reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(12)).timeout(std::time::Duration::from_secs(300)).redirect(reqwest::redirect::Policy::none()).build().map_err(|error|error.to_string())?;
    let response=tokio::select! {_=cancellation.cancelled()=>return Err("已取消生成".into()),response=client.post(format!("{base}/chat/completions")).bearer_auth(key).json(&body).send()=>response.map_err(|error|error.without_url().to_string())?};
    if !response.status().is_success() {return Err(format!("AI服务返回HTTP {}",response.status()));}
    if !response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value|value.to_str().ok()).is_some_and(|value|value.starts_with("text/event-stream")) {return Err("AI服务未返回SSE响应".into());}
    let mut stream=response.bytes_stream().eventsource();let mut completed=false;let mut finish=None;let mut usage=None;let mut produced=false;
    loop {
        let event=tokio::select! {_=cancellation.cancelled()=>return Err("已取消生成".into()),event=stream.next()=>event};
        let Some(event)=event else {break;};let event=event.map_err(|error|error.to_string())?;
        if event.data=="[DONE]" {completed=true;break;}
        crate::context::service::ensure_enabled(&cancellation)?;
        let value:Value=serde_json::from_str(&event.data).map_err(|error|format!("AI事件JSON无效：{error}"))?;
        if let Some(error)=value.get("error") {return Err(error["message"].as_str().unwrap_or("AI服务返回错误").to_owned());}
        if let Some(reason)=value.pointer("/choices/0/finish_reason").and_then(Value::as_str) {finish=Some(reason.to_owned());}
        if let Some(actual)=value.get("usage").filter(|usage|usage.is_object()) {usage=Some(actual.clone());}
        if let Some(piece)=value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            if !piece.is_empty() {delta(piece)?;produced=true;}
        }
    }
    if !completed {return Err("AI响应中断，缺少完成标记".into());}
    if finish.as_deref()!=Some("stop") {return Err(format!("AI回答未完整生成：{}",finish.as_deref().unwrap_or("缺少结束原因")));}
    if !produced {return Err("AI回答正文为空".into());}
    let usage=usage.ok_or("AI响应缺少实际usage，无法核验Token预算")?;
    let input=usage["prompt_tokens"].as_u64().ok_or("AI实际usage缺少prompt_tokens")? as usize;
    let output=usage["completion_tokens"].as_u64().ok_or("AI实际usage缺少completion_tokens")? as usize;
    crate::context::service::validate_usage(budget,input)?;
    if output>budget.requested_output_tokens {return Err("AI实际输出超过已经预留的Token预算".into());}
    crate::context::service::check_final_budget(input,output,0,budget.context_window)?;
    Ok(usage)
}

#[cfg(test)]
mod real_tests;
