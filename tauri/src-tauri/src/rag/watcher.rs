use std::collections::{HashMap,HashSet};
use std::path::{Path,PathBuf};
use std::sync::atomic::{AtomicBool,Ordering};
use std::sync::Arc;
use std::time::{Instant,UNIX_EPOCH};
use serde::{Deserialize,Serialize};
use notify::{RecommendedWatcher,RecursiveMode,Watcher};
use super::config::{IndexExclusion,IndexFileFailure,RagConfig};
use super::embedding::LocalEmbeddingEngine;
use super::indexer::parse_file_with_resources;
use super::model_registry::file_sha256;
use super::storage::RagStorage;

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct IndexProgress {pub total_files:usize,pub processed_files:usize,pub current_file:Option<String>,pub status:String,pub error_message:Option<String>,pub job_id:String,pub workspace_id:String}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct IndexSummary {
    pub job_id:String,pub status:String,pub index_generation:Option<String>,pub total_files_scanned:usize,pub newly_indexed:usize,pub updated_files:usize,pub skipped_unmodified:usize,pub deleted_ghosts:usize,pub skipped_placeholders:usize,pub skipped_temp_files:usize,pub duration_ms:u64,
    pub failed_files:Vec<IndexFileFailure>,pub excluded_files:Vec<IndexExclusion>,
    pub scan_root:String,pub max_files:usize,pub max_depth:usize,pub success_files:usize,
}

pub struct WorkspaceWatcher { _watcher: RecommendedWatcher }

impl WorkspaceWatcher {
    pub fn start<F>(root:&Path,config:&RagConfig,changed:F)->Result<Self,String>
    where F:Fn(Result<Vec<String>,String>)+Send+'static {
        let watched_root=root.to_path_buf();
        let excluded=config.blacklisted_dirs.clone();
        let mut watcher=notify::recommended_watcher(move|event:notify::Result<notify::Event>| {
            let event=match event {Ok(event)=>event,Err(error)=>{changed(Err(format!("知识目录监听失败：{error}")));return;}};
            if matches!(event.kind,notify::EventKind::Access(_)) {return;}
            let paths:Vec<String>=event.paths.into_iter().filter_map(|path| {
                let relative=path.strip_prefix(&watched_root).ok()?;
                if relative.components().any(|component| {
                    let name=component.as_os_str().to_string_lossy();
                    is_ignored_directory(&name)||excluded.iter().any(|item|item.eq_ignore_ascii_case(&name))||is_temporary_or_ignored_file(&name)
                }) {return None;}
                if path.extension().is_some() && !is_supported_extension(&path) {return None;}
                Some(relative.to_string_lossy().replace('\\',"/"))
            }).collect();
            if !paths.is_empty() {changed(Ok(paths));}
        }).map_err(|error|format!("创建知识目录监听失败：{error}"))?;
        watcher.watch(root,RecursiveMode::Recursive).map_err(|error|format!("监听知识目录失败：{error}"))?;
        Ok(Self {_watcher:watcher})
    }
}

#[derive(Debug,Clone)]
pub struct DiscoveredFile {pub abs_path:PathBuf,pub rel_path:String,pub file_size:u64,pub file_mtime:i64}

#[cfg(windows)]
pub fn is_cloud_placeholder(path:&Path)->bool {
    use std::os::windows::ffi::OsStrExt;
    let wide:Vec<u16>=path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let attributes=unsafe {windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr())};
    attributes!=windows_sys::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES && attributes&(0x1000|0x400000|0x40000)!=0
}
#[cfg(not(windows))]
pub fn is_cloud_placeholder(_path:&Path)->bool {false}

