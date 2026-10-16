use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool,Ordering};
use serde::{Deserialize,Serialize};
use tauri::{Emitter,Manager,State};
use crate::rag::{execute_rrf_fusion,resolve_query_weights,search_fts5_bm25,RagState,RagStatus,RagStorage,WorkspaceBinding};
use crate::rag::generation::{workspace_id,GenerationCatalog,PARSER_VERSION,build_generation};
use crate::rag::model_registry::{file_sha256,model_spec};

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct RagSetWorkspaceResponse {
    pub status:String,pub doc_count:usize,pub document_count:usize,pub chunk_count:usize,pub last_indexed:u64,pub model_id:String,pub selected_model_id:String,pub embedding_dim:usize,pub schema_version:String,pub workspace_id:String,pub index_generation:Option<String>,
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct RagSearchRequest {pub vault_root:Option<String>,pub query:String,pub top_k:Option<usize>,#[serde(default)] pub accept_partial:bool}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct RagHitPayload {
    pub chunk_id:String,pub rel_path:String,pub heading_path:String,pub start_line:Option<usize>,pub end_line:Option<usize>,pub page_number:Option<usize>,pub bounding_box:Option<String>,pub content:String,pub rrf_score:f32,pub deep_link:String,pub vector_rank:Option<usize>,pub bm25_rank:Option<usize>,
    pub source_hash:String,pub index_generation:String,pub index_status:String,pub workspace_id:String,pub workspace_root:String,pub model_id:String,
}
pub type RrfRankedChunk=RagHitPayload;

fn binding(state:&RagState,root:Option<&str>)->Result<WorkspaceBinding,String> {
    let root=if let Some(path)=root {crate::fs_api::ensure_dir_allowed(path)?} else {state.workspace_root.read().map_err(|error|error.to_string())?.clone().ok_or("尚未选择知识目录")?};
    state.workspaces.read().map_err(|error|error.to_string())?.get(&workspace_id(&root)).cloned().ok_or("知识目录尚未初始化".into())
}

fn window_binding(window:&tauri::WebviewWindow,state:&RagState,root:Option<&str>)->Result<WorkspaceBinding,String> {
    let path=if let Some(root)=root {root.to_owned()}else {state.window_workspaces.read().map_err(|error|error.to_string())?.get(window.label()).ok_or("当前窗口尚未选择知识目录")?.to_string_lossy().into_owned()};
    crate::fs_api::ensure_window_read_allowed(window,&path)?;
    binding(state,Some(&path))
}

fn record_binding(state:&RagState,mut workspace:WorkspaceBinding)->Result<(),String> {
    workspace.status.source_changed |= workspace.source_revision.load(Ordering::Acquire)!=workspace.indexed_revision;
    state.workspaces.write().map_err(|error|error.to_string())?.insert(workspace_id(&workspace.root),workspace.clone());
    if state.workspace_root.read().map_err(|error|error.to_string())?.as_ref()==Some(&workspace.root) {
        *state.status.write().map_err(|error|error.to_string())?=workspace.status;
        *state.storage.write().map_err(|error|error.to_string())?=workspace.storage;
    }
    Ok(())
}

fn watch_workspace(app:&tauri::AppHandle,state:&RagState,workspace:&WorkspaceBinding)->Result<(),String> {
    let id=workspace_id(&workspace.root);
    let mut watchers=state.watchers.lock().map_err(|error|error.to_string())?;
    if watchers.contains_key(&id) {return Ok(());}
    let root=workspace.root.clone();
    let watched_root=root.clone();
    let callback_app=app.clone();
    let pending=Arc::new(AtomicBool::new(false));
    let watcher=crate::rag::watcher::WorkspaceWatcher::start(&watched_root,&workspace.config,move|event| {
        let state=callback_app.state::<RagState>();
        let mut workspaces=state.workspaces.write().expect("知识工作区锁不可用");
        let workspace=workspaces.get_mut(&id).expect("监听知识目录记录缺失");
        workspace.source_revision.fetch_add(1,Ordering::AcqRel);
        workspace.status.source_changed=true;
        match event {
            Err(error)=> {workspace.status.status="Failed".into();workspace.status.error_message=Some(error);return;}
            Ok(paths)=> {callback_app.emit("rag-source-changed",serde_json::json!({"workspaceId":id,"workspaceRoot":root,"paths":paths})).expect("发送资料变化事件失败");}
        }
        drop(workspaces);
        if pending.swap(true,Ordering::AcqRel) {return;}
        let pending=pending.clone();let app=callback_app.clone();let root=root.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let state=app.state::<RagState>();
            loop {
                let workspace=binding(&state,Some(&root.to_string_lossy())).expect("监听知识目录绑定缺失");
                if !workspace.status.source_changed {
                    let workspaces=state.workspaces.write().expect("知识工作区锁不可用");
                    if workspaces.get(&workspace_id(&root)).expect("监听知识目录绑定缺失").status.source_changed {continue;}
                    pending.store(false,Ordering::Release);break;
                }
                let active=state.jobs.lock().expect("知识任务锁不可用").get(&workspace_id(&root)).cloned();
                if let Some(job)=active {
                    let notified=job.finished.notified();tokio::pin!(notified);notified.as_mut().enable();
                    if !job.ended.load(Ordering::Acquire) {notified.await;}
                    if binding(&state,Some(&root.to_string_lossy())).expect("监听知识目录绑定缺失").status.status=="Cancelled" {pending.store(false,Ordering::Release);break;}
                    continue;
                }
                if let Err(error)=synchronize(app.clone(),&state,workspace,true).await {
                    app.emit("rag-sync-error",serde_json::json!({"workspaceId":workspace_id(&root),"message":error})).expect("发送知识任务错误失败");pending.store(false,Ordering::Release);break;
                }
            }
        });
    })?;
    watchers.insert(workspace_id(&workspace.root),watcher);
    Ok(())
}

