// Empirical Stress Harness for P1-4 (SSE UTF-8 Multi-byte Chunk Split & [DONE] Termination)
use std::io::{self, Read};

pub fn parse_sse_data_line(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with("data:") {
        return None;
    }
    let data = t[5..].trim();
    if data.is_empty() {
        return None;
    }
    Some(data.to_string())
}

/// Simulated mock reader that yields data in fixed or variable chunk sizes
struct ChunkedStreamReader {
    data: Vec<u8>,
    cursor: usize,
    chunk_size: usize,
    reads_after_done: usize,
    infinite_after_done: bool,
    saw_done: bool,
}

impl ChunkedStreamReader {
    fn new(data: Vec<u8>, chunk_size: usize) -> Self {
        Self {
            data,
            cursor: 0,
            chunk_size,
            reads_after_done: 0,
            infinite_after_done: false,
            saw_done: false,
        }
    }
}

impl Read for ChunkedStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cursor >= self.data.len() {
            if self.infinite_after_done {
                self.reads_after_done += 1;
                // If caller didn't terminate on [DONE], it will keep reading dummy data
                let fill_len = std::cmp::min(buf.len(), 512);
                buf[..fill_len].fill(b'X');
                return Ok(fill_len);
            }
            return Ok(0);
        }

        let remaining = self.data.len() - self.cursor;
        let to_read = std::cmp::min(remaining, std::cmp::min(buf.len(), self.chunk_size));
        buf[..to_read].copy_from_slice(&self.data[self.cursor..self.cursor + to_read]);
        self.cursor += to_read;
        Ok(to_read)
    }
}

/// Extract content from standard OpenAI-like delta payload
fn extract_delta_text(json_str: &str) -> String {
    // Quick parse for "content":"..."
    if let Some(idx) = json_str.find("\"content\":\"") {
        let rest = &json_str[idx + 11..];
        if let Some(end_idx) = rest.find('"') {
            return rest[..end_idx].to_string();
        }
    }
    String::new()
}

/// Run StuartMD's exact SSE streaming loop from `ai_chat.rs:725-833`
fn run_stuart_sse_loop<R: Read>(mut reader: R) -> (String, bool, usize) {
    let mut byte_buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    const MAX_LINE_BYTES: usize = 1024 * 1024;
    let mut acc = String::new();
    let mut finished_ok = false;
    let mut err_msg = String::new();
    let mut total_chunks_read = 0;

    loop {
        match reader.read(&mut chunk) {
            Ok(0) => {
                if !byte_buf.is_empty() {
                    let clean_slice = if byte_buf.ends_with(b"\r\n") {
                        &byte_buf[..byte_buf.len() - 2]
                    } else if byte_buf.ends_with(b"\n") {
                        &byte_buf[..byte_buf.len() - 1]
                    } else {
                        &byte_buf[..]
                    };
                    let line = String::from_utf8_lossy(clean_slice);
                    if let Some(data) = parse_sse_data_line(&line) {
                        if data == "[DONE]" {
                            finished_ok = true;
                        } else {
                            let piece = extract_delta_text(&data);
                            if !piece.is_empty() {
                                acc.push_str(&piece);
                            }
                        }
                    }
                    byte_buf.clear();
                }
                finished_ok = finished_ok || !acc.is_empty() || err_msg.is_empty();
                break;
            }
            Ok(n) => {
                total_chunks_read += 1;
                byte_buf.extend_from_slice(&chunk[..n]);

                if byte_buf.len() > MAX_LINE_BYTES {
                    byte_buf.clear();
                    break;
                }

                while let Some(pos) = byte_buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = byte_buf.drain(..=pos).collect();
                    let clean_slice = if line_bytes.ends_with(b"\r\n") {
                        &line_bytes[..line_bytes.len() - 2]
                    } else if line_bytes.ends_with(b"\n") {
                        &line_bytes[..line_bytes.len() - 1]
                    } else {
                        &line_bytes[..]
                    };

                    let line = String::from_utf8_lossy(clean_slice);
                    if let Some(data) = parse_sse_data_line(&line) {
                        if data == "[DONE]" {
                            finished_ok = true;
                            break;
                        }
                        let piece = extract_delta_text(&data);
                        if !piece.is_empty() {
                            acc.push_str(&piece);
                        }
                    }
                }
                if err_msg.is_empty() && finished_ok {
                    break;
                }
                if !err_msg.is_empty() {
                    break;
                }
            }
            Err(e) => {
                if acc.is_empty() {
                    err_msg = e.to_string();
                } else {
                    finished_ok = true;
                }
                break;
            }
        }
    }

    (acc, finished_ok, total_chunks_read)
}