pub fn is_temporary_or_ignored_file(name:&str)->bool {
    name.starts_with(".~stuart_tmp_")||name.starts_with(".#")||name.starts_with("~$")||name.ends_with('~')||[".tmp",".swp",".swo"].iter().any(|suffix|name.ends_with(suffix))||[".ds_store","thumbs.db","desktop.ini"].contains(&name.to_lowercase().as_str())
}
pub fn is_ignored_directory(name:&str)->bool { [".git",".svn",".hg","node_modules","target","dist","build","__pycache__","venv",".env",".stuart",".stuartmd",".trash","$recycle.bin"].contains(&name.to_lowercase().as_str()) }
pub fn is_supported_extension(path:&Path)->bool {
    path.extension().and_then(|value|value.to_str()).is_some_and(|value|["md","markdown","pdf","txt","json","rs","js","py","ts","html","css","c","cpp","h","hpp","toml","yaml","yml","go","java","kt","swift","sql","sh","bat","ps1"].contains(&value.to_lowercase().as_str()))
}

pub struct ScanResult {pub files:Vec<DiscoveredFile>,pub excluded:Vec<IndexExclusion>,pub failures:Vec<IndexFileFailure>}

pub fn scan_workspace_files(root:&Path)->Result<Vec<DiscoveredFile>,String> { Ok(scan_with_config(root,&RagConfig::default())?.files) }

pub fn scan_with_config(root:&Path,config:&RagConfig)->Result<ScanResult,String> {
    let mut result=ScanResult {files:Vec::new(),excluded:Vec::new(),failures:Vec::new()};
    let mut directories=vec![(root.to_path_buf(),0usize)];
    while let Some((directory,depth))=directories.pop() {
        let entries=match std::fs::read_dir(&directory) {Ok(entries)=>entries,Err(error)=>{result.failures.push(IndexFileFailure {path:directory.to_string_lossy().into_owned(),stage:"Scanning".into(),message:error.to_string()});continue;}};
        for entry in entries {
            let entry=entry.map_err(|error|error.to_string())?;
            let path=entry.path();
            let relative=path.strip_prefix(root).map_err(|error|error.to_string())?.to_string_lossy().replace('\\',"/");
            let name=entry.file_name().to_string_lossy().into_owned();
            let kind=entry.file_type().map_err(|error|error.to_string())?;
            let exclusion=if kind.is_symlink() {Some("符号链接不属于已授权扫描范围")} else if kind.is_dir() && (is_ignored_directory(&name)||config.blacklisted_dirs.contains(&name)) {Some("配置排除的目录")} else if kind.is_file() && is_temporary_or_ignored_file(&name) {Some("临时文件")} else if kind.is_file() && !is_supported_extension(&path) {Some("不支持的文件类型")} else if kind.is_file() && is_cloud_placeholder(&path) {Some("云端占位文件尚未下载")} else {None};
            if let Some(reason)=exclusion { result.excluded.push(IndexExclusion {path:relative,reason:reason.into()});continue; }
            if kind.is_dir() {
                if depth>=config.max_vault_depth { return Err(format!("目录递归范围超过配置限制 {}：{}",config.max_vault_depth,path.display())); }
                directories.push((path,depth+1));
            } else if kind.is_file() {
                if result.files.len()>=config.max_vault_files {return Err(format!("文件数量超过配置限制 {}：请调整知识目录范围",config.max_vault_files));}
                let metadata=entry.metadata().map_err(|error|error.to_string())?;
                let file_mtime=metadata.modified().map_err(|error|error.to_string())?.duration_since(UNIX_EPOCH).map_err(|error|error.to_string())?.as_millis() as i64;
                result.files.push(DiscoveredFile {abs_path:path,rel_path:relative,file_size:metadata.len(),file_mtime});
            }
        }
    }
    result.files.sort_by(|left,right|left.rel_path.cmp(&right.rel_path));
    Ok(result)
}

