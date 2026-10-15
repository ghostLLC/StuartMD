use super::{models::*,sqlite_archive::{map_memory_row,now_millis,MEMORY_COLUMNS,CURRENT_MEMORY_COLUMNS},MemoryArchiveStorage};
use rusqlite::{params,OptionalExtension,TransactionBehavior};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use uuid::Uuid;

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct LearningCandidate {
    pub content:String,
    pub category:String,
    pub scope:String,
    pub source_ids:Vec<String>,
}

pub fn validate_candidates(value:serde_json::Value,source_message:&ChatArchiveMessage,request_id:&str,context:&serde_json::Value)->Result<Vec<LearningCandidate>,String> {
    if source_message.role!="assistant" || source_message.completion_status!="Completed" || source_message.request_id.as_deref()!=Some(request_id) {return Err("整理来源必须属于当前已完成的真实回答".into());}
    let candidates:Vec<LearningCandidate>=serde_json::from_value(value).map_err(|e|format!("整理结构无效：{e}"))?;
    if candidates.len()>3 {return Err("整理候选超过三项".into());}
    let sources=context.get("sources").and_then(serde_json::Value::as_array).ok_or("整理依据缺少真实材料清单")?;
    for item in &candidates {
        validate_content(&item.content,&item.category,&item.scope)?;
        if item.source_ids.is_empty() || item.source_ids.iter().any(|id|!sources.iter().any(|source|source.get("sourceId").and_then(serde_json::Value::as_str)==Some(id) && source.get("used").and_then(serde_json::Value::as_bool)==Some(true))) {return Err("整理候选引用了未经使用和核验的材料".into());}
        if item.scope=="document" && source_message.source_anchor.as_ref().and_then(|a|a.get("documentKey")).and_then(serde_json::Value::as_str).is_none() {return Err("整理候选缺少实际文档归属".into());}
        if item.scope=="workspace" && source_message.source_anchor.as_ref().and_then(|a|a.get("workspaceKey")).and_then(serde_json::Value::as_str).is_none() {return Err("整理候选缺少实际工作区归属".into());}
    }
    Ok(candidates)
}

fn validate_content(content:&str,category:&str,scope:&str)->Result<(),String> {
    if content.trim().is_empty() || content.chars().count()>800 {return Err("记忆正文需要包含一至八百个 Unicode 字符".into());}
    if !["concept","knowledge","glossary","preference","person","decision","legacy"].contains(&category) {return Err("记忆类别无效".into());}
    if !["global","workspace","document"].contains(&scope) {return Err("记忆适用范围无效".into());}Ok(())
}

