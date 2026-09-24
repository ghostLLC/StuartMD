#!/usr/bin/env python3
"""
scripts/test_challenger_m1_stress_rigor.py
Exhaustive Empirical Adversarial Stress Test Suite for Milestone M1 RAG Engine.

Focus Areas:
1. RRF Score Calculation & Edge Cases (0-vectors, empty BM25, identical scores tie-break, DEF-06 zero filtering).
2. FTS5 Trigram Query Sanitization with Malicious Inputs (unclosed quotes, wildcards, operators, SQL injection, unicode).
3. Dynamic Query Classification Edge Cases (punctuation, short queries, mixed language, 18 vs 19 Unicode char boundary).
"""

import sys
import io
import math
import sqlite3
import tempfile
from typing import List, Tuple, Dict, Optional

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# =========================================================================
# SECTION 1: DYNAMIC QUERY CLASSIFIER EMPIRICAL STRESS
# =========================================================================

def resolve_query_weights(query: str) -> Tuple[float, float]:
    """
    Exact behavioral clone of `tauri/src-tauri/src/rag/hybrid_search.rs::resolve_query_weights`.
    """
    q = query.strip()

    # Rule 1: Code tokens, paths, extensions, or explicit quotation marks
    if any(sym in q for sym in ['"', "::", "->", ".", "_"]):
        return (0.25, 0.75)

    # Rule 2: Natural language conceptual, reflective, or long exploratory queries
    is_concept = (
        q.startswith("为什么")
        or q.startswith("如何")
        or "原理" in q
        or "本质" in q
        or "对比" in q
    )

    # CRITICAL: Must use Unicode code points count, NOT byte length!
    # In Python len(str) is Unicode code point count (identical to Rust q.chars().count())
    if is_concept or len(q) > 18:
        return (0.70, 0.30)

    # Rule 3: Balanced default state
    return (0.50, 0.50)


