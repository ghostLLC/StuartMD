// tauri/src-tauri/src/context/budget.rs
//! 6-State Token Budget Allocation State Machine
//! Implements DEF-01, DEF-02, and DEF-07

use super::compressor::{compress_conversation, fold_single_turn_spike};
use super::pyramid::ContextPyramid;
use super::tokenizer::{estimate_pyramid_tokens, estimate_text_tokens, safe_unicode_take};

#[derive(Debug, PartialEq, Eq)]
pub enum BudgetState {
    S0Evaluate,
    S1CompressL4,
    S2PruneL3,
    S3SkeletonL2,
    S4ClampL1,
    S5EmitReady,
}

pub struct TokenBudgetStateMachine {
    pub max_input_tokens: usize,
}

impl TokenBudgetStateMachine {
    pub fn new(context_limit: usize, reserve_output: usize) -> Self {
        Self {
            max_input_tokens: context_limit.saturating_sub(reserve_output),
        }
    }

    pub fn execute(&self, mut pyramid: ContextPyramid) -> ContextPyramid {
        let mut state = BudgetState::S0Evaluate;

        loop {
            let current_tokens = estimate_pyramid_tokens(&pyramid);

            match state {
                BudgetState::S0Evaluate => {
                    if current_tokens <= self.max_input_tokens {
                        state = BudgetState::S5EmitReady;
                    } else {
                        state = BudgetState::S1CompressL4;
                    }
                }
                BudgetState::S1CompressL4 => {
                    log::info!("[Budget StateMachine] Entering S1: Compressing L4 conversation history...");
                    // DEF-07: Single-turn spike protection
                    for turn in &mut pyramid.l4_conversation {
                        let turn_tokens = estimate_text_tokens(&turn.content);
                        if turn_tokens > 2000 {
                            log::warn!(
                                "[Budget StateMachine] Single-turn spike detected ({} tokens). Folding turn content...",
                                turn_tokens
                            );
                            turn.content = fold_single_turn_spike(&turn.content, 800, 1200);
                        }
                    }
                    pyramid.l4_conversation = compress_conversation(&pyramid.l4_conversation);

                    if estimate_pyramid_tokens(&pyramid) <= self.max_input_tokens {
                        state = BudgetState::S5EmitReady;
                    } else {
                        state = BudgetState::S2PruneL3;
                    }
                }
                BudgetState::S2PruneL3 => {
                    log::info!("[Budget StateMachine] Entering S2: Pruning lowest RRF RAG chunks...");
                    // Prune lowest scored chunks until budget is met or floor of 2 chunks reached
                    while pyramid.l3_rag_chunks.len() > 2
                        && estimate_pyramid_tokens(&pyramid) > self.max_input_tokens
                    {
                        pyramid.l3_rag_chunks.pop();
                    }

                    if estimate_pyramid_tokens(&pyramid) <= self.max_input_tokens {
                        state = BudgetState::S5EmitReady;
                    } else {
                        state = BudgetState::S3SkeletonL2;
                    }
                }
                BudgetState::S3SkeletonL2 => {
                    log::info!("[Budget StateMachine] Entering S3: Degrading L2 to pure outline skeleton...");
                    if let Some(ref mut doc_ctx) = pyramid.l2_document {
                        doc_ctx.neighbors.clear();
                    }

                    if estimate_pyramid_tokens(&pyramid) <= self.max_input_tokens {
                        state = BudgetState::S5EmitReady;
                    } else {
                        state = BudgetState::S4ClampL1;
                    }
                }
                BudgetState::S4ClampL1 => {
                    log::warn!("[Budget StateMachine] Entering S4: Force clamping huge L1 selection safely!");
                    let total_tokens = estimate_pyramid_tokens(&pyramid);
                    if let Some(ref mut focus) = pyramid.l1_focus {
                        let l1_tokens = estimate_text_tokens(&focus.quote);
                        let other_tokens = total_tokens.saturating_sub(l1_tokens);
                        let budget_for_l1 = self.max_input_tokens.saturating_sub(other_tokens);
                        let target_l1_tokens = budget_for_l1.max(100);

                        let mut char_limit = target_l1_tokens;
                        while char_limit > 10
                            && estimate_text_tokens(safe_unicode_take(&focus.quote, char_limit)) > target_l1_tokens
                        {
                            char_limit = (char_limit * 3 / 4).max(10);
                        }

                        if focus.quote.chars().count() > char_limit {
                            let clamped = safe_unicode_take(&focus.quote, char_limit);
                            focus.quote = format!("{}\n...[选区内容过长，已保留关键头部]", clamped);
                        }
                    }
                    state = BudgetState::S5EmitReady;
                }
                BudgetState::S5EmitReady => {
                    log::info!(
                        "[Budget StateMachine] Context assembled successfully within budget: {} tokens (limit={})",
                        current_tokens,
                        self.max_input_tokens
                    );
                    break;
                }
            }
        }

        pyramid
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::pyramid::{ConversationTurn, FocusContext, RetrievedChunk};

    #[test]
    fn test_budget_state_machine_pruning_and_clamping() {
        let mut pyramid = ContextPyramid::default();
        pyramid.l1_focus = Some(FocusContext {
            rel_path: "large_doc.md".to_string(),
            heading_path: Some("# Section".to_string()),
            start_line: Some(1),
            end_line: Some(100),
            quote: "这是一个很长的焦点选区内容。".repeat(300),
        });

        for i in 0..10 {
            pyramid.l3_rag_chunks.push(RetrievedChunk {
                chunk_id: format!("chunk_{}", i),
                rel_path: "ref.md".to_string(),
                heading_path: "# Ref".to_string(),
                content: format!("Knowledge content snippet number {}", i),
                rrf_score: (10 - i) as f32 / 10.0,
            });
        }

        for i in 0..6 {
            pyramid.l4_conversation.push(ConversationTurn {
                role: if i % 2 == 0 { "user" } else { "assistant" }.to_string(),
                content: format!("Message turn {}", i),
                compressed: false,
            });
        }

        // Limit budget strictly to 500 tokens
        let sm = TokenBudgetStateMachine::new(800, 300); // 500 tokens budget
        let pruned = sm.execute(pyramid);

        let final_tokens = estimate_pyramid_tokens(&pruned);
        assert!(final_tokens <= 550);
        assert!(pruned.l1_focus.is_some());
    }
}
