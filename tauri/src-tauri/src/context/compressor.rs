// tauri/src-tauri/src/context/compressor.rs
//! Tri-Part Conversation Compressor & Single-Turn Spike Protection (DEF-07)

use super::pyramid::ConversationTurn;
use super::tokenizer::safe_unicode_take;

/// Folds gigantic single-turn pastes (>2000 tokens) preserving informative head and tail (DEF-07)
pub fn fold_single_turn_spike(content: &str, head_tokens: usize, tail_tokens: usize) -> String {
    let char_count = content.chars().count();
    let head_chars = head_tokens * 2;
    let tail_chars = tail_tokens * 2;

    if char_count <= head_chars + tail_chars {
        return content.to_string();
    }

    let head: String = content.chars().take(head_chars).collect();
    let tail: String = content.chars().skip(char_count - tail_chars).collect();

    format!(
        "{}\n\n...[单轮长文本突增已自动折叠：已隐藏中间冗余内容，保留首尾关键段落]...\n\n{}",
        head, tail
    )
}

/// Structured semantic compression: keeps initial user intent (Turn 1) and recent turns (last 2),
/// folding intermediate conversation history into a concise semantic summary.
pub fn compress_conversation(turns: &[ConversationTurn]) -> Vec<ConversationTurn> {
    if turns.len() <= 3 {
        return turns.to_vec();
    }

    let mut result = Vec::new();

    // 1. Keep the very first turn (foundational query & framing)
    result.push(turns[0].clone());

    // 2. Aggregate intermediate turns (from 1 to N-2) into structured summary
    let intermediate_slice = &turns[1..turns.len() - 2];
    let mut topics = Vec::new();

    for (idx, turn) in intermediate_slice.iter().enumerate() {
        let snippet = safe_unicode_take(&turn.content, 60);
        let cleaned_snippet = snippet.replace('\n', " ").trim().to_string();
        topics.push(format!("{}. [{}] {}", idx + 1, turn.role, cleaned_snippet));
    }

    let summary_content = format!(
        "[前文多轮历史共识与讨论脉络提炼 (已压缩 {} 轮历史)]:\n{}",
        intermediate_slice.len(),
        topics.join("\n")
    );

    result.push(ConversationTurn {
        role: "system".to_string(),
        content: summary_content,
        compressed: true,
    });

    // 3. Keep the most recent 2 turns completely uncompressed
    let recent_slice = &turns[turns.len() - 2..];
    for turn in recent_slice {
        result.push(turn.clone());
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fold_single_turn_spike() {
        let huge_text = "A".repeat(5000);
        let folded = fold_single_turn_spike(&huge_text, 100, 100);
        assert!(folded.contains("单轮长文本突增已自动折叠"));
        assert!(folded.len() < 1000);
    }

    #[test]
    fn test_compress_conversation_intermediate_folding() {
        let mut turns = Vec::new();
        turns.push(ConversationTurn {
            role: "user".to_string(),
            content: "First turn: What is transformer?".to_string(),
            compressed: false,
        });
        for i in 1..=5 {
            turns.push(ConversationTurn {
                role: if i % 2 == 1 { "assistant" } else { "user" }.to_string(),
                content: format!("Intermediate message {}", i),
                compressed: false,
            });
        }
        turns.push(ConversationTurn {
            role: "assistant".to_string(),
            content: "Recent reply".to_string(),
            compressed: false,
        });
        turns.push(ConversationTurn {
            role: "user".to_string(),
            content: "Final follow-up question".to_string(),
            compressed: false,
        });

        assert_eq!(turns.len(), 8);
        let compressed = compress_conversation(&turns);

        // Turn 0 + 1 summary turn + 2 recent turns = 4 turns
        assert_eq!(compressed.len(), 4);
        assert_eq!(compressed[0].content, turns[0].content);
        assert!(compressed[1].compressed);
        assert_eq!(compressed[2].content, "Recent reply");
        assert_eq!(compressed[3].content, "Final follow-up question");
    }
}
