use super::{encoding, identity, DiskRevision, DocumentService};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEdit { pub from: usize, pub to: usize, pub inserted_text: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum SavePayload {
    TextEdits { encoding: String, bom: bool, source_edits: Vec<SourceEdit> },
    ValidatedBytes { bytes: Vec<u8>, producer: String, validation_hash: String },
    HtmlExport { html: String },
    RecoveryBytes { source_operation_id:String, version:String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub operation_id: String,
    pub document_id: String,
    pub editor_revision: u64,
    pub target_path: String,
    pub expected_disk_revision: DiskRevision,
    pub payload: SavePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SaveStatus { Saved, Conflict }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetails {
    pub reason: String,
    pub base_bytes: Vec<u8>,
    pub local_bytes: Vec<u8>,
    pub external_bytes: Vec<u8>,
    pub disk_revision: DiskRevision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub operation_id: String,
    pub document_id: String,
    pub saved_editor_revision: u64,
    pub disk_revision: DiskRevision,
    pub backup_id: Option<String>,
    pub result: SaveStatus,
    pub conflict: Option<ConflictDetails>,
    pub maintenance_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOperation {
    pub operation_id: String,
    pub document_id: String,
    pub target_path: String,
    pub stage: String,
    pub base_path: String,
    pub local_path: String,
    pub external_path: Option<String>,
    pub replacement_backup_path: String,
    pub temporary_path: String,
    pub created_at: i64,
}

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct SaveVersion {
    pub operation_id:String, pub version:String, pub target_path:String, pub bytes:Vec<u8>,
    pub sha256:String, pub source:Option<String>, pub encoding:Option<String>, pub encoding_candidates:Vec<String>,
}

pub(crate) struct SaveStore { connection: Mutex<Connection>, history: PathBuf, pdf_history: Mutex<std::collections::HashMap<String,std::collections::VecDeque<String>>> }

pub(crate) fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection.busy_timeout(std::time::Duration::from_secs(30)).map_err(|error| error.to_string())?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;").map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn now() -> Result<i64, String> {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis().try_into().map_err(|_| "时间戳溢出".into())
}

pub(crate) fn durable_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|error| format!("创建持久化文件失败 {}: {error}", path.display()))?;
    file.write_all(bytes).map_err(|error| format!("写入持久化文件失败: {error}"))?;
    file.sync_all().map_err(|error| format!("持久化文件失败: {error}"))
}

impl SaveStore {
    pub fn new(data: &Path) -> Result<Self, String> {
        let mut connection = Connection::open(data.join("save_journal.db")).map_err(|error| format!("打开保存日志失败: {error}"))?;
        configure_connection(&connection)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|error| error.to_string())?;
        if version > 2 { return Err("保存日志结构版本高于当前软件支持版本".into()); }
        if version==1 {connection.backup(rusqlite::DatabaseName::Main,data.join(format!("save_journal-v1-{}.backup.db",uuid::Uuid::new_v4())),None).map_err(|error|format!("备份保存日志失败：{error}"))?;}
        let transaction=connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
        let version:i64=transaction.pragma_query_value(None,"user_version",|row|row.get(0)).map_err(|error|error.to_string())?;
        if version>2 {return Err("保存日志结构版本高于当前软件支持版本".into());}
        transaction.execute_batch("
            CREATE TABLE IF NOT EXISTS save_operations (
                operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, target_path TEXT NOT NULL,
                request_hash TEXT NOT NULL, editor_revision INTEGER NOT NULL, stage TEXT NOT NULL,
                base_path TEXT NOT NULL, local_path TEXT NOT NULL, external_path TEXT,
                replacement_backup_path TEXT NOT NULL, temporary_path TEXT NOT NULL,
                created_at INTEGER NOT NULL, result_json TEXT, error TEXT
            );
            CREATE INDEX IF NOT EXISTS save_document_history ON save_operations(document_id,created_at DESC);
            ").map_err(|error| format!("创建保存日志结构失败: {error}"))?;
        if version<2 {transaction.execute_batch("ALTER TABLE save_operations ADD COLUMN base_hash TEXT;
            ALTER TABLE save_operations ADD COLUMN local_hash TEXT;
            ALTER TABLE save_operations ADD COLUMN external_hash TEXT;
            PRAGMA user_version=2;").map_err(|error|format!("升级保存日志结构失败：{error}"))?;}
        transaction.commit().map_err(|error|error.to_string())?;
        let history = data.join("save_history");
        fs::create_dir_all(&history).map_err(|error| format!("创建保存历史目录失败: {error}"))?;
        Ok(Self { connection: Mutex::new(connection), history, pdf_history:Mutex::new(std::collections::HashMap::new()) })
    }

    fn existing(&self, operation_id: &str, request_hash: &str) -> Result<Option<SaveResult>, String> {
        let connection = self.connection.lock().map_err(|_| "保存日志锁损坏")?;
        let row: Option<(String, Option<String>, String)> = connection.query_row("SELECT request_hash,result_json,stage FROM save_operations WHERE operation_id=?1", [operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|error| error.to_string())?;
        match row {
            None => Ok(None),
            Some((hash, result, stage)) => {
                if hash != request_hash { return Err("保存操作编号被重复用于不同内容".into()); }
                match result { Some(result) => Ok(Some(serde_json::from_str(&result).map_err(|error| error.to_string())?)), None => Err(format!("保存操作停留在 {stage} 阶段，需要通过保存恢复列表查看内容")) }
            }
        }
    }

    fn begin(&self, request: &SaveRequest, request_hash: &str, base: &[u8], local: &[u8], target: &Path) -> Result<SaveOperation, String> {
        let operation_id = uuid::Uuid::parse_str(&request.operation_id).map_err(|_| "保存操作编号必须为 UUID")?.to_string();
        let base_path = self.history.join(format!("{operation_id}.base"));
        let local_path = self.history.join(format!("{operation_id}.local"));
        let parent = target.parent().ok_or("保存目标缺少父目录")?;
        let temporary_path = parent.join(format!(".~stuart-{operation_id}.tmp"));
        let replacement_backup_path = parent.join(format!(".~stuart-{operation_id}.backup"));
        let mut connection = self.connection.lock().map_err(|_| "保存日志锁损坏")?;
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO save_operations(operation_id,document_id,target_path,request_hash,editor_revision,stage,base_path,local_path,replacement_backup_path,temporary_path,created_at,base_hash,local_hash) VALUES(?1,?2,?3,?4,?5,'Preparing',?6,?7,?8,?9,?10,?11,?12)", params![operation_id, request.document_id, target.to_string_lossy(), request_hash, request.editor_revision, base_path.to_string_lossy(), local_path.to_string_lossy(), replacement_backup_path.to_string_lossy(), temporary_path.to_string_lossy(), now()?,identity::sha256(base),identity::sha256(local)]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        drop(connection);
        durable_new(&base_path, base)?;
        durable_new(&local_path, local)?;
        self.stage(&operation_id, "Prepared", None, None)?;
        Ok(SaveOperation { operation_id, document_id: request.document_id.clone(), target_path: target.to_string_lossy().into_owned(), stage: "Prepared".into(), base_path: base_path.to_string_lossy().into_owned(), local_path: local_path.to_string_lossy().into_owned(), external_path: None, replacement_backup_path: replacement_backup_path.to_string_lossy().into_owned(), temporary_path: temporary_path.to_string_lossy().into_owned(), created_at: now()? })
    }

    fn stage(&self, operation: &str, stage: &str, external_path: Option<&Path>, result: Option<&SaveResult>) -> Result<(), String> {
        let json = result.map(serde_json::to_string).transpose().map_err(|error| error.to_string())?;
        let external_hash=external_path.map(|path|fs::read(path).map(|bytes|identity::sha256(&bytes)).map_err(|error|error.to_string())).transpose()?;
        self.connection.lock().map_err(|_| "保存日志锁损坏")?.execute("UPDATE save_operations SET stage=?2,external_path=COALESCE(?3,external_path),result_json=COALESCE(?4,result_json),external_hash=COALESCE(?5,external_hash) WHERE operation_id=?1", params![operation, stage, external_path.map(|path| path.to_string_lossy().into_owned()), json,external_hash]).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn read_version(&self,operation_id:&str,version:&str,selected_encoding:Option<&str>)->Result<SaveVersion,String> {
        uuid::Uuid::parse_str(operation_id).map_err(|_|"保存恢复编号必须为UUID")?;
        let column=match version {"base"=>("base_path","base_hash"),"local"=>("local_path","local_hash"),"external"=>("external_path","external_hash"),_=>return Err("保存恢复版本无效".into())};
        let (target,path,hash):(String,Option<String>,Option<String>)=self.connection.lock().map_err(|_|"保存日志锁损坏")?.query_row(&format!("SELECT target_path,{},{} FROM save_operations WHERE operation_id=?1 AND stage<>'Pruned'",column.0,column.1),[operation_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|error|format!("读取保存恢复记录失败：{error}"))?;
        let path=path.ok_or("该操作没有此内容版本")?;
        let hash=hash.ok_or("该保存版本缺少完整性指纹，请查看保存历史文件")?;
        let bytes=fs::read(path).map_err(|error|format!("读取保存恢复内容失败：{error}"))?;
        if identity::sha256(&bytes)!=hash {return Err("保存恢复内容不完整，禁止恢复文件".into());}
        let binary=Path::new(&target).extension().is_some_and(|extension|extension.eq_ignore_ascii_case("pdf"));
        let detected=if binary {None} else {encoding::detect(&bytes)?};
        let (source,name)=if let Some(name)=selected_encoding {if binary {return Err("PDF恢复内容需要保存为文件后阅读".into());}(Some(encoding::decode(&bytes,name,detected.as_ref().is_some_and(|value|value.1))?),Some(name.into()))}
            else {detected.map(|(name,_,source)|(Some(source),Some(name.into()))).unwrap_or((None,None))};
        let candidates=if source.is_none() && !binary {encoding::candidates(&bytes)}else{vec![]};
        Ok(SaveVersion {operation_id:operation_id.into(),version:version.into(),target_path:target,bytes,sha256:hash,source,encoding:name,encoding_candidates:candidates})
    }

    pub fn operations(&self) -> Result<Vec<SaveOperation>, String> {
        let connection = self.connection.lock().map_err(|_| "保存日志锁损坏")?;
        let mut statement = connection.prepare("SELECT operation_id,document_id,target_path,stage,base_path,local_path,external_path,replacement_backup_path,temporary_path,created_at FROM save_operations ORDER BY created_at DESC,operation_id").map_err(|error| error.to_string())?;
        let result = statement.query_map([], |row| Ok(SaveOperation { operation_id: row.get(0)?, document_id: row.get(1)?, target_path: row.get(2)?, stage: row.get(3)?, base_path: row.get(4)?, local_path: row.get(5)?, external_path: row.get(6)?, replacement_backup_path: row.get(7)?, temporary_path: row.get(8)?, created_at: row.get(9)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string());
        result
    }

    pub fn pin_pdf_history(&self, document_id:&str, operation_id:&str) -> Result<(),String> {
        let mut histories=self.pdf_history.lock().map_err(|_|"PDF撤销历史锁损坏")?;
        let history=histories.entry(document_id.into()).or_default();history.push_back(operation_id.into());
        while history.len()>20 {history.pop_front();}
        Ok(())
    }

    pub fn release_pdf_history(&self, document_id:&str) -> Result<(),String> {
        self.pdf_history.lock().map_err(|_|"PDF撤销历史锁损坏")?.remove(document_id);Ok(())
    }

    fn prune(&self, target_path: &str) -> Result<(), String> {
        let operations = self.operations()?;
        let pinned:std::collections::HashSet<String>=self.pdf_history.lock().map_err(|_|"PDF撤销历史锁损坏")?.values().flatten().cloned().collect();
        let completed: Vec<_> = operations.into_iter().filter(|operation| operation.target_path.eq_ignore_ascii_case(target_path) && operation.stage == "Saved").skip(20).filter(|operation|!pinned.contains(&operation.operation_id)).collect();
        for operation in completed {
            for path in [&operation.base_path, &operation.local_path, &operation.replacement_backup_path] { if Path::new(path).exists() { fs::remove_file(path).map_err(|error| format!("清理保存备份失败: {error}"))?; } }
            self.connection.lock().map_err(|_| "保存日志锁损坏")?.execute("UPDATE save_operations SET stage='Pruned' WHERE operation_id=?1", [&operation.operation_id]).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn flush(&self) -> Result<(), String> {
        self.connection.lock().map_err(|_| "保存日志锁损坏")?.execute_batch("PRAGMA wal_checkpoint(FULL);").map_err(|error| error.to_string())
    }
}

fn replace(target: &Path, temporary: &Path, backup: &Path, existing: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH};
        let wide = |path: &Path| path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let wide_target = wide(target); let temporary = wide(temporary); let backup = wide(backup);
        let result = unsafe {
            if existing { ReplaceFileW(wide_target.as_ptr(), temporary.as_ptr(), backup.as_ptr(), 0, std::ptr::null_mut(), std::ptr::null_mut()) }
            else { MoveFileExW(temporary.as_ptr(), wide_target.as_ptr(), MOVEFILE_WRITE_THROUGH) }
        };
        if result == 0 { return Err(format!("原子保存失败，原始文件和恢复内容保留: {}", std::io::Error::last_os_error())); }
        OpenOptions::new().read(true).write(true).open(target).map_err(|error| error.to_string())?.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (target, temporary, backup, existing); Err("当前保存服务要求 Windows 原子替换接口".into()) }
}

impl DocumentService {
    pub fn save_operations(&self) -> Result<Vec<SaveOperation>, String> { self.save_store.operations() }

    pub fn save_operation_read(&self,operation_id:&str,version:&str,encoding:Option<&str>)->Result<SaveVersion,String> {self.save_store.read_version(operation_id,version,encoding)}

    pub fn save_operation_copy(&self,owner:&str,operation_id:&str,version:&str,target:&Path)->Result<SaveResult,String> {
        let target=identity::canonical_target(target)?;
        let revision=identity::read_disk(&target)?.0;
        if revision.exists {return Err("保存恢复副本需要选择尚未存在的目标文件".into());}
        self.save_operation_read(operation_id,version,None)?;
        let document=self.new_document(owner)?;
        let result=self.save(owner,SaveRequest {operation_id:uuid::Uuid::new_v4().to_string(),document_id:document.document_id.clone(),editor_revision:0,target_path:identity::display_path(&target),expected_disk_revision:revision,
            payload:SavePayload::RecoveryBytes {source_operation_id:operation_id.into(),version:version.into()}});
        self.release_document(owner,&document.document_id)?;
        result
    }

    pub fn save(&self, owner: &str, request: SaveRequest) -> Result<SaveResult, String> {
        uuid::Uuid::parse_str(&request.document_id).map_err(|_| "文档身份必须为 UUID")?;
        let state = self.state(owner, &request.document_id)?;
        if request.editor_revision < state.saved_editor_revision { return Err("保存快照早于已保存编辑版本".into()); }
        let target = identity::canonical_target(Path::new(&request.target_path))?;
        let request_hash = identity::sha256(&serde_json::to_vec(&request).map_err(|error| error.to_string())?);
        if let Some(result) = self.save_store.existing(&request.operation_id, &request_hash)? { return Ok(result); }
        let (source, bytes, encoding, bom) = match &request.payload {
            SavePayload::TextEdits { encoding, bom, source_edits } => {
                let original_source = state.source.as_ref().ok_or("文档编码尚未确认，禁止保存")?;
                let original_encoding = state.encoding.as_ref().ok_or("文档编码尚未确认，禁止保存")?;
                let (source, bytes) = encoding::apply_edits(original_source, &state.bytes, original_encoding, state.bom, encoding, *bom, source_edits)?;
                (Some(source), bytes, Some(encoding.clone()), *bom)
            }
            SavePayload::ValidatedBytes { bytes, producer, validation_hash } => {
                if identity::sha256(bytes) != *validation_hash { return Err("批注导出字节指纹不一致".into()); }
                match producer.as_str() {
                    "pdf-annotations" => { lopdf::Document::load_mem(bytes).map_err(|error| format!("批注 PDF 验证失败: {error}"))?; }
                    "json-annotations" => { let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| format!("批注 JSON 验证失败: {error}"))?; if !value.is_object() && !value.is_array() { return Err("批注 JSON 必须为对象或数组".into()); } }
                    _ => return Err("不支持的批注导出生成器".into()),
                }
                (None, bytes.clone(), None, false)
            }
            SavePayload::HtmlExport { html } => {
                if !target.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")) { return Err("HTML 导出目标必须使用 html 或 htm 扩展名".into()); }
                if html.trim().is_empty() { return Err("HTML 导出内容为空".into()); }
                (None, html.as_bytes().to_vec(), None, false)
            }
            SavePayload::RecoveryBytes {source_operation_id,version}=> {
                if request.expected_disk_revision.exists {return Err("保存恢复内容只能写入新副本".into());}
                let recovered=self.save_operation_read(source_operation_id,version,None)?;
                (None,recovered.bytes,None,false)
            }
        };
        let text_save = matches!(&request.payload, SavePayload::TextEdits { .. });
        let base_bytes = if text_save || state.path.as_ref()==Some(&target) { state.bytes.clone() } else { self.resource_base(owner, &request.document_id, &target)?.bytes };
        let (before_lock, _) = identity::read_disk(&target)?;
        let _locks = identity::FileLocks::acquire(&target, &before_lock)?;
        let (current, current_bytes) = identity::read_disk(&target)?;
        let operation = self.save_store.begin(&request, &request_hash, &base_bytes, &bytes, &target)?;
        let conflict = |reason: &str, external: Vec<u8>, disk: DiskRevision| -> Result<SaveResult, String> {
            let external_path = self.save_store.history.join(format!("{}.external", operation.operation_id));
            durable_new(&external_path, &external)?;
            let result = SaveResult { operation_id: operation.operation_id.clone(), document_id: request.document_id.clone(), saved_editor_revision: request.editor_revision, disk_revision: disk.clone(), backup_id: Some(operation.operation_id.clone()), result: SaveStatus::Conflict, conflict: Some(ConflictDetails { reason: reason.into(), base_bytes: base_bytes.clone(), local_bytes: bytes.clone(), external_bytes: external, disk_revision: disk }), maintenance_error: None };
            self.save_store.stage(&operation.operation_id, "Conflict", Some(&external_path), Some(&result))?;
            Ok(result)
        };
        if !current.same_content_and_identity(&request.expected_disk_revision) { return conflict("磁盘内容或文件身份已经变化", current_bytes, current); }
        let temporary = Path::new(&operation.temporary_path);
        durable_new(temporary, &bytes)?;
        self.save_store.stage(&operation.operation_id, "TemporaryWritten", None, None)?;
        let (checked, checked_bytes) = identity::read_disk(&target)?;
        if !checked.same_content_and_identity(&current) { return conflict("创建保存临时文件期间目标发生变化", checked_bytes, checked); }
        self.save_store.stage(&operation.operation_id, "Replacing", None, None)?;
        let backup = Path::new(&operation.replacement_backup_path);
        replace(&target, temporary, backup, current.exists)?;
        self.save_store.stage(&operation.operation_id, "Replaced", None, None)?;
        if current.exists {
            let replaced_bytes = fs::read(backup).map_err(|error| format!("读取实际替换备份失败: {error}"))?;
            if identity::sha256(&replaced_bytes) != current.raw_byte_sha256 { let (disk, _) = identity::read_disk(&target)?; return conflict("替换前外部程序修改了文件，实际被替换的内容已保留", replaced_bytes, disk); }
        }
        let (committed, committed_bytes) = identity::read_disk(&target)?;
        if !committed.exists || committed.raw_byte_sha256 != identity::sha256(&bytes) { return conflict("保存完成前外部程序再次修改了目标文件", committed_bytes, committed); }
        let mut result = SaveResult { operation_id: operation.operation_id.clone(), document_id: request.document_id.clone(), saved_editor_revision: request.editor_revision, disk_revision: committed.clone(), backup_id: Some(operation.operation_id.clone()), result: SaveStatus::Saved, conflict: None, maintenance_error: None };
        self.save_store.stage(&operation.operation_id, "Saved", None, Some(&result))?;
        if text_save {
            let mut states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
            let document = states.get_mut(&request.document_id).ok_or("保存期间文档身份已经释放")?;
            if document.owner != owner { return Err("保存期间文档所有窗口发生变化".into()); }
            if document.path.as_ref() != Some(&target) {
                if let Some(previous) = &document.path { document.path_history.push(identity::display_path(previous)); }
            }
            document.path = Some(target.clone());
            document.source = source;
            document.bytes = bytes;
            document.encoding = encoding;
            document.bom = bom;
            document.disk_revision = committed;
            document.saved_editor_revision = request.editor_revision;
            if document.current_editor_revision <= request.editor_revision {
                document.current_editor_revision = request.editor_revision;
                document.current_source = document.source.clone().unwrap_or_default();
            }
            self.journal.mark_saved(&request.document_id, request.editor_revision, document)?;
        } else {
            self.resources.lock().map_err(|_| "文档导出版本锁损坏")?.insert((request.document_id.clone(), target.clone()), super::ResourceState { bytes: bytes.clone(), disk_revision: committed.clone() });
            if state.kind == "pdf" && state.path.as_ref() == Some(&target) {
                let mut states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
                let document = states.get_mut(&request.document_id).ok_or("保存期间文档身份已经释放")?;
                document.bytes = bytes;
                document.disk_revision = committed;
            }
        }
        if let Err(error) = self.save_store.prune(&operation.target_path) { result.maintenance_error = Some(error); self.save_store.stage(&operation.operation_id, "Saved", None, Some(&result))?; }
        Ok(result)
    }
}
