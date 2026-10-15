use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest,Sha256};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use crate::context::service::{ContextInput, ValidatedContext};
pub mod companion;
pub mod model_catalog;
pub mod configuration;

struct Request {
    window_id: String, document_id: Option<String>, document_key: Option<String>, workspace_key: Option<String>, session_id: String,
    turn_id: String, attempt_no: u64, phase: String, config: Value,
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
    let settings_revision=format!("{:x}",Sha256::digest(serde_json::to_vec(&request.config).map_err(|e|e.to_string())?));
    Ok(json!({"requestId":request_id,"windowId":request.window_id,"documentId":request.document_id,"documentKey":request.document_key,"workspaceKey":request.workspace_key,"sessionId":request.session_id,"settingsRevision":settings_revision,
        "turnId":request.turn_id,"attemptNo":request.attempt_no,"phase":request.phase,
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
    rag:tauri::State<crate::rag::RagState>,
    request_id:String,provider_id:Option<String>,model:Option<String>,messages:Value,thinking:Option<String>,
    max_output_tokens:Option<usize>,document_id:String,session_id:String,context_input:ContextInput)->Result<Value,String> {
    companion::start_legacy(window,document_service,rag,json!({"requestId":request_id,"providerId":provider_id,
        "model":model,"messages":messages,"thinking":thinking,"maxOutputTokens":max_output_tokens,
        "documentId":document_id,"sessionId":session_id,"contextInput":context_input}))
}

pub async fn stream_completion(provider:&Value,key:&str,budget:&ValidatedContext,thinking:Option<&str>,cancellation:CancellationToken,delta:impl FnMut(&str)->Result<(),String>)->Result<Value,String> {
    stream_completion_with_format(provider,key,budget,thinking,cancellation,delta,false).await
}

pub async fn stream_json_completion(provider:&Value,key:&str,budget:&ValidatedContext,cancellation:CancellationToken,delta:impl FnMut(&str)->Result<(),String>)->Result<Value,String> {
    stream_completion_with_format(provider,key,budget,Some("fast"),cancellation,delta,true).await
}

async fn stream_completion_with_format(provider:&Value,key:&str,budget:&ValidatedContext,thinking:Option<&str>,cancellation:CancellationToken,mut delta:impl FnMut(&str)->Result<(),String>,json_response:bool)->Result<Value,String> {
    crate::context::service::ensure_enabled(&cancellation)?;
    let (base,_)=crate::ai_chat::effective_base_url(provider)?;
    let mut body=json!({"model":provider["model"],"messages":budget.messages,"stream":true,"stream_options":{"include_usage":true},"max_tokens":budget.requested_output_tokens});
    if json_response {body["response_format"]=json!({"type":"json_object"});}
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
