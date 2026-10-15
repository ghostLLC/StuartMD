use super::{models::*, sqlite_archive::now_millis, MemoryArchiveStorage};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

pub fn validate_target(target: &ConversationTarget) -> Result<(), String> {
    if target.window_id.is_empty() || (target.document_key.is_none() && target.workspace_key.is_none()) { return Err("会话目标缺少实际身份".into()); }
    if let Some(key)=&target.document_key { if !key.starts_with("file:") && !key.starts_with("draft:") { return Err("文档持久身份无效".into()); } }
    if let Some(key)=&target.workspace_key {
        let canonical=crate::document::identity::canonical_target(std::path::Path::new(key))?;
        if !canonical.is_dir() || crate::document::identity::display_path(&canonical)!=*key { return Err("工作区身份需要规范目录路径".into()); }
    }
    Ok(())
}

fn map_turn(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationTurn> {
    Ok(ConversationTurn{turn_id:row.get(0)?,session_id:row.get(1)?,ordinal:row.get(2)?,kind:row.get(3)?,question:row.get(4)?,current_request_id:row.get(5)?,created_at:row.get(6)?})
}

impl MemoryArchiveStorage {
    // 仅在应用取得单实例所有权后的启动阶段调用。
    pub fn recover_interrupted_operations(&self)->Result<(),String> {
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let now=now_millis();
        let mut statement=tx.prepare("SELECT DISTINCT s.session_id FROM chat_sessions s LEFT JOIN conversation_turns t ON t.session_id=s.session_id LEFT JOIN request_attempts a ON a.turn_id=t.turn_id WHERE s.deletion_state='deleting' OR a.finished_at IS NULL AND a.request_id IS NOT NULL OR a.learning_status='Running'").map_err(|e|e.to_string())?;
        let sessions=statement.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;drop(statement);
        let mut statement=tx.prepare("SELECT a.request_id,a.turn_id,a.attempt_no,t.session_id,s.document_key,m.completion_status FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id JOIN chat_sessions s ON s.session_id=t.session_id LEFT JOIN chat_messages m ON m.request_id=a.request_id AND m.role='assistant' WHERE a.finished_at IS NULL ORDER BY a.started_at,a.request_id").map_err(|e|e.to_string())?;
        let attempts=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,u64>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;drop(statement);
        let interruption="应用退出导致请求中断，尚未归档助手回答。";
        for (request,turn,attempt,session,document,archived_status) in attempts {
            let status=if let Some(status)=archived_status {
                if !["Completed","Cancelled","Failed"].contains(&status.as_str()) {return Err("恢复请求时发现助手归档终态无效".into());}
                status
            }else{
                let sequence:u64=tx.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM chat_messages WHERE session_id=?1",[&session],|r|r.get(0)).map_err(|e|e.to_string())?;
                let anchor=serde_json::json!({"interruptionReason":interruption}).to_string();
                tx.execute("INSERT INTO chat_messages(message_id,session_id,role,content,timestamp,request_id,document_id,completion_status,source_anchor,sequence,turn_id,attempt_no) VALUES(?1,?2,'assistant','',?3,?4,?5,'Failed',?6,?7,?8,?9)",params![Uuid::new_v4().to_string(),session,now,request,document,anchor,sequence,turn,attempt]).map_err(|e|e.to_string())?;
                tx.execute("UPDATE request_attempts SET error=?1 WHERE request_id=?2",params![interruption,request]).map_err(|e|e.to_string())?;
                "Failed".into()
            };
            tx.execute("UPDATE request_attempts SET status=?1,phase=?1,finished_at=?2 WHERE request_id=?3",params![status,now,request]).map_err(|e|e.to_string())?;
        }
        tx.execute("UPDATE request_attempts SET learning_status='Cancelled',learning_error='应用退出导致记忆整理中断。' WHERE learning_status='Running'",[]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE chat_sessions SET deletion_state='active',deletion_owner=NULL WHERE deletion_state='deleting'",[]).map_err(|e|e.to_string())?;
        for session in sessions {
            tx.execute("UPDATE chat_sessions SET session_version=session_version+1,updated_at=?1 WHERE session_id=?2",params![now,session]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e|e.to_string())
    }

    pub fn save_draft_after_first_save(&self,mut draft:ConversationDraft,expected:u64,key:&str)->Result<ConversationDraft,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let owner=conn.query_row("SELECT document_key,workspace_key,session_id,draft_version FROM conversation_drafts WHERE draft_id=?1",[&draft.draft_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,u64>(3)?))).optional().map_err(|e|e.to_string())?;
        let version=if let Some((document,workspace,session,version))=owner {
            if document.as_deref()!=Some(key) || workspace!=draft.target.workspace_key || session!=draft.session_id || (version!=expected && version!=expected.checked_add(1).ok_or("草稿版本超出存储范围")?) {return Err("DraftVersionConflict：首次保存后的草稿身份或版本变化".into());}
            version
        }else{if expected!=0 {return Err("DraftVersionConflict：首次保存的草稿不存在".into());}0};
        drop(conn);
        draft.target.document_key=Some(key.into());draft.draft_version=version;
        self.save_draft(draft,version)
    }

    pub fn request_record(&self,request:&str)->Result<serde_json::Value,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let (intent,window,status,phase,session,context,learning,learning_error,error,usage)=conn.query_row(
            "SELECT a.intent_json,a.window_id,a.status,a.phase,t.session_id,c.record_json,a.learning_status,a.learning_error,a.error,a.actual_usage_json FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id LEFT JOIN context_records c ON c.request_id=a.request_id WHERE a.request_id=?1",[request],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?))).map_err(|e|e.to_string())?;
        let parse=|value:Option<String>|value.map(|v|serde_json::from_str::<serde_json::Value>(&v).map_err(|e|e.to_string())).transpose();
        let (learning_window,learning_usage)=conn.query_row("SELECT learning_window_id,learning_usage_json FROM request_attempts WHERE request_id=?1",[request],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?;
        Ok(serde_json::json!({"requestId":request,"intent":parse(intent)?,"windowId":window,"status":status,"phase":phase,"sessionId":session,"context":parse(context)?,"learningStatus":learning,"learningError":learning_error,"error":error,"actualUsage":parse(usage)?,"learningWindowId":learning_window,"learningUsage":parse(learning_usage)?}))
    }

    pub fn update_attempt_phase(&self,request:&str,window:&str,phase:&str)->Result<(),String> {
        if !["PreparingSources","Counting","Summarizing","Streaming"].contains(&phase) {return Err("请求阶段无效".into());}
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute("UPDATE request_attempts SET phase=?1,status=?1 WHERE request_id=?2 AND window_id=?3 AND finished_at IS NULL",params![phase,request,window]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("请求阶段的窗口所有权或终态无效".into());}Ok(())
    }

    pub fn set_request_learning_status(&self,request:&str,window:&str,status:&str,error:Option<&str>)->Result<(),String> {
        if !["Running","Completed","Failed","Cancelled"].contains(&status) || window.is_empty() {return Err("记忆整理状态或窗口身份无效".into());}
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let changed=if status=="Running" {
            conn.execute("UPDATE request_attempts SET learning_status='Running',learning_error=NULL,learning_window_id=?1 WHERE request_id=?2 AND status='Completed' AND learning_status='NotStarted' AND EXISTS(SELECT 1 FROM conversation_turns t JOIN chat_sessions s ON s.session_id=t.session_id WHERE t.turn_id=request_attempts.turn_id AND s.deletion_state='active')",params![window,request])
        }else{
            conn.execute("UPDATE request_attempts SET learning_status=?1,learning_error=?2 WHERE request_id=?3 AND learning_window_id=?4 AND status='Completed' AND learning_status='Running'",params![status,error,request,window])
        }.map_err(|e|e.to_string())?;
        if changed!=1 {return Err("记忆整理的请求所有权或状态无效".into());}Ok(())
    }

    pub fn record_learning_usage(&self,request:&str,window:&str,usage:&serde_json::Value)->Result<(),String> {
        if !usage.is_object() {return Err("记忆整理实际用量需要对象结构".into());}
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute("UPDATE request_attempts SET learning_usage_json=?1 WHERE request_id=?2 AND learning_window_id=?3 AND learning_status='Running'",params![serde_json::to_string(usage).map_err(|e|e.to_string())?,request,window]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("记忆整理实际用量的窗口所有权无效".into());}Ok(())
    }

    pub fn set_request_actual_usage(&self,request:&str,window:&str,usage:&serde_json::Value)->Result<(),String> {
        if !usage.is_object() {return Err("请求实际用量需要对象结构".into());}
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute("UPDATE request_attempts SET actual_usage_json=?1 WHERE request_id=?2 AND window_id=?3",params![serde_json::to_string(usage).map_err(|e|e.to_string())?,request,window]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("请求实际用量的窗口所有权无效".into());}Ok(())
    }

    pub fn save_draft(&self, mut draft:ConversationDraft, expected:u64)->Result<ConversationDraft,String> {
        validate_target(&draft.target)?;
        if !["selection","section","document","workspace"].contains(&draft.scope.as_str()) {return Err("提问范围无效".into());}
        if draft.draft_version!=expected {return Err("DraftVersionConflict：草稿提交版本不一致".into());}
        if draft.draft_id.is_empty() {draft.draft_id=Uuid::new_v4().to_string();}
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let version=tx.query_row("SELECT draft_version FROM conversation_drafts WHERE draft_id=?1",[&draft.draft_id],|r|r.get::<_,u64>(0)).optional().map_err(|e|e.to_string())?.unwrap_or(0);
        if version!=expected {return Err(format!("DraftVersionConflict：当前版本 {version}"));}
        if version>0 {
            let owner=tx.query_row("SELECT document_key,workspace_key,session_id FROM conversation_drafts WHERE draft_id=?1",[&draft.draft_id],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?))).map_err(|e|e.to_string())?;
            if owner!=(draft.target.document_key.clone(),draft.target.workspace_key.clone(),draft.session_id.clone()) {return Err("草稿身份不能由编辑操作修改".into());}
        }
        if let Some(session)=&draft.session_id {
            let owner=tx.query_row("SELECT document_key,workspace_key FROM chat_sessions WHERE session_id=?1",[session],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?;
            if owner!=(draft.target.document_key.clone(),draft.target.workspace_key.clone()) {return Err("草稿归属与会话不一致".into());}
        }
        draft.draft_version+=1; draft.updated_at=now_millis();
        tx.execute("INSERT INTO conversation_drafts(draft_id,document_key,workspace_key,session_id,draft_json,draft_version,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(draft_id) DO UPDATE SET session_id=excluded.session_id,draft_json=excluded.draft_json,draft_version=excluded.draft_version,updated_at=excluded.updated_at",params![draft.draft_id,draft.target.document_key,draft.target.workspace_key,draft.session_id,serde_json::to_string(&draft).map_err(|e|e.to_string())?,draft.draft_version,draft.updated_at]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?; Ok(draft)
    }

    pub fn get_draft(&self,target:&ConversationTarget,session:Option<&str>)->Result<Option<ConversationDraft>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let row=conn.query_row("SELECT draft_json,session_id,draft_version FROM conversation_drafts WHERE document_key IS ?1 AND workspace_key IS ?2 AND session_id IS ?3 ORDER BY updated_at DESC,draft_id DESC LIMIT 1",params![target.document_key,target.workspace_key,session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,u64>(2)?))).optional().map_err(|e|e.to_string())?;
        row.map(|(json,session,version)| {let mut draft:ConversationDraft=serde_json::from_str(&json).map_err(|e|e.to_string())?;draft.session_id=session;draft.draft_version=version;draft.target.window_id=target.window_id.clone();draft.target.runtime_document_id=target.runtime_document_id.clone();Ok(draft)}).transpose()
    }

    pub fn get_draft_by_id(&self,id:&str,target:&ConversationTarget,session:Option<&str>)->Result<ConversationDraft,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let (json,stored_session,version):(String,Option<String>,u64)=conn.query_row("SELECT draft_json,session_id,draft_version FROM conversation_drafts WHERE draft_id=?1 AND document_key IS ?2 AND workspace_key IS ?3 AND session_id IS ?4",params![id,target.document_key,target.workspace_key,session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|format!("草稿身份或归属无效：{e}"))?;
        let mut draft:ConversationDraft=serde_json::from_str(&json).map_err(|e|e.to_string())?;
        draft.session_id=stored_session;draft.draft_version=version;draft.target=target.clone();Ok(draft)
    }

    pub fn begin_turn(&self,intent:&RequestIntent)->Result<AcceptedTurn,String> {
        validate_target(&intent.target)?;
        if intent.request_id.is_empty() || intent.question.trim().is_empty() {return Err("请求编号和问题不能为空".into());}
        if !["selection","section","document","workspace"].contains(&intent.scope.as_str()) || (intent.scope!="workspace" && intent.target.document_key.is_none()) {return Err("提问范围缺少真实文档".into());}
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let session_id=if let Some(session)=&intent.session_id {
            let state=tx.query_row("SELECT document_key,workspace_key,session_version,deletion_state FROM chat_sessions WHERE session_id=?1",[session],|r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,u64>(2)?,r.get::<_,String>(3)?))).optional().map_err(|e|e.to_string())?.ok_or("会话已经删除")?;
            if state.0!=intent.target.document_key || state.1!=intent.target.workspace_key {return Err("请求目标与会话归属不同".into());}
            if state.2!=intent.expected_session_version {return Err(format!("SessionVersionConflict：当前版本 {}",state.2));}
            if state.3!="active" {return Err("会话正在删除".into());} session.clone()
        } else {
            if intent.expected_session_version!=0 || intent.turn_id.is_some() {return Err("新会话的版本或问题身份无效".into());}
            let id=Uuid::new_v4().to_string();let now=now_millis();
            tx.execute("INSERT INTO chat_sessions(session_id,title,workspace_root,created_at,updated_at,document_id,document_path,document_key,workspace_key,session_version) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?3,0)",params![id,intent.question.chars().take(60).collect::<String>(),intent.target.workspace_key,now,intent.target.runtime_document_id,intent.target.document_key.as_deref().and_then(|k|k.strip_prefix("file:")),intent.target.document_key]).map_err(|e|e.to_string())?;id
        };
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE a.finished_at IS NULL AND (t.session_id=?1 OR a.window_id=?2))",params![session_id,intent.target.window_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        if active {return Err("窗口或会话已经存在活动请求".into());}
        if intent.draft_version>0 {
            let draft_id=intent.draft_id.as_deref().ok_or("发送草稿缺少实际编号")?;
            let draft:Option<(String,u64)>=tx.query_row("SELECT draft_id,draft_version FROM conversation_drafts WHERE draft_id=?1 AND document_key IS ?2 AND workspace_key IS ?3 AND session_id IS ?4",params![draft_id,intent.target.document_key,intent.target.workspace_key,intent.session_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
            let (id,version)=draft.ok_or("发送草稿不存在")?;if version!=intent.draft_version {return Err("DraftVersionConflict：发送草稿已经变化".into());}
            tx.execute("UPDATE conversation_drafts SET session_id=?1,draft_json=json_set(draft_json,'$.question','','$.sessionId',?1,'$.draftVersion',draft_version+1),draft_version=draft_version+1 WHERE draft_id=?2",params![session_id,id]).map_err(|e|e.to_string())?;
        }
        let turn=if let Some(id)=&intent.turn_id {
            let (turn,status)=tx.query_row("SELECT t.turn_id,t.session_id,t.ordinal,t.kind,t.question,t.current_request_id,t.created_at,a.status FROM conversation_turns t JOIN request_attempts a ON a.request_id=t.current_request_id WHERE t.turn_id=?1 AND t.session_id=?2 AND t.ordinal=(SELECT MAX(ordinal) FROM conversation_turns WHERE session_id=?2)",params![id,session_id],|r|Ok((map_turn(r)?,r.get::<_,String>(7)?))).map_err(|e|e.to_string())?;
            if !["Cancelled","Failed"].contains(&status.as_str()) || turn.question!=intent.question {return Err("仅能重试最后一个失败或停止的问题".into());} turn
        } else {
            let ordinal=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM conversation_turns WHERE session_id=?1",[&session_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            let turn=ConversationTurn{turn_id:Uuid::new_v4().to_string(),session_id:session_id.clone(),ordinal,kind:"Question".into(),question:intent.question.clone(),current_request_id:Some(intent.request_id.clone()),created_at:now_millis()};
            tx.execute("INSERT INTO conversation_turns VALUES(?1,?2,?3,?4,?5,?6,?7)",params![turn.turn_id,turn.session_id,turn.ordinal,turn.kind,turn.question,turn.current_request_id,turn.created_at]).map_err(|e|e.to_string())?;turn
        };
        let attempt_no=tx.query_row("SELECT COALESCE(MAX(attempt_no),0)+1 FROM request_attempts WHERE turn_id=?1",[&turn.turn_id],|r|r.get(0)).map_err(|e|e.to_string())?;
        tx.execute("INSERT INTO request_attempts(request_id,turn_id,attempt_no,status,phase,window_id,started_at,intent_json) VALUES(?1,?2,?3,'PreparingSources','PreparingSources',?4,?5,?6)",params![intent.request_id,turn.turn_id,attempt_no,intent.target.window_id,now_millis(),serde_json::to_string(intent).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE conversation_turns SET current_request_id=?1 WHERE turn_id=?2",params![intent.request_id,turn.turn_id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE chat_sessions SET session_version=session_version+1,updated_at=?1 WHERE session_id=?2",params![now_millis(),session_id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;drop(conn);
        Ok(AcceptedTurn{session:self.get_session(&session_id)?,turn:ConversationTurn{current_request_id:Some(intent.request_id.clone()),..turn},attempt_no})
    }

    pub fn finish_attempt(&self,request_id:&str,window_id:&str,status:&str,error:Option<&str>)->Result<ChatSession,String> {
        if !["Completed","Cancelled","Failed"].contains(&status) {return Err("请求终态无效".into());}
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let (session,owner,finished)=tx.query_row("SELECT t.session_id,a.window_id,a.finished_at FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE a.request_id=?1",[request_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<u64>>(2)?))).map_err(|e|e.to_string())?;
        if owner.as_deref()!=Some(window_id) || finished.is_some() {return Err("请求所有权或终态版本无效".into());}
        let archived:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM chat_messages WHERE request_id=?1 AND role='assistant' AND completion_status=?2)",params![request_id,status],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !archived {return Err("请求终态尚未完成真实答案归档".into());}
        tx.execute("UPDATE request_attempts SET status=?1,phase=?1,error=?2,finished_at=?3 WHERE request_id=?4",params![status,error,now_millis(),request_id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE chat_sessions SET session_version=session_version+1,updated_at=?1 WHERE session_id=?2",params![now_millis(),session]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;drop(conn);self.get_session(&session)
    }

    pub fn begin_session_deletion(&self,id:&str,expected:u64,window:&str)->Result<Option<String>,String> {
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let (version,state)=tx.query_row("SELECT session_version,deletion_state FROM chat_sessions WHERE session_id=?1",[id],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
        if version!=expected || state!="active" {return Err("SessionVersionConflict：会话版本或删除状态变化".into());}
        let mut statement=tx.prepare("SELECT a.request_id,CASE WHEN a.learning_status='Running' THEN a.learning_window_id ELSE a.window_id END FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE t.session_id=?1 AND (a.finished_at IS NULL OR a.learning_status='Running') ORDER BY t.ordinal").map_err(|e|e.to_string())?;
        let active=statement.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        drop(statement);
        if active.iter().any(|(_,owner)|owner.as_deref()!=Some(window)) {return Err("请先在拥有活动请求的窗口停止回答或记忆整理".into());}
        tx.execute("UPDATE chat_sessions SET deletion_state='deleting',deletion_owner=?1 WHERE session_id=?2",params![window,id]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(active.into_iter().next().map(|(id,_)|id))
    }

    pub fn session_active_requests(&self,id:&str,window:&str)->Result<Vec<String>,String> {
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let deleting:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE session_id=?1 AND deletion_state='deleting' AND deletion_owner=?2)",params![id,window],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !deleting {return Err("读取删除请求的窗口所有权无效".into());}
        let mut statement=conn.prepare("SELECT a.request_id,CASE WHEN a.learning_status='Running' THEN a.learning_window_id ELSE a.window_id END FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE t.session_id=?1 AND (a.finished_at IS NULL OR a.learning_status='Running') ORDER BY t.ordinal").map_err(|e|e.to_string())?;
        let rows=statement.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        if rows.iter().any(|(_,owner)|owner.as_deref()!=Some(window)) {return Err("活动请求或记忆整理的窗口所有权无效".into());}
        Ok(rows.into_iter().map(|(id,_)|id).collect())
    }

    pub fn complete_session_deletion(&self,id:&str,window:&str,linked:bool)->Result<bool,String> {
        let mut conn=self.conn.lock().map_err(|e|e.to_string())?;let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE session_id=?1 AND deletion_state='deleting' AND deletion_owner=?2)",params![id,window],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !valid {return Err("删除会话的窗口所有权无效".into());}
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE t.session_id=?1 AND (a.finished_at IS NULL OR a.learning_status='Running'))",[id],|r|r.get(0)).map_err(|e|e.to_string())?;if active {return Err("活动请求或记忆整理尚未完成终态归档".into());}
        if linked {tx.execute("UPDATE memory_records SET status='deleted' WHERE record_id IN(SELECT s.record_id FROM memory_sources s JOIN chat_messages m ON m.message_id=s.source_message_id WHERE m.session_id=?1)",[id]).map_err(|e|e.to_string())?;}
        tx.execute("UPDATE conversation_drafts SET draft_json=json_set(draft_json,'$.sessionId',NULL,'$.draftVersion',draft_version+1),draft_version=draft_version+1 WHERE session_id=?1",[id]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM chat_sessions WHERE session_id=?1",[id]).map_err(|e|e.to_string())?;tx.commit().map_err(|e|e.to_string())?;Ok(true)
    }

    pub fn abort_session_deletion(&self,id:&str,window:&str)->Result<(),String> {
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute(
            "UPDATE chat_sessions SET deletion_state='active',deletion_owner=NULL WHERE session_id=?1 AND deletion_state='deleting' AND deletion_owner=?2",
            params![id,window]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("取消删除会话的窗口所有权无效".into());}
        Ok(())
    }

    pub fn rename_session(&self,id:&str,expected:u64,title:&str)->Result<ChatSession,String> {
        if title.trim().is_empty() {return Err("会话名称不能为空".into());}
        let changed=self.conn.lock().map_err(|e|e.to_string())?.execute("UPDATE chat_sessions SET title=?1,session_version=session_version+1,updated_at=?2 WHERE session_id=?3 AND session_version=?4 AND deletion_state='active'",params![title,now_millis(),id,expected]).map_err(|e|e.to_string())?;
        if changed!=1 {return Err("SessionVersionConflict：会话版本变化".into());}self.get_session(id)
    }

    pub fn list_session_page(&self,filter:&SessionFilter,query:&str,cursor:Option<&str>,limit:usize)->Result<Page<SessionSummary>,String> {
        if !["target","document","workspace","all"].contains(&filter.scope.as_str()) {return Err("会话筛选范围无效".into());}
        let after:Option<(u64,String)>=cursor.map(|v|serde_json::from_str(v).map_err(|e|e.to_string())).transpose()?;
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let mut statement=conn.prepare("SELECT s.session_id,s.title,s.workspace_root,s.created_at,s.updated_at,(SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.session_id),s.document_id,s.document_path,s.document_key,s.workspace_key,s.session_version,s.deletion_state,(SELECT question FROM conversation_turns WHERE session_id=s.session_id ORDER BY ordinal DESC LIMIT 1),(SELECT a.status FROM request_attempts a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE t.session_id=s.session_id ORDER BY t.ordinal DESC,a.attempt_no DESC LIMIT 1) FROM chat_sessions s WHERE (?1='all' OR (?1='workspace' AND s.workspace_key IS ?3) OR (?1='document' AND s.document_key IS ?2) OR (?1='target' AND s.document_key IS ?2 AND s.workspace_key IS ?3)) AND (?4='' OR instr(lower(s.title),lower(?4))>0 OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.session_id=s.session_id AND ((length(?4)<3 AND instr(lower(m.content),lower(?4))>0) OR (length(?4)>=3 AND m.message_id IN(SELECT message_id FROM fts_chat_messages WHERE fts_chat_messages MATCH ?7))))) AND (?5 IS NULL OR s.updated_at<?5 OR (s.updated_at=?5 AND s.session_id<?6)) ORDER BY s.updated_at DESC,s.session_id DESC LIMIT ?8").map_err(|e|e.to_string())?;
        let mut items=statement.query_map(params![filter.scope,filter.document_key,filter.workspace_key,query,after.as_ref().map(|v|v.0),after.as_ref().map(|v|&v.1),crate::rag::escape_fts5_query(query),limit.clamp(1,100)+1],|r|Ok(SessionSummary{session:ChatSession{session_id:r.get(0)?,title:r.get(1)?,workspace_root:r.get(2)?,created_at:r.get(3)?,updated_at:r.get(4)?,message_count:r.get(5)?,document_id:r.get(6)?,document_path:r.get(7)?,document_key:r.get(8)?,workspace_key:r.get(9)?,session_version:r.get(10)?,deletion_state:r.get(11)?},recent_question:r.get(12)?,completion_status:r.get(13)?})).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let more=items.len()>limit.clamp(1,100);items.truncate(limit.clamp(1,100));
        let next_cursor=if more {items.last().map(|v|serde_json::to_string(&(v.session.updated_at,&v.session.session_id)).map_err(|e|e.to_string())).transpose()?}else{None};Ok(Page{items,next_cursor})
    }

    pub fn conversation_page(&self,target:Option<&ConversationTarget>,session:Option<&str>,cursor:Option<u64>)->Result<ConversationPage,String> {
        let restored=if session.is_none() {
            if let Some(target)=target {
                let conn=self.conn.lock().map_err(|e|e.to_string())?;
                let draft=conn.query_row("SELECT session_id FROM conversation_drafts WHERE document_key IS ?1 AND workspace_key IS ?2 ORDER BY updated_at DESC,draft_id DESC LIMIT 1",params![target.document_key,target.workspace_key],|r|r.get::<_,Option<String>>(0)).optional().map_err(|e|e.to_string())?;
                match draft {Some(session)=>session,None=>conn.query_row("SELECT session_id FROM chat_sessions WHERE document_key IS ?1 AND workspace_key IS ?2 AND deletion_state='active' ORDER BY updated_at DESC,session_id DESC LIMIT 1",params![target.document_key,target.workspace_key],|r|r.get(0)).optional().map_err(|e|e.to_string())?}
            }else{None}
        }else{None};
        let session=session.or(restored.as_deref());
        let session=session.map(|id|self.get_session(id)).transpose()?;
        if let (Some(target),Some(session))=(target,&session) {if target.document_key!=session.document_key || target.workspace_key!=session.workspace_key {return Err("会话目标归属不一致".into());}}
        let draft=target.map(|target|self.get_draft(target,session.as_ref().map(|s|s.session_id.as_str()))).transpose()?.flatten();
        let Some(session)=session else {return Ok(ConversationPage{session:None,turns:vec![],messages:vec![],draft,learning_actions:vec![],next_cursor:None});};
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let mut statement=conn.prepare("SELECT turn_id,session_id,ordinal,kind,question,current_request_id,created_at FROM conversation_turns WHERE session_id=?1 AND ordinal>?2 ORDER BY ordinal LIMIT 31").map_err(|e|e.to_string())?;
        let mut turns=statement.query_map(params![session.session_id,cursor.unwrap_or(0)],map_turn).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;let more=turns.len()>30;turns.truncate(30);drop(statement);drop(conn);
        let messages=self.get_session_messages(&session.session_id)?.into_iter().filter(|message|turns.iter().any(|turn|message.turn_id.as_deref()==Some(&turn.turn_id) && (turn.current_request_id==message.request_id || turn.kind=="LegacyMessages"))).collect();
        let conn=self.conn.lock().map_err(|e|e.to_string())?;
        let mut statement=conn.prepare("SELECT a.request_id,t.turn_id,a.learning_status,a.learning_error,a.learning_usage_json FROM request_attempts a JOIN conversation_turns t ON t.current_request_id=a.request_id WHERE t.session_id=?1 AND a.status='Completed' ORDER BY t.ordinal").map_err(|e|e.to_string())?;
        let rows=statement.query_map([&session.session_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let learning_actions=rows.into_iter().map(|(request,turn,status,error,usage)| {let usage=usage.map(|v|serde_json::from_str::<serde_json::Value>(&v).map_err(|e|e.to_string())).transpose()?;Ok(serde_json::json!({"requestId":request,"turnId":turn,"sessionId":session.session_id,"status":status,"error":error,"actualUsage":usage}))}).collect::<Result<Vec<_>,String>>()?;
        let next_cursor=if more {turns.last().map(|t|t.ordinal.to_string())}else{None};Ok(ConversationPage{session:Some(session),turns,messages,draft,learning_actions,next_cursor})
    }
}
