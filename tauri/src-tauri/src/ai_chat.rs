use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::Emitter;
use zeroize::{Zeroize, Zeroizing};

fn key_path(id:&str)->Result<PathBuf,String> {
    let id=sanitize_provider_id(id)?;
    let directory=crate::fs_api::data_dir().join("ai/keys");
    fs::create_dir_all(&directory).map_err(|error|format!("创建密钥目录失败：{error}"))?;
    Ok(directory.join(format!("{id}.bin")))
}
pub(crate) fn sanitize_provider_id(id:&str)->Result<String,String> {
    if id.is_empty() || id.len()>64 || id.starts_with('.') || id.contains("..") || !id.chars().all(|character|character.is_ascii_alphanumeric() || ['-','_','.'].contains(&character)) {return Err("服务商编号无效".into());}
    Ok(id.to_owned())
}
fn pinned_base_url(id:&str)->Option<&'static str> {
    match id {"deepseek"=>Some("https://api.deepseek.com/v1"),"qwen"=>Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),"kimi"=>Some("https://api.moonshot.cn/v1"),"glm"=>Some("https://open.bigmodel.cn/api/paas/v4"),_=>None}
}
fn normalize_base_url(raw:&str)->String {raw.trim().trim_end_matches('/').trim_end_matches("/chat/completions").trim_end_matches('/').to_owned()}
pub(crate) fn validate_base_url(raw:&str)->Result<String,String> {
    let base=normalize_base_url(raw);let parsed=url::Url::parse(&base).map_err(|error|format!("API地址无效：{error}"))?;
    let host=parsed.host_str().ok_or("API地址缺少主机")?;
    if parsed.scheme()!="https" && !(parsed.scheme()=="http" && ["localhost","127.0.0.1","[::1]","::1"].contains(&host)) {return Err("API地址必须使用https，本机服务可以使用http".into());}
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {return Err("API地址包含无效的认证或查询字段".into());}
    Ok(base)
}
pub(crate) fn effective_base_url(provider:&Value)->Result<(String,String),String> {
    let id=provider["id"].as_str().ok_or("服务商编号缺失")?;
    let base=if let Some(base)=pinned_base_url(id) {base.to_owned()} else {validate_base_url(provider["base_url"].as_str().ok_or("API地址缺失")?)?};
    let host=url::Url::parse(&base).map_err(|error|error.to_string())?.host_str().ok_or("API地址缺少主机")?.to_owned();
    Ok((base,host))
}

