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
    #[serde(default)] pub discovered: Option<Value>,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionInput {
    pub id: Option<String>, pub provider_type: String, pub region: String,
    pub label: String, pub base_url: Option<String>, pub enabled:Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInput {
    pub model_id: String, pub display_name: Option<String>, pub thinking: Option<String>,
    pub max_output_tokens: Option<usize>, pub token_counting: Option<Value>,
    #[serde(default = "empty_object")] pub overrides: Value,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AiConfigChange {
    SaveProviderModels {connection: ConnectionInput, models: Vec<ModelInput>, api_key: Option<String>},
    EditModel {model: SavedModel}, SelectModel {model_id: String}, SetDefaultModel {model_id: String},
    SetModelEnabled {model_id: String, enabled: bool}, DeleteModel {model_id: String},
    DeleteProvider {provider_id: String}, UpdatePreferences {preferences: Map<String,Value>},
    SetCredential {provider_id:String, api_key:String}, ClearCredential {provider_id:String},
}
impl AiConfigChange {
    pub fn kind(&self) -> &'static str {
        match self {Self::SaveProviderModels{..}=>"saveProviderModels",Self::EditModel{..}=>"editModel",Self::SelectModel{..}=>"selectModel",Self::SetDefaultModel{..}=>"setDefaultModel",Self::SetModelEnabled{..}=>"setModelEnabled",Self::DeleteModel{..}=>"deleteModel",Self::DeleteProvider{..}=>"deleteProvider",Self::UpdatePreferences{..}=>"updatePreferences",Self::SetCredential{..}=>"setCredential",Self::ClearCredential{..}=>"clearCredential"}
    }
    pub fn affected_credentials(&self, config:&AiConfig) -> Vec<String> {
        match self {
            Self::SaveProviderModels{connection,api_key,..} if api_key.as_ref().is_some_and(|key|!key.is_empty()) || connection.provider_type=="custom" || connection.enabled==Some(false) => connection.id.iter().cloned().collect(),
            Self::DeleteProvider{provider_id}|Self::SetCredential{provider_id,..}|Self::ClearCredential{provider_id} => vec![provider_id.clone()],
            Self::DeleteModel{model_id}|Self::SetModelEnabled{model_id,enabled:false} => config.models.iter().find(|m|m.id==*model_id).map(|m|vec![m.provider_id.clone()]).unwrap_or_default(),
            Self::UpdatePreferences{preferences} if preferences.get("enabled")==Some(&json!(false)) => config.providers.iter().map(|p|p.id.clone()).collect(),
            _=>vec![],
        }
    }
}

static MUTATING_CREDENTIALS: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> = std::sync::LazyLock::new(||std::sync::Mutex::new(HashSet::new()));
pub struct CredentialMutation { ids:Vec<String> }
impl CredentialMutation {
    pub fn begin(ids:Vec<String>) -> Result<Self,String> {
        let mut pending=MUTATING_CREDENTIALS.lock().map_err(|_|"凭据操作锁损坏")?;
        if ids.iter().any(|id|pending.contains(id)) {return Err("此连接正在修改，请稍后重试".into());}
        pending.extend(ids.iter().cloned());Ok(Self {ids})
    }
}
impl Drop for CredentialMutation {
    fn drop(&mut self) {let mut pending=MUTATING_CREDENTIALS.lock().expect("凭据操作锁损坏");for id in &self.ids {pending.remove(id);}}
}
pub fn ensure_connection_available(id:&str)->Result<(),String> {
    if MUTATING_CREDENTIALS.lock().map_err(|_|"凭据操作锁损坏")?.contains(id) {Err("服务商连接正在修改，请稍后重新发送".into())}else{Ok(())}
}
pub fn ensure_request_current(provider:&Value)->Result<(),String> {
    let id=provider["connection_id"].as_str().ok_or("模型连接编号缺失")?;
    ensure_connection_available(id)?;
    crate::fs_api::with_settings_checked(|settings| {
        let config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
        if config.preferences.get("enabled").and_then(Value::as_bool)!=Some(true) {return Err("AIDisabled".into());}
        let model=config.models.iter().find(|model|Some(model.id.as_str())==provider["model_config_id"].as_str()).ok_or("模型已经删除，请重新选择")?;
        let connection=config.providers.iter().find(|connection|connection.id==id).ok_or("连接已经删除，请重新选择")?;
        if !model.enabled || !connection.enabled {return Err("所选模型或连接已经停用".into());}
        let current=resolve_model(&config,&model.id,&load_catalog()?)?.provider_value()?;
        if ["connection_id","base_url","credential_ref","credential_revision"].iter().any(|field|current[*field]!=provider[*field]) {return Err("SettingsVersionConflict：连接或凭据已经变化，请重新发送".into());}
        Ok(())
    })
}