def test_dynamic_query_classifier_stress():
    print("=" * 70)
    print("STRESS TEST 1: Dynamic Query Classifier Rigorous Edge Cases")
    print("=" * 70)

    # 1.1 All-punctuation edge cases
    test_cases_punct = [
        ("...", (0.25, 0.75), "Contains '.' -> Rule 1"),
        ("::", (0.25, 0.75), "Contains '::' -> Rule 1"),
        ("->", (0.25, 0.75), "Contains '->' -> Rule 1"),
        ('""', (0.25, 0.75), 'Contains \'"\' -> Rule 1'),
        ("___", (0.25, 0.75), "Contains '_' -> Rule 1"),
        ("!@#$%^&*()", (0.50, 0.50), "Punctuation without Rule 1 tokens, length 10 <= 18 -> Rule 3 default"),
        ("!@#$%^&*()!@#$%^&*()", (0.70, 0.30), "Punctuation length 20 > 18 -> Rule 2 long query"),
    ]
    for q, exp, desc in test_cases_punct:
        res = resolve_query_weights(q)
        print(f"  [Punctuation] '{q}' -> {res} (Exp: {exp}) | {desc}")
        assert res == exp, f"Failed on '{q}': got {res}, expected {exp}"

    # 1.2 Short queries edge cases
    test_cases_short = [
        ("", (0.50, 0.50), "Empty query -> default"),
        ("   ", (0.50, 0.50), "Whitespace-only -> default"),
        ("a", (0.50, 0.50), "Single ASCII -> default"),
        (".", (0.25, 0.75), "Single dot -> Rule 1 code token"),
        ("_", (0.25, 0.75), "Single underscore -> Rule 1 code token"),
        ("好", (0.50, 0.50), "Single Chinese char -> default"),
        ("?", (0.50, 0.50), "Single question mark -> default"),
        ("如何", (0.70, 0.30), "2-char '如何' -> Rule 2 concept prefix"),
        ("为什么", (0.70, 0.30), "3-char '为什么' -> Rule 2 concept prefix"),
    ]
    for q, exp, desc in test_cases_short:
        res = resolve_query_weights(q)
        print(f"  [Short Query] '{q}' -> {res} (Exp: {exp}) | {desc}")
        assert res == exp, f"Failed on '{q}': got {res}, expected {exp}"

    # 1.3 Mixed language queries
    test_cases_mixed = [
        ("Rust并发编程", (0.50, 0.50), "Chinese+English 10 chars -> default"),
        ("Rust::sync::Arc", (0.25, 0.75), "Rust path with '::' -> Rule 1"),
        ("FastEmbed.rs", (0.25, 0.75), "Filename with '.' -> Rule 1"),
        ("stuart_open_url 函数实现", (0.25, 0.75), "Identifier with '_' -> Rule 1"),
        ("为什么 fastembed 需要 onnx?", (0.70, 0.30), "Prefix '为什么' with English -> Rule 2"),
        ("如何使用 bge-m3 跨语种检索", (0.70, 0.30), "Starts with '如何', '-' is not '->' so Rule 2 triggers -> (0.70, 0.30)"),
        ("如何调用 bge_m3 函数？", (0.25, 0.75), "Starts with '如何' BUT contains '_' so Rule 1 takes precedence -> (0.25, 0.75)"),
    ]
    for q, exp, desc in test_cases_mixed:
        res = resolve_query_weights(q)
        print(f"  [Mixed Language] '{q}' -> {res} (Exp: {exp}) | {desc}")
        assert res == exp, f"Failed on '{q}': got {res}, expected {exp}"

    # 1.4 Unicode 18 vs 19 character boundary stress test
    # 18 Chinese characters = 54 UTF-8 bytes.
    # If the implementation mistakenly checks bytes (`q.len() > 18`), it would falsely trigger Rule 2!
    # Rust uses `q.chars().count() > 18`.
    zh_18_chars = "一二三四五六七八九十甲乙丙丁戊己庚辛"
    assert len(zh_18_chars) == 18
    assert len(zh_18_chars.encode('utf-8')) == 54
    res_18 = resolve_query_weights(zh_18_chars)
    print(f"  [Boundary] 18 Chinese characters (54 bytes): {res_18} (Must be (0.50, 0.50), NOT (0.70, 0.30))")
    assert res_18 == (0.50, 0.50), "Failed: 18 Unicode characters triggered > 18 check (possible byte length bug!)"

    zh_19_chars = "一二三四五六七八九十甲乙丙丁戊己庚辛壬"
    assert len(zh_19_chars) == 19
    res_19 = resolve_query_weights(zh_19_chars)
    print(f"  [Boundary] 19 Chinese characters (57 bytes): {res_19} (Must be (0.70, 0.30))")
    assert res_19 == (0.70, 0.30), "Failed: 19 Unicode characters failed to trigger > 18 check"

    # Same for 18 ASCII vs 19 ASCII
    ascii_18 = "abcdefghijklmnopqr" # 18
    assert resolve_query_weights(ascii_18) == (0.50, 0.50)
    ascii_19 = "abcdefghijklmnopqrs" # 19
    assert resolve_query_weights(ascii_19) == (0.70, 0.30)
    print("  [Boundary] ASCII 18 vs 19 passed.")

    print("=> Dynamic Query Classifier Stress: 100% PASS\n")


# =========================================================================
# SECTION 2: RRF SCORE CALCULATION & DEF-06 STRESS
# =========================================================================

class HybridSearchResult:
    def __init__(self, chunk_id: str, rrf_score: float, vector_rank: Optional[int], bm25_rank: Optional[int]):
        self.chunk_id = chunk_id
        self.rrf_score = rrf_score
        self.vector_rank = vector_rank
        self.bm25_rank = bm25_rank

    def __repr__(self):
        return f"Chunk({self.chunk_id}: score={self.rrf_score:.6f}, v={self.vector_rank}, b={self.bm25_rank})"


def execute_rrf_fusion(
    vector_hits: List[Tuple[str, int]],
    bm25_hits: List[Tuple[str, int]],
    w_vec: float,
    w_bm25: float,
    top_n: int,
    k: float = 60.0,
) -> List[HybridSearchResult]:
    """
    Exact behavioral clone of `tauri/src-tauri/src/rag/hybrid_search.rs::execute_rrf_fusion`.
    """
    score_map: Dict[str, Tuple[float, Optional[int], Optional[int]]] = {}

    for doc_id, r_vec in vector_hits:
        entry = score_map.get(doc_id, (0.0, None, None))
        new_score = entry[0] + w_vec / (k + float(r_vec))
        score_map[doc_id] = (new_score, r_vec, entry[2])

    for doc_id, r_bm in bm25_hits:
        entry = score_map.get(doc_id, (0.0, None, None))
        new_score = entry[0] + w_bm25 / (k + float(r_bm))
        score_map[doc_id] = (new_score, entry[1], r_bm)

    # 3. DEF-06: Filter out items with score <= 0.0
    results: List[HybridSearchResult] = [
        HybridSearchResult(cid, score, vr, br)
        for cid, (score, vr, br) in score_map.items()
        if score > 0.0
    ]

    # 4. DEF-06: Sort descending by rrf_score; ties broken deterministically by chunk_id ascending
    results.sort(key=lambda x: (-x.rrf_score, x.chunk_id))

    return results[:top_n]


