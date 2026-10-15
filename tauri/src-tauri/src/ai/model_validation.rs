use super::configuration::{self, AiConfig};
use crate::context::{model_spec::ProviderModelSpec, service::{self,ChatMessage,ValidatedContext}};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tauri::{Emitter,Manager};
use tokio_util::sync::CancellationToken;

pub async fn discover_models(provider_id:&str,expected_revision:&str,cancellation:CancellationToken)->Result<Value,String> {
    let (provider,key,catalog)=crate::fs_api::with_settings_checked(|settings| {
        let config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
        if configuration::revision(&config)?!=expected_revision {return Err("SettingsVersionConflict：配置已经变化，请重新加载".into());}
        let provider=config.providers.iter().find(|p|p.id==provider_id).ok_or("连接不存在")?.clone();
        if !provider.enabled {return Err("连接已经停用".into());}
        configuration::ensure_connection_available(provider_id)?;
        let catalog=super::model_catalog::load_catalog()?;
        if provider.r#type!="custom" && !catalog.provider(&provider.r#type,&provider.region)?.discovery {return Err("此服务商没有声明模型发现接口，请使用随软件提供的官方目录".into());}
        let key=crate::ai_chat::read_api_key(provider.credential_ref.as_deref().ok_or("连接尚未保存 API Key")?)?;
        Ok((provider,key,catalog))
    })?;
    let base=if provider.r#type=="custom" {crate::ai_chat::validate_base_url(&provider.base_url)?}else{catalog.provider(&provider.r#type,&provider.region)?.base_url.clone()};
    service::ensure_enabled(&cancellation)?;
    let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?;
    let response=tokio::select!{_=cancellation.cancelled()=>return Err("目录获取已经取消".into()),response=client.get(format!("{base}/models")).bearer_auth(key.as_str()).send()=>response.map_err(|e|format!("目录获取失败：{}",e.without_url()))?};
    if !response.status().is_success() {return Err(format!("目录获取返回 HTTP {}",response.status()));}
    let value:Value=tokio::select!{_=cancellation.cancelled()=>return Err("目录获取已经取消".into()),value=response.json()=>value.map_err(|e|e.to_string())?};
    let mut models=vec![];
    for item in value["data"].as_array().ok_or("服务商未返回模型列表")? {
        let id=item["id"].as_str().filter(|id|!id.is_empty()).ok_or("服务商目录缺少模型名称")?;
        let known=catalog.model(&provider.r#type,&provider.region,id).is_ok();
        let mut metadata=serde_json::Map::new();
        for name in ["name","context_window","max_output_tokens","input_modalities","output_modalities","reasoning_effort"] {if let Some(value)=item.get(name){metadata.insert(name.into(),value.clone());}}
        models.push(json!({"modelId":id,"metadata":metadata,"configurationStatus":if known{"官方配置已提供；账号调用待验证"}else{"容量、参数与计数配置尚待确认"}}));
    }
    service::ensure_enabled(&cancellation)?;
    Ok(json!({"providerId":provider_id,"fetchedAt":crate::memory::sqlite_archive::now_millis(),"source":format!("{base}/models"),"models":models}))
}

#[tauri::command]
pub async fn stuart_ai_discover_models(window:tauri::WebviewWindow,provider_id:String,expected_revision:String)->Result<Value,String> {
    let probe=super::begin_provider_probe(window.label(),&provider_id)?;
    let result=discover_models(&provider_id,&expected_revision,probe.cancellation.clone()).await?;
    let settings=crate::fs_api::modify_settings(|settings| {
        let mut config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
        if configuration::revision(&config)?!=expected_revision {return Err("SettingsVersionConflict：目录获取期间配置已经变化，请重新获取".into());}
        config.providers.iter_mut().find(|p|p.id==provider_id).ok_or("连接已经删除")?.discovered=Some(result.clone());
        settings["ai"]=configuration::stored_value(&config)?;Ok(())
    })?;
    let snapshot=configuration::snapshot(serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?)?;
    window.app_handle().emit("ai-config-changed",json!({"revision":snapshot.settings_revision,"providerIds":[provider_id],"modelIds":[],"kind":"discovery"})).map_err(|e|e.to_string())?;
    Ok(result)
}

pub async fn verify_model(model_id:&str,expected_revision:&str,cancellation:CancellationToken)->Result<Value,String> {
    let captured=configuration::capture_request_model(model_id,expected_revision).map_err(|e|format!("配置检查：{e}"))?;
    let provider=captured.model.provider_value()?;let spec=ProviderModelSpec::from_model(&captured.model)?;
    let identity=captured.model.identity()?;let checked_at=crate::memory::sqlite_archive::now_millis();
    let mut stages=vec![json!({"stage":"configuration","status":"Passed"})];
    let mut stage="counting";
    let work=async {
        let messages=vec![ChatMessage::text("user","这是公开的软件接口验证消息。请简短回复：StuartMD 模型验证完成。")];
        let count=service::count_messages(&spec,&captured.key,&messages,&cancellation).await?;
        let reserve=spec.protocol_reserve+(count as f64*spec.estimate_safety_ratio).ceil() as usize;
        let output=captured.model.model.max_output_tokens;
        service::check_final_budget(count,output,reserve,spec.context_window)?;
        stages.push(json!({"stage":"counting","status":"Passed","promptTokens":count}));stage="completion";
        let budget=ValidatedContext {messages_hash:format!("{:x}",Sha256::digest(serde_json::to_vec(&messages).map_err(|e|e.to_string())?)),messages,prompt_tokens:count,requested_output_tokens:output,protocol_reserve:reserve,context_window:spec.context_window,count_method:spec.count_method.clone(),model_spec_id:spec.identity()?,settings_revision:captured.revision.clone(),document_id:None,session_id:"model-validation".into(),window_id:"model-validation".into(),used_memory_ids:vec![],omitted_sources:vec![],summaries:vec![],source_anchors:vec![]};
        let mut text=String::new();
        let usage=super::stream_completion(&provider,&captured.key,&budget,None,cancellation.clone(),|part|{text.push_str(part);Ok(())}).await?;
        stages.push(json!({"stage":"completion","status":"Passed","text":text}));Ok::<Value,String>(usage)
    }.await;
    if let Err(error)=&work {stages.push(json!({"stage":stage,"status":"Failed","error":error}));}
    let result=json!({"modelConfigId":model_id,"configIdentity":identity,"credentialRevision":captured.model.connection.credential_revision,"checkedAt":checked_at,"status":if work.is_ok(){"Passed"}else{"Failed"},"stages":stages,"usage":work.ok()});
    crate::fs_api::modify_settings(|settings| {
        let mut config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
        let current=configuration::resolve_model(&config,model_id,&super::model_catalog::load_catalog()?)?;
        if current.identity()?!=identity {return Err("SettingsVersionConflict：验证期间模型或密钥已经修改，请重新验证".into());}
        config.models.iter_mut().find(|m|m.id==model_id).ok_or("验证模型已经删除")?.verification=Some(result.clone());
        if result["status"]=="Passed" {if let Some(records)=config.preferences.get_mut("token_counting_invalidations").and_then(Value::as_object_mut){records.remove(&spec.identity()?);}}
        settings["ai"]=configuration::stored_value(&config)?;Ok(())
    })?;
    Ok(result)
}
#[tauri::command]
pub async fn stuart_ai_verify_model(window:tauri::WebviewWindow,model_config_id:String,expected_revision:String)->Result<Value,String> {
    let snapshot=configuration::load_ai_configuration()?;
    let model=snapshot.ai.models.iter().find(|m|m.id==model_config_id).ok_or("模型已经删除")?;
    let probe=super::begin_provider_probe(window.label(),&model.provider_id)?;
    let result=verify_model(&model_config_id,&expected_revision,probe.cancellation.clone()).await?;
    window.app_handle().emit("ai-config-changed",json!({"revision":crate::ai_chat::settings_revision()?,"providerIds":[model.provider_id],"modelIds":[model_config_id],"kind":"verification"})).map_err(|e|e.to_string())?;
    Ok(result)
}
