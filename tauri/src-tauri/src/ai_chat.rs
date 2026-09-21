//! AI provider config, DPAPI key storage, OpenAI-compatible streaming chat.
//! Keys live under `%APPDATA%\StuartMD\ai\keys\` — never in settings.json.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::Emitter;

use crate::ai_api::ai_home;
use crate::fs_api::{load_settings_migrated, save_json, settings_path};

static CANCEL: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static ACTIVE: LazyLock<Mutex<HashMap<String, ()>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn keys_dir() -> PathBuf {
    let d = ai_home().join("keys");
    let _ = fs::create_dir_all(&d);
    d
}

fn sanitize_provider_id(id: &str) -> Result<String, String> {
    let k = id.trim();
    if k.is_empty() || k.len() > 64 {
        return Err("服务商 ID 非法".into());
    }
    if !k
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("服务商 ID 仅允许字母数字 - _ .".into());
    }
    Ok(k.to_string())
}

fn key_path(id: &str) -> Result<PathBuf, String> {
    Ok(keys_dir().join(format!("{}.bin", sanitize_provider_id(id)?)))
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if plain.is_empty() {
        return Err("密钥为空".into());
    }
    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut in_blob,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("DPAPI 加密失败".into());
    }
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }
        .to_vec();
    unsafe { LocalFree(out_blob.pbData as *mut core::ffi::c_void) };
    Ok(out)
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if blob.is_empty() {
        return Err("密钥文件为空".into());
    }
    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let mut descr: *mut u16 = std::ptr::null_mut();
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            &mut descr,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("DPAPI 解密失败".into());
    }
    if !descr.is_null() {
        unsafe { LocalFree(descr as *mut core::ffi::c_void) };
    }
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }
        .to_vec();
    unsafe { LocalFree(out_blob.pbData as *mut core::ffi::c_void) };
    Ok(out)
}

#[cfg(not(windows))]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    // Non-Windows dev fallback only (product ships Windows DPAPI)
    let mut out = b"stmplain:".to_vec();
    out.extend_from_slice(plain);
    Ok(out)
}

#[cfg(not(windows))]
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    if let Some(rest) = blob.strip_prefix(b"stmplain:") {
        return Ok(rest.to_vec());
    }
    Err("密钥无法解密".into())
}

fn provider_has_key(id: &str) -> bool {
    key_path(id)
        .map(|p| p.is_file() && fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false))
        .unwrap_or(false)
}

fn read_api_key(id: &str) -> Result<String, String> {
    let p = key_path(id)?;
    if !p.is_file() {
        return Err("尚未配置该服务商的 API Key".into());
    }
    let blob = fs::read(&p).map_err(|e| e.to_string())?;
    let plain = dpapi_unprotect(&blob)?;
    String::from_utf8(plain).map_err(|_| "密钥编码无效".into())
}

pub fn builtin_ai_defaults() -> Value {
    json!({
        "enabled": true,
        "active_provider_id": "deepseek",
        "explain_shortcut": "Alt+E",
        "thinking": "balanced",
        "context_scope": "neighborhood",
        "context_max_chars": 8000,
        "max_output_tokens": 2048,
        "memory_mode": "always",
        "style": {
            "length": "normal",
            "tone": "neutral",
            "custom": "",
            "length_hint": "",
            "feedback": {"short": 0, "ok": 0, "long": 0}
        },
        "providers": [
            {
                "id": "deepseek",
                "label": "DeepSeek",
                "kind": "openai_compat",
                "base_url": "https://api.deepseek.com/v1",
                "model": "deepseek-chat",
                "enabled": true,
                "builtin": true
            },
            {
                "id": "qwen",
                "label": "通义千问 Qwen",
                "kind": "openai_compat",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model": "qwen-plus",
                "enabled": true,
                "builtin": true
            },
            {
                "id": "kimi",
                "label": "Kimi (Moonshot)",
                "kind": "openai_compat",
                "base_url": "https://api.moonshot.cn/v1",
                "model": "moonshot-v1-8k",
                "enabled": true,
                "builtin": true
            },
            {
                "id": "glm",
                "label": "智谱 GLM",
                "kind": "openai_compat",
                "base_url": "https://open.bigmodel.cn/api/paas/v4",
                "model": "glm-4-air",
                "enabled": true,
                "builtin": true
            },
            {
                "id": "custom",
                "label": "自定义 OpenAI 兼容",
                "kind": "openai_compat",
                "base_url": "",
                "model": "",
                "enabled": false,
                "builtin": true
            }
        ]
    })
}