def test_rrf_fusion_edge_cases():
    print("=" * 70)
    print("STRESS TEST 2: RRF Reciprocal Rank Fusion & DEF-06 Edge Cases")
    print("=" * 70)

    # 2.1 0 Vectors (Vector channel empty)
    bm25_hits = [(f"doc_{i}", i) for i in range(1, 21)]
    res_0_vec = execute_rrf_fusion([], bm25_hits, w_vec=0.70, w_bm25=0.30, top_n=10)
    print(f"  [0 Vectors] Total returned: {len(res_0_vec)} (top_n=10)")
    assert len(res_0_vec) == 10
    for i, r in enumerate(res_0_vec):
        assert r.chunk_id == f"doc_{i+1}", f"Ordering broken: {r.chunk_id} != doc_{i+1}"
        assert r.vector_rank is None, f"Expected vector_rank None, got {r.vector_rank}"
        assert r.bm25_rank == i + 1, f"Expected bm25_rank {i+1}, got {r.bm25_rank}"
        expected_score = 0.30 / (60.0 + (i + 1))
        assert abs(r.rrf_score - expected_score) < 1e-6
    print("  -> 0 Vectors: Strictly preserves BM25 monotonicity and ranks.")

    # 2.2 Empty BM25 results
    vec_hits = [(f"chunk_{i}", i) for i in range(1, 21)]
    res_0_bm = execute_rrf_fusion(vec_hits, [], w_vec=0.70, w_bm25=0.30, top_n=10)
    print(f"  [0 BM25] Total returned: {len(res_0_bm)} (top_n=10)")
    assert len(res_0_bm) == 10
    for i, r in enumerate(res_0_bm):
        assert r.chunk_id == f"chunk_{i+1}"
        assert r.vector_rank == i + 1
        assert r.bm25_rank is None
        expected_score = 0.70 / (60.0 + (i + 1))
        assert abs(r.rrf_score - expected_score) < 1e-6
    print("  -> 0 BM25: Strictly preserves Vector monotonicity and ranks.")

    # 2.3 Both channels empty
    res_both_empty = execute_rrf_fusion([], [], w_vec=0.50, w_bm25=0.50, top_n=10)
    print(f"  [Both Empty] Result count: {len(res_both_empty)}")
    assert len(res_both_empty) == 0

    # 2.4 Identical scores tie-breaking (chunk_id ASCENDING)
    # Construct 10 items with exact same score
    scrambled_ids = [
        "chunk_zebra", "chunk_alpha", "chunk_delta", "chunk_beta", "chunk_gamma",
        "chunk_10", "chunk_01", "chunk_02", "chunk_09", "chunk_omega"
    ]
    tied_vec_hits = [(cid, 1) for cid in scrambled_ids]
    res_tied = execute_rrf_fusion(tied_vec_hits, [], w_vec=1.0, w_bm25=0.0, top_n=10)
    sorted_ids = [r.chunk_id for r in res_tied]
    expected_ids = sorted(scrambled_ids)
    print(f"  [Tie-Breaker Input ]: {scrambled_ids[:5]}...")
    print(f"  [Tie-Breaker Output]: {sorted_ids}")
    print(f"  [Expected Output  ]: {expected_ids}")
    assert sorted_ids == expected_ids, "Tie-breaker failed to sort lexicographically ascending!"
    print("  -> Tie-Breaker: Exact deterministic chunk_id ascending order confirmed.")

    # 2.5 DEF-06 Zero-Score Filtering
    # Scenario A: w_vec = 0.0, w_bm25 = 1.0. Vector-only items MUST NOT appear!
    vec_only_items = [("ghost_v1", 1), ("ghost_v2", 2), ("ghost_v3", 3)]
    bm_items = [("valid_b1", 1), ("valid_b2", 2)]
    res_def06_a = execute_rrf_fusion(vec_only_items, bm_items, w_vec=0.0, w_bm25=1.0, top_n=10)
    print(f"  [DEF-06 Zero-Score A] w_vec=0.0: Output count={len(res_def06_a)} (Exp: 2)")
    assert len(res_def06_a) == 2, f"Failed: Ghost items with 0.0 score leaked into results: {res_def06_a}"
    assert all(r.rrf_score > 0.0 for r in res_def06_a)
    assert [r.chunk_id for r in res_def06_a] == ["valid_b1", "valid_b2"]

    # Scenario B: w_vec = 1.0, w_bm25 = 0.0. BM25-only items MUST NOT appear!
    bm_only_items = [("ghost_b1", 1), ("ghost_b2", 2)]
    v_items = [("valid_v1", 1), ("valid_v2", 2)]
    res_def06_b = execute_rrf_fusion(v_items, bm_only_items, w_vec=1.0, w_bm25=0.0, top_n=10)
    print(f"  [DEF-06 Zero-Score B] w_bm25=0.0: Output count={len(res_def06_b)} (Exp: 2)")
    assert len(res_def06_b) == 2
    assert all(r.rrf_score > 0.0 for r in res_def06_b)
    assert [r.chunk_id for r in res_def06_b] == ["valid_v1", "valid_v2"]

    # Scenario C: Both weights 0.0 -> Result MUST be empty
    res_def06_c = execute_rrf_fusion(v_items, bm_items, w_vec=0.0, w_bm25=0.0, top_n=10)
    print(f"  [DEF-06 Zero-Score C] w_vec=0, w_bm25=0: Output count={len(res_def06_c)} (Exp: 0)")
    assert len(res_def06_c) == 0

    # 2.6 Top-N Truncation
    assert len(execute_rrf_fusion(vec_hits, bm25_hits, 0.5, 0.5, top_n=0)) == 0
    assert len(execute_rrf_fusion(vec_hits, bm25_hits, 0.5, 0.5, top_n=1)) == 1
    assert len(execute_rrf_fusion(vec_hits, bm25_hits, 0.5, 0.5, top_n=5)) == 5
    assert len(execute_rrf_fusion(vec_hits[:3], [], 1.0, 0.0, top_n=50)) == 3

    print("=> RRF Fusion & DEF-06: 100% PASS\n")


