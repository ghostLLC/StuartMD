use super::model_catalog::{load_catalog, AiModelCatalog, CatalogModel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConnection {
    pub id: String, pub r#type: String, pub label: String, pub region: String,
    pub kind: String, pub base_url: String, pub enabled: bool, pub builtin: bool,
    pub credential_ref: Option<String>, pub credential_revision: String,
    #[serde(default)] pub key_set: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedModel {
    pub id: String, pub provider_id: String, pub model_id: String, pub display_name: String,
    pub catalog_id: Option<String>, pub catalog_version: Option<String>, pub enabled: bool,
    pub thinking: String, pub max_output_tokens: usize, pub token_counting: Option<Value>,
    #[serde(default = "empty_object")] pub overrides: Value,
    #[serde(default)] pub verification: Option<Value>,
}
fn empty_object() -> Value { json!({}) }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub providers: Vec<ProviderConnection>, pub models: Vec<SavedModel>,
    pub active_model_id: Option<String>, pub default_model_id: Option<String>,
    pub recent_model_ids: Vec<String>,
    #[serde(flatten)] pub preferences: Map<String, Value>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigSnapshot { pub ai: AiConfig, pub catalog: AiModelCatalog, pub settings_revision: String }
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedModel {
    pub model: SavedModel, pub connection: ProviderConnection,
    pub capability: Option<CatalogModel>, pub token_counting: Value,
}
pub struct ResolvedRequestModel {
    pub ai: AiConfig, pub model: ResolvedModel, pub revision: String,
    pub key: Zeroizing<String>,
}

pub fn defaults() -> AiConfig {
    AiConfig { providers:vec![], models:vec![], active_model_id:None, default_model_id:None, recent_model_ids:vec![],
        preferences:serde_json::from_value(json!({"enabled":true,"explain_shortcut":"Alt+E","context_scope":"document","memory_mode":"ask","use_saved_memories":true,"learning_policy":"ask","style":{"length":"normal","tone":"neutral","custom":"","length_hint":"","feedback":{"short":0,"ok":0,"long":0}}})).expect("AI 默认偏好无效") }
}
pub fn stored_value(config: &AiConfig) -> Result<Value, String> {
    let mut value = serde_json::to_value(config).map_err(|e|e.to_string())?;
    for provider in value["providers"].as_array_mut().ok_or("连接列表无效")? {
        provider.as_object_mut().ok_or("连接条目无效")?.remove("key_set");
    }
    Ok(value)
}
pub fn revision(config: &AiConfig) -> Result<String, String> {
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&public_config(config.clone())?).map_err(|e|e.to_string())?)))
}
fn public_config(mut config: AiConfig) -> Result<AiConfig, String> {
    for provider in &mut config.providers {
        provider.key_set = provider.credential_ref.as_deref().map(crate::ai_chat::provider_has_key).transpose()?.unwrap_or(false);
    }
    Ok(config)
}
pub fn snapshot(config: AiConfig) -> Result<AiConfigSnapshot, String> {
    let config = public_config(config)?;
    Ok(AiConfigSnapshot {settings_revision:revision(&config)?, ai:config, catalog:load_catalog()?})
}
pub fn migrate_ai(raw: &Value) -> Result<AiConfig, String> {
    if raw.get("models").is_some() {
        let config: AiConfig = serde_json::from_value(raw.clone()).map_err(|e|format!("AI 配置格式无效：{e}"))?;
        validate(&config)?;
        return Ok(config);
    }
    let mut config = defaults();
    let catalog = load_catalog()?;
    let object = raw.as_object().ok_or("AI 配置必须是对象")?;
    for (name,value) in object {
        if !["providers","active_provider_id","thinking","max_output_tokens"].contains(&name.as_str()) { config.preferences.insert(name.clone(),value.clone()); }
    }
    let active = raw["active_provider_id"].as_str();
    for previous in raw["providers"].as_array().ok_or("旧版 AI 连接列表无效")? {
        let id = previous["id"].as_str().ok_or("旧版连接编号缺失")?.to_owned();
        crate::ai_chat::sanitize_provider_id(&id)?;
        let provider_type = previous["type"].as_str().unwrap_or(&id).to_owned();
        let region = previous["region"].as_str().unwrap_or(if provider_type == "qwen" {"cn-beijing"} else {"cn"}).to_owned();
        let connection = ProviderConnection {id:id.clone(),r#type:provider_type.clone(),label:previous["label"].as_str().unwrap_or(&id).into(),region:region.clone(),kind:previous["kind"].as_str().unwrap_or("openai_compat").into(),base_url:previous["base_url"].as_str().unwrap_or("").into(),enabled:previous["enabled"].as_bool().unwrap_or(true),builtin:previous["builtin"].as_bool().unwrap_or(false),credential_ref:if crate::ai_chat::provider_has_key(&id)? {Some(id.clone())} else {None},credential_revision:"legacy".into(),key_set:false};
        config.providers.push(connection);
        if let Some(model_id) = previous["model"].as_str().filter(|name|!name.trim().is_empty()) {
            let capability = catalog.model(&provider_type,&region,model_id).ok();
            let thinking = match raw["thinking"].as_str().unwrap_or("balanced") {"fast"=>"off","deep"=>"high",_=>"on"}.to_owned();
            let model = SavedModel {id:uuid::Uuid::new_v4().to_string(),provider_id:id.clone(),model_id:model_id.into(),display_name:capability.map(|m|m.display_name.clone()).unwrap_or_else(||model_id.into()),catalog_id:capability.map(|m|format!("{provider_type}/{}",m.model_id)),catalog_version:capability.map(|_|catalog.catalog_version.clone()),enabled:previous["enabled"].as_bool().unwrap_or(true),thinking:if let Some(m)=capability {if m.validate_thinking(&thinking).is_ok(){thinking}else{m.default_thinking.clone()}}else{thinking},max_output_tokens:raw["max_output_tokens"].as_u64().unwrap_or(2048) as usize,token_counting:previous.get("token_counting").cloned(),overrides:json!({"legacy_provider":previous.as_object().ok_or("旧版连接无效")?.iter().filter(|(key,_)|!["id","label","kind","base_url","model","enabled","builtin","api_key","key","key_set","token_counting"].contains(&key.as_str())).map(|(k,v)|(k.clone(),v.clone())).collect::<Map<_,_>>()}),verification:None};
            if active == Some(id.as_str()) { config.active_model_id=Some(model.id.clone());config.default_model_id=Some(model.id.clone()); }
            config.models.push(model);
        }
    }
    validate(&config)?;
    Ok(config)
}
pub fn load_ai_configuration() -> Result<AiConfigSnapshot, String> {
    let settings = crate::fs_api::load_settings_checked()?;
    snapshot(serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?)
}
pub fn validate(config: &AiConfig) -> Result<(), String> {
    let mut connections = HashSet::new();
    for p in &config.providers {
        crate::ai_chat::sanitize_provider_id(&p.id)?;
        if !connections.insert(p.id.as_str()) {return Err("连接编号重复".into());}
        if let Some(reference)=&p.credential_ref {crate::ai_chat::sanitize_provider_id(reference)?;}
    }
    let mut ids=HashSet::new();let mut names=HashSet::new();
    for m in &config.models {
        uuid::Uuid::parse_str(&m.id).map_err(|_|"保存的模型编号必须是 UUID")?;
        if !ids.insert(m.id.as_str()) || !names.insert((&m.provider_id,&m.model_id)) {return Err("模型编号或型号重复".into());}
        if !connections.contains(m.provider_id.as_str()) || m.model_id.trim().is_empty() || m.display_name.trim().is_empty() || m.max_output_tokens == 0 || !m.overrides.is_object() {return Err("模型连接、名称或输出预算无效".into());}
    }
    for id in config.active_model_id.iter().chain(config.default_model_id.iter()).chain(config.recent_model_ids.iter()) { if !ids.contains(id.as_str()) {return Err("模型选择引用了不存在的条目".into());} }
    Ok(())
}
pub fn resolve_model(config: &AiConfig, model_config_id: &str, catalog: &AiModelCatalog) -> Result<ResolvedModel, String> {
    let model=config.models.iter().find(|m|m.id==model_config_id).ok_or("请在已保存模型中选择模型")?.clone();
    let connection=config.providers.iter().find(|p|p.id==model.provider_id).ok_or("模型所属连接不存在")?.clone();
    if !model.enabled || !connection.enabled {return Err("所选模型或连接已经停用，请选择模型".into());}
    if connection.r#type=="kimi" && (model.model_id.starts_with("moonshot-v1") || ["kimi-k2.5","kimi-k2","kimi-latest","kimi-thinking-preview"].iter().any(|name|model.model_id==*name || model.model_id.starts_with(&format!("{name}-")))) {return Err("模型已下线，请添加当前 Kimi 型号并重新选择".into());}
    let capability=catalog.model(&connection.r#type,&connection.region,&model.model_id).ok().cloned();
    if let Some(capability)=&capability {capability.validate_thinking(&model.thinking)?;if model.max_output_tokens>capability.output_limit {return Err("输出预算超过模型上限".into());}}
    let counting=if let Some(counting)=&model.token_counting {counting.clone()} else if let Some(capability)=&capability {capability.counting(&connection.region)?} else {crate::context::model_spec::default_counting(&connection.r#type,&model.model_id)?.ok_or("TokenCountingUnavailable：请在模型高级设置中补充计数配置")?};
    Ok(ResolvedModel {model,connection,capability,token_counting:counting})
}
impl ResolvedModel {
    pub fn provider_value(&self) -> Result<Value, String> {
        let base=if self.connection.r#type=="custom" {crate::ai_chat::validate_base_url(&self.connection.base_url)?} else {load_catalog()?.provider(&self.connection.r#type,&self.connection.region)?.base_url.clone()};
        Ok(json!({"id":self.connection.r#type,"connection_id":self.connection.id,"base_url":base,"model":self.model.model_id,"enabled":self.model.enabled && self.connection.enabled,"credential_ref":self.connection.credential_ref,"credential_revision":self.connection.credential_revision,"model_config_id":self.model.id,"display_name":self.model.display_name,"thinking":self.model.thinking,"max_output_tokens":self.model.max_output_tokens,"token_counting":self.token_counting,"capability":self.capability,"overrides":self.model.overrides}))
    }
}
pub fn capture_request_model(model_config_id: &str, expected_revision: &str) -> Result<ResolvedRequestModel, String> {
    crate::fs_api::with_settings_checked(|settings| {
        let config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
        let revision=revision(&config)?;
        if revision!=expected_revision {return Err("SettingsVersionConflict：模型配置已经变化，请重新加载".into());}
        if config.preferences.get("enabled").and_then(Value::as_bool)!=Some(true) {return Err("AIDisabled".into());}
        let model=resolve_model(&config,model_config_id,&load_catalog()?)?;
        let key=crate::ai_chat::read_api_key(model.connection.credential_ref.as_deref().ok_or("服务商尚未保存 API Key")?)?;
        Ok(ResolvedRequestModel {ai:config,model,revision,key})
    })
}

#[cfg(test)]
mod checks {
    use super::*;
    #[test]
    #[ignore = "需要独立目录中的实际用户配置副本"]
    fn settings_file_probe() {
        let directory=std::path::PathBuf::from(std::env::var("STUART_DATA_DIR").expect("必须指定独立目录"));
        assert!(directory.to_string_lossy().contains("native-artifacts"));
        let snapshot=load_ai_configuration().unwrap();
        for connection in &snapshot.ai.providers {
            if let Some(reference)=&connection.credential_ref {assert!(!crate::ai_chat::read_api_key(reference).unwrap().is_empty());}
        }
        crate::fs_api::atomic_write_file(&directory.join("configuration-result.json"),&serde_json::to_vec(&snapshot).unwrap()).unwrap();
    }
}