impl MemoryArchiveStorage {
    pub fn save_learning_batch(&self,request:&str,window:&str,edits:&[MemoryEdit])->Result<serde_json::Value,String> {
        if edits.len()>3 {return Err("整理候选超过三项".into());}
        let record=self.request_record(request)?;
        let context=&record["context"];
        let sources=context["sources"].as_array().ok_or("整理依据缺少真实材料清单")?;
        let session=self.get_session(record["sessionId"].as_str().ok_or("整理来源缺少会话身份")?)?;
        let target=serde_json::json!({"documentKey":session.document_key,"workspaceKey":session.workspace_key});
        let message=self.get_session_messages(&session.session_id)?.into_iter().find(|m|m.request_id.as_deref()==Some(request) && m.role=="assistant" && m.completion_status=="Completed").ok_or("整理来源缺少真实已完成答案")?;
        for edit in edits {
            validate_content(&edit.content,&edit.category,&edit.scope)?;
            if edit.source_message_id.as_deref()!=Some(&message.message_id) || edit.source_request_id.as_deref()!=Some(request) {return Err("整理候选来源请求或消息不一致".into());}
            let expected_workspace=if edit.scope=="global" {None}else{target["workspaceKey"].as_str()};
            let expected_document=if edit.scope=="document" {target["documentKey"].as_str()}else{None};
            if edit.workspace_key.as_deref()!=expected_workspace || edit.document_key.as_deref()!=expected_document || (edit.scope=="workspace" && expected_workspace.is_none()) || (edit.scope=="document" && expected_document.is_none()) {return Err("整理候选归属与实际问题目标不同".into());}
            let anchor=edit.source_anchor.as_ref().ok_or("整理候选缺少真实来源锚点")?;
            let ids=anchor["sourceIds"].as_array().ok_or("整理候选缺少来源编号")?;
            if ids.is_empty() || anchor["sources"]!=context["sources"] || ids.iter().any(|id|id.as_str().is_none_or(|id|!sources.iter().any(|s|s["sourceId"].as_str()==Some(id) && s["used"].as_bool()==Some(true)))) {return Err("整理候选材料与实际使用的来源不同".into());}
        }
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let reserved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id JOIN chat_sessions s ON s.session_id=t.session_id WHERE a.request_id=?1 AND a.learning_window_id=?2 AND a.status='Completed' AND a.learning_status='Running' AND s.deletion_state='active' AND s.document_key IS ?3 AND s.workspace_key IS ?4)",params![request,window,session.document_key,session.workspace_key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !reserved {return Err("记忆整理所有权、会话状态或完成状态变化".into());}
        let ordinal:u64=tx.query_row("SELECT COALESCE(MAX(candidate_ordinal),0)+1 FROM memory_proposals WHERE source_request_id=?1",[request],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut memories=Vec::new();let mut proposals=Vec::new();
        for (index,edit) in edits.iter().enumerate() {
            let now=now_millis();
            if ["concept","knowledge","glossary"].contains(&edit.category.as_str()) {
                let id=Uuid::new_v4().to_string();let memory=Uuid::new_v4().to_string();
                let tier=match edit.scope.as_str(){"workspace"=>1,"document"=>2,_=>3};
                tx.execute("INSERT INTO memory_records VALUES(?1,1,'active',?2,?3,?4,?5)",params![id,edit.scope,edit.workspace_key,edit.document_key,edit.preference_key]).map_err(|e|e.to_string())?;
                tx.execute(&format!("INSERT INTO organic_memories({MEMORY_COLUMNS}) VALUES(?1,?2,?3,?4,1.0,?5,?5,0,?6,?7,?8,?9,?10,1,?11,?12,1,NULL,?13,?14,'automatic')"),params![memory,tier,edit.category,edit.content,now,edit.pinned,edit.scope,edit.workspace_key,edit.document_key,edit.preference_key,message.message_id,edit.source_anchor.as_ref().map(serde_json::Value::to_string),request,id]).map_err(|e|e.to_string())?;
                tx.execute("INSERT INTO memory_sources VALUES(?1,?2,?3,?4,?5,?6,?7)",params![Uuid::new_v4().to_string(),id,message.message_id,request,edit.source_anchor.as_ref().map(serde_json::Value::to_string),message.content,format!("{:x}",Sha256::digest(message.content.as_bytes()))]).map_err(|e|e.to_string())?;
                memories.push(id);
            }else{
                let id=Uuid::new_v4().to_string();
                tx.execute("INSERT INTO memory_proposals(proposal_id,source_request_id,source_message_id,candidate_ordinal,content,category,scope,workspace_key,document_key,proposal_version,status,created_at,source_anchor) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,'Pending',?10,?11)",params![id,request,message.message_id,ordinal+index as u64,edit.content,edit.category,edit.scope,edit.workspace_key,edit.document_key,now,edit.source_anchor.as_ref().map(serde_json::Value::to_string)]).map_err(|e|e.to_string())?;
                proposals.push(id);
            }
        }
        tx.commit().map_err(|e|e.to_string())?;drop(conn);
        let memories=memories.iter().map(|id|self.memory_by_record(id)).collect::<Result<Vec<_>,_>>()?;
        let proposals=proposals.iter().map(|id|self.get_proposal(id)).collect::<Result<Vec<_>,_>>()?;
        Ok(serde_json::json!({"memories":memories,"proposals":proposals}))
    }

