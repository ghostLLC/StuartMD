use super::model_spec::ProviderModelSpec;
use super::service::{check_final_budget, count_local, ChatMessage};
use serde_json::json;
use std::path::PathBuf;

fn provider(resource: &str) -> ProviderModelSpec {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/tokenizers").join(resource);
    let manifest: serde_json::Value = serde_json::from_str(include_str!("../../../../resources/tokenizers-manifest.json")).unwrap();
    let archive = manifest["archives"].as_array().unwrap().iter().find(|entry| entry["id"] == resource).unwrap();
    ProviderModelSpec::from_provider(&json!({"id":"deepseek","model":"deepseek-flash","token_counting":{
        "method":"local-tokenizer","context_window":1000000,"max_output_tokens":393216,"protocol_reserve":256,
        "tokenizer_artifact":directory.join("tokenizer.json"),"tokenizer_hash":archive["files"]["tokenizer.json"],
        "chat_template":directory.join("tokenizer_config.json"),"chat_template_hash":archive["files"]["tokenizer_config.json"],
        "bos_token":"<｜begin▁of▁sentence｜>","eos_token":"<｜end▁of▁sentence｜>"
    }})).unwrap()
}

#[test]
fn official_tokenizer_templates_count_chinese_emoji_and_completed_reasoning() {
    let messages = vec![
        ChatMessage { role:"system".into(),content:"完整解释公开样本。".into() },
        ChatMessage { role:"user".into(),content:"中文与 English 😀，保留全部选区。".into() },
        ChatMessage { role:"assistant".into(),content:"<think>处理公开资料</think>已经完成。".into() },
        ChatMessage { role:"user".into(),content:"最新更正：保留否定关系。".into() },
    ];
    for resource in ["deepseek-v3", "deepseek-v4"] {
        let count = count_local(&provider(resource), &messages).unwrap();
        assert!(count > 20 && count < 100, "{resource}: {count}");
    }
}

#[test]
fn counting_configuration_rejects_nonfinite_reserve_and_output_above_window() {
    let mut spec = provider("deepseek-v4");
    spec.estimate_safety_ratio = f64::NAN;
    assert!(spec.validate().is_err());
    spec.estimate_safety_ratio = 0.0;
    spec.max_output_tokens = spec.context_window + 1;
    assert!(spec.validate().is_err());
}

#[test]
fn final_message_budget_includes_requested_output_and_protocol_reserve() {
    check_final_budget(300, 100, 100, 500).unwrap();
    assert!(check_final_budget(301, 100, 100, 500).unwrap_err().starts_with("ContextTooLarge"));
    assert!(check_final_budget(1, 1, 0, 0).is_err());
    assert!(check_final_budget(usize::MAX, 1, 1, usize::MAX).is_err());
}