#[tauri::command]
pub async fn stuart_rag_set_workspace(window:tauri::WebviewWindow,app:tauri::AppHandle,state:State<'_,RagState>,workspace_root:Option<String>,vault_path:Option<String>)->Result<RagSetWorkspaceResponse,String> {
    let _operation=state.operation_lock.lock().await;
    let path=workspace_root.or(vault_path);
    if path.is_none() {
        state.window_workspaces.write().map_err(|error|error.to_string())?.remove(window.label());
        return Ok(RagSetWorkspaceResponse {status:"Uninitialized".into(),doc_count:0,document_count:0,chunk_count:0,last_indexed:0,model_id:String::new(),selected_model_id:String::new(),embedding_dim:0,schema_version:"2".into(),workspace_id:String::new(),index_generation:None});
    }
    let path=path.expect("知识目录路径已经检查");
    crate::fs_api::ensure_window_read_allowed(&window,&path)?;
    let root=crate::fs_api::ensure_dir_allowed(&path)?;
    let id=workspace_id(&root);
    let existing=state.workspaces.read().map_err(|error|error.to_string())?.get(&id).cloned();
    let workspace=if let Some(workspace)=existing {workspace}else {
        let mut catalog=GenerationCatalog::open(&root)?;
        let generation=catalog.current()?;
        let mut config=state.config.read().map_err(|error|error.to_string())?.clone();
        #[cfg(debug_assertions)] {config.native_resources=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/native");}
        #[cfg(not(debug_assertions))] {config.native_resources=app.path().resource_dir().map_err(|error|error.to_string())?.join("native");}
        let selected=catalog.selected_model()?.ok_or("知识模型配置缺失")?;
        config.model_id=selected.clone();config.embedding_dim=model_spec(&selected)?.dimension;
        let storage=if let Some(generation)=&generation {
            let mut active_config=config.clone();active_config.db_path=generation.database_path.clone();active_config.model_id=generation.model.model_id.clone();active_config.embedding_dim=generation.model.dimension;
            let storage=Arc::new(RagStorage::open(active_config)?);
            if storage.metadata("model_spec_hash")?!=generation.model.identity_hash()? {return Err("索引模型清单与数据库不一致".into());}
            Some(storage)
        } else {None};
        let mut status=RagStatus {status:generation.as_ref().map(|generation|generation.status.clone()).unwrap_or("Uninitialized".into()),workspace_id:id.clone(),index_generation:generation.as_ref().map(|generation|generation.generation_id.clone()),model_id:generation.as_ref().map(|generation|generation.model.model_id.clone()).unwrap_or(selected.clone()),selected_model_id:selected,embedding_dim:generation.as_ref().map(|generation|generation.model.dimension).unwrap_or(config.embedding_dim),..Default::default()};
        if let Some(storage)=&storage {let metadata=storage.get_vault_meta()?;status.doc_count=metadata.document_count;status.chunk_count=metadata.chunk_count;status.last_indexed=metadata.last_indexed;}
        if let Some(generation)=&generation {status.failed_files=serde_json::from_str(&generation.failures_json).map_err(|error|error.to_string())?;status.source_changed=generation.parser_version!=PARSER_VERSION || generation.model.model_id!=config.model_id;}
        WorkspaceBinding {root:root.clone(),storage,generation,status,config,operation:Arc::new(tokio::sync::Mutex::new(())),source_revision:Arc::new(std::sync::atomic::AtomicU64::new(0)),indexed_revision:0}
    };
    let response=RagSetWorkspaceResponse {status:workspace.status.status.clone(),doc_count:workspace.status.doc_count,document_count:workspace.status.doc_count,chunk_count:workspace.status.chunk_count,last_indexed:workspace.status.last_indexed,model_id:workspace.status.model_id.clone(),selected_model_id:workspace.config.model_id.clone(),embedding_dim:workspace.status.embedding_dim,schema_version:"2".into(),workspace_id:id,index_generation:workspace.status.index_generation.clone()};
    state.window_workspaces.write().map_err(|error|error.to_string())?.insert(window.label().into(),root.clone());
    *state.workspace_root.write().map_err(|error|error.to_string())?=Some(root);
    record_binding(&state,workspace.clone())?;
    watch_workspace(&app,&state,&workspace)?;
    Ok(response)
}

