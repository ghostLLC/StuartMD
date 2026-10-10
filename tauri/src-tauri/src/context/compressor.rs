use super::pyramid::ConversationTurn;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SummarySource { pub message_id: String, pub quote: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SummaryEntry { pub text: String, pub sources: Vec<SummarySource> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct StructuredSummary {
    pub decisions: Vec<SummaryEntry>, pub constraints: Vec<SummaryEntry>,
    pub corrections: Vec<SummaryEntry>, pub open_questions: Vec<SummaryEntry>,
}

impl StructuredSummary {
    pub fn validate(&self, originals: &HashMap<String,String>) -> Result<(), String> {
        for entry in self.decisions.iter().chain(&self.constraints).chain(&self.corrections).chain(&self.open_questions) {
            if entry.text.trim().is_empty() || entry.sources.is_empty() { return Err("摘要条目缺少正文或来源".into()); }
            for source in &entry.sources {
                let original = originals.get(&source.message_id).ok_or("摘要引用的消息不存在")?;
                if source.quote.trim().is_empty() || !original.contains(&source.quote) {
                    return Err("摘要引用与原始消息不相符".into());
                }
            }
        }
        Ok(())
    }
}

pub fn fold_single_turn_spike(content: &str, _head_tokens: usize, _tail_tokens: usize) -> String { content.to_owned() }
pub fn compress_conversation(turns: &[ConversationTurn]) -> Vec<ConversationTurn> { turns.to_vec() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_helpers_preserve_complete_original_messages() {
        let huge = "初始决定，随后撤销决定并使用最新修正。".repeat(500);
        assert_eq!(fold_single_turn_spike(&huge,100,100),huge);
        let turns = vec![ConversationTurn {role:"user".into(),content:huge,compressed:false}];
        assert_eq!(compress_conversation(&turns),turns);
    }
    #[test]
    fn structured_summary_requires_actual_source_quote() {
        let mut originals = HashMap::new();
        originals.insert("message-one".into(),"使用最新修正，输出完整正文。".into());
        let mut summary = StructuredSummary { decisions:vec![],constraints:vec![SummaryEntry {
            text:"输出完整正文".into(),sources:vec![SummarySource {message_id:"message-one".into(),quote:"输出完整正文".into()}]
        }],corrections:vec![],open_questions:vec![] };
        summary.validate(&originals).unwrap();
        summary.constraints[0].sources[0].quote = "无来源内容".into();
        assert!(summary.validate(&originals).is_err());
    }
}
