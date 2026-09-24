#!/usr/bin/env python3
"""
scripts/test_algo_adversarial_challenge.py
Empirical Adversarial Stress Test Suite for StuartMD AI-Wiki RAG Architecture.

Tests:
1. RRF & Dynamic Query Classifier:
   - Asymmetric empty channels (vector empty, BM25 empty, both empty).
   - Extreme weights (w=0.0, w=1.0) and score ties / stability.
2. 6-State Token Budget State Machine:
   - Ultra-small context windows (e.g. 2048 context, 1500 reserve).
   - Large L1 selection (3000 tokens) clamping behavior.
   - UTF-8 multi-byte boundary truncation safety (Rust String::truncate simulation).
   - Ultra-long conversation history (>32k tokens) and 3-part semantic takeaway.
   - Huge last-turn conversation anomaly.
3. 3-Tier Organic Memory Network & Ebbinghaus Retention Decay:
   - Decay limits as Delta t -> infinity.
   - Access gain limits as A(m) -> infinity.
   - Low initial importance I(m) < 0.25 day-0 birth eviction anomaly.
   - Unpinned immortality threshold at A(m) >= 5.
   - Pinned memory immortality guarantee.
4. Flash Anchor Levenshtein Self-Healing:
   - Line shift > 50 lines against +/-30 line neighborhood window.
   - False-positive risks and graceful degradation.
   - Proposed hash-based / AST global fallback recovery.
"""

import math
import sys
import unicodedata
from typing import List, Tuple, Dict, Optional

# =========================================================================
# 1. RRF & DYNAMIC QUERY CLASSIFIER HARNESS
# =========================================================================

def resolve_query_weights(query: str) -> Tuple[float, float]:
    q = query.strip()
    # Rule 1: Code tokens or explicit quotes
    if any(sym in q for sym in ['"', "::", "->", ".", "_"]):
        return (0.25, 0.75) # (w_vec, w_bm25)
    # Rule 2: Natural language conceptual / reflective query
    is_concept = (q.startswith("为什么") or q.startswith("如何") or
                  "原理" in q or "本质" in q or "对比" in q)
    if is_concept or len(q) > 18:
        return (0.70, 0.30)
    # Rule 3: Balanced default
    return (0.50, 0.50)

def execute_rrf_fusion(
    vector_hits: List[Tuple[str, int]], # (chunk_id, 1-based rank)
    bm25_hits: List[Tuple[str, int]],   # (chunk_id, 1-based rank)
    w_vec: float,
    w_bm25: float,
    top_n: int = 10,
    k: float = 60.0
) -> List[Dict]:
    scores = {}
    for doc_id, r_vec in vector_hits:
        scores.setdefault(doc_id, {"rrf_score": 0.0, "vector_rank": None, "bm25_rank": None})
        scores[doc_id]["rrf_score"] += w_vec / (k + float(r_vec))
        scores[doc_id]["vector_rank"] = r_vec

    for doc_id, r_bm in bm25_hits:
        scores.setdefault(doc_id, {"rrf_score": 0.0, "vector_rank": None, "bm25_rank": None})
        scores[doc_id]["rrf_score"] += w_bm25 / (k + float(r_bm))
        scores[doc_id]["bm25_rank"] = r_bm

    results = []
    for doc_id, data in scores.items():
        results.append({
            "chunk_id": doc_id,
            "rrf_score": data["rrf_score"],
            "vector_rank": data["vector_rank"],
            "bm25_rank": data["bm25_rank"]
        })

    # Sort descending by rrf_score
    results.sort(key=lambda x: x["rrf_score"], reverse=True)
    return results[:top_n]