    pub fn get_message(&self,id:&str)->Result<ChatArchiveMessage,String> {
        let session:String=self.conn.lock().map_err(|e|e.to_string())?.query_row("SELECT session_id FROM chat_messages WHERE message_id=?1",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
        self.get_session_messages(&session)?.into_iter().find(|m|m.message_id==id).ok_or("来源消息不存在".into())
    }

    pub fn memory_by_record(&self,id:&str)->Result<OrganicMemoryItem,String> {
        self.conn.lock().map_err(|e|e.to_string())?.query_row(&format!("SELECT {CURRENT_MEMORY_COLUMNS} FROM organic_memories WHERE record_id=?1 AND version=(SELECT current_version FROM memory_records WHERE record_id=?1)"),[id],map_memory_row).map_err(|e|e.to_string())
    }

    pub fn active_memory_by_record(&self,id:&str)->Result<OrganicMemoryItem,String> {
        self.conn.lock().map_err(|e|e.to_string())?.query_row(&format!("SELECT {CURRENT_MEMORY_COLUMNS} FROM organic_memories WHERE record_id=?1 AND version=(SELECT current_version FROM memory_records WHERE record_id=?1 AND status='active') AND confirmed=1 AND superseded_by IS NULL"),[id],map_memory_row).optional().map_err(|e|e.to_string())?.ok_or("记忆记录已经停用、删除或替换".into())
    }

    pub fn memory_versions(&self,id:&str)->Result<Vec<OrganicMemoryItem>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM memory_records WHERE record_id=?1)",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !exists {return Err("记忆记录不存在".into());}
        let mut statement=conn.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM organic_memories WHERE record_id=?1 ORDER BY version DESC")).map_err(|e|e.to_string())?;
        let items=statement.query_map([id],map_memory_row).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        Ok(items)
    }

    pub fn save_memory(&self,record:Option<&str>,expected:u64,edit:&MemoryEdit,approval:&str)->Result<OrganicMemoryItem,String> {
        self.save_memory_transaction(record,expected,edit,approval,None)
    }

    fn save_memory_transaction(&self,record:Option<&str>,expected:u64,edit:&MemoryEdit,approval:&str,proposal:Option<(&str,u64)>)->Result<OrganicMemoryItem,String> {
        validate_content(&edit.content,&edit.category,&edit.scope)?;
        if !["user","automatic","legacy"].contains(&approval) || (approval=="automatic" && !["concept","knowledge","glossary"].contains(&edit.category.as_str())) {return Err("记忆确认方式与类别不一致".into());}
        if edit.scope=="document" && edit.document_key.is_none() || edit.scope=="workspace" && edit.workspace_key.is_none() {return Err("记忆归属缺少实际身份".into());}
        let previous=record.map(|id|self.memory_by_record(id)).transpose()?;
        if previous.as_ref().map_or(0,|m|m.version)!=expected {return Err("MemoryVersionConflict：记录已经变化".into());}
        if let Some(previous)=&previous {
            if previous.source_message_id!=edit.source_message_id || previous.request_id!=edit.source_request_id || previous.source_anchor!=edit.source_anchor {return Err("编辑记忆需要保留原始来源".into());}
        }
        let source=if let Some(previous)=&previous {Some(previous.clone())}else{None};
        let manual=approval=="user" && edit.source_message_id.is_none() && edit.source_request_id.is_none() && edit.source_anchor.as_ref().and_then(|a|a.get("createdBy")).and_then(serde_json::Value::as_str).is_some_and(|origin|["manual-confirmation","manual-entry"].contains(&origin));
        let message=if previous.is_none() {edit.source_message_id.as_deref().map(|id|self.get_message(id)).transpose()?}else{None};
        if let Some(message)=&message {if message.role!="assistant" || message.completion_status!="Completed" || message.request_id!=edit.source_request_id {return Err("记忆来源需要真实已完成答案".into());}}
        if previous.is_none() && message.is_none() && !manual {return Err("保存记忆缺少真实来源消息或人工确认标记".into());}
        let id=record.map(str::to_owned).unwrap_or_else(||Uuid::new_v4().to_string());let memory_id=Uuid::new_v4().to_string();let now=now_millis();
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        if let Some((proposal,version))=proposal {
            let changed=tx.execute("UPDATE memory_proposals SET status='Confirmed',proposal_version=proposal_version+1 WHERE proposal_id=?1 AND proposal_version=?2 AND status='Pending'",params![proposal,version]).map_err(|e|e.to_string())?;
            if changed!=1 {return Err("MemoryVersionConflict：候选已经变化".into());}
        }
        if let Some(record)=record {
            let version:u64=tx.query_row("SELECT current_version FROM memory_records WHERE record_id=?1 AND status<>'deleted'",[record],|r|r.get(0)).map_err(|e|e.to_string())?;if version!=expected {return Err(format!("MemoryVersionConflict：当前版本 {version}"));}
        }
        let conflict:Option<String>=tx.query_row("SELECT record_id FROM memory_records WHERE status='active' AND scope=?1 AND workspace_key IS ?2 AND document_key IS ?3 AND preference_key=?4 AND record_id<>?5",params![edit.scope,edit.workspace_key,edit.document_key,edit.preference_key,id],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        if let Some(conflict)=conflict {return Err(format!("记忆偏好名称与记录 {conflict} 冲突"));}
        tx.execute("INSERT INTO memory_records VALUES(?1,?2,'active',?3,?4,?5,?6) ON CONFLICT(record_id) DO UPDATE SET current_version=excluded.current_version,status='active',scope=excluded.scope,workspace_key=excluded.workspace_key,document_key=excluded.document_key,preference_key=excluded.preference_key",params![id,expected+1,edit.scope,edit.workspace_key,edit.document_key,edit.preference_key]).map_err(|e|e.to_string())?;
        let tier=match edit.scope.as_str(){"workspace"=>1,"document"=>2,_=>3};
        tx.execute(&format!("INSERT INTO organic_memories({MEMORY_COLUMNS}) VALUES(?1,?2,?3,?4,1.0,?5,?5,0,?6,?7,?8,?9,?10,?11,?12,?13,1,NULL,?14,?15,?16)"),params![memory_id,tier,edit.category,edit.content,now,edit.pinned,edit.scope,edit.workspace_key,edit.document_key,edit.preference_key,expected+1,edit.source_message_id,edit.source_anchor.as_ref().map(serde_json::Value::to_string),edit.source_request_id,id,approval]).map_err(|e|e.to_string())?;
        if source.is_none() {
            let excerpt=message.as_ref().map_or(edit.content.as_str(),|m|m.content.as_str());
            tx.execute("INSERT INTO memory_sources VALUES(?1,?2,?3,?4,?5,?6,?7)",params![Uuid::new_v4().to_string(),id,message.as_ref().map(|m|&m.message_id),edit.source_request_id,edit.source_anchor.as_ref().map(serde_json::Value::to_string),excerpt,format!("{:x}",Sha256::digest(excerpt.as_bytes()))]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e|e.to_string())?;drop(conn);self.memory_by_record(&id)
    }

    pub fn delete_memory_record(&self,id:&str,expected:u64)->Result<bool,String> {
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute("UPDATE memory_records SET status='deleted' WHERE record_id=?1 AND current_version=?2 AND status<>'deleted'",params![id,expected]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("MemoryVersionConflict：记录已经变化或删除".into());}Ok(true)
    }

    pub fn effective_target_memories(&self,workspace:Option<&str>,document:Option<&str>,query:&str,use_memory:bool)->Result<Vec<OrganicMemoryItem>,String> {
        if !use_memory {return Ok(vec![]);}
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let mut statement=conn.prepare(&format!("SELECT {CURRENT_MEMORY_COLUMNS} FROM organic_memories WHERE memory_id IN(SELECT m.memory_id FROM organic_memories m JOIN memory_records r ON r.record_id=m.record_id AND r.current_version=m.version WHERE r.status='active' AND m.confirmed=1 AND (r.scope='global' OR (r.scope='workspace' AND r.workspace_key=?1) OR (r.scope='document' AND r.document_key=?2 AND (r.workspace_key IS NULL OR r.workspace_key=?1))) AND (m.pinned=1 OR m.category IN('preference','decision') OR (length(?3)<3 AND instr(lower(m.content),lower(?3))>0) OR (length(?3)>=3 AND m.memory_id IN(SELECT memory_id FROM fts_organic_memories WHERE fts_organic_memories MATCH ?4)))) ORDER BY CASE scope WHEN 'document' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END,pinned DESC,last_accessed_at DESC")).map_err(|e|e.to_string())?;
        let mut items=statement.query_map(params![workspace,document,query,crate::rag::escape_fts5_query(query)],map_memory_row).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let mut preferences=std::collections::HashSet::new();items.retain(|m|m.preference_key.as_ref().is_none_or(|key|preferences.insert(key.clone())));Ok(items)
    }

    pub fn get_memory_source(&self,id:&str)->Result<serde_json::Value,String> {
        let item=self.memory_by_record(id)?;let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let mut statement=conn.prepare("SELECT s.source_message_id,s.request_id,s.source_anchor,s.source_excerpt,s.source_hash,m.session_id FROM memory_sources s LEFT JOIN chat_messages m ON m.message_id=s.source_message_id WHERE record_id=?1 ORDER BY source_id").map_err(|e|e.to_string())?;
        let sources=statement.query_map([id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let sources=sources.into_iter().map(|(message,request,anchor,excerpt,hash,session)| {let anchor=anchor.map(|a|serde_json::from_str::<serde_json::Value>(&a).map_err(|e|e.to_string())).transpose()?;Ok(serde_json::json!({"sourceMessageId":message,"requestId":request,"sourceAnchor":anchor,"excerpt":excerpt,"sourceHash":hash,"sessionId":session,"sourceDeleted":message.is_none() && request.is_some()}))}).collect::<Result<Vec<_>,String>>()?;Ok(serde_json::json!({"record":item,"sources":sources}))
    }

    pub fn archived_source(&self,source_id:&str,request:&str)->Result<serde_json::Value,String> {
        let json:String=self.conn.lock().map_err(|e|e.to_string())?.query_row("SELECT record_json FROM context_records WHERE request_id=?1",[request],|r|r.get(0)).map_err(|e|e.to_string())?;
        let context:serde_json::Value=serde_json::from_str(&json).map_err(|e|e.to_string())?;
        context.get("sources").and_then(serde_json::Value::as_array).ok_or("请求材料缺少来源清单")?.iter().find(|s|s.get("sourceId").and_then(serde_json::Value::as_str)==Some(source_id)).cloned().ok_or("请求来源编号不存在".into())
    }

    pub fn create_memory_proposal(&self,edit:&MemoryEdit,ordinal:u64)->Result<MemoryProposal,String> {
        validate_content(&edit.content,&edit.category,&edit.scope)?;
        let message=self.get_message(edit.source_message_id.as_deref().ok_or("候选缺少来源消息")?)?;
        if message.completion_status!="Completed" || message.role!="assistant" || message.request_id!=edit.source_request_id {return Err("候选来源需要真实已完成答案".into());}
        let proposal=MemoryProposal{proposal_id:Uuid::new_v4().to_string(),source_request_id:edit.source_request_id.clone().ok_or("候选缺少来源请求")?,source_message_id:Some(message.message_id),source_anchor:edit.source_anchor.clone(),content:edit.content.clone(),category:edit.category.clone(),scope:edit.scope.clone(),workspace_key:edit.workspace_key.clone(),document_key:edit.document_key.clone(),proposal_version:1,status:"Pending".into()};
        self.conn.lock().map_err(|e|e.to_string())?.execute("INSERT INTO memory_proposals VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,'Pending',?10,?11)",params![proposal.proposal_id,proposal.source_request_id,proposal.source_message_id,ordinal,proposal.content,proposal.category,proposal.scope,proposal.workspace_key,proposal.document_key,now_millis(),edit.source_anchor.as_ref().map(serde_json::Value::to_string)]).map_err(|e|e.to_string())?;Ok(proposal)
    }

    pub fn next_proposal_ordinal(&self,request:&str)->Result<u64,String> {
        self.conn.lock().map_err(|e|e.to_string())?.query_row("SELECT COALESCE(MAX(candidate_ordinal),0)+1 FROM memory_proposals WHERE source_request_id=?1",[request],|r|r.get(0)).map_err(|e|e.to_string())
    }

    pub fn get_proposal(&self,id:&str)->Result<MemoryProposal,String> {
        self.conn.lock().map_err(|e|e.to_string())?.query_row("SELECT proposal_id,source_request_id,source_message_id,content,category,scope,workspace_key,document_key,proposal_version,status,source_anchor FROM memory_proposals WHERE proposal_id=?1",[id],map_proposal).map_err(|e|e.to_string())
    }

    pub fn update_proposal(&self,id:&str,expected:u64,edit:&MemoryEdit,discard:bool)->Result<MemoryProposal,String> {
        validate_content(&edit.content,&edit.category,&edit.scope)?;
        let proposal=self.get_proposal(id)?;
        if edit.source_message_id!=proposal.source_message_id || edit.source_request_id.as_deref()!=Some(&proposal.source_request_id) || edit.source_anchor!=proposal.source_anchor {return Err("编辑候选需要保留原始来源".into());}
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute("UPDATE memory_proposals SET content=?1,category=?2,scope=?3,workspace_key=?4,document_key=?5,status=?6,proposal_version=proposal_version+1 WHERE proposal_id=?7 AND proposal_version=?8 AND status='Pending'",params![edit.content,edit.category,edit.scope,edit.workspace_key,edit.document_key,if discard{"Discarded"}else{"Pending"},id,expected]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("MemoryVersionConflict：候选版本或状态变化".into());}self.get_proposal(id)
    }

    pub fn confirm_proposal(&self,id:&str,expected:u64,edit:&MemoryEdit)->Result<OrganicMemoryItem,String> {
        let proposal=self.get_proposal(id)?;
        if proposal.proposal_version!=expected || proposal.status!="Pending" || proposal.source_message_id.is_none() || edit.source_message_id!=proposal.source_message_id || edit.source_request_id.as_deref()!=Some(&proposal.source_request_id) || edit.source_anchor!=proposal.source_anchor {return Err("MemoryVersionConflict：候选版本或来源变化".into());}
        self.save_memory_transaction(None,0,edit,"user",Some((id,expected)))
    }

    pub fn list_proposals(&self,cursor:Option<&str>,limit:usize)->Result<Page<MemoryProposal>,String> {
        self.list_proposals_filtered(None,None,None,None,"",cursor,limit)
    }

    pub fn list_proposals_filtered(&self,scope:Option<&str>,workspace:Option<&str>,document:Option<&str>,category:Option<&str>,query:&str,cursor:Option<&str>,limit:usize)->Result<Page<MemoryProposal>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;let mut statement=conn.prepare("SELECT proposal_id,source_request_id,source_message_id,content,category,scope,workspace_key,document_key,proposal_version,status,source_anchor FROM memory_proposals WHERE status='Pending' AND (?1 IS NULL OR proposal_id>?1) AND (?3 IS NULL OR scope=?3) AND (?4 IS NULL OR workspace_key=?4) AND (?5 IS NULL OR document_key=?5) AND (?6 IS NULL OR category=?6) AND (?7='' OR instr(lower(content),lower(?7))>0) ORDER BY proposal_id LIMIT ?2").map_err(|e|e.to_string())?;
        let mut items=statement.query_map(params![cursor,limit.clamp(1,100)+1,scope,workspace,document,category,query],map_proposal).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;let more=items.len()>limit.clamp(1,100);items.truncate(limit.clamp(1,100));let next_cursor=if more{items.last().map(|i|i.proposal_id.clone())}else{None};Ok(Page{items,next_cursor})
    }

    pub fn list_memory_page(&self,scope:Option<&str>,workspace:Option<&str>,document:Option<&str>,query:&str,cursor:Option<&str>,limit:usize)->Result<Page<OrganicMemoryItem>,String> {
        self.list_memory_page_filtered(scope,workspace,document,None,None,query,cursor,limit)
    }

    pub fn list_memory_page_filtered(&self,scope:Option<&str>,workspace:Option<&str>,document:Option<&str>,category:Option<&str>,preference:Option<&str>,query:&str,cursor:Option<&str>,limit:usize)->Result<Page<OrganicMemoryItem>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;let mut statement=conn.prepare(&format!("SELECT {CURRENT_MEMORY_COLUMNS} FROM organic_memories WHERE memory_id IN(SELECT m.memory_id FROM organic_memories m JOIN memory_records r ON r.record_id=m.record_id AND r.current_version=m.version WHERE r.status='active' AND (?1 IS NULL OR r.scope=?1) AND (?2 IS NULL OR r.workspace_key=?2) AND (?3 IS NULL OR r.document_key=?3) AND (?8 IS NULL OR m.category=?8) AND (?9 IS NULL OR r.preference_key=?9) AND (?4='' OR (length(?4)<3 AND instr(lower(m.content),lower(?4))>0) OR (length(?4)>=3 AND m.memory_id IN(SELECT memory_id FROM fts_organic_memories WHERE fts_organic_memories MATCH ?5)))) AND (?6 IS NULL OR record_id>?6) ORDER BY record_id LIMIT ?7")).map_err(|e|e.to_string())?;
        let mut items=statement.query_map(params![scope,workspace,document,query,crate::rag::escape_fts5_query(query),cursor,limit.clamp(1,100)+1,category,preference],map_memory_row).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;let more=items.len()>limit.clamp(1,100);items.truncate(limit.clamp(1,100));let next_cursor=if more{items.last().map(|i|i.record_id.clone())}else{None};Ok(Page{items,next_cursor})
    }
}

fn map_proposal(r:&rusqlite::Row<'_>)->rusqlite::Result<MemoryProposal>{
    let anchor=r.get::<_,Option<String>>(10)?.map(|value|serde_json::from_str(&value).map_err(|e|rusqlite::Error::FromSqlConversionFailure(10,rusqlite::types::Type::Text,Box::new(e)))).transpose()?;
    Ok(MemoryProposal{proposal_id:r.get(0)?,source_request_id:r.get(1)?,source_message_id:r.get(2)?,source_anchor:anchor,content:r.get(3)?,category:r.get(4)?,scope:r.get(5)?,workspace_key:r.get(6)?,document_key:r.get(7)?,proposal_version:r.get(8)?,status:r.get(9)?})
}
