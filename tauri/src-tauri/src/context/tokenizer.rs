// tauri/src-tauri/src/context/tokenizer.rs
//! High-Performance Offline Token Estimator & Unicode-Safe Boundary Pruner

use super::pyramid::ContextPyramid;

/// Fast offline token estimation for multilingual mixed text (CJK, Latin, Code)
pub fn estimate_text_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let mut tokens: usize = 0;
    let mut latin_char_seq: usize = 0;

    for ch in text.chars() {
        let u = ch as u32;
        // CJK Unified Ideographs & Hangul / Kana
        if (0x4E00..=0x9FFF).contains(&u)
            || (0x3400..=0x4DBF).contains(&u)
            || (0x20000..=0x2A6DF).contains(&u)
            || (0x3040..=0x30FF).contains(&u)
            || (0xAC00..=0xD7AF).contains(&u)
        {
            if latin_char_seq > 0 {
                tokens += (latin_char_seq + 3) / 4;
                latin_char_seq = 0;
            }
            tokens += 2; // ~1.5 - 2.0 tokens per CJK character in BPE
        } else if ch.is_whitespace() {
            if latin_char_seq > 0 {
                tokens += (latin_char_seq + 3) / 4;
                latin_char_seq = 0;
            }
        } else if ch.is_ascii_punctuation() {
            if latin_char_seq > 0 {
                tokens += (latin_char_seq + 3) / 4;
                latin_char_seq = 0;
            }
            tokens += 1;
        } else {
            // ASCII alphanumeric / Latin script
            latin_char_seq += 1;
        }
    }

    if latin_char_seq > 0 {
        tokens += (latin_char_seq + 3) / 4;
    }

    tokens.max(1)
}

/// Computes cumulative estimated tokens across all 5 levels of the context pyramid
pub fn estimate_pyramid_tokens(pyramid: &ContextPyramid) -> usize {
    let mut total = 0;

    // L1
    if let Some(ref focus) = pyramid.l1_focus {
        total += estimate_text_tokens(&focus.quote);
        if let Some(ref h) = focus.heading_path {
            total += estimate_text_tokens(h);
        }
    }

    // L2
    if let Some(ref doc) = pyramid.l2_document {
        for heading in &doc.heading_outline {
            total += estimate_text_tokens(heading);
        }
        for neighbor in &doc.neighbors {
            total += estimate_text_tokens(neighbor);
        }
    }

    // L3
    for chunk in &pyramid.l3_rag_chunks {
        total += estimate_text_tokens(&chunk.content);
        total += estimate_text_tokens(&chunk.heading_path);
    }

    // L4
    for turn in &pyramid.l4_conversation {
        total += estimate_text_tokens(&turn.content);
    }

    // L5
    if let Some(ref user) = pyramid.l5_user_profile {
        total += estimate_text_tokens(&user.domain_expertise);
        total += estimate_text_tokens(&user.preferred_tone);
        for term in &user.terminology_glossary {
            total += estimate_text_tokens(term);
        }
    }

    total
}

/// Unicode-safe substring pruner: takes `target_chars` without UTF-8 boundary panics (DEF-01)
pub fn safe_unicode_take(s: &str, target_chars: usize) -> &str {
    match s.char_indices().nth(target_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_multilingual_token_estimation() {
        let cjk = "这是一个关于人工智能和深度学习的测试文档";
        let tokens = estimate_text_tokens(cjk);
        assert!(tokens >= 20 && tokens <= 50);

        let english = "This is a simple English sentence for token estimation.";
        let en_tokens = estimate_text_tokens(english);
        assert!(en_tokens >= 8 && en_tokens <= 18);
    }

    #[test]
    fn test_safe_unicode_take_boundary() {
        let text = "你好，世界！Rust 语言";
        let clamped = safe_unicode_take(text, 5);
        assert_eq!(clamped, "你好，世界");
    }
}
