use fastembed::{InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel};
use ort::{session::Session, value::Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokenizers::{PaddingParams, Tokenizer, TruncationParams};
use tokio::sync::RwLock;
use super::model_registry::{model_spec, EmbeddingModelSpec};

static NATIVE_DIRECTORY:OnceLock<PathBuf>=OnceLock::new();

pub fn initialize_runtime(directory:PathBuf)->Result<(),String> {
    NATIVE_DIRECTORY.set(directory).map_err(|_|"ONNX运行库目录已经初始化")?;
    ensure_runtime()
}

fn ensure_runtime()->Result<(),String> {
    static INITIALIZED:OnceLock<Result<(),String>>=OnceLock::new();
    INITIALIZED.get_or_init(|| {
        let directory=NATIVE_DIRECTORY.get().cloned();
        #[cfg(test)]
        let directory=directory.or_else(||Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/native")));
        let library=directory.ok_or("ONNX运行库目录尚未初始化")?.join("onnxruntime/onnxruntime.dll");
        if super::model_registry::file_sha256(&library)?!="4cb41e89b8bf30578e1dd95e9c40292d61974a4bfcd666409302c4f0c5aa8ce0" {return Err("ONNX Runtime 1.20.1资源指纹不匹配".into());}
        ort::init_from(library.to_string_lossy()).with_name("StuartMD").commit().map_err(|error|error.to_string())?;
        Ok(())
    }).clone()
}

#[derive(Debug, Error)]
pub enum EmbeddingError {
    #[error("模型初始化失败：{0}")] InitFailed(String),
    #[error("模型推理失败：{0}")] InferenceFailed(String),
    #[error("模型缓存目录不可用：{0}")] CacheDirError(String),
    #[error("模型锁不可用：{0}")] LockError(String),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModelConfig { pub model_id: String, pub dimension: usize }
impl Default for ModelConfig { fn default() -> Self { Self::bge_m3() } }
impl ModelConfig {
    pub fn bge_m3() -> Self { Self { model_id: "BAAI/bge-m3".into(), dimension: 1024 } }
    pub fn minilm_multilingual() -> Self { Self { model_id: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2".into(), dimension: 384 } }
}

enum ModelInstance {
    Bge { session: Session, tokenizer: Tokenizer },
    MiniLm(TextEmbedding),
}

impl ModelInstance {
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        match self {
            Self::MiniLm(model) => model.embed(texts.to_vec(), Some(4)).map_err(|error| error.to_string()),
            Self::Bge { session, tokenizer } => {
                let mut vectors = Vec::with_capacity(texts.len());
                for text in texts {
                    let encoding = tokenizer.encode(text.as_str(), true).map_err(|error| error.to_string())?;
                    let ids: Vec<i64> = encoding.get_ids().iter().map(|value| *value as i64).collect();
                    let mask: Vec<i64> = encoding.get_attention_mask().iter().map(|value| *value as i64).collect();
                    let count = ids.len();
                    let ids_value = Value::from_array(([1usize, count], ids)).map_err(|error| error.to_string())?;
                    let mask_value = Value::from_array(([1usize, count], mask)).map_err(|error| error.to_string())?;
                    let inputs = ort::inputs!["input_ids" => ids_value, "attention_mask" => mask_value].map_err(|error| error.to_string())?;
                    let output = session.run(inputs).map_err(|error| error.to_string())?;
                    let tensor = output[0].try_extract_tensor::<f32>().map_err(|error| error.to_string())?;
                    let shape = tensor.shape();
                    if shape.len() != 3 || shape[0] != 1 || shape[2] != 1024 { return Err(format!("BGE-M3 输出形状不符合清单：{shape:?}")); }
                    let mut vector: Vec<f32> = tensor.iter().take(1024).copied().collect();
                    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
                    if !norm.is_finite() || norm <= 0.0 { return Err("BGE-M3 输出包含无效数值".into()); }
                    for value in &mut vector { *value /= norm; }
                    vectors.push(vector);
                }
                Ok(vectors)
            }
        }
    }
}

struct LoadedModel { instance: ModelInstance, spec: EmbeddingModelSpec, last_used: Instant }

pub struct LocalEmbeddingEngine {
    model: Arc<Mutex<Option<LoadedModel>>>,
    active_config: Arc<RwLock<ModelConfig>>,
    cache_dir: PathBuf,
}

impl LocalEmbeddingEngine {
    pub fn new() -> Self { Self::with_default_cache() }
    pub fn for_model(model_id: &str) -> Result<Self, String> {
        let spec = model_spec(model_id)?;
        let mut engine = Self::with_default_cache();
        engine.active_config = Arc::new(RwLock::new(ModelConfig { model_id: spec.model_id, dimension: spec.dimension }));
        Ok(engine)
    }
    pub fn with_cache_dir<P: AsRef<Path>>(directory: P) -> Self {
        Self { model: Arc::new(Mutex::new(None)), active_config: Arc::new(RwLock::new(ModelConfig::default())), cache_dir: directory.as_ref().to_path_buf() }
    }
    pub fn with_default_cache() -> Self {
        let local = dirs::data_local_dir().expect("应用数据目录不可用");
        Self::with_cache_dir(local.join("StuartMD").join("models"))
    }
    pub async fn get_active_config(&self) -> ModelConfig { self.active_config.read().await.clone() }
    pub async fn set_model(&self, model_id: &str) -> Result<(), EmbeddingError> {
        let spec = model_spec(model_id).map_err(EmbeddingError::InitFailed)?;
        if self.active_config.read().await.model_id == model_id { return Ok(()); }
        {
            let mut model = self.model.lock().map_err(|error| EmbeddingError::LockError(error.to_string()))?;
            *model = None;
        }
        *self.active_config.write().await = ModelConfig { model_id: spec.model_id, dimension: spec.dimension };
        Ok(())
    }
    pub async fn unload(&self) { *self.model.lock().expect("模型锁不可用") = None; }
    pub async fn validated_spec(&self) -> Result<EmbeddingModelSpec, EmbeddingError> {
        self.embed_batch(&["真实中文资料检索".into(), "English document retrieval".into()]).await?;
        model_spec(&self.active_config.read().await.model_id).map_err(EmbeddingError::InitFailed)
    }
    pub async fn embed_query(&self, query: &str) -> Result<Vec<f32>, EmbeddingError> {
        let mut vectors = self.embed_batch(&[query.into()]).await?;
        vectors.pop().ok_or_else(|| EmbeddingError::InferenceFailed("模型未返回向量".into()))
    }
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        if texts.is_empty() { return Ok(Vec::new()); }
        static INFERENCE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let _permit = INFERENCE.acquire().await.map_err(|error| EmbeddingError::InferenceFailed(error.to_string()))?;
        let spec = model_spec(&self.active_config.read().await.model_id).map_err(EmbeddingError::InitFailed)?;
        let model = self.model.clone();
        let directory = self.cache_dir.clone();
        let texts = texts.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut slot = model.lock().map_err(|error| EmbeddingError::LockError(error.to_string()))?;
            if slot.as_ref().is_some_and(|loaded| loaded.last_used.elapsed() >= Duration::from_secs(600)) { *slot = None; }
            if slot.is_none() {
                let directory = spec.prepare(&directory).map_err(EmbeddingError::InitFailed)?;
                let instance = load_model(&spec, &directory).map_err(EmbeddingError::InitFailed)?;
                *slot = Some(LoadedModel { instance, spec: spec.clone(), last_used: Instant::now() });
            }
            let loaded = slot.as_mut().expect("已经初始化的模型缺失");
            if loaded.spec != spec { return Err(EmbeddingError::InitFailed("当前模型与加载模型身份不一致".into())); }
            let vectors = loaded.instance.embed(&texts).map_err(EmbeddingError::InferenceFailed)?;
            if vectors.len() != texts.len() { return Err(EmbeddingError::InferenceFailed("模型输出数量与输入数量不同".into())); }
            for vector in &vectors { validate_vector(vector, spec.dimension).map_err(EmbeddingError::InferenceFailed)?; }
            loaded.last_used = Instant::now();
            Ok(vectors)
        }).await.map_err(|error| EmbeddingError::InferenceFailed(error.to_string()))?
    }
}

fn load_model(spec: &EmbeddingModelSpec, directory: &Path) -> Result<ModelInstance, String> {
    ensure_runtime()?;
    if spec.key == "bge-m3" {
        let session = Session::builder().map_err(|error| error.to_string())?
            .with_intra_threads(2).map_err(|error| error.to_string())?
            .commit_from_file(directory.join("model.onnx")).map_err(|error| error.to_string())?;
        let mut tokenizer = Tokenizer::from_file(directory.join("tokenizer.json")).map_err(|error| error.to_string())?;
        tokenizer.with_truncation(Some(TruncationParams { max_length: spec.max_input_length, ..Default::default() })).map_err(|error| error.to_string())?;
        tokenizer.with_padding(Some(PaddingParams::default()));
        Ok(ModelInstance::Bge { session, tokenizer })
    } else if spec.key == "minilm-multilingual" {
        let read = |name: &str| std::fs::read(directory.join(name)).map_err(|error| error.to_string());
        let tokenizer_files = TokenizerFiles { tokenizer_file: read("tokenizer.json")?, config_file: read("config.json")?, special_tokens_map_file: read("special_tokens_map.json")?, tokenizer_config_file: read("tokenizer_config.json")? };
        let model = UserDefinedEmbeddingModel::new(read("model.onnx")?, tokenizer_files).with_pooling(Pooling::Mean);
        let instance = TextEmbedding::try_new_from_user_defined(model, InitOptionsUserDefined::new().with_max_length(spec.max_input_length)).map_err(|error| error.to_string())?;
        Ok(ModelInstance::MiniLm(instance))
    } else { Err(format!("模型实现未注册：{}", spec.key)) }
}

pub fn validate_vector(vector: &[f32], dimension: usize) -> Result<(), String> {
    if vector.len() != dimension || vector.iter().any(|value| !value.is_finite()) { return Err("向量维度或数值不符合模型资源清单".into()); }
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if (norm - 1.0).abs() > 0.01 { return Err(format!("向量未经L2归一化：{norm}")); }
    Ok(())
}
impl Default for LocalEmbeddingEngine { fn default() -> Self { Self::new() } }