fn forget_model(config:&mut AiConfig,id:&str) {
    if config.active_model_id.as_deref()==Some(id) {config.active_model_id=None;}
    if config.default_model_id.as_deref()==Some(id) {config.default_model_id=None;}
    config.recent_model_ids.retain(|item|item!=id);
}
fn validate_model(config:&AiConfig,model:&SavedModel,catalog:&AiModelCatalog)->Result<(),String> {
    let mut checked=config.clone();
    let item=checked.models.iter_mut().find(|item|item.id==model.id).ok_or("模型不存在")?;
    *item=model.clone();item.enabled=true;
    let resolved=resolve_model(&checked,&model.id,catalog)?;
    let provider=resolved.provider_value()?;
    crate::context::model_spec::ProviderModelSpec::from_provider(&provider)?;
    super::request_parameters::completion_body(&provider,&[],model.max_output_tokens,false,None)?;
    Ok(())
}
fn update_preferences(config:&mut AiConfig,preferences:Map<String,Value>)->Result<(),String> {
    for (key,value) in preferences {
        match key.as_str() {
            "enabled"|"use_saved_memories" if value.is_boolean()=>{},
            "learning_policy" if value.as_str().is_some_and(|v|["off","ask","automatic"].contains(&v))=>{},
            "context_scope" if value.as_str().is_some_and(|v|["selection","section","document","workspace"].contains(&v))=>{},
            "explain_shortcut" if value.as_str().is_some_and(|v|!v.trim().is_empty() && !v.eq_ignore_ascii_case("Alt+I"))=>{},
            "style" if value.is_object()=>{
                if !value["length"].as_str().is_some_and(|v|["brief","normal","detailed"].contains(&v)) || !value["tone"].as_str().is_some_and(|v|["neutral","friendly","professional","academic"].contains(&v)) || !value["custom"].is_string() || !value["length_hint"].is_string() || !value["feedback"].is_object() {return Err("回答风格字段无效".into());}
            },
            _=>return Err(format!("对话偏好字段无效：{key}")),
        }
        config.preferences.insert(key,value);
    }
    let policy=config.preferences.get("learning_policy").and_then(Value::as_str).ok_or("记忆整理偏好缺失")?;
    config.preferences.insert("memory_mode".into(),json!(if policy=="automatic" {"always"}else{policy}));Ok(())
}