#[tauri::command]
pub async fn stuart_rag_query(window:tauri::WebviewWindow,app:tauri::AppHandle,state:State<'_,RagState>,query:Option<String>,top_k:Option<usize>,request:Option<RagSearchRequest>)->Result<Vec<RagHitPayload>,String> {
    let request_root=request.as_ref().and_then(|request|request.vault_root.as_deref());
    let mut workspace=window_binding(&window,&state,request_root)?;
    if workspace.status.source_changed {
        synchronize(app,&state,workspace.clone(),true).await?;
        workspace=binding(&state,Some(&workspace.root.to_string_lossy()))?;
    }
    if workspace.status.source_changed {return Err("工作区资料正在变化，请等待索引完成后重新查询".into());}
    let generation=workspace.generation.as_ref().ok_or("知识目录尚未建立真实语义索引")?;
    if generation.status=="Partial" && !request.as_ref().is_some_and(|request|request.accept_partial) {return Err("知识目录包含未完成资料，请先确认Partial范围".into());}
    let storage=workspace.storage.as_ref().ok_or("知识目录数据库未加载")?;
    let query=query.or_else(||request.as_ref().map(|request|request.query.clone())).ok_or("检索问题缺失")?;
    if query.trim().is_empty() {return Ok(Vec::new());}
    let top=top_k.or_else(||request.as_ref().and_then(|request|request.top_k)).unwrap_or(10).clamp(1,50);
    let engine=state.engine_for(&generation.model.model_id)?;
    let reader=storage.get_reader()?;
    let (vector_weight,text_weight)=resolve_query_weights(&query);
    let vector=engine.embed_query(&query).await.map_err(|error|error.to_string())?;
    let vector_hits:Vec<_>=storage.search_vector_knn(&reader,&vector,50)?.into_iter().enumerate().map(|(index,hit)|(hit.chunk_id,index+1)).collect();
    let text_hits:Vec<_>=search_fts5_bm25(&reader,&query,50).map_err(|error|error.to_string())?.into_iter().map(|(id,rank,_)|(id,rank)).collect();
    let fused=execute_rrf_fusion(&vector_hits,&text_hits,vector_weight,text_weight,top);
    let ids:Vec<_>=fused.iter().map(|hit|hit.chunk_id.clone()).collect();
    let details:HashMap<_,_>=storage.get_chunks_by_ids(&ids)?.into_iter().map(|chunk|(chunk.chunk_id.clone(),chunk)).collect();
    let source_hashes:HashMap<_,_>=storage.get_all_documents()?.into_iter().map(|(path,hash,_)|(path,hash)).collect();
    let mut hits=Vec::new();
    for hit in fused {
        let chunk=details.get(&hit.chunk_id).ok_or("检索结果引用缺失片段")?;
        let source_hash=source_hashes.get(&chunk.rel_path).ok_or("片段缺少资料来源指纹")?;
        if file_sha256(&workspace.root.join(&chunk.rel_path))? != *source_hash {return Err(format!("资料发生变化，需要重新建立索引：{}",chunk.rel_path));}
        let link=if let Some(page)=chunk.page_number {format!("stuart://anchor?file={}&page={page}",urlencoding::encode(&chunk.rel_path))}else{format!("stuart://anchor?file={}&line={}",urlencoding::encode(&chunk.rel_path),chunk.start_line.unwrap_or(1))};
        hits.push(RagHitPayload {chunk_id:hit.chunk_id,rel_path:chunk.rel_path.clone(),heading_path:chunk.heading_path.clone(),start_line:chunk.start_line,end_line:chunk.end_line,page_number:chunk.page_number,bounding_box:chunk.bounding_box.clone(),content:chunk.content.clone(),rrf_score:hit.rrf_score,deep_link:link,vector_rank:hit.vector_rank,bm25_rank:hit.bm25_rank,source_hash:source_hash.clone(),index_generation:generation.generation_id.clone(),index_status:generation.status.clone(),workspace_id:generation.workspace_id.clone(),workspace_root:workspace.root.to_string_lossy().into_owned(),model_id:generation.model.model_id.clone()});
    }
    let latest=binding(&state,Some(&workspace.root.to_string_lossy()))?;
    if latest.status.source_changed || latest.generation.as_ref().map(|generation|&generation.generation_id)!=Some(&generation.generation_id) {return Err("检索期间知识来源或索引代际已经变化，请重新查询".into());}
    Ok(hits)
}