fn merge_ai_settings(mut ai: Value) -> Value {
    let defaults = builtin_ai_defaults();
    if !ai.is_object() {
        return defaults;
    }
    if let (Some(obj), Some(def)) = (ai.as_object_mut(), defaults.as_object()) {
        for (k, v) in def {
            if k == "style" {
                let cur = obj.get("style").cloned().unwrap_or(json!({}));
                if let (Some(co), Some(do_)) = (cur.as_object(), v.as_object()) {
                    let mut merged = co.clone();
                    for (sk, sv) in do_ {
                        merged.entry(sk.clone()).or_insert_with(|| sv.clone());
                    }
                    if let Some(fb) = merged.get_mut("feedback") {
                        if let Some(dfb) = do_.get("feedback").and_then(|x| x.as_object()) {
                            if let Some(fbo) = fb.as_object_mut() {
                                for (fk, fv) in dfb {
                                    fbo.entry(fk.clone()).or_insert_with(|| fv.clone());
                                }
                            }
                        }
                    } else if let Some(dfb) = do_.get("feedback") {
                        merged.insert("feedback".into(), dfb.clone());
                    }
                    obj.insert("style".into(), json!(merged));
                } else {
                    obj.entry("style".to_string()).or_insert_with(|| v.clone());
                }
                continue;
            }
            obj.entry(k.clone()).or_insert_with(|| v.clone());
        }
        // Ensure provider list has builtin presets (keep user edits for known ids)
        let mut providers = obj
            .get("providers")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(def_providers) = def.get("providers").and_then(|p| p.as_array()) {
            for dp in def_providers {
                let id = dp.get("id").and_then(|x| x.as_str()).unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                let exists = providers
                    .iter()
                    .any(|p| p.get("id").and_then(|x| x.as_str()) == Some(id));
                if !exists {
                    providers.push(dp.clone());
                }
            }
        }
        obj.insert("providers".into(), json!(providers));
        // Never echo secrets
        if let Some(list) = obj.get_mut("providers").and_then(|p| p.as_array_mut()) {
            for p in list.iter_mut() {
                if let Some(o) = p.as_object_mut() {
                    o.remove("api_key");
                    o.remove("key");
                    let id = o.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    o.insert("key_set".into(), json!(provider_has_key(&id)));
                }
            }
        }
    }
    ai
}

pub fn load_ai_settings() -> Value {
    let s = load_settings_migrated();
    let ai = s.get("ai").cloned().unwrap_or_else(|| json!({}));
    merge_ai_settings(ai)
}

fn save_ai_settings(ai: &Value) -> Result<(), String> {
    let path = settings_path();
    let mut s = load_settings_migrated();
    if let Some(obj) = s.as_object_mut() {
        obj.insert("ai".into(), ai.clone());
    }
    save_json(&path, &s)
}

fn active_provider(ai: &Value) -> Result<Value, String> {
    let active = ai
        .get("active_provider_id")
        .and_then(|x| x.as_str())
        .unwrap_or("deepseek")
        .to_string();
    let providers = ai
        .get("providers")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    providers
        .iter()
        .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(active.as_str()))
        .cloned()
        .ok_or_else(|| "未找到当前 AI 服务商".into())
}

fn normalize_base_url(u: &str) -> String {
    let mut s = u.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return s;
    }
    // Accept full chat/completions path and strip to API root
    if let Some(idx) = s.find("/chat/completions") {
        s = s[..idx].to_string();
        s = s.trim_end_matches('/').to_string();
    }
    s
}

fn thinking_to_effort(thinking: &str) -> Option<&'static str> {
    match thinking {
        "fast" => Some("low"),
        "deep" => Some("high"),
        // balanced: omit (provider default)
        _ => None,
    }
}

