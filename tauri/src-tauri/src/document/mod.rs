pub mod encoding;
pub mod identity;
pub mod journal;
pub mod pdf_annotations;
pub(crate) mod pdf_runtime;
pub mod save;

pub use identity::DiskRevision;
pub use journal::{JournalAck, JournalEntry, JournalRecord, JournalSnapshot};
pub use save::{ConflictDetails, SaveOperation, SavePayload, SaveRequest, SaveResult, SaveStatus, SourceEdit};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReadResult {
    pub document_id: String,
    #[serde(default)]
    pub document_key: String,
    pub kind: String,
    pub path: Option<String>,
    pub name: String,
    pub source: Option<String>,
    pub content: Option<String>,
    pub encoding: Option<String>,
    pub bom: bool,
    pub disk_revision: DiskRevision,
    pub access_state: String,
    pub encoding_candidates: Vec<String>,
    pub default_separator: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContextSnapshot {
    pub document_id: String,
    pub kind: String,
    pub path: Option<String>,
    pub source: String,
    pub revision: u64,
    pub content_hash: String,
    pub disk_revision: DiskRevision,
}

#[derive(Clone)]
pub(crate) struct DocumentState {
    pub owner: String,
    pub kind: String,
    pub path: Option<PathBuf>,
    pub source: Option<String>,
    pub bytes: Vec<u8>,
    pub encoding: Option<String>,
    pub bom: bool,
    pub disk_revision: DiskRevision,
    pub saved_editor_revision: u64,
    pub current_editor_revision: u64,
    pub current_source: String,
    pub path_history: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct ResourceState {
    pub bytes: Vec<u8>,
    pub disk_revision: DiskRevision,
}

pub struct DocumentService {
    pub(crate) states: Mutex<HashMap<String, DocumentState>>,
    pub(crate) save_store: save::SaveStore,
    pub(crate) journal: journal::JournalStore,
    pub(crate) data_dir: PathBuf,
    pub(crate) resources: Mutex<HashMap<(String, PathBuf), ResourceState>>,
}

impl DocumentService {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|error| format!("创建文档数据目录失败: {error}"))?;
        Ok(Self { states: Mutex::new(HashMap::new()), save_store: save::SaveStore::new(&data_dir)?, journal: journal::JournalStore::new(&data_dir)?, data_dir, resources: Mutex::new(HashMap::new()) })
    }

    pub fn new_document(&self, owner: &str) -> Result<DocumentReadResult, String> {
        let document_id = uuid::Uuid::new_v4().to_string();
        let state = DocumentState { owner: owner.into(), kind: "markdown".into(), path: None, source: Some(String::new()), bytes: vec![], encoding: Some("utf-8".into()), bom: false, disk_revision: DiskRevision::absent(), saved_editor_revision: 0, current_editor_revision: 0, current_source: String::new(), path_history: vec![] };
        let result = Self::read_result(&document_id, &state);
        self.states.lock().map_err(|_| "文档身份锁损坏")?.insert(document_id, state);
        Ok(result)
    }

    pub fn read(&self, owner: &str, path: &Path) -> Result<DocumentReadResult, String> {
        let canonical = identity::canonical_target(path)?;
        let (revision, bytes) = identity::read_disk(&canonical)?;
        if !revision.exists { return Err("文件不存在".into()); }
        if bytes.len() > 16 * 1024 * 1024 { return Err("文档超过 16 MiB 编辑上限".into()); }
        let detected = encoding::detect(&bytes)?;
        let (name, bom, source) = match detected { Some((name, bom, text)) => (Some(name.into()), bom, Some(text)), None => (None, false, None) };
        let document_id = uuid::Uuid::new_v4().to_string();
        let current_source = source.clone().unwrap_or_default();
        let state = DocumentState { owner: owner.into(), kind: "markdown".into(), path: Some(canonical), source, bytes, encoding: name, bom, disk_revision: revision, saved_editor_revision: 0, current_editor_revision: 0, current_source, path_history: vec![] };
        let result = Self::read_result(&document_id, &state);
        self.states.lock().map_err(|_| "文档身份锁损坏")?.insert(document_id, state);
        Ok(result)
    }

    pub fn read_binary(&self, owner: &str, path: &Path) -> Result<DocumentReadResult, String> {
        let canonical = identity::canonical_target(path)?;
        if std::fs::metadata(&canonical).map_err(|error|error.to_string())?.len() > 100 * 1024 * 1024 { return Err("PDF 文件超过 100 MiB 阅读上限".into()); }
        let (revision, bytes) = identity::read_disk(&canonical)?;
        if !revision.exists { return Err("PDF 文件不存在".into()); }
        if bytes.len() > 100 * 1024 * 1024 { return Err("PDF 文件超过 100 MiB 阅读上限".into()); }
        lopdf::Document::load_mem(&bytes).map_err(|error| format!("PDF 文档验证失败: {error}"))?;
        let document_id = uuid::Uuid::new_v4().to_string();
        let state = DocumentState { owner: owner.into(), kind: "pdf".into(), path: Some(canonical), source: None, bytes, encoding: None, bom: false, disk_revision: revision, saved_editor_revision: 0, current_editor_revision: 0, current_source: String::new(), path_history: vec![] };
        let result = Self::read_result(&document_id, &state);
        self.states.lock().map_err(|_| "文档身份锁损坏")?.insert(document_id, state);
        Ok(result)
    }

    pub fn confirm_encoding(&self, owner: &str, document_id: &str, name: &str) -> Result<DocumentReadResult, String> {
        let mut states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
        let state = states.get_mut(document_id).ok_or("文档身份不存在")?;
        if state.owner != owner { return Err("当前窗口无权修改该文档".into()); }
        let name = name.to_ascii_lowercase();
        let source = encoding::decode(&state.bytes, &name, state.bom)?;
        state.encoding = Some(name);
        state.current_source = source.clone();
        state.source = Some(source);
        Ok(Self::read_result(document_id, state))
    }

    pub fn encoding_preview(&self, owner: &str, document_id: &str, name: &str) -> Result<DocumentReadResult, String> {
        let mut state = self.state(owner, document_id)?;
        let encoding = name.to_ascii_lowercase();
        state.source = Some(encoding::decode(&state.bytes, &encoding, state.bom)?);
        state.encoding = Some(encoding);
        Ok(Self::read_result(document_id, &state))
    }

    fn read_result(document_id: &str, state: &DocumentState) -> DocumentReadResult {
        let document_key = match &state.path {
            Some(path) => format!("file:{}", identity::display_path(path)),
            None => format!("draft:{document_id}"),
        };
        DocumentReadResult { document_id: document_id.into(), document_key, kind: state.kind.clone(), path: state.path.as_ref().map(|path| identity::display_path(path)), name: state.path.as_ref().and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "未保存文档.md".into()), source: state.source.clone(), content: state.source.clone(), encoding: state.encoding.clone(), bom: state.bom, disk_revision: state.disk_revision.clone(), access_state: if state.source.is_some() || state.kind == "pdf" { "Editable" } else { "EncodingConfirmationRequired" }.into(), encoding_candidates: if state.source.is_none() && state.kind == "markdown" { encoding::candidates(&state.bytes) } else { vec![] }, default_separator: default_separator(state.source.as_deref().unwrap_or("")) }
    }

    pub(crate) fn state(&self, owner: &str, document_id: &str) -> Result<DocumentState, String> {
        let states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
        let state = states.get(document_id).ok_or("文档身份不存在")?;
        if state.owner != owner { return Err("当前窗口无权访问该文档".into()); }
        Ok(state.clone())
    }

    pub fn release_window(&self, owner: &str) -> Result<(), String> {
        self.flush()?;
        let mut states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
        let document_ids: Vec<_> = states.iter().filter(|(_, state)| state.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &document_ids {self.save_store.release_pdf_history(id)?;}
        self.resources.lock().map_err(|_| "文档导出版本锁损坏")?.retain(|(id, _), _| !document_ids.contains(id));
        states.retain(|_, state| state.owner != owner);
        Ok(())
    }

    pub fn release_document(&self, owner:&str, document_id:&str)->Result<(),String> {
        self.state(owner,document_id)?;
        self.flush()?;
        self.save_store.release_pdf_history(document_id)?;
        self.resources.lock().map_err(|_|"文档导出版本锁损坏")?.retain(|(id,_),_|id!=document_id);
        self.states.lock().map_err(|_|"文档身份锁损坏")?.remove(document_id);
        Ok(())
    }

    pub fn document_for_path(&self, owner: &str, path: &Path) -> Result<String, String> {
        let canonical = identity::canonical_target(path)?;
        let states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
        let matches: Vec<_> = states.iter().filter(|(_, state)| state.owner == owner && state.path.as_ref() == Some(&canonical)).map(|(id, _)| id.clone()).collect();
        if matches.len() != 1 { return Err("当前窗口缺少唯一的已打开文档身份".into()); }
        Ok(matches[0].clone())
    }

    pub(crate) fn resource_base(&self, owner: &str, document_id: &str, target: &Path) -> Result<ResourceState, String> {
        self.state(owner, document_id)?;
        let target = identity::canonical_target(target)?;
        let mut resources = self.resources.lock().map_err(|_| "文档导出版本锁损坏")?;
        let key = (document_id.to_owned(), target.clone());
        if let Some(resource) = resources.get(&key) { return Ok(resource.clone()); }
        let (disk_revision, bytes) = identity::read_disk(&target)?;
        let resource = ResourceState { disk_revision, bytes };
        resources.insert(key, resource.clone());
        Ok(resource)
    }

    pub fn capture_export_target(&self, owner: &str, document_id: &str, target: &Path) -> Result<DiskRevision, String> {
        self.state(owner, document_id)?;
        let target = identity::canonical_target(target)?;
        let (disk_revision, bytes) = identity::read_disk(&target)?;
        self.resources.lock().map_err(|_| "文档导出版本锁损坏")?.insert((document_id.to_owned(), target), ResourceState { disk_revision: disk_revision.clone(), bytes });
        Ok(disk_revision)
    }

    pub fn validate_context_snapshot(&self, owner: &str, document_id: &str, editor_revision: u64, source_hash: &str) -> Result<String, String> {
        let state = self.state(owner, document_id)?;
        if editor_revision != state.current_editor_revision { return Err("上下文编辑版本与已经持久化的文档版本不一致".into()); }
        let hash = if state.kind == "pdf" { identity::sha256(&state.bytes) } else { identity::sha256(state.current_source.as_bytes()) };
        if source_hash != hash { return Err("上下文来源指纹与实际文档不一致".into()); }
        Ok(state.current_source)
    }

    pub fn snapshot_for_window(&self, owner: &str, document_id: &str) -> Result<DocumentContextSnapshot, String> {
        let state = self.state(owner, document_id)?;
        let content_hash = if state.kind == "pdf" { identity::sha256(&state.bytes) } else { identity::sha256(state.current_source.as_bytes()) };
        Ok(DocumentContextSnapshot { document_id: document_id.into(), kind: state.kind, path: state.path.as_ref().map(|path| identity::display_path(path)), source: state.current_source, revision: state.current_editor_revision, content_hash, disk_revision: state.disk_revision })
    }

    pub fn document_key(document: &DocumentContextSnapshot) -> Result<String, String> {
        match &document.path {
            Some(path) => Ok(format!("file:{}", identity::display_path(&identity::canonical_target(Path::new(path))?))),
            None => {
                uuid::Uuid::parse_str(&document.document_id).map_err(|_| "恢复草稿身份无效")?;
                Ok(format!("draft:{}", document.document_id))
            }
        }
    }
}

pub fn default_separator(source: &str) -> String {
    for (index, character) in source.char_indices() {
        if character == '\r' { return if source.as_bytes().get(index + 1) == Some(&b'\n') { "\r\n" } else { "\r" }.into(); }
        if character == '\n' { return "\n".into(); }
    }
    "\n".into()
}

#[cfg(test)]
mod tests;