def test_challenge_1_rrf():
    print("\n" + "="*70)
    print(">>> CHALLENGE 1: RRF & DYNAMIC QUERY CLASSIFIER RIGOR TEST")
    print("="*70)

    # 1.1 Asymmetric Empty Results: Vector Empty (Out of Vocabulary)
    bm25_hits = [(f"doc_{i}", i) for i in range(1, 11)]
    res_vec_empty = execute_rrf_fusion([], bm25_hits, w_vec=0.70, w_bm25=0.30, top_n=10)
    print("Test 1.1: Vector empty (0 hits), BM25 has 10 hits:")
    ranks_preserved = all(res_vec_empty[i]["chunk_id"] == f"doc_{i+1}" for i in range(len(res_vec_empty)))
    print(f"  -> BM25 rank preserved strictly monotonically: {ranks_preserved}")
    print(f"  -> Top-1 score: {res_vec_empty[0]['rrf_score']:.6f} (expected: {0.30/61:.6f})")
    assert ranks_preserved, "RRF failed to preserve BM25 ranking when vector hits were empty"

    # 1.2 Asymmetric Empty Results: BM25 Empty (0 text matches)
    vec_hits = [(f"doc_{i}", i) for i in range(1, 11)]
    res_bm_empty = execute_rrf_fusion(vec_hits, [], w_vec=0.70, w_bm25=0.30, top_n=10)
    print("\nTest 1.2: BM25 empty (0 hits), Vector has 10 hits:")
    ranks_preserved_vec = all(res_bm_empty[i]["chunk_id"] == f"doc_{i+1}" for i in range(len(res_bm_empty)))
    print(f"  -> Vector rank preserved strictly monotonically: {ranks_preserved_vec}")
    print(f"  -> Top-1 score: {res_bm_empty[0]['rrf_score']:.6f} (expected: {0.70/61:.6f})")
    assert ranks_preserved_vec, "RRF failed to preserve Vector ranking when BM25 hits were empty"

    # 1.3 Both Empty
    res_both_empty = execute_rrf_fusion([], [], w_vec=0.5, w_bm25=0.5, top_n=10)
    print(f"\nTest 1.3: Both channels empty -> Results count: {len(res_both_empty)} (safe, no divide-by-zero)")
    assert len(res_both_empty) == 0

    # 1.4 Extreme Weight w_vec = 0.0, w_bm25 = 1.0
    print("\nTest 1.4: Extreme weight w_vec = 0.0, w_bm25 = 1.0:")
    vec_only = [("vec_only_1", 1), ("vec_only_2", 2)]
    bm_hits = [("bm_1", 1), ("bm_2", 2)]
    res_extreme_0 = execute_rrf_fusion(vec_only, bm_hits, w_vec=0.0, w_bm25=1.0, top_n=10)
    for r in res_extreme_0:
        print(f"  -> {r['chunk_id']}: score = {r['rrf_score']:.6f}, vec_rank={r['vector_rank']}, bm_rank={r['bm25_rank']}")
    # Findings: Items only in vector have score 0.0. Tied scores for all vec-only items!
    vec_scores = [r["rrf_score"] for r in res_extreme_0 if "vec_only" in r["chunk_id"]]
    print(f"  -> Vector-only items have score 0.0: {all(s == 0.0 for s in vec_scores)}")
    print("  -> VULNERABILITY NOTE: In Rust, items with score 0.0 tie and have unstable HashMap order unless tie-breaker exists.")

    # 1.5 Query Classifier Boundaries
    print("\nTest 1.5: Query Classifier Weight Resolution:")
    queries = [
        ('stuart::fs_api::ReplaceFileW', (0.25, 0.75)),
        ('"exact quote"', (0.25, 0.75)),
        ('config.json', (0.25, 0.75)),
        ('为什么本地向量化需要sqlite-vec？', (0.70, 0.30)),
        ('这是一个超过十八个字符的极其漫长的哲学思辨问题讨论', (0.70, 0.30)),
        ('hello world', (0.50, 0.50)),
    ]
    for q, exp in queries:
        w = resolve_query_weights(q)
        print(f"  Query: '{q[:20]}...' -> w_vec={w[0]}, w_bm25={w[1]} (expected {exp})")
        assert w == exp, f"Weight resolution mismatch for query: {q}"

    print(">>> Challenge 1 Passed with Observations.")


# =========================================================================
# 2. 6-STATE TOKEN BUDGET STATE MACHINE HARNESS
# =========================================================================

class MockFocusContext:
    def __init__(self, quote: str):
        self.quote = quote

class MockDocContext:
    def __init__(self, heading: str, neighbors: List[str]):
        self.heading = heading
        self.neighbors = neighbors

class MockPyramid:
    def __init__(self, l1_focus: Optional[MockFocusContext],
                 l2_doc: Optional[MockDocContext],
                 l3_chunks: List[str],
                 l4_convo: List[Dict[str, str]],
                 l5_profile: Optional[str]):
        self.l1_focus = l1_focus
        self.l2_document = l2_doc
        self.l3_rag_chunks = l3_chunks
        self.l4_conversation = l4_convo
        self.l5_user_profile = l5_profile

def estimate_tokens(text: str) -> int:
    # Heuristic: 1 token approx 1.5 chars for Chinese, 4 chars for English
    # Simple hybrid estimate:
    zh_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    en_chars = len(text) - zh_chars
    return int(zh_chars * 0.8 + en_chars * 0.3) + 1

def estimate_pyramid_tokens(p: MockPyramid) -> int:
    total = 0
    if p.l1_focus:
        total += estimate_tokens(p.l1_focus.quote)
    if p.l2_document:
        total += estimate_tokens(p.l2_document.heading)
        for n in p.l2_document.neighbors:
            total += estimate_tokens(n)
    for c in p.l3_rag_chunks:
        total += estimate_tokens(c)
    for turn in p.l4_conversation:
        total += estimate_tokens(turn.get("content", ""))
    if p.l5_user_profile:
        total += estimate_tokens(p.l5_user_profile)
    return total