fn emit_chat(app: &tauri::AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

fn is_cancelled(id: &str) -> bool {
    CANCEL
        .lock()
        .map(|c| c.contains(id))
        .unwrap_or(false)
}

fn clear_active(id: &str) {
    if let Ok(mut a) = ACTIVE.lock() {
        a.remove(id);
    }
    if let Ok(mut c) = CANCEL.lock() {
        c.remove(id);
    }
}

fn parse_sse_data_line(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with("data:") {
        return None;
    }
    let data = t[5..].trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    Some(data.to_string())
}

fn extract_delta_text(v: &Value) -> String {
    // OpenAI chat completions delta
    if let Some(d) = v
        .pointer("/choices/0/delta/content")
        .and_then(|x| x.as_str())
    {
        return d.to_string();
    }
    // Some providers put content in message
    if let Some(d) = v
        .pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
    {
        return d.to_string();
    }
    // OpenRouter / alt reasoning fields sometimes named differently
    if let Some(d) = v.get("delta").and_then(|x| x.as_str()) {
        return d.to_string();
    }
    String::new()
}

#[tauri::command]
pub fn stuart_ai_get_config() -> Value {
    let ai = load_ai_settings();
    json!({"ok": true, "ai": ai})
}

#[tauri::command]
pub fn stuart_ai_save_config(ai: Value) -> Value {
    let mut next = merge_ai_settings(ai);
    // Strip any accidental secrets from client payload
    if let Some(list) = next.get_mut("providers").and_then(|p| p.as_array_mut()) {
        for p in list.iter_mut() {
            if let Some(o) = p.as_object_mut() {
                o.remove("api_key");
                o.remove("key");
                o.remove("key_set");
            }
        }
    }
    // Re-attach key_set flags after save merge
    match save_ai_settings(&next) {
        Ok(()) => {
            let out = load_ai_settings();
            json!({"ok": true, "ai": out})
        }
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_ai_set_api_key(provider_id: String, api_key: String) -> Value {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return json!({"error": "API Key 不能为空"});
    }
    if key.len() > 512 {
        return json!({"error": "API Key 过长"});
    }
    let id = match sanitize_provider_id(&provider_id) {
        Ok(id) => id,
        Err(e) => return json!({"error": e}),
    };
    let p = match key_path(&id) {
        Ok(p) => p,
        Err(e) => return json!({"error": e}),
    };
    match dpapi_protect(key.as_bytes()) {
        Ok(blob) => match fs::write(&p, blob) {
            Ok(()) => json!({"ok": true, "provider_id": id, "key_set": true}),
            Err(e) => json!({"error": e.to_string()}),
        },
        Err(e) => json!({"error": e}),
    }
}

#[tauri::command]
pub fn stuart_ai_clear_api_key(provider_id: String) -> Value {
    let id = match sanitize_provider_id(&provider_id) {
        Ok(id) => id,
        Err(e) => return json!({"error": e}),
    };
    if let Ok(p) = key_path(&id) {
        let _ = fs::remove_file(p);
    }
    json!({"ok": true, "provider_id": id, "key_set": false})
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(12))
        .timeout_read(Duration::from_secs(90))
        .timeout_write(Duration::from_secs(30))
        .user_agent("StuartMD/3.0.0")
        .build()
}

#[tauri::command]
pub fn stuart_ai_test_provider(provider_id: String) -> Value {
    let ai = load_ai_settings();
    let providers = ai
        .get("providers")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let Some(p) = providers
        .iter()
        .find(|x| x.get("id").and_then(|i| i.as_str()) == Some(provider_id.as_str()))
        .cloned()
    else {
        return json!({"error": "服务商不存在"});
    };
    let base = normalize_base_url(p.get("base_url").and_then(|x| x.as_str()).unwrap_or(""));
    if base.is_empty() {
        return json!({"error": "请先填写 API Base URL"});
    }
    let key = match read_api_key(&provider_id) {
        Ok(k) => k,
        Err(e) => return json!({"error": e}),
    };
    let url = format!("{}/models", base);
    let resp = http_agent()
        .get(&url)
        .set("Authorization", &format!("Bearer {key}"))
        .call();
    match resp {
        Ok(r) => {
            let status = r.status();
            let body = r.into_string().unwrap_or_default();
            if !(200..300).contains(&status) {
                return json!({"error": format!("HTTP {status}"), "body": body.chars().take(200).collect::<String>()});
            }
            let models: Vec<String> = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("data")
                        .and_then(|d| d.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
                                .take(50)
                                .collect()
                        })
                })
                .unwrap_or_default();
            json!({
                "ok": true,
                "provider_id": provider_id,
                "models": models,
                "model": p.get("model").cloned().unwrap_or(json!("")),
            })
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            json!({"error": format!("HTTP {code}"), "body": body.chars().take(200).collect::<String>()})
        }
        Err(e) => json!({"error": e.to_string()}),
    }
}

