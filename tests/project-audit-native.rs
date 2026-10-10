#[path = "../tauri/src-tauri/src/context/pyramid.rs"]
pub mod pyramid;
#[path = "../tauri/src-tauri/src/context/tokenizer.rs"]
pub mod tokenizer;
#[path = "../tauri/src-tauri/src/context/compressor.rs"]
pub mod compressor;
#[path = "../tauri/src-tauri/src/context/budget.rs"]
pub mod budget;
#[path = "../tauri/src-tauri/src/memory/models.rs"]
pub mod models;
#[path = "../tauri/src-tauri/src/memory/evolution.rs"]
pub mod evolution;
#[path = "../tauri/src-tauri/src/memory/sqlite_archive.rs"]
pub mod sqlite_archive;
#[path = "../tauri/src-tauri/src/rag/fts.rs"]
pub mod fts;

pub mod context {
    pub use crate::{budget, compressor, pyramid, tokenizer};
    pub use crate::tokenizer::safe_unicode_take;
}

pub mod rag {
    pub use crate::fts::escape_fts5_query;
}

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn audit_database(name: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "stuart-project-audit-{}-{}-{}", name, std::process::id(), stamp
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory.join("archive.sqlite3")
}

#[test]
fn project_audit_context_budget_is_enforced_for_profile() {
    let mut input = pyramid::ContextPyramid::default();
    input.l5_user_profile = Some(pyramid::UserProfileContext {
        domain_expertise: "知识".repeat(1000),
        preferred_tone: "明确".to_owned(),
        terminology_glossary: Vec::new(),
    });
    let machine = budget::TokenBudgetStateMachine::new(800, 300);
    let output = machine.execute(input);
    let actual = tokenizer::estimate_pyramid_tokens(&output);
    println!("context_profile_budget: actual={}, limit={}", actual, machine.max_input_tokens);
    assert!(actual <= machine.max_input_tokens, "上下文超过输入预算");
}

#[test]
fn project_audit_two_sessions_can_be_created_in_one_second() {
    let path = audit_database("session");
    let archive = sqlite_archive::MemoryArchiveStorage::open(&path).unwrap();
    // 使用实际时钟，将两个数据库操作安排在同一个自然秒内。
    while SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_millis() > 100 {
        std::thread::sleep(Duration::from_millis(5));
    }
    let first = archive.create_session("阅读讨论", None).unwrap();
    let second = archive.create_session("术语讨论", None);
    println!("session_creation: first={}, second={:?}, database={}",
        first.session_id, second, path.display());
    let second = second.expect("连续创建会话应当成功");
    assert_ne!(first.session_id, second.session_id);
    assert_eq!(archive.list_sessions().unwrap().len(), 2);
}

#[test]
fn project_audit_memory_search_index_tracks_content_updates() {
    let path = audit_database("memory");
    let archive = sqlite_archive::MemoryArchiveStorage::open(&path).unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let mut memory = models::OrganicMemoryItem {
        memory_id: "reading-preference".to_owned(),
        tier: 3,
        category: "preference".to_owned(),
        content: "starlight reading preference".to_owned(),
        confidence: 1.0,
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        pinned: true,
    };
    archive.upsert_organic_memory(memory.clone()).unwrap();
    memory.content = "moonlight reading preference".to_owned();
    archive.upsert_organic_memory(memory.clone()).unwrap();
    let records = archive.list_organic_memories(None).unwrap();
    assert_eq!(records[0].content, memory.content);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let indexed: String = connection.query_row(
        "SELECT content FROM fts_organic_memories WHERE memory_id = ?1",
        [&memory.memory_id], |row| row.get(0),
    ).unwrap();
    let matches: i64 = connection.query_row(
        "SELECT count(*) FROM fts_organic_memories WHERE fts_organic_memories MATCH ?1",
        ["moonlight"], |row| row.get(0),
    ).unwrap();
    println!("memory_update: stored={:?}, indexed={:?}, new_term_matches={}, database={}",
        records[0].content, indexed, matches, path.display());
    assert_eq!(indexed, memory.content, "搜索索引应当更新记忆正文");
    assert_eq!(matches, 1);
}