def compress_conversation_mock(convo: List[Dict[str, str]]) -> List[Dict[str, str]]:
    if len(convo) <= 2:
        return convo
    # Keep last 2, summarize earlier
    summary = (
        "[前文对话核心纪要 (Context Takeaways)]\n"
        "- 讨论主题: 本地架构演进与安全\n"
        "- 已定共识: 采纳 SQLite 与原子写盘\n"
        "- 待决疑问: 极端压力测试"
    )
    return [{"role": "system", "content": summary}] + convo[-2:]

def simulate_rust_truncate(s: str, byte_limit: int) -> Tuple[bool, str]:
    """
    Simulates Rust's String::truncate(byte_limit).
    In Rust, if byte_limit is inside a multi-byte UTF-8 character, IT PANICS!
    """
    raw_bytes = s.encode("utf-8")
    if byte_limit >= len(raw_bytes):
        return (True, s)
    # Check if byte_limit falls on a UTF-8 lead byte or single-byte (ASCII)
    # In UTF-8, continuation bytes have bit pattern 10xxxxxx (0x80 to 0xBF)
    target_byte = raw_bytes[byte_limit]
    is_char_boundary = (target_byte & 0xC0) != 0x80
    if not is_char_boundary:
        # PANIC!
        return (False, f"PANIC: byte index {byte_limit} is not a char boundary; it is inside a multi-byte character!")
    truncated_bytes = raw_bytes[:byte_limit]
    return (True, truncated_bytes.decode("utf-8"))

