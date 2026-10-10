use super::{identity, DiskRevision, DocumentService, DocumentState, SourceEdit};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSnapshot {
    pub document_id: String,
    pub revision: u64,
    pub source: String,
    pub path: Option<String>,
    pub title: String,
    #[serde(default)]
    pub source_edits: Vec<SourceEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAck { pub document_id: String, pub journal_revision: u64, pub persisted_revision: u64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub document_id: String,
    pub title: String,
    pub path: Option<String>,
    pub revision: u64,
    pub persisted_revision: u64,
    pub updated_at: i64,
    pub conflict: bool,
    pub legacy_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRecord {
    #[serde(flatten)]
    pub entry: JournalEntry,
    pub source: String,
    pub base_source: String,
    pub kind: String,
    pub base_bytes: Vec<u8>,
    pub encoding: String,
    pub bom: bool,
    pub base_disk_revision: DiskRevision,
    pub disk_revision: DiskRevision,
    pub disk_bytes: Vec<u8>,
    pub default_separator: String,
    pub source_edits: Vec<SourceEdit>,
}

pub(crate) struct JournalStore { connection: Mutex<Connection> }

impl JournalStore {
    pub fn new(data: &Path) -> Result<Self, String> {
        let connection = Connection::open(data.join("document_journal.db")).map_err(|error| format!("打开文档草稿数据库失败: {error}"))?;
        super::save::configure_connection(&connection)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|error| error.to_string())?;
        if version > 1 { return Err("文档草稿数据库结构高于当前软件支持版本".into()); }
        connection.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, path TEXT,
                encoding TEXT NOT NULL, bom INTEGER NOT NULL, base_bytes BLOB NOT NULL, base_disk_json TEXT NOT NULL,
                revision INTEGER NOT NULL, persisted_revision INTEGER NOT NULL, source TEXT NOT NULL,
                updated_at INTEGER NOT NULL, legacy_file TEXT, discarded INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS edits (
                document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
                revision INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE, source_edits_json TEXT NOT NULL,
                source TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(document_id,revision)
            );
            CREATE TABLE IF NOT EXISTS legacy_imports (fingerprint TEXT PRIMARY KEY, original_path TEXT NOT NULL, document_id TEXT NOT NULL, imported_at INTEGER NOT NULL);
            PRAGMA user_version=1; COMMIT;").map_err(|error| format!("创建草稿数据库结构失败: {error}"))?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    pub fn write(&self, owner: &str, snapshot: &JournalSnapshot, state: &DocumentState, legacy: Option<&str>, import_key: Option<&str>) -> Result<JournalAck, String> {
        let encoding = state.encoding.as_ref().ok_or("文档编码尚未确认，禁止记录可编辑草稿")?;
        let base_json = serde_json::to_string(&state.disk_revision).map_err(|error| error.to_string())?;
        let edits_json = serde_json::to_string(&snapshot.source_edits).map_err(|error| error.to_string())?;
        let mut connection = self.connection.lock().map_err(|_| "草稿数据库锁损坏")?;
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        let existing: Option<(u64, String, u64)> = transaction.query_row("SELECT revision,source,persisted_revision FROM documents WHERE document_id=?1", [&snapshot.document_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|error| error.to_string())?;
        if let Some((revision, source, persisted)) = existing {
            if snapshot.revision < revision { return Err("迟到草稿版本早于已经持久化的版本".into()); }
            if snapshot.revision == revision {
                if source != snapshot.source { return Err("同一草稿版本包含不同内容".into()); }
                return Ok(JournalAck { document_id: snapshot.document_id.clone(), journal_revision: revision, persisted_revision: persisted });
            }
        }
        transaction.execute("INSERT INTO documents(document_id,owner,title,path,encoding,bom,base_bytes,base_disk_json,revision,persisted_revision,source,updated_at,legacy_file) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(document_id) DO UPDATE SET owner=excluded.owner,title=excluded.title,path=excluded.path,encoding=excluded.encoding,bom=excluded.bom,base_bytes=excluded.base_bytes,base_disk_json=excluded.base_disk_json,revision=excluded.revision,persisted_revision=MAX(documents.persisted_revision,excluded.persisted_revision),source=excluded.source,updated_at=excluded.updated_at,discarded=0", params![snapshot.document_id, owner, snapshot.title, snapshot.path, encoding, state.bom, state.bytes, base_json, snapshot.revision, state.saved_editor_revision, snapshot.source, super::save::now()?, legacy]).map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO edits(document_id,revision,operation_id,source_edits_json,source,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![snapshot.document_id, snapshot.revision, uuid::Uuid::new_v4().to_string(), edits_json, snapshot.source, super::save::now()?]).map_err(|error| error.to_string())?;
        if let (Some(fingerprint), Some(original_path)) = (import_key, legacy) {
            transaction.execute("INSERT INTO legacy_imports(fingerprint,original_path,document_id,imported_at) VALUES(?1,?2,?3,?4)", params![fingerprint, original_path, snapshot.document_id, super::save::now()?]).map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(JournalAck { document_id: snapshot.document_id.clone(), journal_revision: snapshot.revision, persisted_revision: state.saved_editor_revision })
    }

    pub fn mark_saved(&self, id: &str, revision: u64, state: &DocumentState) -> Result<(), String> {
        let disk_json = serde_json::to_string(&state.disk_revision).map_err(|error| error.to_string())?;
        let mut connection = self.connection.lock().map_err(|_| "草稿数据库锁损坏")?;
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        transaction.execute("UPDATE documents SET persisted_revision=MAX(persisted_revision,?2),path=?3,base_bytes=?4,base_disk_json=?5,encoding=?6,bom=?7 WHERE document_id=?1", params![id, revision, state.path.as_ref().map(|path| path.to_string_lossy().into_owned()), state.bytes, disk_json, state.encoding, state.bom]).map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM edits WHERE document_id=?1 AND revision<=?2", params![id, revision]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    fn read(&self, id: &str) -> Result<JournalRecord, String> {
        let connection = self.connection.lock().map_err(|_| "草稿数据库锁损坏")?;
        let mut record = connection.query_row("SELECT document_id,title,path,revision,persisted_revision,updated_at,legacy_file,source,base_bytes,encoding,bom,base_disk_json FROM documents WHERE document_id=?1 AND discarded=0", [id], |row| {
            Ok((JournalEntry { document_id: row.get(0)?, title: row.get(1)?, path: row.get(2)?, revision: row.get(3)?, persisted_revision: row.get(4)?, updated_at: row.get(5)?, conflict: false, legacy_file: row.get(6)? }, row.get::<_, String>(7)?, row.get::<_, Vec<u8>>(8)?, row.get::<_, String>(9)?, row.get::<_, bool>(10)?, row.get::<_, String>(11)?))
        }).map_err(|error| format!("读取草稿失败: {error}"))?;
        let base_disk_revision: DiskRevision = serde_json::from_str(&record.5).map_err(|error| error.to_string())?;
        let (disk_revision, disk_bytes) = match record.0.path.as_ref() { Some(path) => identity::read_disk(Path::new(path))?, None => (DiskRevision::absent(), vec![]) };
        record.0.conflict = !base_disk_revision.same_content_and_identity(&disk_revision);
        let edits: Option<String> = connection.query_row("SELECT source_edits_json FROM edits WHERE document_id=?1 ORDER BY revision DESC LIMIT 1", [id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        let base_source = super::encoding::decode(&record.2, &record.3, record.4)?;
        let default_separator = super::default_separator(&base_source);
        Ok(JournalRecord { entry: record.0, source: record.1, base_source, kind: "markdown".into(), base_bytes: record.2, encoding: record.3, bom: record.4, base_disk_revision, disk_revision, disk_bytes, default_separator, source_edits: match edits { Some(edits) => serde_json::from_str(&edits).map_err(|error| error.to_string())?, None => vec![] } })
    }

    fn list(&self) -> Result<Vec<JournalEntry>, String> {
        let ids = {
            let connection = self.connection.lock().map_err(|_| "草稿数据库锁损坏")?;
            let mut statement = connection.prepare("SELECT document_id FROM documents WHERE discarded=0 AND revision>persisted_revision ORDER BY updated_at DESC,document_id").map_err(|error| error.to_string())?;
            let ids = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            ids
        };
        ids.into_iter().map(|id| self.read(&id).map(|record| record.entry)).collect()
    }

    fn discard(&self, id: &str) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|_| "草稿数据库锁损坏")?;
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
        let legacy: Option<String> = transaction.query_row("SELECT legacy_file FROM documents WHERE document_id=?1", [id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.flatten();
        transaction.execute("UPDATE documents SET discarded=1 WHERE document_id=?1", [id]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        if let Some(path) = legacy { if Path::new(&path).exists() { fs::remove_file(path).map_err(|error| format!("删除已明确丢弃的旧草稿失败: {error}"))?; } }
        Ok(())
    }

    fn flush(&self) -> Result<(), String> {
        self.connection.lock().map_err(|_| "草稿数据库锁损坏")?.execute_batch("PRAGMA wal_checkpoint(FULL);").map_err(|error| error.to_string())
    }
}

impl DocumentService {
    pub fn write_journal(&self, owner: &str, mut snapshot: JournalSnapshot) -> Result<JournalAck, String> {
        if snapshot.source.len() > 16 * 1024 * 1024 { return Err("草稿超过 16 MiB 上限".into()); }
        let state = self.state(owner, &snapshot.document_id)?;
        if let Some(path) = &snapshot.path {
            let historical = state.path_history.iter().any(|previous| previous.replace('\\', "/").eq_ignore_ascii_case(&path.replace('\\', "/")));
            if !historical {
                let canonical = identity::canonical_target(Path::new(path))?;
                if state.path.as_ref() != Some(&canonical) { return Err("草稿目标路径与文档身份不一致".into()); }
            }
        } else if state.path.is_some() { return Err("已打开文件的草稿缺少原始路径".into()); }
        snapshot.path = state.path.as_ref().map(|path| identity::display_path(path));
        let acknowledgement = self.journal.write(owner, &snapshot, &state, None, None)?;
        let mut states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
        let document = states.get_mut(&snapshot.document_id).ok_or("记录草稿期间文档身份已经释放")?;
        if snapshot.revision >= document.current_editor_revision { document.current_editor_revision = snapshot.revision; document.current_source = snapshot.source; }
        Ok(acknowledgement)
    }

    pub fn journal_read(&self, id: &str) -> Result<JournalRecord, String> { self.journal.read(id) }
    pub fn journal_list(&self) -> Result<Vec<JournalEntry>, String> { self.journal.list() }
    pub fn discard(&self, id: &str) -> Result<(), String> { self.journal.discard(id) }
    pub fn flush(&self) -> Result<(), String> { self.journal.flush()?; self.save_store.flush() }

    pub fn restore(&self, owner: &str, id: &str) -> Result<JournalRecord, String> {
        let record = self.journal.read(id)?;
        let base_source = super::encoding::decode(&record.base_bytes, &record.encoding, record.bom)?;
        let path = record.entry.path.as_ref().map(|path| identity::canonical_target(Path::new(path))).transpose()?;
        let state = DocumentState { owner: owner.into(), kind: "markdown".into(), path, source: Some(base_source), bytes: record.base_bytes.clone(), encoding: Some(record.encoding.clone()), bom: record.bom, disk_revision: record.base_disk_revision.clone(), saved_editor_revision: record.entry.persisted_revision, current_editor_revision: record.entry.revision, current_source: record.source.clone(), path_history: vec![] };
        let mut states = self.states.lock().map_err(|_| "文档身份锁损坏")?;
        if let Some(existing) = states.get(id) { if existing.owner != owner { return Err("草稿文档已在其他窗口打开".into()); } }
        states.insert(id.into(), state);
        Ok(record)
    }

    pub fn import_legacy(&self, known_paths: &[String]) -> Result<usize, String> {
        use sha1::{Digest, Sha1};
        let drafts = self.data_dir.join("drafts");
        if !drafts.exists() { return Ok(0); }
        let mut mappings = std::collections::HashMap::new();
        for path in known_paths {
            let key = match fs::canonicalize(path) { Ok(path) => identity::display_path(&path), Err(_) => path.trim().into() };
            mappings.insert(format!("{:x}.md", Sha1::digest(key.as_bytes())), path.clone());
        }
        let mut imported = 0;
        for file in fs::read_dir(&drafts).map_err(|error| error.to_string())? {
            let file = file.map_err(|error| error.to_string())?;
            if !file.file_type().map_err(|error| error.to_string())?.is_file() || file.path().extension().and_then(|extension| extension.to_str()) != Some("md") { continue; }
            let bytes = fs::read(file.path()).map_err(|error| format!("读取旧草稿失败: {error}"))?;
            let source = String::from_utf8(bytes.clone()).map_err(|error| format!("旧草稿 UTF-8 编码无效: {error}"))?;
            let fingerprint = identity::sha256(&bytes);
            let import_key = format!("{}:{fingerprint}", file.path().to_string_lossy());
            let existing: bool = self.journal.connection.lock().map_err(|_| "草稿数据库锁损坏")?.query_row("SELECT EXISTS(SELECT 1 FROM legacy_imports WHERE fingerprint=?1)", [&import_key], |row| row.get(0)).map_err(|error| error.to_string())?;
            if existing { continue; }
            let filename = file.file_name().to_string_lossy().into_owned();
            let original_path = mappings.get(&filename).cloned();
            let read = match original_path.as_ref().filter(|path| Path::new(path).exists()) { Some(path) => self.read("migration", Path::new(path))?, None => self.new_document("migration")? };
            let state = self.state("migration", &read.document_id)?;
            let snapshot = JournalSnapshot { document_id: read.document_id.clone(), revision: 1, source, path: original_path, title: filename, source_edits: vec![] };
            self.journal.write("migration", &snapshot, &state, Some(&file.path().to_string_lossy()), Some(&import_key))?;
            self.states.lock().map_err(|_| "文档身份锁损坏")?.remove(&read.document_id);
            imported += 1;
        }
        Ok(imported)
    }
}
