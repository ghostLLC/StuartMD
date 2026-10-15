use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::path::PathBuf;
use std::sync::OnceLock;

static RESOURCE_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

pub fn initialize_resource_directory(path: PathBuf) -> Result<(),String> {
    RESOURCE_DIRECTORY.set(path).map_err(|_| "分词资源目录已经初始化".into())
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProviderModelSpec {
    pub provider_id: String, pub model_id: String, pub context_window: usize,
    pub max_output_tokens: usize, pub protocol_reserve: usize, pub count_method: String,
    pub tokenizer_artifact: Option<PathBuf>, pub tokenizer_hash: Option<String>,
    pub chat_template: Option<PathBuf>, pub chat_template_hash: Option<String>,
    pub bos_token: String, pub eos_token: String, pub count_endpoint: Option<String>,
    pub estimate_safety_ratio: f64,
}

impl ProviderModelSpec {
    pub fn from_provider(provider: &Value) -> Result<Self,String> {
        let provider_id = provider.get("id").and_then(Value::as_str).ok_or("服务商编号不存在")?.to_owned();
        let model_id = provider.get("model").and_then(Value::as_str).filter(|model| !model.trim().is_empty()).ok_or("模型编号不存在")?.to_owned();
        let defaults = if provider.get("token_counting").is_none() { default_counting(&provider_id,&model_id)? } else { None };
        let config = provider.get("token_counting").or(defaults.as_ref());
        let kimi_window = match model_id.as_str() {
            "moonshot-v1-8k" => Some(8192), "moonshot-v1-32k" => Some(32768),
            "moonshot-v1-128k" => Some(131072), _ => None,
        };
        if config.is_none() && provider_id == "kimi" {
            if let Some(context_window) = kimi_window {
                return Ok(Self {provider_id,model_id,context_window,max_output_tokens:context_window,
                    protocol_reserve:256,count_method:"kimi-estimate".into(),tokenizer_artifact:None,
                    tokenizer_hash:None,chat_template:None,chat_template_hash:None,bos_token:String::new(),
                    eos_token:String::new(),count_endpoint:Some("https://api.moonshot.cn/v1/tokenizers/estimate-token-count".into()),estimate_safety_ratio:0.1});
            }
        }
        let config = config.ok_or_else(|| format!("TokenCountingUnavailable：{provider_id}/{model_id} 缺少经验证的 token_counting 配置"))?;
        let number = |field: &str| config.get(field).and_then(Value::as_u64).and_then(|v| usize::try_from(v).ok()).ok_or_else(|| format!("TokenCountingUnavailable：缺少 {field}"));
        let string = |field: &str| config.get(field).and_then(Value::as_str).map(str::to_owned);
        let spec = Self { provider_id,model_id,context_window:number("context_window")?,
            max_output_tokens:number("max_output_tokens")?,protocol_reserve:number("protocol_reserve")?,
            count_method:string("method").ok_or("TokenCountingUnavailable：缺少 method")?,
            tokenizer_artifact:string("tokenizer_artifact").map(PathBuf::from),tokenizer_hash:string("tokenizer_hash"),
            chat_template:string("chat_template").map(PathBuf::from),chat_template_hash:string("chat_template_hash"),
            bos_token:string("bos_token").unwrap_or_default(),eos_token:string("eos_token").unwrap_or_default(),
            count_endpoint:string("endpoint"),estimate_safety_ratio:config.get("estimate_safety_ratio").and_then(Value::as_f64).unwrap_or(0.0) };
        spec.validate()?;
        Ok(spec)
    }

    pub fn validate(&self) -> Result<(),String> {
        if self.context_window == 0 || self.max_output_tokens == 0 || self.max_output_tokens > self.context_window || self.protocol_reserve >= self.context_window || !self.estimate_safety_ratio.is_finite() || !(0.0..=1.0).contains(&self.estimate_safety_ratio) {
            return Err("InvalidTokenBudget：模型上下文长度及预留配置无效".into());
        }
        match self.count_method.as_str() {
            "local-tokenizer" => {
                if self.tokenizer_artifact.is_none() || self.tokenizer_hash.is_none() || self.chat_template.is_none() || self.chat_template_hash.is_none() {
                    return Err("TokenCountingUnavailable：本地计数需要 tokenizer、真实消息模板及各自 SHA-256".into());
                }
            }
            "kimi-estimate" => {
                if self.provider_id != "kimi" || self.count_endpoint.as_deref() != Some("https://api.moonshot.cn/v1/tokenizers/estimate-token-count") || !(0.0..=1.0).contains(&self.estimate_safety_ratio) {
                    return Err("TokenCountingUnavailable：Kimi 估算接口或额外预留配置无效".into());
                }
            }
            "qwen-provider" => {
                if self.provider_id != "qwen" || ![Some("https://dashscope.aliyuncs.com/api/v1/tokenizer"),Some("https://dashscope-intl.aliyuncs.com/api/v1/tokenizer")].contains(&self.count_endpoint.as_deref()) {
                    return Err("TokenCountingUnavailable：Qwen 计数地址无效".into());
                }
            }
            "glm-provider" => {
                if self.provider_id != "glm" || self.count_endpoint.as_deref()!=Some("https://open.bigmodel.cn/api/paas/v4/tokenizer") {
                    return Err("TokenCountingUnavailable：GLM 计数地址无效".into());
                }
            }
            _ => return Err(format!("TokenCountingUnavailable：计数方式 {} 未经过验证",self.count_method)),
        }
        Ok(())
    }

    pub fn identity(&self) -> Result<String,String> {
        Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(self).map_err(|e| e.to_string())?)))
    }
}

