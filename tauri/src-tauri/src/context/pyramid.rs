// tauri/src-tauri/src/context/pyramid.rs
//! StuartMD 5-Level Context Pyramid Data Structures (L1 ~ L5)

use serde::{Deserialize, Serialize};

/// L1: Current user focus selection / active block (100% preservation weight)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusContext {
    pub rel_path: String,
    pub heading_path: Option<String>,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub quote: String,
}

/// L2: Active document structural skeleton and immediate neighborhood
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocStructureContext {
    pub rel_path: String,
    pub heading_outline: Vec<String>,
    pub neighbors: Vec<String>,
}

/// L3: Cross-document RAG retrieved chunks (ordered descending by RRF score)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedChunk {
    pub chunk_id: String,
    pub rel_path: String,
    pub heading_path: String,
    pub content: String,
    pub rrf_score: f32,
}

/// L4: Conversation history turn (eligible for structured semantic compression)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    pub compressed: bool,
}

/// L5: Long-term user cognitive profile & professional preferences
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileContext {
    pub domain_expertise: String,
    pub preferred_tone: String,
    pub terminology_glossary: Vec<String>,
}

/// Unified 5-Level Context Pyramid
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextPyramid {
    /// L1: Active reading selection / block
    pub l1_focus: Option<FocusContext>,
    /// L2: Document outline and surrounding paragraphs
    pub l2_document: Option<DocStructureContext>,
    /// L3: Cross-document knowledge slices
    pub l3_rag_chunks: Vec<RetrievedChunk>,
    /// L4: Conversation history turns
    pub l4_conversation: Vec<ConversationTurn>,
    /// L5: User cognitive profile
    pub l5_user_profile: Option<UserProfileContext>,
}

impl Default for ContextPyramid {
    fn default() -> Self {
        Self {
            l1_focus: None,
            l2_document: None,
            l3_rag_chunks: Vec::new(),
            l4_conversation: Vec::new(),
            l5_user_profile: None,
        }
    }
}