pub async fn sync_vault_pipeline<F>(root:&Path,storage:&Arc<RagStorage>,engine:&Arc<LocalEmbeddingEngine>,config:&RagConfig,cancel:&Arc<AtomicBool>,mut progress:F)->Result<IndexSummary,String>
where F:FnMut(IndexProgress) {
    let start=Instant::now();
    let job_id=uuid::Uuid::new_v4().to_string();
    let scan=scan_with_config(root,config)?;
    let total=scan.files.len();
    let mut failures=scan.failures;
    let mut newly_indexed=0;
    let existing:HashMap<String,String>=storage.get_all_documents()?.into_iter().map(|(path,hash,_)|(path,hash)).collect();
    let current_paths:HashSet<&str>=scan.files.iter().map(|file|file.rel_path.as_str()).collect();
    let mut deleted=0;
    for relative in existing.keys() { if !current_paths.contains(relative.as_str()) {storage.delete_document(relative)?;deleted+=1;} }
    let mut updated=0;
    let mut skipped=0;
    let workspace_id=super::generation::workspace_id(root);
    for (position,file) in scan.files.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {return Err("Cancelled".into());}
        progress(IndexProgress {total_files:total,processed_files:position,current_file:Some(file.rel_path.clone()),status:"Indexing".into(),error_message:None,job_id:job_id.clone(),workspace_id:workspace_id.clone()});
        let hash=match file_sha256(&file.abs_path) {Ok(hash)=>hash,Err(message)=>{failures.push(IndexFileFailure {path:file.rel_path.clone(),stage:"Fingerprint".into(),message});continue;}};
        if existing.get(&file.rel_path)==Some(&hash) {skipped+=1;continue;}
        let mut success=false;
        for attempt in 0..3 {
            let path=file.abs_path.clone();let relative=file.rel_path.clone();let native=config.native_resources.clone();let size=config.chunk_size;let overlap=config.chunk_overlap;let cancel_parse=cancel.clone();
            let parsed=tokio::task::spawn_blocking(move||parse_file_with_resources(&relative,&path,size,overlap,&native,&cancel_parse)).await.map_err(|error|error.to_string())?;
            let mut parsed=match parsed {Ok(parsed)=>parsed,Err(message)=>{ if message=="Cancelled" || message.starts_with("Resources：") {return Err(message);} failures.push(IndexFileFailure {path:file.rel_path.clone(),stage:"Parsing".into(),message});break;}};
            let texts:Vec<String>=parsed.chunks.iter().map(|chunk|chunk.content.clone()).collect();
            let vectors=engine.embed_batch(&texts).await.map_err(|error|format!("Embedding：{error}"))?;
            if cancel.load(Ordering::Acquire) {return Err("Cancelled".into());}
            if file_sha256(&file.abs_path)? != parsed.document.content_hash {
                if attempt==2 {return Err(format!("资料在索引期间持续变化：{}",file.rel_path));}
                continue;
            }
            if parsed.chunks.len()!=vectors.len() {return Err("模型返回的片段数量不一致".into());}
            for (chunk,vector) in parsed.chunks.iter_mut().zip(vectors) {chunk.embedding=Some(vector);}
            if let Some(message)=parsed.scan_warning {failures.push(IndexFileFailure {path:file.rel_path.clone(),stage:"OcrReview".into(),message});}
            storage.insert_document_batch(parsed.document,parsed.chunks)?;
            if existing.contains_key(&file.rel_path) {updated+=1;}else{newly_indexed+=1;}success=true;break;
        }
        if !success {progress(IndexProgress {total_files:total,processed_files:position+1,current_file:Some(file.rel_path.clone()),status:"Partial".into(),error_message:failures.last().map(|failure|failure.message.clone()),job_id:job_id.clone(),workspace_id:workspace_id.clone()});}
    }
    for (path,hash,_) in storage.get_all_documents()? {if file_sha256(&root.join(&path)).map_err(|error|format!("读取索引来源 {path}：{error}"))?!=hash {return Err(format!("完成校验时资料版本发生变化：{path}"));}}
    let next_scan=scan_with_config(root,config)?;
    let next_paths:HashSet<&str>=next_scan.files.iter().map(|file|file.rel_path.as_str()).collect();
    if current_paths!=next_paths {return Err("索引期间工作区资料范围发生变化，请重新建立索引".into());}
    let status=if failures.is_empty() && !scan.excluded.iter().any(|file|file.reason=="云端占位文件尚未下载") {"Ready"}else{"Partial"};
    storage.validate_and_flush()?;
    progress(IndexProgress {total_files:total,processed_files:total,current_file:None,status:status.into(),error_message:None,job_id:job_id.clone(),workspace_id});
    Ok(IndexSummary {job_id,status:status.into(),index_generation:None,total_files_scanned:total,newly_indexed,updated_files:updated,skipped_unmodified:skipped,deleted_ghosts:deleted,skipped_placeholders:scan.excluded.iter().filter(|file|file.reason=="云端占位文件尚未下载").count(),skipped_temp_files:scan.excluded.iter().filter(|file|file.reason=="临时文件").count(),duration_ms:start.elapsed().as_millis() as u64,failed_files:failures,excluded_files:scan.excluded,scan_root:root.to_string_lossy().into_owned(),max_files:config.max_vault_files,max_depth:config.max_vault_depth,success_files:newly_indexed+updated+skipped})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_workspace_changes_report_create_write_rename_delete() {
        let directory=std::env::temp_dir().join(format!("stuart-watch-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&directory).unwrap();
        let (sender,receiver)=std::sync::mpsc::channel();
        let watcher=WorkspaceWatcher::start(&directory,&RagConfig::default(),move|event|sender.send(event).unwrap()).unwrap();
        let wait=|expected:&str| {
            let deadline=Instant::now()+std::time::Duration::from_secs(15);
            loop {
                let paths=receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("实际目录事件没有到达").unwrap();
                if paths.iter().any(|path|path==expected) {break;}
            }
        };
        let first=directory.join("actual.md");let renamed=directory.join("renamed.md");
        std::fs::write(&first,"# 新建资料\n").unwrap();wait("actual.md");
        while receiver.try_recv().is_ok() {}
        std::fs::write(&first,"# 修改资料\n\n保存新的正文。\n").unwrap();wait("actual.md");
        while receiver.try_recv().is_ok() {}
        std::fs::rename(&first,&renamed).unwrap();wait("renamed.md");
        while receiver.try_recv().is_ok() {}
        std::fs::remove_file(&renamed).unwrap();wait("renamed.md");
        drop(watcher);std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn scanner_includes_more_than_two_hundred_real_documents() {
        let directory=std::env::temp_dir().join(format!("stuart-scan-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&directory).unwrap();
        for index in 0..201 {std::fs::write(directory.join(format!("document-{index}.md")),format!("# Document {index}\nActual text\n")).unwrap();}
        assert_eq!(scan_workspace_files(&directory).unwrap().len(),201);
        let mut config=RagConfig::default();config.max_vault_files=200;assert!(scan_with_config(&directory,&config).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn temporary_files_and_ignored_directories_have_explicit_rules() {
        for name in [".~stuart_tmp_document.md","notes.md~","tempfile.tmp",".#document.org","~$paper.docx",".DS_Store","Thumbs.db"] {assert!(is_temporary_or_ignored_file(name));}
        for name in ["paper.md","analysis.pdf","main.rs"] {assert!(!is_temporary_or_ignored_file(name));}
        for name in [".git","node_modules","target","__pycache__",".stuartmd"] {assert!(is_ignored_directory(name));}
        for name in ["docs","chapters","src"] {assert!(!is_ignored_directory(name));}
        for name in ["doc.md","paper.pdf","code.rs","data.json"] {assert!(is_supported_extension(Path::new(name)));}
        for name in ["binary.exe","image.png"] {assert!(!is_supported_extension(Path::new(name)));}
    }
}