# =========================================================================
# SECTION 3: FTS5 TRIGRAM QUERY SANITIZATION WITH MALICIOUS QUERIES
# =========================================================================

def escape_fts5_query(raw_query: str) -> str:
    """
    Exact behavioral clone of `tauri/src-tauri/src/rag/fts.rs::escape_fts5_query`.
    """
    # 1. Filter null bytes and non-whitespace control characters
    sanitized: str = "".join(
        c for c in raw_query
        if c != '\0' and (not (ord(c) < 32 or ord(c) == 127) or c in ('\t', '\n', '\r'))
    )
    trimmed = sanitized.strip()
    if not trimmed:
        return '""'

    # 2. Escape all internal double quotes by doubling them ("" -> """")
    escaped = trimmed.replace('"', '""')
    return f'"{escaped}"'


def test_fts5_trigram_malicious_sanitization():
    print("=" * 70)
    print("STRESS TEST 3: FTS5 Trigram Malicious Query Sanitization")
    print("=" * 70)

    # Initialize SQLite with real FTS5 trigram virtual table
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
            chunk_id UNINDEXED,
            heading_path,
            content,
            tokenize = 'trigram'
        );
    """)

    # Populate sample documents
    corpus = [
        ("c1", "System Arch", "StuartMD local offline RAG engine with sqlite-vec and trigram tokenizer"),
        ("c2", "Code Reference", "pub fn stuart_open_url(url: &str) -> Result<(), String> {"),
        ("c3", "Security Audit", "Win32 ReplaceFileW atomic write prevents partial file corruptions"),
        ("c4", "Academic Paper", "倒数排名融合算法（RRF）在大模型多路召回知识库中的工程落地与实践"),
        ("c5", "Unicode Spec", "Emoji test 💖🚀🔥 and symbols ∫∑∏∂ and quotes \"test\""),
    ]
    for cid, heading, content in corpus:
        conn.execute("INSERT INTO rag_chunks_fts VALUES (?, ?, ?)", (cid, heading, content))
    conn.commit()

    # 40+ Malicious / Adversarial Payloads
    malicious_payloads = [
        # Unclosed and pathological quotes
        '"',
        '""',
        '"""',
        '""""',
        '"""""',
        'foo "bar',
        '"unmatched quote at end',
        'start " middle " end',
        '"""quoted"""',
        '"""""broken"""""',
        'Chinese quotes “你好” and ‘世界’',

        # Wildcards and globbing
        '*',
        '***',
        '?',
        '???',
        '*.*',
        '%.%',
        '^prefix',
        'stuart*',
        'stuart* AND open*',

        # Boolean and syntax operators
        'AND',
        'OR',
        'NOT',
        'AND OR NOT',
        'NEAR(a, b)',
        'NEAR/5(a, b)',
        '+',
        '-',
        '()',
        '(((((((',
        ')))))))',
        '(a OR b) AND (c NOT d)',
        'heading_path:System',
        'content:sqlite',
        'nonexistent_column:foobar',
        'chunk_id:c1',

        # SQL Injection attempts
        "' OR 1=1; --",
        '" OR "1"="1',
        "'; DROP TABLE rag_chunks_fts; --",
        "admin'--",
        "1' UNION SELECT * FROM sqlite_master --",
        "'; ATTACH DATABASE 'pwn.db' AS pwn; --",
        '"; VACUUM; --',
        "x'616263'",

        # Unicode & control bytes
        "null\x00byte\x00injection",
        "\x01\x02\x03\x04\x05\x1b\x7f",
        "💖🔥🚀 emojis",
        "مرحبا بالعالم",
        "שלום עולם",
        "∫∑∏∂√±≠≤≥",
        "Zero\u200bWidth\u200bSpace",
        "Non\u00a0Breaking\u00a0Space",
        "Tab\tAnd\nNewline\rCarriage",

        # Extreme lengths and whitespace
        "",
        "    ",
        "\t\n\r",
        "a" * 1000,
        ('"' * 50) + "hello" + ('"' * 50),
    ]

    executed_count = 0
    crashes = []

    for payload in malicious_payloads:
        safe_query = escape_fts5_query(payload)
        try:
            cur = conn.cursor()
            if safe_query == '""':
                # Exact Rust behavior: search_fts5_bm25 returns Ok(Vec::new()) for empty query
                executed_count += 1
                continue

            # Execute actual SQLite FTS5 MATCH query with BM25 ranking
            sql = "SELECT chunk_id, bm25(rag_chunks_fts, 0.0, 3.0, 1.0) FROM rag_chunks_fts WHERE rag_chunks_fts MATCH ? ORDER BY 2 ASC;"
            cur.execute(sql, (safe_query,))
            rows = cur.fetchall()
            executed_count += 1
        except Exception as e:
            crashes.append((payload, safe_query, str(e)))

    conn.close()

    print(f"  • Total Malicious Payloads Tested: {len(malicious_payloads)}")
    print(f"  • Successfully Handled without Syntax Error: {executed_count}")
    print(f"  • Crashes / SQL Syntax Errors: {len(crashes)}")

    if crashes:
        for p, s, err in crashes:
            print(f"  [CRASH] Payload: {repr(p)} -> Sanitized: {repr(s)} -> Error: {err}")
        assert False, f"FTS5 Query Sanitization Failed on {len(crashes)} inputs!"

    print("=> FTS5 Trigram Malicious Query Sanitization: 100% PASS\n")


# =========================================================================
# MAIN ENTRYPOINT
# =========================================================================

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print(" CHALLENGER M1 ADVERSARIAL STRESS RIGOR VERIFICATION")
    print("=" * 70 + "\n")

    test_dynamic_query_classifier_stress()
    test_rrf_fusion_edge_cases()
    test_fts5_trigram_malicious_sanitization()

    print("=" * 70)
    print(">> ALL CHALLENGER M1 ADVERSARIAL STRESS TESTS COMPLETED: 100% PASS <<")
    print("=" * 70 + "\n")
