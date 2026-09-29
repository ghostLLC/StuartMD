// Empirical verification of SSE streaming chunk buffering & settings persistence concurrency

fn parse_sse_data_line(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with("data:") {
        return None;
    }
    let data = t[5..].trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    Some(data.to_string())
}

fn test_sse_done_dead_code() {
    println!("=== TEST 4.1: SSE '[DONE]' Dead Code Verification ===");

    let line = "data: [DONE]";
    let parsed = parse_sse_data_line(line);
    println!("  Input line: {:?}", line);
    println!("  Result of parse_sse_data_line: {:?}", parsed);

    // Roadmap P1-4 logic:
    let mut reached_done_block = false;
    if let Some(data) = parse_sse_data_line(line) {
        if data == "[DONE]" {
            reached_done_block = true;
        }
    }
    println!("  Did roadmap P1-4 reach 'if data == \"[DONE]\"'? {}", reached_done_block);
    if !reached_done_block {
        println!("  [-] CRITICAL BUG CONFIRMED: Roadmap P1-4 `if data == \"[DONE]\"` is 100% DEAD UNREACHABLE CODE!");
        println!("      Because `parse_sse_data_line` returns `None` for '[DONE]', the block is never entered!");
        println!("      The stream will hang until socket EOF or timeout instead of terminating cleanly on '[DONE]'!");
    }
}

fn test_utf8_chunk_splitting() {
    println!("\n=== TEST 4.2: UTF-8 Chunk Boundary Splitting ===");

    // Chinese characters: "你好世界"
    // "你": [0xE4, 0xBD, 0xA0]
    // "好": [0xE5, 0xA5, 0xBD]
    let full_text = "你好世界";
    let full_bytes = full_text.as_bytes();
    println!("  Original text: {}", full_text);
    println!("  Original UTF-8 bytes: {:02X?}", full_bytes);

    // Split across chunk boundary:
    // Chunk 1 gets first 2 bytes of "你" (0xE4, 0xBD)
    // Chunk 2 gets last byte of "你" (0xA0) + rest of bytes
    let chunk1 = &full_bytes[..2];
    let chunk2 = &full_bytes[2..];

    // Current StuartMD implementation (ai_chat.rs:678):
    let mut bad_buf = String::new();
    bad_buf.push_str(&String::from_utf8_lossy(chunk1));
    bad_buf.push_str(&String::from_utf8_lossy(chunk2));
    println!("  Decoded via current StuartMD logic (per-chunk from_utf8_lossy):");
    println!("    Result: {:?}", bad_buf);
    let contains_replacement = bad_buf.contains('\u{FFFD}');
    println!("    Contains corruption replacement char (\\u{{FFFD}})? {}", contains_replacement);
    if contains_replacement {
        println!("    [-] BUG CONFIRMED: Splitting across chunk boundaries corrupts UTF-8 text into '\\u{{FFFD}}'!");
    }

    // Proposed line-buffered logic:
    // With newline at end:
    let mut stream_bytes = full_bytes.to_vec();
    stream_bytes.push(b'\n');

    let chunk_a = &stream_bytes[..2];
    let chunk_b = &stream_bytes[2..];

    let mut byte_buf: Vec<u8> = Vec::new();
    let mut good_buf = String::new();

    // Feed chunk_a
    byte_buf.extend_from_slice(chunk_a);
    while let Some(pos) = byte_buf.iter().position(|&b| b == b'\n') {
        let line_bytes: Vec<u8> = byte_buf.drain(..=pos).collect();
        good_buf.push_str(&String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]));
    }
    // Feed chunk_b
    byte_buf.extend_from_slice(chunk_b);
    while let Some(pos) = byte_buf.iter().position(|&b| b == b'\n') {
        let line_bytes: Vec<u8> = byte_buf.drain(..=pos).collect();
        good_buf.push_str(&String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]));
    }
    println!("  Decoded via line-buffered byte accumulator:");
    println!("    Result: {:?}", good_buf);
    println!("    Match original? {}", good_buf == full_text);

    // Flaw in line-buffered logic: What if response ends without trailing '\n'?
    let mut unclosed_byte_buf = Vec::new();
    unclosed_byte_buf.extend_from_slice(b"data: {\"text\":\"final_word_no_newline\"}");
    // Read loop ends with Ok(0)...
    let mut unclosed_decoded = Vec::new();
    while let Some(pos) = unclosed_byte_buf.iter().position(|&b| b == b'\n') {
        unclosed_decoded.push(unclosed_byte_buf.drain(..=pos).collect::<Vec<_>>());
    }
    println!("  Flaw in roadmap P1-4 line-buffered logic:");
    println!("    Remaining bytes left in buffer at EOF (dropped): {:?}", String::from_utf8_lossy(&unclosed_byte_buf));
    if !unclosed_byte_buf.is_empty() {
        println!("    [-] FLAW CONFIRMED: Roadmap P1-4 drops trailing data if stream ends without '\\n'!");
    }
}

fn test_multi_process_settings_race() {
    println!("\n=== TEST 4.3: Multi-Process Settings Race Condition ===");
    println!("  Analysis of in-process Mutex<SETTINGS_LOCK>:");
    println!("  1. StuartMD allows multiple windows via `stuart_open_new_window` & `stuart_open_in_new_window`.");
    println!("  2. Each window runs in an independent OS process (Command::new(&exe).spawn()).");
    println!("  3. std::sync::Mutex<()> lives strictly within the virtual address space of a single process.");
    println!("  4. When Process A and Process B write to %APPDATA%\\StuartMD\\settings.json concurrently:");
    println!("     Neither process acquires the other's Mutex!");
    println!("     Both processes write to settings.json concurrently, causing last-writer-wins silent overwrite!");
    println!("  [-] ARCHITECTURAL DEFECT: In-process Mutex is insufficient for desktop multi-window architecture; requires Windows named mutex or file-level exclusive lock!");
}

fn main() {
    test_sse_done_dead_code();
    test_utf8_chunk_splitting();
    test_multi_process_settings_race();
}
