use super::pyramid::ContextPyramid;
use super::tokenizer::estimate_pyramid_tokens;

#[derive(Debug, PartialEq, Eq)]
pub enum BudgetState { S0Evaluate, S1CompressL4, S2PruneL3, S3SkeletonL2, S4ClampL1, S5EmitReady }

pub struct TokenBudgetStateMachine { pub max_input_tokens: usize, valid: bool }

impl TokenBudgetStateMachine {
    pub fn new(context_limit: usize, reserve_output: usize) -> Self {
        Self { max_input_tokens: context_limit.saturating_sub(reserve_output),
            valid: context_limit > 0 && reserve_output < context_limit }
    }

    pub fn execute(&self, mut pyramid: ContextPyramid) -> Result<ContextPyramid, String> {
        if !self.valid { return Err("InvalidTokenBudget：上下文长度及输出预留无效".into()); }
        pyramid.l3_rag_chunks.sort_by(|left,right| right.rrf_score.total_cmp(&left.rrf_score));
        while estimate_pyramid_tokens(&pyramid) > self.max_input_tokens {
            if pyramid.l3_rag_chunks.pop().is_some() { continue; }
            if let Some(document) = &mut pyramid.l2_document {
                if document.neighbors.pop().is_some() { continue; }
                if document.heading_outline.pop().is_some() { continue; }
            }
            if pyramid.l2_document.take().is_some() { continue; }
            if pyramid.l5_user_profile.take().is_some() { continue; }
            return Err(format!("ContextTooLarge：完整焦点和历史需要 {}，输入预算为 {}",estimate_pyramid_tokens(&pyramid),self.max_input_tokens));
        }
        Ok(pyramid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::pyramid::{FocusContext, UserProfileContext};

    #[test]
    fn project_audit_context_budget_is_enforced_for_profile() {
        let mut input = ContextPyramid::default();
        input.l5_user_profile = Some(UserProfileContext { domain_expertise:"知识".repeat(1000),
            preferred_tone:"明确".into(),terminology_glossary:vec![] });
        let machine = TokenBudgetStateMachine::new(800,300);
        let output = machine.execute(input).unwrap();
        assert!(estimate_pyramid_tokens(&output) <= machine.max_input_tokens);
    }

    #[test]
    fn full_focus_is_preserved_or_reports_context_too_large() {
        let mut input = ContextPyramid::default();
        let quote = "必须完整保留焦点及最新修正".repeat(300);
        input.l1_focus = Some(FocusContext { rel_path:"notes.md".into(),heading_path:None,
            start_line:Some(1),end_line:Some(100),quote:quote.clone() });
        assert_eq!(TokenBudgetStateMachine::new(20000,1000).execute(input.clone()).unwrap().l1_focus.unwrap().quote,quote);
        assert!(TokenBudgetStateMachine::new(800,300).execute(input).unwrap_err().starts_with("ContextTooLarge"));
    }

    #[test]
    fn invalid_budget_stops_before_assembly() {
        assert!(TokenBudgetStateMachine::new(0,0).execute(ContextPyramid::default()).is_err());
        assert!(TokenBudgetStateMachine::new(100,101).execute(ContextPyramid::default()).is_err());
    }
}