#[cfg(windows)]
fn dpapi_protect(plain:&[u8])->Result<Vec<u8>,String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData,CRYPTPROTECT_UI_FORBIDDEN,CRYPT_INTEGER_BLOB};
    if plain.is_empty() {return Ok(Vec::new());}
    let entropy=b"stuartmd::secure_vault::entropy_salt_v1";
    let input=CRYPT_INTEGER_BLOB {cbData:plain.len() as u32,pbData:plain.as_ptr() as *mut u8};
    let entropy=CRYPT_INTEGER_BLOB {cbData:entropy.len() as u32,pbData:entropy.as_ptr() as *mut u8};
    let mut output=CRYPT_INTEGER_BLOB {cbData:0,pbData:std::ptr::null_mut()};
    let status=unsafe {CryptProtectData(&input,std::ptr::null(),&entropy,std::ptr::null_mut(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)};
    if status==0 {return Err(format!("DPAPI加密失败：{}",std::io::Error::last_os_error()));}
    if output.pbData.is_null() || output.cbData==0 {return Err("DPAPI返回空密文".into());}
    let result=unsafe {std::slice::from_raw_parts(output.pbData,output.cbData as usize)}.to_vec();
    unsafe {LocalFree(output.pbData as *mut core::ffi::c_void);}
    Ok(result)
}
#[cfg(windows)]
fn dpapi_unprotect(blob:&[u8])->Result<Vec<u8>,String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData,CRYPTPROTECT_UI_FORBIDDEN,CRYPT_INTEGER_BLOB};
    if blob.is_empty() {return Ok(Vec::new());}
    let entropy=b"stuartmd::secure_vault::entropy_salt_v1";
    let input=CRYPT_INTEGER_BLOB {cbData:blob.len() as u32,pbData:blob.as_ptr() as *mut u8};
    let entropy=CRYPT_INTEGER_BLOB {cbData:entropy.len() as u32,pbData:entropy.as_ptr() as *mut u8};
    let mut output=CRYPT_INTEGER_BLOB {cbData:0,pbData:std::ptr::null_mut()};
    let mut status=unsafe {CryptUnprotectData(&input,std::ptr::null_mut(),&entropy,std::ptr::null_mut(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)};
    // 导入当前用户保存的旧版DPAPI密钥。
    if status==0 {status=unsafe {CryptUnprotectData(&input,std::ptr::null_mut(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null(),CRYPTPROTECT_UI_FORBIDDEN,&mut output)};}
    if status==0 {return Err(format!("DPAPI解密失败：{}",std::io::Error::last_os_error()));}
    if output.pbData.is_null() || output.cbData==0 {return Err("DPAPI返回空密钥".into());}
    let result=unsafe {std::slice::from_raw_parts(output.pbData,output.cbData as usize)}.to_vec();
    unsafe {std::ptr::write_bytes(output.pbData,0,output.cbData as usize);LocalFree(output.pbData as *mut core::ffi::c_void);}
    Ok(result)
}
#[cfg(not(windows))]
fn dpapi_protect(_: &[u8])->Result<Vec<u8>,String> {Err("当前系统不支持Windows DPAPI密钥存储".into())}
#[cfg(not(windows))]
fn dpapi_unprotect(_: &[u8])->Result<Vec<u8>,String> {Err("当前系统不支持Windows DPAPI密钥读取".into())}
pub(crate) fn read_api_key(id:&str)->Result<Zeroizing<String>,String> {
    let path=key_path(id)?;let blob=fs::read(path).map_err(|error|format!("读取服务商密钥失败：{error}"))?;
    let plain=dpapi_unprotect(&blob)?;
    match String::from_utf8(plain) {Ok(key) if !key.is_empty()=>Ok(Zeroizing::new(key)),Ok(_)=>Err("密钥为空".into()),Err(error)=>{let mut bytes=error.into_bytes();bytes.zeroize();Err("密钥编码无效".into())}}
}
pub(crate) fn provider_has_key(id:&str)->Result<bool,String> {Ok(key_path(id)?.is_file())}

pub fn builtin_ai_defaults()->Value {
    crate::ai::configuration::stored_value(&crate::ai::configuration::defaults()).expect("默认 AI 配置序列化失败")
}
pub fn load_ai_settings()->Value {
    serde_json::to_value(crate::ai::configuration::load_ai_configuration().expect("读取 AI 配置失败").ai).expect("AI 配置序列化失败")
}
pub fn settings_revision()->Result<String,String> {
    Ok(crate::ai::configuration::load_ai_configuration()?.settings_revision)
}
pub(crate) fn active_provider(ai:&Value)->Result<Value,String> {
    let config:crate::ai::configuration::AiConfig=serde_json::from_value(ai.clone()).map_err(|e|e.to_string())?;
    crate::ai::configuration::resolve_model(&config,config.active_model_id.as_deref().ok_or("请添加并选择模型")?,&crate::ai::model_catalog::load_catalog()?)?.provider_value()
}
#[tauri::command]
pub fn stuart_ai_get_config()->Result<crate::ai::configuration::AiConfigSnapshot,String> {crate::ai::configuration::load_ai_configuration()}
#[tauri::command]
pub async fn stuart_ai_save_config(_app:tauri::AppHandle,_ai:Value,_confirm:Option<bool>)->Result<Value,String> {
    Err("请使用类型化 AI 配置操作".into())
}
#[tauri::command]
pub async fn stuart_ai_set_api_key(provider_id:String,api_key:String)->Result<Value,String> {
    let input=Zeroizing::new(api_key);let key=Zeroizing::new(input.trim().to_owned());
    if key.is_empty() || key.len()>512 {return Err("API密钥为空或超过长度限制".into());}
    let id=sanitize_provider_id(&provider_id)?;let blob=dpapi_protect(key.as_bytes())?;
    crate::ai::cancel_all_and_wait().await?;
    crate::fs_api::atomic_write_file(&key_path(&id)?,&blob)?;
    Ok(json!({"ok":true,"provider_id":id,"key_set":true}))
}
#[tauri::command]
pub async fn stuart_ai_clear_api_key(provider_id:String)->Result<Value,String> {
    let id=sanitize_provider_id(&provider_id)?;let path=key_path(&id)?;
    crate::ai::cancel_all_and_wait().await?;
    if path.exists() {fs::remove_file(path).map_err(|error|error.to_string())?;}
    Ok(json!({"ok":true,"provider_id":id,"key_set":false}))
}
#[tauri::command]
pub async fn stuart_ai_test_provider(window:tauri::WebviewWindow,provider_id:String)->Result<Value,String> {
    let probe=crate::ai::begin_probe(window.label())?;let cancellation=probe.cancellation.clone();
    test_provider_connection(&provider_id,cancellation).await
}
pub(crate) async fn test_provider_connection(provider_id:&str,cancellation:tokio_util::sync::CancellationToken)->Result<Value,String> {
    crate::context::service::ensure_enabled(&cancellation)?;
    let config=load_ai_settings();let provider=active_provider(&json!({"active_provider_id":provider_id,"providers":config["providers"]}))?;
    let (base,host)=effective_base_url(&provider)?;let key=read_api_key(provider_id)?;
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(|error|error.to_string())?;
    let response=tokio::select! {_=cancellation.cancelled()=>return Err("AI验证请求已经取消".into()),response=client.get(format!("{base}/models")).bearer_auth(key.as_str()).send()=>response.map_err(|error|error.without_url().to_string())?};
    if !response.status().is_success() {return Err(format!("AI服务返回HTTP {}",response.status()));}
    let response:Value=tokio::select! {_=cancellation.cancelled()=>return Err("AI验证请求已经取消".into()),response=response.json()=>response.map_err(|error|error.to_string())?};
    let models=response["data"].as_array().ok_or("服务商响应缺少实际模型列表")?.iter().map(|model|model["id"].as_str().map(str::to_owned).ok_or("模型编号缺失")).collect::<Result<Vec<_>,_>>()?;
    crate::context::service::ensure_enabled(&cancellation)?;
    Ok(json!({"ok":true,"provider_id":provider_id,"models":models,"model":provider["model"],"key_sent_to":host}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builtin_credentials_use_the_official_host() {
        let (base,host)=effective_base_url(&json!({"id":"deepseek","base_url":"https://example.com/v1"})).unwrap();
        assert_eq!(base,"https://api.deepseek.com/v1");assert_eq!(host,"api.deepseek.com");
        assert!(validate_base_url("https://user:pass@example.com/v1").is_err());
        assert!(validate_base_url("http://example.com/v1").is_err());
        assert!(validate_base_url("http://localhost:8080/v1").is_ok());
        assert_eq!(validate_base_url("https://api.example.com/v1/chat/completions").unwrap(),"https://api.example.com/v1");
    }
    #[test]
    fn provider_id_cannot_escape_the_keys_directory() {
        for id in ["", "..", "../key", "x/y", ".hidden"] {assert!(sanitize_provider_id(id).is_err());}
    }
    #[cfg(windows)]
    #[test]
    fn windows_dpapi_protects_and_reads_the_same_user_key() {
        let data="公开的DPAPI验证数据".as_bytes();let encrypted=dpapi_protect(data).unwrap();
        assert_ne!(encrypted,data);assert_eq!(dpapi_unprotect(&encrypted).unwrap(),data);
        assert!(dpapi_unprotect("无效的密文".as_bytes()).is_err());
    }
}