fn test_p1_4_utf8_boundary_splits() {
    println!("============================================================");
    println!(">>> TARGET 5.1: UTF-8 Multi-byte Chunk Boundary Splitting");
    println!("============================================================");

    // 3-byte Chinese characters: "床前明月光疑是地上霜"
    // 4-byte emojis and rare characters: "𠮷野家🚀🌟🎉"
    let test_corpus = [
        "床前明月光，疑是地上霜。举头望明月，低头思故乡。",
        "特殊扩展字：𠮷野家，𪚥，𠀀；表情：🚀🌟🎉🔥💯",
        "StuartMD 智能伴读助手深度测试：高吞吐并发数据流，无乱码，无丢字。",
    ];

    let full_text = test_corpus.join(" --- ");
    println!("Test Source Text Length: {} chars ({} bytes)", full_text.chars().count(), full_text.len());

    // We will test various chunk sizes: 1, 2, 3, 4, 5, 7, 13, 2047, 2048, 2049 bytes
    let test_chunk_sizes = [1, 2, 3, 4, 7, 13, 31, 1024, 2047, 2048, 2049, 4096];

    for &chunk_size in &test_chunk_sizes {
        // Construct SSE stream where each sentence is a delta
        let mut raw_stream = Vec::new();
        for ch in full_text.chars() {
            let s = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\n", ch);
            raw_stream.extend_from_slice(s.as_bytes());
        }
        raw_stream.extend_from_slice(b"data: [DONE]\n\n");

        let reader = ChunkedStreamReader::new(raw_stream, chunk_size);
        let (decoded, finished_ok, chunks_read) = run_stuart_sse_loop(reader);

        let corrupt_count = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
        let exact_match = decoded == full_text;

        println!(
            "  Chunk size {:4} bytes -> Chunks: {:4}, Finished [DONE]: {}, \\u{{FFFD}} count: {}, Match: {}",
            chunk_size, chunks_read, finished_ok, corrupt_count, exact_match
        );

        assert!(finished_ok, "Stream did not report finished_ok on [DONE]!");
        assert_eq!(corrupt_count, 0, "Corrupt replacement characters detected!");
        assert!(exact_match, "Decoded text does not match original text!");
    }

    // Adversarial alignment test:
    // Place a 3-byte char ('中' = [0xE4, 0xB8, 0xAD]) split across 2048 boundary:
    // chunk 1 has 2047 bytes, ending with [0xE4]
    // chunk 2 has rest of line including [0xB8, 0xAD]
    println!("\n[Adversarial Alignment Test] Split 3-byte and 4-byte characters exactly at offset 2047 and 2048...");
    {
        let prefix = "A".repeat(2040); // 2040 bytes
        // "data: {"choices":[{"delta":{"content":""
        // prefix takes line to ~2045
        // We will carefully craft a line such that byte 2047 is byte 1 of '中'
        let mut line = Vec::new();
        line.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"");
        // Pad with 'X' until len is 2047
        while line.len() < 2047 {
            line.push(b'X');
        }
        // Now at index 2047, put '中' = [0xE4, 0xB8, 0xAD]
        line.extend_from_slice("中".as_bytes());
        // And put 4-byte '🚀' = [0xF0, 0x9F, 0x9A, 0x80]
        line.extend_from_slice("🚀".as_bytes());
        line.extend_from_slice(b"\"}}]}\n\n");
        line.extend_from_slice(b"data: [DONE]\n\n");

        let reader = ChunkedStreamReader::new(line, 2048);
        let (decoded, finished_ok, chunks_read) = run_stuart_sse_loop(reader);
        assert!(finished_ok);
        assert!(!decoded.contains('\u{FFFD}'));
        assert!(decoded.contains('中'));
        assert!(decoded.contains('🚀'));
        println!("  Exact boundary 2047/2048 split: PASSED (contains '中' and '🚀', zero \\u{{FFFD}})");
    }

    println!("[+] P1-4 UTF-8 MULTI-BYTE CHUNK BOUNDARY SPLIT: PASSED 100%");
}

fn test_p1_4_done_immediate_termination() {
    println!("\n============================================================");
    println!(">>> TARGET 5.2: Immediate Stream Termination on [DONE]");
    println!("============================================================");

    // Construct stream with [DONE], followed by trailing poison data
    let mut raw_stream = Vec::new();
    raw_stream.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"First Message\"}}]}\n\n");
    raw_stream.extend_from_slice(b"data: [DONE]\n\n");
    // Poison data after [DONE]
    raw_stream.extend_from_slice(b"data: {\"choices\":[{\"delta\":{\"content\":\"POISON DO NOT READ\"}}]}\n\n");

    let mut reader = ChunkedStreamReader::new(raw_stream, 32);
    reader.infinite_after_done = true; // Simulates hanging or infinite connection after [DONE]

    let (decoded, finished_ok, chunks_read) = run_stuart_sse_loop(&mut reader);

    println!("  Decoded Text: {:?}", decoded);
    println!("  Finished OK: {}", finished_ok);
    println!("  Total chunks read before loop exited: {}", chunks_read);
    println!("  Did caller read after [DONE]? reads_after_done = {}", reader.reads_after_done);
    println!("  Contains poison text? {}", decoded.contains("POISON"));

    assert!(finished_ok, "Stream did not terminate with finished_ok!");
    assert_eq!(decoded, "First Message", "Stream read past [DONE]!");
    assert!(!decoded.contains("POISON"), "Poison text after [DONE] was read!");
    assert_eq!(reader.reads_after_done, 0, "Loop hung or continued reading after [DONE]!");

    println!("[+] P1-4 IMMEDIATE TERMINATION ON [DONE]: PASSED 100%");
}

fn main() {
    test_p1_4_utf8_boundary_splits();
    test_p1_4_done_immediate_termination();

    println!("\n############################################################");
    println!("# P1-4 EMPIRICAL VERIFICATION COMPLETE: ALL PASS           #");
    println!("############################################################");
}