pub fn update_config(change:AiConfigChange,expected_revision:&str,confirm:bool)->Result<AiConfigSnapshot,String> {
    let catalog=load_catalog()?;let mut staged:Option<String>=None;let mut obsolete=vec![];
    let default_selection=matches!(&change,AiConfigChange::SetDefaultModel{..});
    let saved=crate::fs_api::modify_settings(|settings| {
        let mut config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
        if revision(&config)?!=expected_revision {return Err("SettingsVersionConflict：配置已经变化，当前输入已保留，请重新加载后保存".into());}
        match change {
            AiConfigChange::SaveProviderModels{connection,models,api_key}=>{
                if models.is_empty() && connection.id.is_none() {return Err("请勾选需要添加的模型".into());}
                let id=if let Some(id)=connection.id {id}else if connection.provider_type=="custom" {format!("custom-{}",uuid::Uuid::new_v4())}else{config.providers.iter().find(|p|p.r#type==connection.provider_type && p.region==connection.region).map(|p|p.id.clone()).unwrap_or_else(||format!("{}-{}",connection.provider_type,connection.region))};
                crate::ai_chat::sanitize_provider_id(&id)?;
                let existing=config.providers.iter().find(|p|p.id==id).cloned();
                if existing.as_ref().is_some_and(|p|p.r#type!=connection.provider_type || p.region!=connection.region) {return Err("已有连接的厂商和区域需要保持一致".into());}
                let base=if connection.provider_type=="custom" {crate::ai_chat::validate_base_url(connection.base_url.as_deref().ok_or("自定义连接需要 API 地址")?)?}else{catalog.provider(&connection.provider_type,&connection.region)?.base_url.clone()};
                if let Some(previous)=&existing {
                    let previous_host=url::Url::parse(&previous.base_url).ok().and_then(|url|url.host_str().map(str::to_owned));
                    let next_host=url::Url::parse(&base).map_err(|e|e.to_string())?.host_str().map(str::to_owned);
                    if previous_host!=next_host && previous.credential_ref.is_some() && !confirm {return Err(format!("HostConfirmationRequired：保存后会将密钥发送至 {}",next_host.ok_or("地址缺少主机")?));}
                }
                let mut provider=existing.clone().unwrap_or(ProviderConnection {id:id.clone(),r#type:connection.provider_type.clone(),label:connection.label.clone(),region:connection.region.clone(),kind:"openai_compat".into(),base_url:base.clone(),enabled:true,builtin:connection.provider_type!="custom",credential_ref:None,credential_revision:String::new(),key_set:false,discovered:None});
                if connection.label.trim().is_empty() {return Err("连接名称不能为空".into());}
                provider.label=connection.label;provider.base_url=base;
                if let Some(enabled)=connection.enabled {provider.enabled=enabled;}
                if let Some(api_key)=api_key.filter(|key|!key.is_empty()) {
                    let reference=crate::ai_chat::stage_api_key(api_key)?;staged=Some(reference.clone());
                    if let Some(old)=provider.credential_ref.replace(reference.clone()) {obsolete.push(old);}
                    provider.credential_revision=reference;
                }
                if provider.credential_ref.is_none() && !models.is_empty() {return Err("请填写此连接的 API Key".into());}
                let changed=existing.as_ref().is_none_or(|old|old.base_url!=provider.base_url || old.credential_revision!=provider.credential_revision);
                if let Some(old)=config.providers.iter_mut().find(|p|p.id==id) {*old=provider;}else{config.providers.push(provider);}
                if connection.enabled==Some(false) {let affected:Vec<_>=config.models.iter().filter(|m|m.provider_id==id).map(|m|m.id.clone()).collect();for model_id in affected {forget_model(&mut config,&model_id);}}
                if changed {for model in config.models.iter_mut().filter(|m|m.provider_id==id){model.verification=None;}}
                let was_empty=config.models.is_empty();let mut added=vec![];
                for input in models {
                    if config.models.iter().any(|m|m.provider_id==id && m.model_id==input.model_id) {continue;}
                    let capability=catalog.model(&connection.provider_type,&connection.region,&input.model_id).ok();
                    if capability.is_none() && input.token_counting.is_none() {return Err("目录外型号需要填写高级计数资料".into());}
                    let model=SavedModel{id:uuid::Uuid::new_v4().to_string(),provider_id:id.clone(),model_id:input.model_id.clone(),display_name:input.display_name.unwrap_or_else(||capability.map(|c|c.display_name.clone()).unwrap_or(input.model_id)),catalog_id:capability.map(|c|format!("{}/{}",c.provider_type,c.model_id)),catalog_version:capability.map(|_|catalog.catalog_version.clone()),enabled:true,thinking:input.thinking.unwrap_or_else(||capability.map(|c|c.default_thinking.clone()).unwrap_or("off".into())),max_output_tokens:input.max_output_tokens.unwrap_or_else(||capability.map(|c|c.default_output_tokens).unwrap_or(8192)),token_counting:input.token_counting,overrides:input.overrides,verification:None};
                    added.push(model.id.clone());config.models.push(model.clone());validate_model(&config,&model,&catalog)?;
                }
                if was_empty {if let Some(first)=added.first() {config.active_model_id=Some(first.clone());config.default_model_id=Some(first.clone());}}
            },
            AiConfigChange::EditModel{mut model}=>{
                let old=config.models.iter().find(|m|m.id==model.id).ok_or("模型已经删除")?;
                if old.provider_id!=model.provider_id {return Err("模型所属连接不能修改".into());}
                model.verification=if old.model_id==model.model_id && old.thinking==model.thinking && old.max_output_tokens==model.max_output_tokens && old.token_counting==model.token_counting && old.overrides==model.overrides {old.verification.clone()}else{None};
                validate_model(&config,&model,&catalog)?;
                let id=model.id.clone();
                *config.models.iter_mut().find(|m|m.id==id).ok_or("模型已经删除")?=model;
            },
            AiConfigChange::SelectModel{model_id}|AiConfigChange::SetDefaultModel{model_id}=>{
                let resolved=resolve_model(&config,&model_id,&catalog)?;
                crate::context::model_spec::ProviderModelSpec::from_provider(&resolved.provider_value()?)?;
                if !resolved.connection.credential_ref.as_deref().map(crate::ai_chat::provider_has_key).transpose()?.unwrap_or(false) {return Err("所选模型的连接尚未保存 API Key".into());}
                if default_selection {config.default_model_id=Some(model_id);}else{
                    config.active_model_id=Some(model_id.clone());config.recent_model_ids.retain(|id|id!=&model_id);config.recent_model_ids.insert(0,model_id);config.recent_model_ids.truncate(12);
                }
            },
            AiConfigChange::SetModelEnabled{model_id,enabled}=>{
                config.models.iter_mut().find(|m|m.id==model_id).ok_or("模型已经删除")?.enabled=enabled;
                if !enabled {forget_model(&mut config,&model_id);}
            },
            AiConfigChange::DeleteModel{model_id}=>{
                if !config.models.iter().any(|m|m.id==model_id) {return Err("模型已经删除".into());}
                config.models.retain(|m|m.id!=model_id);forget_model(&mut config,&model_id);
            },
            AiConfigChange::DeleteProvider{provider_id}=>{
                if !confirm {return Err("DeleteConfirmationRequired：删除连接会删除其全部模型并清除密钥".into());}
                let provider=config.providers.iter().find(|p|p.id==provider_id).ok_or("连接已经删除")?;
                if let Some(reference)=&provider.credential_ref {obsolete.push(reference.clone());}
                let ids:Vec<_>=config.models.iter().filter(|m|m.provider_id==provider_id).map(|m|m.id.clone()).collect();
                for id in ids {forget_model(&mut config,&id);}
                config.models.retain(|m|m.provider_id!=provider_id);config.providers.retain(|p|p.id!=provider_id);
            },
            AiConfigChange::UpdatePreferences{preferences}=>update_preferences(&mut config,preferences)?,
            AiConfigChange::SetCredential{provider_id,api_key}=>{
                let provider=config.providers.iter_mut().find(|p|p.id==provider_id).ok_or("连接已经删除")?;
                let reference=crate::ai_chat::stage_api_key(api_key)?;staged=Some(reference.clone());
                if let Some(old)=provider.credential_ref.replace(reference.clone()){obsolete.push(old);}
                provider.credential_revision=reference;
                for model in config.models.iter_mut().filter(|m|m.provider_id==provider_id){model.verification=None;}
            },
            AiConfigChange::ClearCredential{provider_id}=>{
                let provider=config.providers.iter_mut().find(|p|p.id==provider_id).ok_or("连接已经删除")?;
                if let Some(reference)=provider.credential_ref.take() {obsolete.push(reference);}
                provider.credential_revision=uuid::Uuid::new_v4().to_string();
                for model in config.models.iter_mut().filter(|m|m.provider_id==provider_id){model.verification=None;}
            },
        }
        validate(&config)?;settings["ai"]=stored_value(&config)?;Ok(())
    });
    match saved {
        Err(error)=>{if let Some(reference)=staged {crate::ai_chat::remove_api_key(&reference).map_err(|cleanup|format!("{error}；清理临时凭据失败：{cleanup}"))?;}Err(error)},
        Ok(settings)=>{
            let config:AiConfig=serde_json::from_value(settings["ai"].clone()).map_err(|e|e.to_string())?;
            for reference in obsolete {if !config.providers.iter().any(|p|p.credential_ref.as_deref()==Some(&reference)) {crate::ai_chat::remove_api_key(&reference)?;}}
            snapshot(config)
        }
    }
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
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&serde_json::to_value(public_config(config.clone())?).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?)))
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
        let declared_type=previous["type"].as_str().unwrap_or(&id);
        let provider_type=if ["deepseek","qwen","kimi","glm"].contains(&declared_type) {declared_type}else{"custom"}.to_owned();
        let region = previous["region"].as_str().unwrap_or(if provider_type == "qwen" {"cn-beijing"} else if provider_type=="custom" {"custom"}else {"cn"}).to_owned();
        let connection = ProviderConnection {id:id.clone(),r#type:provider_type.clone(),label:previous["label"].as_str().unwrap_or(&id).into(),region:region.clone(),kind:previous["kind"].as_str().unwrap_or("openai_compat").into(),base_url:previous["base_url"].as_str().unwrap_or("").into(),enabled:previous["enabled"].as_bool().unwrap_or(true),builtin:previous["builtin"].as_bool().unwrap_or(false),credential_ref:if crate::ai_chat::provider_has_key(&id)? {Some(id.clone())} else {None},credential_revision:"legacy".into(),key_set:false,discovered:None};
        config.providers.push(connection);
        if let Some(model_id) = previous["model"].as_str().filter(|name|!name.trim().is_empty()) {
            let capability = catalog.model(&provider_type,&region,model_id).ok();
            let thinking = match raw["thinking"].as_str().unwrap_or("balanced") {"fast"=>"off","deep" if capability.is_some_and(|c|c.efforts.is_empty())=>"on","deep"=>"high",_=>"default"}.to_owned();
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
    let resolved=ResolvedModel {model,connection,capability,token_counting:counting};
    let spec=crate::context::model_spec::ProviderModelSpec::from_model(&resolved)?;
    if resolved.model.max_output_tokens>spec.max_output_tokens || resolved.model.max_output_tokens>=spec.context_window {return Err("输出预算超过已配置的模型容量".into());}
    if let Some(cap)=&resolved.capability {if spec.context_window>cap.context_window.min(cap.input_limit) || spec.max_output_tokens>cap.output_limit {return Err("计数配置容量超过官方模型上限".into());}}
    Ok(resolved)
}
impl ResolvedModel {
    pub fn identity(&self)->Result<String,String> {
        let mut copy=self.clone();copy.model.verification=None;copy.connection.key_set=false;copy.connection.discovered=None;
        Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&copy).map_err(|e|e.to_string())?)))
    }
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
        ensure_connection_available(&model.connection.id)?;
        let key=crate::ai_chat::read_api_key(model.connection.credential_ref.as_deref().ok_or("服务商尚未保存 API Key")?)?;
        Ok(ResolvedRequestModel {ai:config,model,revision,key})
    })
}