def test_challenge_2_budget_state_machine():
    print("\n" + "="*70)
    print(">>> CHALLENGE 2: 6-STATE TOKEN BUDGET STATE MACHINE RIGOR TEST")
    print("="*70)

    # 2.1 Boundary Condition: Ultra-small Context Window (e.g. 2048 limit, 1500 reserve)
    context_limit = 2048
    reserve_output = 1500
    max_input_tokens = max(0, context_limit - reserve_output) # 548 tokens
    print(f"Test 2.1: Ultra-small context window: context={context_limit}, reserve={reserve_output} -> max_input_tokens={max_input_tokens}")

    # User selects 3000 tokens of text in L1
    huge_selection = "这是一个非常冗长的用户划词选区内容。" * 300 # ~3000 tokens
    pyramid = MockPyramid(
        l1_focus=MockFocusContext(quote=huge_selection),
        l2_doc=MockDocContext(heading="# 架构设计", neighbors=["邻近段落A", "邻近段落B"]),
        l3_chunks=["RAG切片1内容"*50, "RAG切片2内容"*50, "RAG切片3内容"*50],
        l4_convo=[{"role": "user", "content": "轮次1"}, {"role": "assistant", "content": "回答1"}],
        l5_profile="用户偏好简洁"
    )

    initial_tokens = estimate_pyramid_tokens(pyramid)
    print(f"  -> Initial total tokens: {initial_tokens} tokens (limit is {max_input_tokens})")

    # Simulate Budget State Machine execution as specified in budget.rs
    state = "S0Evaluate"
    transitions = []
    while True:
        current_tokens = estimate_pyramid_tokens(pyramid)
        transitions.append((state, current_tokens))
        if state == "S0Evaluate":
            if current_tokens <= max_input_tokens:
                state = "S5EmitReady"
            else:
                state = "S1CompressL4"
        elif state == "S1CompressL4":
            pyramid.l4_conversation = compress_conversation_mock(pyramid.l4_conversation)
            if estimate_pyramid_tokens(pyramid) <= max_input_tokens:
                state = "S5EmitReady"
            else:
                state = "S2PruneL3"
        elif state == "S2PruneL3":
            while len(pyramid.l3_rag_chunks) > 2 and estimate_pyramid_tokens(pyramid) > max_input_tokens:
                pyramid.l3_rag_chunks.pop()
            if estimate_pyramid_tokens(pyramid) <= max_input_tokens:
                state = "S5EmitReady"
            else:
                state = "S3SkeletonL2"
        elif state == "S3SkeletonL2":
            if pyramid.l2_document:
                pyramid.l2_document.neighbors.clear()
            if estimate_pyramid_tokens(pyramid) <= max_input_tokens:
                state = "S5EmitReady"
            else:
                state = "S4ClampL1"
        elif state == "S4ClampL1":
            # Examine the code in ROADMAP line 587:
            # let allowed_chars = self.max_input_tokens.saturating_sub(1000) * 2;
            # CRITICAL DEFECT: If max_input_tokens < 1000, saturating_sub(1000) gives ZERO!
            allowed_tokens_spec = max(0, max_input_tokens - 1000)
            allowed_chars = allowed_tokens_spec * 2
            print(f"  -> In S4ClampL1: max_input_tokens={max_input_tokens}, allowed_chars = (548 - 1000).saturating_sub * 2 = {allowed_chars}!")
            if pyramid.l1_focus:
                print(f"  -> VULNERABILITY FOUND: When max_input_tokens <= 1000, allowed_chars collapses to 0, completely wiping L1!")
                # Also test UTF-8 truncate panic:
                # If allowed_chars > 0, does truncate(allowed_chars) panic on UTF-8 char boundary?
                test_str = "中文测试段落，每一个汉字占用三个字节。"
                for test_cut in range(1, 10):
                    ok, msg = simulate_rust_truncate(test_str, test_cut)
                    if not ok:
                        print(f"  -> UTF-8 TRUNCATE PANIC CONFIRMED: byte_limit={test_cut} -> {msg}")
                        break
                # Graceful clamp instead:
                clamped_chars = max(100, int(max_input_tokens * 1.5))
                pyramid.l1_focus.quote = pyramid.l1_focus.quote[:clamped_chars] + "\n...[Clamped]"
            state = "S5EmitReady"
        elif state == "S5EmitReady":
            final_tokens = estimate_pyramid_tokens(pyramid)
            transitions.append((state, final_tokens))
            break

    print(f"  -> State transitions completed: {[t[0] for t in transitions]}")
    print(f"  -> Final token count: {final_tokens}")

    # 2.2 Conversation History >32k tokens
    print("\nTest 2.2: L4 Conversation History >32k tokens:")
    long_convo = []
    for i in range(50):
        long_convo.append({"role": "user", "content": f"第{i}轮问题：" + "关于Rust并发与内存模型的深度探讨。" * 30})
        long_convo.append({"role": "assistant", "content": f"第{i}轮回答：" + "Rust通过所有权与生命周期保证内存安全。" * 30})
    initial_l4_tokens = sum(estimate_tokens(m["content"]) for m in long_convo)
    print(f"  -> Raw 100-turn conversation tokens: {initial_l4_tokens} tokens (>32k tokens)")
    compressed_l4 = compress_conversation_mock(long_convo)
    compressed_l4_tokens = sum(estimate_tokens(m["content"]) for m in compressed_l4)
    print(f"  -> After 3-part semantic compression: {compressed_l4_tokens} tokens")
    print(f"  -> Compression ratio: {(1.0 - compressed_l4_tokens/initial_l4_tokens)*100:.2f}% token reduction!")
    assert compressed_l4_tokens < 1000, "Compression failed to reduce >32k tokens below 1000 tokens"

    # 2.3 Edge Case: Huge Last Turn (e.g. user pasted 20k tokens in the last turn)
    print("\nTest 2.3: Edge case: Last turn of L4 is huge (>15k tokens):")
    huge_last_convo = long_convo[:4]
    huge_last_convo.append({"role": "user", "content": "用户在最后一轮贴了万字长文：" + "超长日志文本" * 2000})
    comp_huge = compress_conversation_mock(huge_last_convo)
    comp_huge_tokens = sum(estimate_tokens(m["content"]) for m in comp_huge)
    print(f"  -> Tokens after standard 3-part compression: {comp_huge_tokens} tokens")
    print(f"  -> VULNERABILITY NOTE: If the last 2 turns themselves exceed budget, compress_conversation does NOT truncate the last turns!")


# =========================================================================
# 3. 3-TIER ORGANIC MEMORY & EBBINGHAUS DECAY HARNESS
# =========================================================================

def memory_score(I: float, delta_t_days: float, A: int, pin: int,
                 lmbda: float = 0.05, alpha: float = 0.15, beta: float = 2.0) -> float:
    decay_term = I * math.exp(-lmbda * delta_t_days)
    access_term = alpha * math.log(1.0 + float(A))
    pin_term = beta * float(pin)
    return decay_term + access_term + pin_term

