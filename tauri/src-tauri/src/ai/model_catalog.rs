use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelCatalog {
    pub schema_version: u32, pub catalog_version: String, pub verified_at: String,
    pub providers: Vec<CatalogProvider>, pub models: Vec<CatalogModel>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogProvider {
    pub r#type: String, pub label: String, pub region: String, pub region_label: String,
    pub base_url: String, pub discovery: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub provider_type: String, pub regions: Vec<String>, pub model_id: String,
    pub display_name: String, pub description: String, pub protocol: String,
    pub input_types: Vec<String>, pub output_types: Vec<String>, pub streaming: bool,
    pub json_output: bool, pub thinking: String, pub efforts: Vec<String>,
    pub default_thinking: String, pub default_output_tokens: usize, pub context_window: usize,
    pub input_limit: usize, pub output_limit: usize, pub output_parameter: String,
    pub preserve_reasoning: bool, pub count_profile: String, pub sources: Vec<String>,
}
impl AiModelCatalog {
    pub fn provider(&self, provider_type: &str, region: &str) -> Result<&CatalogProvider, String> {
        self.providers.iter().find(|p| p.r#type == provider_type && p.region == region)
            .ok_or_else(|| format!("未配置服务商区域：{provider_type}/{region}"))
    }
    pub fn model(&self, provider_type: &str, region: &str, model_id: &str) -> Result<&CatalogModel, String> {
        self.models.iter().find(|m| m.provider_type == provider_type && m.model_id == model_id && m.regions.iter().any(|r| r == region))
            .ok_or_else(|| format!("官方目录中没有此型号：{provider_type}/{region}/{model_id}"))
    }
}
impl CatalogModel {
    pub fn validate_thinking(&self, thinking: &str) -> Result<(), String> {
        if thinking == "off" && self.thinking == "optional" || thinking == "on" && self.efforts.is_empty() || self.efforts.iter().any(|value| value == thinking) { Ok(()) }
        else { Err(format!("{} 不支持所选思考参数：{thinking}", self.display_name)) }
    }
    pub fn counting(&self, region: &str) -> Result<Value, String> {
        let mut value = if self.count_profile == "deepseek-v4" {
            crate::context::model_spec::default_counting("deepseek", &self.model_id)?.ok_or("DeepSeek 分词资源缺失")?
        } else {
            let endpoint = match (self.count_profile.as_str(), region) {
                ("kimi-estimate", "cn") => "https://api.moonshot.cn/v1/tokenizers/estimate-token-count",
                ("glm-provider", "cn") => "https://open.bigmodel.cn/api/paas/v4/tokenizer",
                ("qwen-provider", "cn-beijing") => "https://dashscope.aliyuncs.com/api/v1/tokenizer",
                ("qwen-provider", "ap-southeast-1") => "https://dashscope-intl.aliyuncs.com/api/v1/tokenizer",
                _ => return Err("TokenCountingUnavailable：模型计数区域无效".into()),
            };
            json!({"method":self.count_profile,"endpoint":endpoint,"protocol_reserve":256,"estimate_safety_ratio":0.1})
        };
        value["context_window"] = json!(self.context_window.min(self.input_limit));
        value["max_output_tokens"] = json!(self.output_limit);
        Ok(value)
    }
}
pub fn load_catalog() -> Result<AiModelCatalog, String> {
    let catalog: AiModelCatalog = serde_json::from_str(include_str!("../../../../resources/ai-model-catalog.json")).map_err(|e| e.to_string())?;
    if catalog.schema_version != 1 || catalog.catalog_version.is_empty() || catalog.verified_at.is_empty() { return Err("模型目录版本无效".into()); }
    let mut providers = HashSet::new();
    for p in &catalog.providers {
        if !providers.insert((&p.r#type, &p.region)) || url::Url::parse(&p.base_url).map_err(|e| e.to_string())?.scheme() != "https" { return Err("模型目录连接重复或地址无效".into()); }
    }
    let mut ids = HashSet::new();
    for m in &catalog.models {
        if !ids.insert((&m.provider_type, &m.model_id)) || m.context_window == 0 || m.input_limit > m.context_window || m.output_limit > m.context_window || m.default_output_tokens == 0 || m.default_output_tokens > m.output_limit || !m.streaming || m.sources.is_empty() { return Err(format!("模型目录条目无效：{}",m.model_id)); }
        m.validate_thinking(&m.default_thinking)?;
        for region in &m.regions { catalog.provider(&m.provider_type,region)?; m.counting(region)?; }
    }
    Ok(catalog)
}

#[cfg(test)]
mod checks {
    use super::*;
    #[test]
    fn shipped_catalog_and_tokenizer_resources_are_consistent() {
        let catalog = load_catalog().unwrap();
        assert_eq!(catalog.models.len(), 12);
        for model in &catalog.models {
            for region in &model.regions {
                let counting = model.counting(region).unwrap();
                let spec = crate::context::model_spec::ProviderModelSpec::from_provider(&json!({"id":model.provider_type,"model":model.model_id,"token_counting":counting})).unwrap();
                if spec.count_method == "local-tokenizer" {
                    crate::context::model_spec::verified_resource(spec.tokenizer_artifact.as_ref().unwrap(),spec.tokenizer_hash.as_ref().unwrap()).unwrap();
                    crate::context::model_spec::verified_resource(spec.chat_template.as_ref().unwrap(),spec.chat_template_hash.as_ref().unwrap()).unwrap();
                }
            }
        }
    }
}
