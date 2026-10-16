use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const KNOWLEDGE_MODEL_ID:&str="BAAI/bge-m3";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifact {
    pub remote_path: String,
    pub local_path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingModelSpec {
    pub key: String,
    pub model_id: String,
    pub publisher: String,
    pub revision: String,
    pub dimension: usize,
    pub pooling: String,
    pub normalization: String,
    pub max_input_length: usize,
    pub quantization: String,
    pub artifacts: Vec<ModelArtifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelManifest { schema_version: u32, models: Vec<EmbeddingModelSpec> }

pub fn model_spec(model_id: &str) -> Result<EmbeddingModelSpec, String> {
    let manifest: ModelManifest = serde_json::from_str(include_str!("../../../../resources/models/manifest.json"))
        .map_err(|error| format!("模型清单无效：{error}"))?;
    if manifest.schema_version != 1 { return Err("不支持的模型清单版本".into()); }
    manifest.models.into_iter().find(|spec| spec.model_id == model_id)
        .ok_or_else(|| format!("模型未注册：{model_id}"))
}

pub fn file_sha256(path: &Path) -> Result<String, String> {
    let mut input = File::open(path).map_err(|error| format!("读取资源 {}：{error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

impl EmbeddingModelSpec {
    pub fn identity_hash(&self) -> Result<String, String> {
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self).map_err(|error| error.to_string())?)))
    }

    pub fn prepare(&self, cache_root: &Path) -> Result<PathBuf, String> {
        let directory = cache_root.join(&self.key);
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(directory.join("download.lock")).map_err(|error| error.to_string())?;
        lock.lock_exclusive().map_err(|error| error.to_string())?;
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(1800))
            .build().map_err(|error| error.to_string())?;
        for artifact in &self.artifacts {
            let path = directory.join(&artifact.local_path);
            if path.exists() {
                let actual_hash = file_sha256(&path)?;
                if actual_hash != artifact.sha256 { return Err(format!("模型资源指纹不匹配：{}", path.display())); }
                continue;
            }
            let url = format!("https://huggingface.co/{}/resolve/{}/{}", self.publisher, self.revision, artifact.remote_path);
            let temporary = path.with_extension(format!("{}.download", uuid::Uuid::new_v4()));
            let mut output = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
            let mut response = client.get(url).send().map_err(|error| error.to_string())?
                .error_for_status().map_err(|error| error.to_string())?;
            std::io::copy(&mut response, &mut output).map_err(|error| error.to_string())?;
            output.flush().map_err(|error| error.to_string())?;
            output.sync_all().map_err(|error| error.to_string())?;
            drop(output);
            if file_sha256(&temporary)? != artifact.sha256 { return Err(format!("下载资源指纹不匹配：{}", artifact.remote_path)); }
            std::fs::rename(temporary, path).map_err(|error| error.to_string())?;
        }
        Ok(directory)
    }
}