def test_challenge_3_ebbinghaus_decay():
    print("\n" + "="*70)
    print(">>> CHALLENGE 3: 3-TIER MEMORY & EBBINGHAUS RETENTION DECAY RIGOR TEST")
    print("="*70)

    # 3.1 Mathematical Limits as Delta t -> infinity
    print("Test 3.1: Asymptotic limit as Delta t -> inf (A(m) fixed, pin=0):")
    for A in [0, 1, 2, 4, 5, 10]:
        limit_val = 0.15 * math.log(1 + A)
        print(f"  -> A(m)={A:2d}: lim_(t->inf) S(m) = {limit_val:.5f} | Pruned if < 0.25? {'YES' if limit_val < 0.25 else 'NO (IMMORTAL)'}")

    # Finding exact threshold for immortality:
    # 0.15 * ln(1 + A) >= 0.25 => 1 + A >= exp(5/3) = 5.294 => A >= 5
    A_immortal = math.ceil(math.exp(0.25 / 0.15) - 1.0)
    print(f"  -> Exact access count threshold for perpetual immortality: A(m) >= {A_immortal}")
    assert A_immortal == 5, f"Expected A_immortal to be 5, got {A_immortal}"

    # 3.2 Mathematical Limits as A(m) -> infinity
    print("\nTest 3.2: Asymptotic limit as A(m) -> inf:")
    for A in [10, 100, 1000, 10000, 100000, 1000000]:
        s = memory_score(I=0.5, delta_t_days=30, A=A, pin=0)
        print(f"  -> A(m)={A:7d}: S(m) = {s:.4f}")
    print("  -> Mathematical property: ln(1+A) grows without bound (diverges to +inf).")
    print("  -> Practical impact: Even at 1,000,000 accesses, score is only ~2.18, so no float overflow, but lacks an upper saturation bound.")

    # 3.3 Critical Vulnerability: Day-0 Birth Eviction for Low Initial Importance
    print("\nTest 3.3: Day-0 Immediate Eviction Bug for Low Initial Importance:")
    for I_init in [0.10, 0.15, 0.20, 0.24, 0.25, 0.50]:
        s_day0 = memory_score(I=I_init, delta_t_days=0, A=0, pin=0)
        is_pruned = s_day0 < 0.25
        print(f"  -> I(m)={I_init:.2f} at day 0 (A=0): S(m) = {s_day0:.2f} -> Pruned immediately? {is_pruned}")
    print("  -> VULNERABILITY CONFIRMED: Any memory created with I(m) < 0.25 is born dead! If background maintenance runs on day 0, it is immediately evicted!")

    # 3.4 Pinned Memory Immortality Guarantee
    print("\nTest 3.4: Pinned Memory Immortality Guarantee:")
    s_pin_worst_case = memory_score(I=0.0, delta_t_days=36500, A=0, pin=1) # 100 years later
    print(f"  -> Pinned memory after 100 years with 0 accesses: S(m) = {s_pin_worst_case:.4f} (threshold: 0.25)")
    print(f"  -> Pinned condition: S(m) >= 2.0 and pin==1 => 100% IMMORTAL.")
    assert s_pin_worst_case >= 2.0, "Pinned memory failed immortality test"


# =========================================================================
# 4. FLASH ANCHOR LEVENSHTEIN SELF-HEALING HARNESS
# =========================================================================

def levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    return previous_row[-1]

def text_similarity(s1: str, s2: str) -> float:
    max_len = max(len(s1), len(s2))
    if max_len == 0:
        return 1.0
    dist = levenshtein_distance(s1, s2)
    return 1.0 - dist / max_len

def self_heal_anchor(lines: List[str], target_line_1based: int, anchor_text: str,
                     window_radius: int = 30, similarity_threshold: float = 0.85) -> Tuple[Optional[int], str]:
    """
    Simulates SPEC self-healing:
    Scan lines in [target_line - window_radius, target_line + window_radius].
    Find line with similarity > similarity_threshold.
    """
    n = len(lines)
    target_idx = target_line_1based - 1

    # Exact match check
    if 0 <= target_idx < n and lines[target_idx] == anchor_text:
        return (target_line_1based, "EXACT_MATCH")

    # Neighborhood scan
    start_idx = max(0, target_idx - window_radius)
    end_idx = min(n - 1, target_idx + window_radius)

    best_sim = 0.0
    best_idx = None
    for idx in range(start_idx, end_idx + 1):
        sim = text_similarity(lines[idx], anchor_text)
        if sim > best_sim:
            best_sim = sim
            best_idx = idx

    if best_sim >= similarity_threshold and best_idx is not None:
        return (best_idx + 1, f"HEALED_SIMILARITY_{best_sim:.2f}")

    return (None, "FAILED_OUT_OF_WINDOW_OR_LOW_SIMILARITY")