#[cfg(test)]
mod checks {
    use super::*;
    #[test]
    fn legacy_independent_custom_connection_keeps_routing() {
        let counting=crate::context::model_spec::default_counting("deepseek","deepseek-chat").unwrap().unwrap();
        let migrated=migrate_ai(&json!({"providers":[{"id":"openrouter","base_url":"https://api.deepseek.com/v1","model":"deepseek-chat","token_counting":counting}],"active_provider_id":"openrouter","thinking":"balanced","max_output_tokens":2048})).unwrap();
        assert_eq!(migrated.providers[0].r#type,"custom");
        assert_eq!(migrated.providers[0].id,"openrouter");
        let resolved=resolve_model(&migrated,&migrated.models[0].id,&load_catalog().unwrap()).unwrap();
        assert_eq!(resolved.provider_value().unwrap()["base_url"],"https://api.deepseek.com/v1");
    }
    #[test]
    fn legacy_balanced_keeps_service_default_parameters() {
        let migrated=migrate_ai(&json!({"providers":[{"id":"deepseek","base_url":"https://api.deepseek.com/v1","model":"deepseek-flash"}],"active_provider_id":"deepseek","thinking":"balanced","max_output_tokens":2048})).unwrap();
        let provider=resolve_model(&migrated,&migrated.models[0].id,&load_catalog().unwrap()).unwrap().provider_value().unwrap();
        let body=super::super::request_parameters::completion_body(&provider,&[],2048,false,None).unwrap();
        assert!(body.get("thinking").is_none());assert!(body.get("reasoning_effort").is_none());
    }
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

    #[test]
    #[ignore = "需要独立目录中的实际用户配置副本"]
    fn settings_ui_operation() {
        let directory=std::path::PathBuf::from(std::env::var("STUART_DATA_DIR").expect("必须指定独立目录"));
        assert!(directory.to_string_lossy().contains("native-artifacts"));
        let input:Value=serde_json::from_slice(&std::fs::read(directory.join("ui-operation.json")).unwrap()).unwrap();
        let result=if input["kind"]=="read" {load_ai_configuration()} else {update_config(serde_json::from_value(input["change"].clone()).unwrap(),input["revision"].as_str().unwrap(),false)};
        let output=match result {Ok(value)=>serde_json::to_value(value).unwrap(),Err(error)=>json!({"error":error})};
        crate::fs_api::atomic_write_file(&directory.join("ui-result.json"),&serde_json::to_vec(&output).unwrap()).unwrap();
    }

    #[test]
    #[ignore = "需要独立目录中的实际用户配置副本"]
    fn actual_advanced_models() {
        let directory=std::path::PathBuf::from(std::env::var("STUART_DATA_DIR").expect("必须指定独立目录"));
        assert!(directory.to_string_lossy().contains("native-artifacts"));
        let before=load_ai_configuration().unwrap();
        let provider=before.ai.providers.iter().find(|p|p.r#type=="deepseek" && p.credential_ref.is_some()).unwrap().clone();
        let secret=crate::ai_chat::read_api_key(provider.credential_ref.as_deref().unwrap()).unwrap();
        let mut counting=crate::context::model_spec::default_counting("deepseek","deepseek-v4-flash").unwrap().unwrap();
        counting["context_window"]=json!(4096);counting["max_output_tokens"]=json!(2048);
        let model=||ModelInput{model_id:"deepseek-v4-flash".into(),display_name:None,thinking:Some("default".into()),max_output_tokens:Some(1024),token_counting:Some(counting.clone()),overrides:json!({"thinking_parameter":"none","output_parameter":"max_tokens","json_output":true})};
        let official=update_config(AiConfigChange::SaveProviderModels{connection:ConnectionInput{id:Some(provider.id.clone()),provider_type:"deepseek".into(),region:provider.region.clone(),label:provider.label.clone(),base_url:None,enabled:Some(true)},models:vec![model()],api_key:None},&before.settings_revision,false).expect("官方连接应允许添加具有明确高级配置的目录外型号");
        assert!(official.ai.models.iter().any(|m|m.provider_id==provider.id && m.model_id=="deepseek-v4-flash" && m.max_output_tokens==1024));
        let mut saved=official;
        for label in ["阅读服务一","阅读服务二"] {
            saved=update_config(AiConfigChange::SaveProviderModels{connection:ConnectionInput{id:None,provider_type:"custom".into(),region:"custom".into(),label:label.into(),base_url:Some(provider.base_url.clone()),enabled:Some(true)},models:vec![model()],api_key:Some(secret.to_string())},&saved.settings_revision,false).unwrap();
        }
        assert_eq!(saved.ai.providers.iter().filter(|p|p.r#type=="custom" && ["阅读服务一","阅读服务二"].contains(&p.label.as_str())).count(),2);
        crate::fs_api::atomic_write_file(&directory.join("advanced-snapshot.json"),&serde_json::to_vec(&saved).unwrap()).unwrap();
    }

    #[test]
    #[ignore = "需要独立目录中的实际用户配置副本"]
    fn actual_atomic_changes() {
        let directory=std::env::var("STUART_DATA_DIR").expect("必须指定独立目录");
        assert!(directory.contains("native-artifacts"));
        let before=load_ai_configuration().unwrap();
        let provider=before.ai.providers.iter().find(|p|p.r#type=="deepseek" && p.credential_ref.is_some()).expect("实际配置缺少 DeepSeek 凭据").clone();
        let secret=crate::ai_chat::read_api_key(provider.credential_ref.as_deref().unwrap()).unwrap();
        let snapshot=update_config(AiConfigChange::SaveProviderModels {connection:ConnectionInput{id:Some(provider.id.clone()),provider_type:provider.r#type.clone(),region:provider.region.clone(),label:provider.label.clone(),base_url:None,enabled:Some(true)},models:["deepseek-flash","deepseek-v4-pro"].into_iter().map(|name|ModelInput{model_id:name.into(),display_name:None,thinking:None,max_output_tokens:None,token_counting:None,overrides:json!({})}).collect(),api_key:None},&before.settings_revision,false).unwrap();
        let models:Vec<_>=snapshot.ai.models.iter().filter(|m|m.provider_id==provider.id).cloned().collect();
        assert!(models.len()>=2);
        crate::fs_api::atomic_write_file(&std::path::Path::new(&directory).join("picker-snapshot-before.json"),&serde_json::to_vec(&snapshot).unwrap()).unwrap();
        let selected=update_config(AiConfigChange::SelectModel{model_id:models[1].id.clone()},&snapshot.settings_revision,false).unwrap();
        assert_eq!(selected.ai.active_model_id.as_deref(),Some(models[1].id.as_str()));
        assert_eq!(selected.ai.default_model_id,snapshot.ai.default_model_id);
        let stale=update_config(AiConfigChange::UpdatePreferences{preferences:serde_json::from_value(json!({"use_saved_memories":false})).unwrap()},&snapshot.settings_revision,false).unwrap_err();
        assert!(stale.starts_with("SettingsVersionConflict"));
        let mut edited=models[0].clone();edited.display_name="DeepSeek 阅读模型".into();
        let edited=update_config(AiConfigChange::EditModel{model:edited},&selected.settings_revision,false).unwrap();
        assert_eq!(edited.ai.models.iter().find(|m|m.id==models[1].id).unwrap().model_id,models[1].model_id);
        let pending=capture_request_model(&models[1].id,&edited.settings_revision).unwrap();
        let pending_provider=pending.model.provider_value().unwrap();
        let rotated=update_config(AiConfigChange::SetCredential{provider_id:provider.id.clone(),api_key:secret.to_string()},&edited.settings_revision,false).unwrap();
        assert!(ensure_request_current(&pending_provider).is_err(),"凭据轮换完成后需要拒绝尚未登记的旧请求");
        crate::fs_api::atomic_write_file(&std::path::Path::new(&directory).join("picker-snapshot-after.json"),&serde_json::to_vec(&rotated).unwrap()).unwrap();
        let connection=rotated.ai.providers.iter().find(|p|p.id==provider.id).unwrap();
        assert_ne!(connection.credential_ref,provider.credential_ref);
        assert_eq!(crate::ai_chat::read_api_key(connection.credential_ref.as_deref().unwrap()).unwrap().as_str(),secret.as_str());
        assert!(!String::from_utf8(std::fs::read(crate::fs_api::settings_path()).unwrap()).unwrap().contains(secret.as_str()));
        let resolved=resolve_model(&rotated.ai,&models[0].id,&rotated.catalog).unwrap();
        let mut oversized=resolved.model.clone();let mut counting=resolved.token_counting.clone();counting["context_window"]=json!(4_000_000);oversized.token_counting=Some(counting);
        assert!(update_config(AiConfigChange::EditModel{model:oversized},&rotated.settings_revision,false).is_err(),"模型计数覆盖项需要遵守官方容量上限");
        let enable:AiConfigChange=serde_json::from_value(json!({"kind":"saveProviderModels","connection":{"id":provider.id,"provider_type":provider.r#type,"region":provider.region,"label":provider.label,"base_url":null,"enabled":true},"models":[],"api_key":null})).expect("连接编辑需要支持启用状态");
        let _=enable;
        let frozen=capture_request_model(&models[1].id,&rotated.settings_revision).unwrap();
        let next=update_config(AiConfigChange::SelectModel{model_id:models[0].id.clone()},&rotated.settings_revision,false).unwrap();
        assert_eq!(frozen.model.model.id,models[1].id);
        let deleted=update_config(AiConfigChange::DeleteModel{model_id:models[0].id.clone()},&next.settings_revision,false).unwrap();
        assert_eq!(deleted.ai.active_model_id,None);
        assert!(deleted.ai.providers.iter().any(|p|p.id==provider.id && p.key_set));
        assert!(update_config(AiConfigChange::DeleteProvider{provider_id:provider.id.clone()},&deleted.settings_revision,false).is_err());
        let removed=update_config(AiConfigChange::DeleteProvider{provider_id:provider.id.clone()},&deleted.settings_revision,true).unwrap();
        assert!(!removed.ai.models.iter().any(|m|m.provider_id==provider.id));
        assert!(!crate::ai_chat::provider_has_key(connection.credential_ref.as_deref().unwrap()).unwrap());
    }
}
