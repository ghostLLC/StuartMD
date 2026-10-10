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
}

/// Organic memory item supporting 3-tier lifecycle and Ebbinghaus evolution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrganicMemoryItem {
    pub memory_id: String,
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