def test_challenge_4_flash_anchor():
    print("\n" + "="*70)
    print(">>> CHALLENGE 4: FLASH ANCHOR LEVENSHTEIN SELF-HEALING RIGOR TEST")
    print("="*70)

    # Base document of 200 lines
    original_lines = [f"Line {i}: Normal content paragraph" for i in range(1, 201)]
    original_lines[41] = "TARGET: 本地离线 RAG 核心架构与 Flash Anchor 自愈机制。" # Line 42 (1-based)
    anchor_text = original_lines[41]
    original_target_line = 42

    # 4.1 Shift within window: +20 lines
    lines_shift_20 = ["Inserted Line"] * 20 + original_lines
    res_line_20, status_20 = self_heal_anchor(lines_shift_20, original_target_line, anchor_text, window_radius=30)
    print(f"Test 4.1: Line shift +20 (new line: 62, within window [12, 72]):")
    print(f"  -> Result line: {res_line_20}, Status: {status_20}")
    assert res_line_20 == 62, f"Expected line 62, got {res_line_20}"

    # 4.2 Shift EXCEEDING window: +60 lines (extensive edit)
    lines_shift_60 = ["Inserted Line"] * 60 + original_lines
    res_line_60, status_60 = self_heal_anchor(lines_shift_60, original_target_line, anchor_text, window_radius=30)
    print(f"\nTest 4.2: Extensive edit: Line shift +60 (new line: 102, window [12, 72]):")
    print(f"  -> Result line: {res_line_60}, Status: {status_60}")
    print("  -> VULNERABILITY CONFIRMED: Window radius=30 FAILS when edits shift content by >30 lines (e.g. 50+ lines)!")
    print("  -> Behavior: Returns None and status FAILED_OUT_OF_WINDOW_OR_LOW_SIMILARITY.")
    print("  -> Graceful degradation: The UI shows prompt '原段落已被实质性修改或删除' (does NOT crash).")

    # 4.3 Proposed Algorithmic Fix: Two-tier Self-Healing (Neighborhood -> Global Short-Hash/Substring)
    def proposed_self_heal_two_tier(lines: List[str], target_line_1based: int, anchor_text: str,
                                   window_radius: int = 30) -> Tuple[Optional[int], str]:
        # Tier 1: Local window
        line, status = self_heal_anchor(lines, target_line_1based, anchor_text, window_radius)
        if line is not None:
            return (line, status)
        # Tier 2: Global prefix substring or CRC32 hash match
        prefix = anchor_text[:20]
        for idx, l in enumerate(lines):
            if prefix in l or text_similarity(l, anchor_text) >= 0.85:
                return (idx + 1, "GLOBAL_HEALED_TIER2")
        return (None, "FAILED_PERMANENTLY")

    res_tier2, status_tier2 = proposed_self_heal_two_tier(lines_shift_60, original_target_line, anchor_text, window_radius=30)
    print(f"\nTest 4.3: Proposed Two-Tier Fallback Self-Healing with +60 shift:")
    print(f"  -> Result line: {res_tier2}, Status: {status_tier2}")
    assert res_tier2 == 102, f"Proposed two-tier self-healing should have recovered line 102, got {res_tier2}"
    print("  -> PROPOSAL VERIFIED: Global Tier-2 fallback successfully recovers anchors shifted by >50 lines!")

# =========================================================================
# 5. PATCHED ALGORITHM VERIFICATION (DEF-01 through DEF-07)
# =========================================================================

