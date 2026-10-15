// tauri/src-tauri/src/memory/models.rs
//! StuartMD Organic 3-Tier Memory Models & Chat Archive Entities

use serde::{Deserialize, Serialize};

/// Persistent chat session entity
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub session_id: String,
    pub title: String,
    pub workspace_root: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub message_count: usize,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub document_path: Option<String>,
    #[serde(default)]
    pub document_key: Option<String>,
    #[serde(default)]
    pub workspace_key: Option<String>,
    #[serde(default = "initial_version")]
    pub session_version: u64,
    #[serde(default)]
    pub deletion_state: String,
}

/// Message turn within a chat session
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatArchiveMessage {
    pub message_id: String,
    pub session_id: String,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    pub timestamp: u64,
    pub anchor_file: Option<String>,
    pub anchor_line: Option<usize>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default = "completed_status")]
    pub completion_status: String,
    #[serde(default)]
    pub source_hash: Option<String>,
    #[serde(default)]
    pub source_anchor: Option<serde_json::Value>,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub attempt_no: u64,
}

impl ChatArchiveMessage {
    pub fn provider_message(&self,preserve_reasoning:bool)->Result<crate::context::service::ChatMessage,String> {
        let mut message=if let Some(value)=self.source_anchor.as_ref().and_then(|anchor|anchor.get("assistantMessage")) {
            let message:crate::context::service::ChatMessage=serde_json::from_value(value.clone()).map_err(|e|e.to_string())?;
            if message.role!=self.role || message.content!=self.content {return Err("归档助手消息与正文不一致".into());}message
        }else {crate::context::service::ChatMessage::text(&self.role,&self.content)};
        if !preserve_reasoning {message.fields.clear();}
        Ok(message)
    }
}

/// Organic memory item supporting 3-tier lifecycle and Ebbinghaus evolution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrganicMemoryItem {
    pub memory_id: String,
    #[serde(default)]
    pub record_id: String,
    #[serde(default)]
    pub approval_kind: String,
    /// Tier 1: Workspace / Topic, Tier 2: Document Companion, Tier 3: Global User Cognitive
    pub tier: u8,
    /// Category: "decision" | "concept" | "preference" | "glossary"
    pub category: String,
    pub content: String,
    /// Model confidence [0.0, 1.0]
    pub confidence: f32,
    pub created_at: u64,
    pub last_accessed_at: u64,
    pub access_count: u32,
    /// Pinned items are immortal (beta = 2.0, never decayed or evicted)
    pub pinned: bool,
    #[serde(default = "global_scope")]
    pub scope: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub preference_key: Option<String>,
    #[serde(default = "initial_version")]
    pub version: u64,
    #[serde(default)]
    pub source_message_id: Option<String>,
    #[serde(default)]
    pub source_anchor: Option<serde_json::Value>,
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default)]
    pub superseded_by: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

fn completed_status() -> String { "Completed".to_owned() }
fn global_scope() -> String { "global".to_owned() }
fn initial_version() -> u64 { 1 }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationTarget {
    pub document_key: Option<String>,
    pub workspace_key: Option<String>,
    pub runtime_document_id: Option<String>,
    pub window_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationDraft {
    pub draft_id: String,
    pub target: ConversationTarget,
    pub session_id: Option<String>,
    pub question: String,
    pub scope: String,
    pub selection: Option<serde_json::Value>,
    pub reading_anchor: Option<serde_json::Value>,
    pub explicit_sources: Vec<serde_json::Value>,
    pub view_state: serde_json::Value,
    #[serde(default)]
    pub partial_confirmed: bool,
    #[serde(default)]
    pub partial_acknowledgement: Option<serde_json::Value>,
    pub draft_version: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestIntent {
    pub request_id: String,
    pub turn_id: Option<String>,
    pub session_id: Option<String>,
    pub expected_session_version: u64,
    #[serde(default)]
    pub draft_id: Option<String>,
    pub draft_version: u64,
    pub target: ConversationTarget,
    pub question: String,
    pub scope: String,
    pub selection: Option<serde_json::Value>,
    pub reading_anchor: Option<serde_json::Value>,
    pub explicit_sources: Vec<serde_json::Value>,
    pub settings_revision: String,
    #[serde(default)]
    pub editor_revision: u64,
    #[serde(default)]
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub turn_id: String,
    pub session_id: String,
    pub ordinal: u64,
    pub kind: String,
    pub question: String,
    pub current_request_id: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedTurn {
    pub session: ChatSession,
    pub turn: ConversationTurn,
    pub attempt_no: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFilter {
    pub scope: String,
    pub document_key: Option<String>,
    pub workspace_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[serde(flatten)]
    pub session: ChatSession,
    pub recent_question: Option<String>,
    pub completion_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> { pub items: Vec<T>, pub next_cursor: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPage {
    pub session: Option<ChatSession>,
    pub turns: Vec<ConversationTurn>,
    pub messages: Vec<ChatArchiveMessage>,
    pub draft: Option<ConversationDraft>,
    pub learning_actions: Vec<serde_json::Value>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEdit {
    pub content: String,
    pub category: String,
    pub scope: String,
    pub workspace_key: Option<String>,
    pub document_key: Option<String>,
    pub preference_key: Option<String>,
    pub pinned: bool,
    pub source_message_id: Option<String>,
    pub source_request_id: Option<String>,
    pub source_anchor: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProposal {
    pub proposal_id: String,
    pub source_request_id: String,
    pub source_message_id: Option<String>,
    pub source_anchor: Option<serde_json::Value>,
    pub content: String,
    pub category: String,
    pub scope: String,
    pub workspace_key: Option<String>,
    pub document_key: Option<String>,
    pub proposal_version: u64,
    pub status: String,
}

/// Search hit across messages or memories
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchHit {
    pub entity_id: String,
    pub entity_type: String, // "message" | "organic_memory"
    pub title_or_role: String,
    pub snippet: String,
    pub timestamp: u64,
    pub rank_score: f32,
}