#[tauri::command]
pub fn stuart_ai_chat_cancel(request_id: String) -> Value {
    if let Ok(mut c) = CANCEL.lock() {
        c.insert(request_id.clone());
    }
    json!({"ok": true, "request_id": request_id})
}

/// Start a streaming explain/chat. Returns immediately; deltas arrive as events:
/// `ai-chat-delta` / `ai-chat-done` / `ai-chat-error`
#[tauri::command]
pub fn stuart_ai_chat_start(
    app: tauri::AppHandle,
    request_id: String,
    provider_id: Option<String>,
    model: Option<String>,
    messages: Value,
    thinking: Option<String>,
    max_output_tokens: Option<u64>,
) -> Value {
    let rid = request_id.trim().to_string();
    if rid.is_empty() || rid.len() > 64 {
        return json!({"error": "request_id 非法"});
    }
    if !messages.is_array() {
        return json!({"error": "messages 必须是数组"});
    }
    if let Ok(mut a) = ACTIVE.lock() {
        if a.contains_key(&rid) {
            return json!({"error": "请求已在进行中", "request_id": rid});
        }
        a.insert(rid.clone(), ());
    }
    if let Ok(mut c) = CANCEL.lock() {
        c.remove(&rid);
    }

    let ai = load_ai_settings();
    let pid = provider_id
        .clone()
        .unwrap_or_else(|| {
            ai.get("active_provider_id")
                .and_then(|x| x.as_str())
                .unwrap_or("deepseek")
                .to_string()
        });
    let provider = match active_provider(&json!({
        "active_provider_id": pid,
        "providers": ai.get("providers").cloned().unwrap_or(json!([]))
    })) {
        Ok(p) => p,
        Err(e) => {
            clear_active(&rid);
            return json!({"error": e});
        }
    };

    let base = normalize_base_url(provider.get("base_url").and_then(|x| x.as_str()).unwrap_or(""));
    if base.is_empty() {
        clear_active(&rid);
        return json!({"error": "请先在「模型」中填写 API Base URL"});
    }
    let model_id = model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| {
            provider
                .get("model")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string()
        });
    if model_id.is_empty() {
        clear_active(&rid);
        return json!({"error": "请先选择模型 ID"});
    }
    let key = match read_api_key(&pid) {
        Ok(k) => k,
        Err(e) => {
            clear_active(&rid);
            return json!({"error": e});
        }
    };

    let think = thinking.unwrap_or_else(|| {
        ai.get("thinking")
            .and_then(|x| x.as_str())
            .unwrap_or("balanced")
            .to_string()
    });
    let max_out = max_output_tokens.unwrap_or_else(|| {
        ai.get("max_output_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(2048)
    });

    let mut body = json!({
        "model": model_id,
        "messages": messages,
        "stream": true,
        "max_tokens": max_out,
    });
    if let Some(effort) = thinking_to_effort(&think) {
        // OpenAI-compatible path; unknown params are often ignored
        if let Some(obj) = body.as_object_mut() {
            obj.insert("reasoning_effort".into(), json!(effort));
        }
    }

    let url = format!("{}/chat/completions", base);
    let rid2 = rid.clone();
    std::thread::spawn(move || {
        let mut acc = String::new();
        let mut finished_ok = false;
        let mut err_msg = String::new();

        let agent = http_agent();
        let result = agent
            .post(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Content-Type", "application/json")
            .set("Accept", "text/event-stream")
            .send_json(body.clone());

        match result {
            Ok(resp) => {
                let mut reader = resp.into_reader();
                let mut buf = String::new();
                let mut chunk = [0u8; 2048];
                loop {
                    if is_cancelled(&rid2) {
                        break;
                    }
                    match reader.read(&mut chunk) {
                        Ok(0) => {
                            finished_ok = !acc.is_empty() || err_msg.is_empty();
                            break;
                        }
                        Ok(n) => {
                            buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                            while let Some(pos) = buf.find('\n') {
                                let line = buf[..pos].trim_end_matches('\r').to_string();
                                buf = buf[pos + 1..].to_string();
                                if let Some(data) = parse_sse_data_line(&line) {
                                    if data == "[DONE]" {
                                        finished_ok = true;
                                        break;
                                    }
                                    if let Ok(v) = serde_json::from_str::<Value>(&data) {
                                        if let Some(err) = v.get("error") {
                                            err_msg = err
                                                .get("message")
                                                .and_then(|m| m.as_str())
                                                .unwrap_or("上游返回错误")
                                                .to_string();
                                        }
                                        let piece = extract_delta_text(&v);
                                        if !piece.is_empty() {
                                            acc.push_str(&piece);
                                            emit_chat(
                                                &app,
                                                "ai-chat-delta",
                                                json!({"requestId": rid2, "text": piece}),
                                            );
                                        }
                                    }
                                }
                            }
                            if err_msg.is_empty() && finished_ok {
                                break;
                            }
                            if !err_msg.is_empty() {
                                break;
                            }
                        }
                        Err(e) => {
                            if acc.is_empty() {
                                err_msg = e.to_string();
                            } else {
                                // partial success
                                finished_ok = true;
                            }
                            break;
                        }
                    }
                }
            }
            Err(ureq::Error::Status(code, r)) => {
                let body_s = r.into_string().unwrap_or_default();
                // Retry non-stream once for some gateways
                if code == 400 || code == 404 || code == 415 {
                    let mut nb = body.clone();
                    if let Some(o) = nb.as_object_mut() {
                        o.insert("stream".into(), json!(false));
                    }
                    if let Ok(r2) = agent
                        .post(&url)
                        .set("Authorization", &format!("Bearer {key}"))
                        .set("Content-Type", "application/json")
                        .send_json(nb)
                    {
                        if let Ok(text) = r2.into_string() {
                            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                                if let Some(content) = v
                                    .pointer("/choices/0/message/content")
                                    .and_then(|x| x.as_str())
                                {
                                    acc = content.to_string();
                                    emit_chat(
                                        &app,
                                        "ai-chat-delta",
                                        json!({"requestId": rid2, "text": acc}),
                                    );
                                    finished_ok = true;
                                } else if let Some(msg) = v
                                    .pointer("/error/message")
                                    .and_then(|x| x.as_str())
                                {
                                    err_msg = msg.to_string();
                                }
                            }
                        }
                    }
                    if !finished_ok && err_msg.is_empty() {
                        err_msg = format!(
                            "HTTP {code}: {}",
                            body_s.chars().take(180).collect::<String>()
                        );
                    }
                } else {
                    err_msg = format!(
                        "HTTP {code}: {}",
                        body_s.chars().take(180).collect::<String>()
                    );
                }
            }
            Err(e) => {
                err_msg = e.to_string();
            }
        }

        clear_active(&rid2);
        if !err_msg.is_empty() && acc.is_empty() {
            emit_chat(
                &app,
                "ai-chat-done",
                json!({"requestId": rid2, "ok": false, "text": "", "error": err_msg}),
            );
        } else {
            let cancelled = !finished_ok && acc.is_empty();
            emit_chat(
                &app,
                "ai-chat-done",
                json!({
                    "requestId": rid2,
                    "ok": !acc.is_empty() || finished_ok,
                    "text": acc,
                    "error": if err_msg.is_empty() && cancelled { Some("已取消") } else { None },
                    "cancelled": cancelled
                }),
            );
        }
    });

    json!({"ok": true, "request_id": rid, "provider_id": pid, "model": model_id})
}