pub fn default_counting(provider_id: &str, model_id: &str) -> Result<Option<Value>,String> {
    match provider_id {
        "qwen" if model_id=="qwen-plus" => Ok(Some(serde_json::json!({"method":"qwen-provider","context_window":1000000,"max_output_tokens":32768,"protocol_reserve":256,"endpoint":"https://dashscope.aliyuncs.com/api/v1/tokenizer"}))),
        "glm" if ["glm-4-air","glm-4.5-air","glm-4.5","glm-4.6","glm-4.7"].contains(&model_id) => Ok(Some(serde_json::json!({"method":"glm-provider","context_window":131072,"max_output_tokens":8192,"protocol_reserve":256,"endpoint":"https://open.bigmodel.cn/api/paas/v4/tokenizer"}))),
        "deepseek" => {
            let (resource,window,output) = match model_id {
                "deepseek-chat" | "deepseek-reasoner" => ("deepseek-v3",131072,8192),
                "deepseek-flash" | "deepseek-v4-pro" | "deepseek-v4-flash" => ("deepseek-v4",1000000,393216),
                _ => return Ok(None),
            };
            let directory = if let Some(directory) = RESOURCE_DIRECTORY.get() { directory.clone() }
                else if cfg!(debug_assertions) { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/tokenizers") }
                else { return Err("TokenCountingUnavailable：安装资源目录未初始化".into()); };
            let manifest: Value = serde_json::from_str(include_str!("../../../../resources/tokenizers-manifest.json")).map_err(|e|e.to_string())?;
            let archive = manifest.get("archives").and_then(Value::as_array).and_then(|archives|archives.iter().find(|archive|archive.get("id").and_then(Value::as_str)==Some(resource))).ok_or("分词资源清单缺少模型")?;
            let hashes = &archive["files"];
            Ok(Some(serde_json::json!({"method":"local-tokenizer","context_window":window,"max_output_tokens":output,"protocol_reserve":256,"estimate_safety_ratio":0.02,"tokenizer_artifact":directory.join(resource).join("tokenizer.json"),"tokenizer_hash":hashes["tokenizer.json"],"chat_template":directory.join(resource).join("tokenizer_config.json"),"chat_template_hash":hashes["tokenizer_config.json"],"bos_token":"<｜begin▁of▁sentence｜>","eos_token":"<｜end▁of▁sentence｜>"})))
        }
        _ => Ok(None),
    }
}

pub fn verified_resource(path: &std::path::Path, expected: &str) -> Result<Vec<u8>,String> {
    let bytes = std::fs::read(path).map_err(|e| format!("计数资源读取失败：{e}"))?;
    let actual = format!("{:x}",Sha256::digest(&bytes));
    if actual != expected.to_ascii_lowercase() { return Err(format!("TokenCountingUnavailable：计数资源指纹不符：{}",path.display())); }
    Ok(bytes)
}
