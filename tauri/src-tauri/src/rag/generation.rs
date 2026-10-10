use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::model_registry::EmbeddingModelSpec;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool,Ordering};
use super::{LocalEmbeddingEngine,RagConfig,RagStorage,IndexProgress,IndexSummary};

pub const PARSER_VERSION:u32=4;

pub struct BuiltGeneration {pub generation:Generation,pub storage:Arc<RagStorage>,pub summary:IndexSummary}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation {
    pub workspace_id: String,
    pub generation_id: String,
    pub model: EmbeddingModelSpec,
    pub parser_version: u32,
    pub status: String,
    pub failures_json: String,
    pub database_path: PathBuf,
}

pub struct GenerationCatalog { root: PathBuf, connection: Connection }

pub fn workspace_id(root: &Path) -> String {
    format!("{:x}", Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes()))
}

impl GenerationCatalog {
    pub fn open(root: &Path) -> Result<Self, String> {
        let directory = root.join(".stuart");
        std::fs::create_dir_all(directory.join("indices")).map_err(|error| format!("创建索引目录 {}：{error}",directory.display()))?;
        let connection = Connection::open(directory.join("index_catalog.db")).map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,model_json TEXT NOT NULL,parser_version INTEGER NOT NULL,status TEXT NOT NULL,failures_json TEXT NOT NULL,database_path TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS current_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation_id TEXT NOT NULL REFERENCES generations(id));
            CREATE TABLE IF NOT EXISTS workspace_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|error| error.to_string())?;
        Ok(Self { root: root.into(), connection })
    }

    pub fn current(&self) -> Result<Option<Generation>, String> {
        self.connection.query_row("SELECT g.workspace_id,g.id,g.model_json,g.parser_version,g.status,g.failures_json,g.database_path FROM current_generation c JOIN generations g ON g.id=c.generation_id WHERE c.singleton=1", [], |row| {
            Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,u32>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,String>(6)?))
        }).optional().map_err(|error| error.to_string())?.map(|(workspace_id,generation_id,model_json,parser_version,status,failures_json,path)| {
            Ok(Generation { workspace_id,generation_id,model:serde_json::from_str(&model_json).map_err(|error| error.to_string())?,parser_version,status,failures_json,database_path:path.into() })
        }).transpose()
    }

    pub fn staging(&mut self, model: EmbeddingModelSpec) -> Result<Generation, String> {
        let generation_id = uuid::Uuid::new_v4().to_string();
        let generation = Generation { workspace_id:workspace_id(&self.root),database_path:self.root.join(".stuart/indices").join(format!("{generation_id}.db")),generation_id,model,parser_version:PARSER_VERSION,status:"Indexing".into(),failures_json:"[]".into() };
        self.record(&generation)?;
        Ok(generation)
    }

    pub fn record(&mut self, generation: &Generation) -> Result<(), String> {
        self.connection.execute("INSERT INTO generations VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET status=excluded.status,failures_json=excluded.failures_json",params![generation.generation_id,generation.workspace_id,serde_json::to_string(&generation.model).map_err(|error| error.to_string())?,generation.parser_version,generation.status,generation.failures_json,generation.database_path.to_string_lossy()]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn publish(&mut self, generation: &Generation) -> Result<(), String> {
        if generation.status != "Ready" && generation.status != "Partial" { return Err("未完成一致性校验的索引代际禁止发布".into()); }
        self.record(generation)?;
        let transaction = self.connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO current_generation(singleton,generation_id) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id",params![generation.generation_id]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.connection.execute_batch("PRAGMA wal_checkpoint(FULL)").map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn selected_model(&self)->Result<Option<String>,String> {
        self.connection.query_row("SELECT value FROM workspace_settings WHERE key='selected_model'",[],|row|row.get(0)).optional().map_err(|error|error.to_string())
    }

    pub fn select_model(&mut self,model_id:&str)->Result<(),String> {
        super::model_registry::model_spec(model_id)?;
        let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(self.root.join(".stuart/index.lock")).map_err(|error|error.to_string())?;
        FileExt::try_lock_exclusive(&lock).map_err(|error|format!("切换模型需要等待当前索引任务结束：{error}"))?;
        self.connection.execute("INSERT INTO workspace_settings(key,value) VALUES('selected_model',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![model_id]).map_err(|error|error.to_string())?;
        Ok(())
    }
}

pub async fn build_generation<F>(root:&Path,config:&RagConfig,engine:&Arc<LocalEmbeddingEngine>,cancel:&Arc<AtomicBool>,job_id:&str,mut progress:F)->Result<BuiltGeneration,String>
where F:FnMut(IndexProgress) {
    let spec=super::model_registry::model_spec(&config.model_id)?;
    let mut catalog=GenerationCatalog::open(root)?;
    let lock=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join(".stuart/index.lock")).map_err(|error|error.to_string())?;
    let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(30);
    loop {
        if cancel.load(Ordering::Acquire) {return Err("Cancelled".into());}
        match FileExt::try_lock_exclusive(&lock) {
            Ok(())=>break,
            Err(error) if error.kind()==std::io::ErrorKind::WouldBlock || error.raw_os_error()==fs2::lock_contended_error().raw_os_error()=> {
                if tokio::time::Instant::now()>=deadline {return Err("IndexBusy：工作区的另一个索引任务尚未结束".into());}
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            Err(error)=>return Err(format!("锁定索引目录失败：{error}")),
        }
    }
    let mut generation=catalog.staging(spec.clone())?;
    let result:Result<(Arc<RagStorage>,IndexSummary),String>=async {
        if cancel.load(Ordering::Acquire) {return Err("Cancelled".into());}
        let actual=engine.validated_spec().await.map_err(|error|format!("Loading：{error}"))?;
        if actual!=spec {return Err("Loading：实际模型身份与工作区配置不同".into());}
        let mut staging_config=config.clone();
        staging_config.embedding_dim=spec.dimension;
        staging_config.db_path=generation.database_path.clone();
        let storage=Arc::new(RagStorage::open(staging_config.clone()).map_err(|error|format!("Database：{error}"))?);
        storage.set_metadata("model_spec_hash",&spec.identity_hash()?)?;
        storage.set_metadata("index_generation",&generation.generation_id)?;
        storage.set_metadata("parser_version",&PARSER_VERSION.to_string())?;
        let mut summary=super::sync_vault_pipeline(root,&storage,engine,&staging_config,cancel,|mut event| {
            event.job_id=job_id.into();
            progress(event);
        }).await?;
        if cancel.load(Ordering::Acquire) {return Err("Cancelled".into());}
        let reader=storage.get_reader()?;
        let first:Option<(String,String)>=reader.query_row("SELECT chunk_id,content FROM rag_chunks ORDER BY chunk_id LIMIT 1",[],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|error|format!("Database：{error}"))?;
        if let Some((chunk_id,text))=first {
            let vector=engine.embed_query(&text).await.map_err(|error|format!("Embedding：{error}"))?;
            let hits=storage.search_vector_knn(&reader,&vector,5)?;
            if !hits.iter().any(|hit|hit.chunk_id==chunk_id) {return Err("Database：实际向量查询未返回来源片段".into());}
        }
        drop(reader);
        storage.validate_and_flush()?;
        if cancel.load(Ordering::Acquire) {return Err("Cancelled".into());}
        summary.job_id=job_id.into();
        summary.index_generation=Some(generation.generation_id.clone());
        Ok((storage,summary))
    }.await;
    match result {
        Ok((storage,summary))=> {
            generation.status=summary.status.clone();
            generation.failures_json=serde_json::to_string(&summary.failed_files).map_err(|error|error.to_string())?;
            catalog.publish(&generation)?;
            Ok(BuiltGeneration {generation,storage,summary})
        }
        Err(error)=> {
            generation.status=if error=="Cancelled" {"Cancelled"}else{"Failed"}.into();
            generation.failures_json=serde_json::to_string(&vec![super::config::IndexFileFailure {path:root.to_string_lossy().into_owned(),stage:error.split('：').next().unwrap_or("Indexing").into(),message:error.clone()}]).map_err(|error|error.to_string())?;
            catalog.record(&generation)?;
            Err(error)
        }
    }
}