#[tauri::command]
pub async fn stuart_rag_get_status(window:tauri::WebviewWindow,state:State<'_,RagState>,workspace_root:Option<String>)->Result<RagStatus,String> {Ok(window_binding(&window,&state,workspace_root.as_deref())?.status)}

async fn synchronize(app:tauri::AppHandle,state:&RagState,workspace:WorkspaceBinding,wait:bool)->Result<crate::rag::IndexSummary,String> {
    let operation=workspace.operation.clone();
    let _operation=if wait {operation.lock().await}else {operation.try_lock().map_err(|_|"当前工作区知识任务正在执行")?};
    let mut workspace=binding(state,Some(&workspace.root.to_string_lossy()))?;
    let source_revision=workspace.source_revision.load(Ordering::Acquire);
    let root=workspace.root.clone();let id=workspace_id(&root);
    let job=state.begin_job(&id)?;
    workspace.status.status="Loading".into();workspace.status.job_id=Some(job.job_id.clone());workspace.status.error_message=None;
    record_binding(state,workspace.clone())?;
    let result:Result<crate::rag::IndexSummary,String>=async {
        let engine=state.engine_for(&workspace.config.model_id)?;
        let built=build_generation(&root,&workspace.config,&engine,&job.cancel,&job.job_id,|progress| {
            let mut workspaces=state.workspaces.write().expect("知识工作区锁不可用");
            let active=workspaces.get_mut(&id).expect("知识工作区记录缺失");
            if active.status.job_id.as_deref()==Some(&job.job_id) {active.status.total_files=progress.total_files;active.status.processed_files=progress.processed_files;active.status.status=progress.status.clone();}
            app.emit("rag-sync-progress",&progress).expect("发送知识索引进度失败");
        }).await?;
        let metadata=built.storage.get_vault_meta()?;
        workspace.status.status=built.summary.status.clone();workspace.status.index_generation=Some(built.generation.generation_id.clone());workspace.status.model_id=built.generation.model.model_id.clone();workspace.status.selected_model_id=workspace.config.model_id.clone();workspace.status.embedding_dim=built.generation.model.dimension;workspace.status.doc_count=metadata.document_count;workspace.status.chunk_count=metadata.chunk_count;workspace.status.last_indexed=metadata.last_indexed;workspace.status.failed_files=built.summary.failed_files.clone();workspace.status.excluded_files=built.summary.excluded_files.clone();workspace.status.source_changed=false;workspace.status.total_files=built.summary.total_files_scanned;workspace.status.processed_files=built.summary.total_files_scanned;
        workspace.generation=Some(built.generation);workspace.storage=Some(built.storage);
        workspace.indexed_revision=source_revision;
        workspace.status.source_changed=workspace.source_revision.load(Ordering::Acquire)!=source_revision;
        record_binding(state,workspace.clone())?;
        app.emit("rag-status-changed",&workspace.status).map_err(|error|error.to_string())?;
        Ok(built.summary)
    }.await;
    if let Err(error)=&result {workspace.status.status=if error=="Cancelled"{"Cancelled"}else{"Failed"}.into();workspace.status.error_message=Some(error.clone());record_binding(state,workspace)?;}
    state.finish_job(&id,&job)?;
    result
}

#[tauri::command]
pub async fn stuart_rag_sync_workspace(window:tauri::WebviewWindow,app:tauri::AppHandle,state:State<'_,RagState>,workspace_root:Option<String>)->Result<crate::rag::IndexSummary,String> {
    let workspace=window_binding(&window,&state,workspace_root.as_deref())?;
    synchronize(app,&state,workspace,false).await
}

#[tauri::command]
pub async fn stuart_rag_cancel_sync(window:tauri::WebviewWindow,state:State<'_,RagState>,workspace_root:Option<String>,job_id:Option<String>)->Result<bool,String> {
    let workspace=window_binding(&window,&state,workspace_root.as_deref())?;
    let job=state.jobs.lock().map_err(|error|error.to_string())?.get(&workspace_id(&workspace.root)).cloned();
    let Some(job)=job else {return Ok(false);};
    if job_id.as_ref().is_some_and(|id|*id!=job.job_id) {return Err("取消凭据与当前知识任务不同".into());}
    job.cancel.store(true,Ordering::Release);
    loop {
        let finished=job.finished.notified();tokio::pin!(finished);finished.as_mut().enable();
        if job.ended.load(Ordering::Acquire) {break;}
        finished.await;
    }
    Ok(true)
}

#[tauri::command]
pub async fn stuart_pdf_context(window:tauri::WebviewWindow,app:tauri::AppHandle,path:String,page_number:usize)->Result<crate::rag::pdf_extract::PdfContent,String> {
    let path=crate::fs_api::ensure_window_read_allowed(&window,&path)?;
    #[cfg(debug_assertions)] let native=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/native");
    #[cfg(not(debug_assertions))] let native=app.path().resource_dir().map_err(|error|error.to_string())?.join("native");
    tokio::task::spawn_blocking(move||crate::rag::pdf_extract::extract_pdf_context(&path,&native,&AtomicBool::new(false),page_number)).await.map_err(|error|error.to_string())?
}