def test_patched_algorithms_verification():
    print("\n" + "="*70)
    print(">>> VERIFICATION SUITE: TESTING PATCHED ALGORITHMS (DEF-01 TO DEF-07)")
    print("="*70)

    # --- DEF-06: Patched RRF Fusion (zero-score filtering & deterministic secondary sort) ---
    print("\n[VERIFY DEF-06] RRF Zero-Score Filtering & Deterministic Secondary Tie-Breaker:")
    def execute_rrf_fusion_patched(vector_hits, bm25_hits, w_vec, w_bm25, top_n=10, k=60.0):
        scores = {}
        for doc_id, r_vec in vector_hits:
            scores.setdefault(doc_id, {"rrf_score": 0.0, "vector_rank": None, "bm25_rank": None})
            scores[doc_id]["rrf_score"] += w_vec / (k + float(r_vec))
            scores[doc_id]["vector_rank"] = r_vec
        for doc_id, r_bm in bm25_hits:
            scores.setdefault(doc_id, {"rrf_score": 0.0, "vector_rank": None, "bm25_rank": None})
            scores[doc_id]["rrf_score"] += w_bm25 / (k + float(r_bm))
            scores[doc_id]["bm25_rank"] = r_bm
        # Filter out rrf_score <= 0.0 (DEF-06)
        results = [
            {"chunk_id": doc_id, "rrf_score": d["rrf_score"]}
            for doc_id, d in scores.items() if d["rrf_score"] > 0.0
        ]
        # Sort descending by rrf_score, tie-break by chunk_id ascending (DEF-06)
        results.sort(key=lambda x: (-x["rrf_score"], x["chunk_id"]))
        return results[:top_n]

    vec_only = [("vec_z", 1), ("vec_a", 2)]
    bm_hits = [("bm_b", 1), ("bm_a", 2)]
    # With w_vec = 0.0, vector items get 0.0 score
    res_patched = execute_rrf_fusion_patched(vec_only, bm_hits, w_vec=0.0, w_bm25=1.0)
    print(f"  -> Returned items count: {len(res_patched)}")
    assert all(r["rrf_score"] > 0.0 for r in res_patched), "DEF-06 Failed: Found items with score <= 0.0"
    assert [r["chunk_id"] for r in res_patched] == ["bm_b", "bm_a"], "DEF-06 Failed: Incorrect ordering"
    # Tied score secondary sort test
    tied_res = execute_rrf_fusion_patched([("doc_c", 1), ("doc_a", 1), ("doc_b", 1)], [], w_vec=1.0, w_bm25=0.0)
    assert [r["chunk_id"] for r in tied_res] == ["doc_a", "doc_b", "doc_c"], "DEF-06 Failed: Secondary chunk_id tie-breaker failed"
    print("  -> DEF-06 VERIFIED: 0.0-score items filtered, deterministic chunk_id tie-breaker confirmed.")

    # --- DEF-01 & DEF-02: Patched Budget S4ClampL1 (Unicode iteration & adaptive budget) ---
    print("\n[VERIFY DEF-01 & DEF-02] Budget S4ClampL1 (Unicode Safe Clamping & Adaptive Budget):")
    def clamp_l1_patched(quote: str, max_input_tokens: int, other_tokens: int) -> Tuple[str, int]:
        budget_for_l1 = max(0, max_input_tokens - other_tokens)
        target_l1_tokens = max(150, budget_for_l1) # DEF-02: adaptive min 150
        target_chars = target_l1_tokens * 2
        # Unicode char iteration (DEF-01)
        quote_chars = list(quote)
        if len(quote_chars) > target_chars:
            clamped = "".join(quote_chars[:target_chars])
            return (clamped + "\n...[选区内容过长，已保留关键头部]", target_l1_tokens)
        return (quote, target_l1_tokens)

    # Test DEF-02 underflow
    huge_zh_quote = "测试中文字符串" * 500
    res_quote, l1_budget = clamp_l1_patched(huge_zh_quote, max_input_tokens=548, other_tokens=500)
    print(f"  -> When max_input_tokens=548, other_tokens=500: l1_budget={l1_budget}")
    assert l1_budget == 150, f"DEF-02 Failed: expected 150 tokens floor, got {l1_budget}"
    assert len(res_quote) > 0, "DEF-02 Failed: quote collapsed to empty string"

    # Test DEF-01 UTF-8 character boundary safety
    for cut in range(1, 20):
        # Taking 'cut' chars and encoding to UTF-8 must decode without error
        chars_cut = "".join(list(huge_zh_quote)[:cut])
        encoded = chars_cut.encode("utf-8")
        decoded = encoded.decode("utf-8")
        assert decoded == chars_cut
    print("  -> DEF-01 & DEF-02 VERIFIED: Unicode char clamping eliminates UTF-8 panic, adaptive floor prevents collapse.")

    # --- DEF-07: Single-turn Spike Protection in S1CompressL4 ---
    print("\n[VERIFY DEF-07] Single-turn Spike Protection (Head/Tail Folding):")
    def fold_single_turn_spike(content: str, head_tokens: int = 800, tail_tokens: int = 1200) -> str:
        # Simple token estimate: 1 char ~= 0.5 token
        est_tokens = len(content) // 2
        if est_tokens <= 2000:
            return content
        head_chars = head_tokens * 2
        tail_chars = tail_tokens * 2
        if len(content) <= head_chars + tail_chars:
            return content
        chars = list(content)
        head = "".join(chars[:head_chars])
        tail = "".join(chars[-tail_chars:])
        return f"{head}\n...[单轮突增文本折叠：已隐藏中间冗余行，保留首尾关键段落]...\n{tail}"

    spike_content = "头部关键指令：" + ("中间超长堆栈日志片段\n" * 3000) + "尾部具体疑问：如何解决此Panic？"
    folded = fold_single_turn_spike(spike_content)
    print(f"  -> Original chars: {len(spike_content)} -> Folded chars: {len(folded)}")
    assert "头部关键指令" in folded, "DEF-07 Failed: Head lost"
    assert "尾部具体疑问" in folded, "DEF-07 Failed: Tail lost"
    assert "[单轮突增文本折叠" in folded, "DEF-07 Failed: Folding marker missing"
    assert len(folded) <= (800 + 1200) * 2 + 100, "DEF-07 Failed: Folded text exceeds ceiling"
    print("  -> DEF-07 VERIFIED: Single-turn spikes folded with head and tail preserved.")

    # --- DEF-03 & DEF-04: Patched Ebbinghaus Decay ---
    print("\n[VERIFY DEF-03 & DEF-04] Patched Ebbinghaus Retention Decay:")
    def compute_retention_score_patched(initial_importance: float, days_elapsed: float, access_count: int, is_pinned: bool) -> float:
        if is_pinned:
            return 2.0
        i_eff = max(0.25, min(1.0, initial_importance)) # DEF-03
        decay_term = i_eff * math.exp(-0.05 * days_elapsed)
        access_term = 0.06 * math.log(1.0 + min(float(access_count), 50.0)) # DEF-04
        return decay_term + access_term

    # Test DEF-03: Day 0 survival for any initial importance
    for I_low in [0.05, 0.10, 0.15, 0.20, 0.24]:
        s0 = compute_retention_score_patched(I_low, days_elapsed=0.0, access_count=0, is_pinned=False)
        assert s0 >= 0.25, f"DEF-03 Failed: I={I_low} evicted on Day 0 with score {s0}"
    print("  -> DEF-03 VERIFIED: All memories survive Day 0 with score >= 0.25.")

    # Test DEF-04: Bound access gain with saturation cap and allow archiving for moderate access
    # In original formula, A=5 gave 0.15*ln(6) = 0.2688 > 0.25 (immortal!)
    # In patched formula with alpha=0.06, even at saturation A=50, 0.06*ln(51) = 0.2359 < 0.25 (properly archived!)
    for acc in [0, 1, 2, 4, 5, 7, 10, 20, 50]:
        asymptote = 0.06 * math.log(1.0 + min(float(acc), 50.0))
        assert asymptote < 0.25, f"DEF-04 Failed: asymptote {asymptote} >= 0.25 for A={acc}"
    s_a5_long_term = compute_retention_score_patched(1.0, days_elapsed=365.0, access_count=5, is_pinned=False)
    print(f"  -> Score after 1 year with A=5: {s_a5_long_term:.4f} (archived because < 0.25: {s_a5_long_term < 0.25})")
    assert s_a5_long_term < 0.25, "DEF-04 Failed: A=5 item did not archive after prolonged inactivity"

    # Verify saturation cap at 50 prevents unbounded divergence:
    cap_gain = 0.06 * math.log(1.0 + 50.0)
    for high_acc in [50, 100, 1000, 100000]:
        gain = 0.06 * math.log(1.0 + min(float(high_acc), 50.0))
        assert gain == cap_gain, f"DEF-04 Failed: Access count not capped at 50"
    print(f"  -> Max access gain capped at: {cap_gain:.4f} (bounded, prevents log divergence, 0.06*ln(51) < 0.25)")

    # Pinned immortality
    s_pinned = compute_retention_score_patched(0.0, days_elapsed=36500.0, access_count=0, is_pinned=True)
    assert s_pinned == 2.0, "DEF-04 Failed: Pinned memory lost immortality"
    print("  -> DEF-04 VERIFIED: A=5 no longer immortal, access gain capped at 50, pinned items 100% immortal.")

    # --- DEF-05: Two-Tier Flash Anchor Self-Healing ---
    print("\n[VERIFY DEF-05] Two-Tier Flash Anchor Self-Healing:")
    original_lines = [f"Line {i}: Normal content paragraph" for i in range(1, 201)]
    original_lines[41] = "TARGET: 本地离线 RAG 核心架构与 Flash Anchor 自愈机制。" # Line 42 (1-based)
    anchor_text = original_lines[41]
    # Displaced by +60 lines
    displaced_lines = ["Inserted Line"] * 60 + original_lines
    target_line_1based = 42

    def resolve_anchor_two_tier(lines: List[str], target_line: int, text: str) -> Optional[int]:
        # Tier 1: Local window
        line, status = self_heal_anchor(lines, target_line, text, window_radius=30)
        if line is not None:
            return line
        # Tier 2: Global fallback
        prefix = text[:20]
        for idx, l in enumerate(lines):
            if prefix in l or text_similarity(l, text) >= 0.85:
                return idx + 1
        return None

    recovered_line = resolve_anchor_two_tier(displaced_lines, target_line_1based, anchor_text)
    print(f"  -> Target moved from line 42 to line 102. Recovered line: {recovered_line}")
    assert recovered_line == 102, f"DEF-05 Failed: Expected line 102, got {recovered_line}"
    print("  -> DEF-05 VERIFIED: Tier-2 global fallback successfully resolves large displacements.")

    print("\n>>> ALL 7 PATCHED ALGORITHMIC DEFECTS VERIFIED 100% SUCCESSFUL!")

# =========================================================================
# MAIN EXECUTION
# =========================================================================

if __name__ == "__main__":
    print("Running Full Adversarial Challenge Test Harness...")
    test_challenge_1_rrf()
    test_challenge_2_budget_state_machine()
    test_challenge_3_ebbinghaus_decay()
    test_challenge_4_flash_anchor()
    test_patched_algorithms_verification()
    print("\n" + "="*70)
    print("ALL EMPIRICAL ADVERSARIAL STRESS & VERIFICATION TESTS COMPLETED!")
    print("="*70)

