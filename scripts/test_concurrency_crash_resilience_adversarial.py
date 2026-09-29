#!/usr/bin/env python3
"""
scripts/test_concurrency_crash_resilience_adversarial.py
Adversarial Concurrency, Lock Contention, Memory Bounds, and Crash Resilience Stress Test Suite
for StuartMD AI-Wiki RAG Architecture.

Target Test Vectors:
1. SQLite Concurrent Access & Connection Architecture:
   - Single Arc<Mutex<Connection>> bottleneck (Reader latency starvation under batch indexing)
   - Reader/Writer Separation with WAL Mode (Zero-latency readers during write transactions)
   - Missing `busy_timeout` failure vs configured `busy_timeout` resilience
2. Incremental Indexing & File Watcher Race Conditions:
   - File deletion during debounce window & Ghost Chunks anomaly
   - Atomic file save self-triggering & temp file filtering (.~stuart_tmp_*)
   - File lock sharing conflict on Windows ReplaceFileW
3. Memory Bounds & Queue Backpressure:
   - Unbounded queue memory explosion simulation (10,000 files / 100,000 chunks)
   - Bounded channel backpressure memory bounding (< 2MB buffer)
   - CPU duty cycle calculation & Fan Spin throttle validation (15ms vs adaptive sleep)
4. Crash Resilience & Transactional Atomicity:
   - Partial file indexing crash & atomic document transaction rollback
   - SQLite corruption detection & auto-healing re-index
   - Two-phase atomic note creation (disk file + SQLite memory entry)
"""

import os
import sys
import io
import time
import shutil
import sqlite3
import tempfile
import threading
import queue
from pathlib import Path
from typing import List, Dict, Tuple, Optional

# Ensure UTF-8 output on Windows console
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


# =========================================================================
# 1. SQLITE CONCURRENCY & CONNECTION ARCHITECTURE BENCHMARK
# =========================================================================

def test_mutex_vs_reader_writer_pool():
    """
    Test Case 1.1: Compare Arc<Mutex<Connection>> (ROADMAP P1-2)
    vs Reader/Writer Separation under WAL mode.
    """
    print("\n" + "="*70)
    print("TEST 1.1: SQLite Mutex Contention vs Reader/Writer Separation (WAL)")
    print("="*70)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_concurrency.db")
        
        # Initialize DB with WAL mode
        init_conn = sqlite3.connect(db_path)
        init_conn.execute("PRAGMA journal_mode = WAL;")
        init_conn.execute("PRAGMA synchronous = NORMAL;")
        init_conn.execute("""
            CREATE TABLE doc_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_path TEXT NOT NULL,
                content TEXT NOT NULL
            );
        """)
        init_conn.commit()
        init_conn.close()

        # -------------------------------------------------------------
        # Part A: Simulating Arc<Mutex<Connection>> (Single Connection Locked by Mutex)
        # -------------------------------------------------------------
        mutex_conn = sqlite3.connect(db_path, check_same_thread=False)
        mutex_lock = threading.Lock()
        
        read_latencies_mutex = []
        writer_running = threading.Event()
        writer_running.set()
        
        def writer_thread_mutex():
            batch_count = 0
            while writer_running.is_set() and batch_count < 10:
                with mutex_lock:
                    # Hold mutex during batch write simulation (50ms per batch)
                    cur = mutex_conn.cursor()
                    cur.execute("BEGIN IMMEDIATE;")
                    for i in range(100):
                        chunk_id = f"chunk_mutex_{batch_count}_{i}"
                        cur.execute("INSERT OR REPLACE INTO doc_chunks VALUES (?, ?, ?)",
                                    (chunk_id, "doc1.md", "content " * 20))
                    time.sleep(0.060) # Simulate ONNX embedding + SQLite disk sync
                    mutex_conn.commit()
                batch_count += 1
                time.sleep(0.010)

        def reader_thread_mutex():
            for _ in range(30):
                t0 = time.perf_counter()
                with mutex_lock:
                    cur = mutex_conn.cursor()
                    cur.execute("SELECT count(*) FROM doc_chunks;")
                    _ = cur.fetchone()
                latency_ms = (time.perf_counter() - t0) * 1000.0
                read_latencies_mutex.append(latency_ms)
                time.sleep(0.005)

        tw_m = threading.Thread(target=writer_thread_mutex)
        tr_m = threading.Thread(target=reader_thread_mutex)
        tw_m.start()
        time.sleep(0.010) # Let writer start
        tr_m.start()
        tr_m.join()
        writer_running.clear()
        tw_m.join()
        mutex_conn.close()

        p95_mutex = sorted(read_latencies_mutex)[int(len(read_latencies_mutex)*0.95)]
        max_mutex = max(read_latencies_mutex)
        print(f"  [Architecture A: Arc<Mutex<Connection>> (Current ROADMAP)]")
        print(f"    • Reader Queries: {len(read_latencies_mutex)}")
        print(f"    • P95 Query Latency: {p95_mutex:.2f} ms")
        print(f"    • Max Query Latency: {max_mutex:.2f} ms")
        print(f"    • Starvation Result: {'FAILED (<15ms budget blown!)' if max_mutex > 15.0 else 'OK'}")

        # -------------------------------------------------------------
        # Part B: Simulating Reader/Writer Separation (Dedicated Connections with WAL)
        # -------------------------------------------------------------
        read_latencies_rw = []
        writer_running_rw = threading.Event()
        writer_running_rw.set()

        def writer_thread_rw():
            w_conn = sqlite3.connect(db_path, timeout=5.0)
            w_conn.execute("PRAGMA journal_mode = WAL;")
            batch_count = 0
            while writer_running_rw.is_set() and batch_count < 10:
                cur = w_conn.cursor()
                cur.execute("BEGIN IMMEDIATE;")
                for i in range(100):
                    chunk_id = f"chunk_rw_{batch_count}_{i}"
                    cur.execute("INSERT OR REPLACE INTO doc_chunks VALUES (?, ?, ?)",
                                (chunk_id, "doc1.md", "content " * 20))
                time.sleep(0.060) # Simulate ONNX embedding + SQLite sync
                w_conn.commit()
                batch_count += 1
                time.sleep(0.010)
            w_conn.close()

        def reader_thread_rw():
            # Dedicated reader connection
            r_conn = sqlite3.connect(db_path, timeout=5.0)
            r_conn.execute("PRAGMA journal_mode = WAL;")
            for _ in range(30):
                t0 = time.perf_counter()
                cur = r_conn.cursor()
                cur.execute("SELECT count(*) FROM doc_chunks;")
                _ = cur.fetchone()
                latency_ms = (time.perf_counter() - t0) * 1000.0
                read_latencies_rw.append(latency_ms)
                time.sleep(0.005)
            r_conn.close()

        tw_rw = threading.Thread(target=writer_thread_rw)
        tr_rw = threading.Thread(target=reader_thread_rw)
        tw_rw.start()
        time.sleep(0.010)
        tr_rw.start()
        tr_rw.join()
        writer_running_rw.clear()
        tw_rw.join()

        p95_rw = sorted(read_latencies_rw)[int(len(read_latencies_rw)*0.95)]
        max_rw = max(read_latencies_rw)
        print(f"  [Architecture B: Reader/Writer Separation (Recommended)]")
        print(f"    • Reader Queries: {len(read_latencies_rw)}")
        print(f"    • P95 Query Latency: {p95_rw:.2f} ms")
        print(f"    • Max Query Latency: {max_rw:.2f} ms")
        print(f"    • RAG Guarantee: {'PASS (< 15ms target satisfied!)' if max_rw < 15.0 else 'FAIL'}")

        assert max_mutex > 30.0, "Expected mutex to block reader significantly!"
        assert max_rw < 15.0, f"Expected reader/writer separation to be < 15ms, got {max_rw}ms"
        print("  => CONCLUSION: Single Arc<Mutex<Connection>> fatally blocks concurrent RAG reads.")
        print("     Reader/Writer separation MUST be adopted.\n")


def test_missing_busy_timeout():
    """
    Test Case 1.2: Demonstrate SQLITE_BUSY failure when PRAGMA busy_timeout is missing.
    """
    print("="*70)
    print("TEST 1.2: Missing busy_timeout vs Configured busy_timeout")
    print("="*70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_busy.db")
        
        # Initialize
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("CREATE TABLE test_data (id INT PRIMARY KEY, val TEXT);")
        conn.commit()
        conn.close()

        # Test A: Without busy_timeout (default 0ms in sqlite C API / rusqlite)
        conn1 = sqlite3.connect(db_path, timeout=0.0) # timeout=0 simulates missing busy_timeout
        conn2 = sqlite3.connect(db_path, timeout=0.0)
        
        conn1.execute("BEGIN EXCLUSIVE;")
        conn1.execute("INSERT INTO test_data VALUES (1, 'locked');")

        busy_raised = False
        try:
            conn2.execute("BEGIN EXCLUSIVE;")
        except sqlite3.OperationalError as e:
            busy_raised = True
            print(f"  [Without busy_timeout] Immediate failure: {e}")

        conn1.rollback()
        conn1.close()
        conn2.close()

        # Test B: With busy_timeout = 5000ms
        connB_ready = threading.Event()
        connA_committed = threading.Event()

        def thread_writer_A():
            cA = sqlite3.connect(db_path, timeout=5.0)
            cA.execute("BEGIN EXCLUSIVE;")
            cA.execute("INSERT INTO test_data VALUES (2, 'hold');")
            connB_ready.set()
            time.sleep(0.080)
            cA.commit()
            connA_committed.set()
            cA.close()

        t = threading.Thread(target=thread_writer_A)
        t.start()
        connB_ready.wait()

        # connB tries to acquire exclusive lock, but connA is holding it
        # With timeout=5.0 (busy_timeout 5000ms), connB waits until connA commits
        t0 = time.perf_counter()
        connB = sqlite3.connect(db_path, timeout=5.0)
        connB.execute("BEGIN EXCLUSIVE;")
        connB.execute("INSERT INTO test_data VALUES (3, 'success');")
        connB.commit()
        connB.close()
        t.join()
        elapsed = (time.perf_counter() - t0) * 1000.0
        print(f"  [With busy_timeout=5000ms] Gracefully queued & succeeded in {elapsed:.1f}ms")

        assert busy_raised, "Expected SQLITE_BUSY without busy_timeout"
        print("  => CONCLUSION: SPEC & ROADMAP must explicitly enforce PRAGMA busy_timeout = 5000;\n")



# =========================================================================
# 2. FILE WATCHER DEBOUNCING, RAPID DELETION & GHOST CHUNKS
# =========================================================================

def test_file_watcher_deletion_and_ghost_chunks():
    """
    Test Case 2.1: File deletion during debounce window produces Ghost Chunks
    if NotFound error does not trigger CASCADE DELETE.
    """
    print("="*70)
    print("TEST 2.1: File Watcher Deletion Race & Ghost Chunks Verification")
    print("="*70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "rag_watcher.db")
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("""
            CREATE TABLE rag_documents (
                doc_id TEXT PRIMARY KEY,
                rel_path TEXT UNIQUE NOT NULL,
                content_hash TEXT NOT NULL
            );
        """)
        conn.execute("""
            CREATE TABLE rag_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES rag_documents(doc_id) ON DELETE CASCADE
            );
        """)
        conn.commit()

        # Step 1: Initial file indexed
        doc_path = "notes/deleted_thought.md"
        doc_id = "hash_notes_deleted_thought"
        conn.execute("INSERT INTO rag_documents VALUES (?, ?, ?)", (doc_id, doc_path, "hash_1"))
        conn.execute("INSERT INTO rag_chunks VALUES (?, ?, ?)", ("chunk_001", doc_id, "Secret insight about quantum physics"))
        conn.commit()

        # Verify chunk exists
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM rag_chunks WHERE content LIKE '%quantum%';")
        assert cur.fetchone()[0] == 1, "Initial chunk should exist"

        # Step 2: Simulating Watcher Debounce:
        # Event arrives: Modify(notes/deleted_thought.md)
        # But before indexer executes, file is deleted on disk!
        # Indexer does:
        # try { read_to_string(path) } catch (NotFound)
        
        # FLUID DEFECT: If indexer simply does `log::warn!("File not found, skipping: {}", path); return Ok(());`
        # then doc_chunks still contains the deleted file's chunks!
        def flawed_indexer_handle_event(rel_path: str, file_exists: bool, db):
            if not file_exists:
                # Flawed: ignores deletion, just returns
                # log::warn!("File {} missing, skipping", rel_path)
                return "SKIPPED_IGNORE"
            return "INDEXED"

        # Robust indexer handles NotFound by purging doc:
        def robust_indexer_handle_event(rel_path: str, file_exists: bool, db):
            if not file_exists:
                # Purge from DB
                db.execute("DELETE FROM rag_documents WHERE rel_path = ?;", (rel_path,))
                db.commit()
                return "PURGED_GHOST_CHUNKS"
            return "INDEXED"

        # Test flawed behavior:
        flawed_indexer_handle_event(doc_path, False, conn)
        cur.execute("SELECT count(*) FROM rag_chunks WHERE content LIKE '%quantum%';")
        ghost_count = cur.fetchone()[0]
        print(f"  [Flawed Watcher Handler] Ghost chunks remaining in index: {ghost_count}")
        assert ghost_count == 1, "Ghost chunks remained!"

        # Test robust behavior:
        robust_indexer_handle_event(doc_path, False, conn)
        cur.execute("SELECT count(*) FROM rag_chunks WHERE content LIKE '%quantum%';")
        purged_count = cur.fetchone()[0]
        print(f"  [Robust Watcher Handler] Ghost chunks remaining after purge: {purged_count}")
        assert purged_count == 0, "Ghost chunks successfully purged!"

        conn.close()
        print("  => CONCLUSION: Watcher MUST treat std::io::ErrorKind::NotFound as an implicit")
        print("     DELETE event to prevent stale ghost chunks from polluting RAG.\n")


def test_atomic_save_temp_file_filter():
    """
    Test Case 2.2: Verify Watcher temp-file regex filter for StuartMD's atomic write.
    """
    print("="*70)
    print("TEST 2.2: StuartMD Atomic Save Temp File Filtering Pattern")
    print("="*70)

    import re
    # Temp file format from fs_api.rs & SPEC 5.3:
    # .~stuart_tmp_{pid}_{seq}_{timestamp}.tmp
    temp_pattern = re.compile(r"^(\.~stuart_tmp_.*|\..*\.tmp|.*\.tmp|.*~|\.#.*|~\$.*|.*\.swp)$", re.IGNORECASE)

    test_paths = [
        (".~stuart_tmp_1234_1_1727142000.tmp", True),
        (".~stuart_tmp_99.tmp", True),
        ("subfolder/.~stuart_tmp_1.tmp", True),
        ("regular_note.md", False),
        ("paper.pdf", False),
        ("notes.md.tmp", True),
        ("notes.md~", True),
        (".#notes.md", True),
        ("~$draft.docx", True),
        ("notes.swp", True),
    ]

    for p, should_filter in test_paths:
        filename = os.path.basename(p)
        matched = bool(temp_pattern.match(filename))
        print(f"  Path: {p:<40} -> Ignored: {matched:<5} (Expected: {should_filter})")
        assert matched == should_filter, f"Pattern failed on {p}"

    print("  => CONCLUSION: Watcher must apply filename-level regex filtering prior to debounce.\n")


# =========================================================================
# 3. MEMORY BOUNDS & QUEUE BACKPRESSURE UNDER 10,000 FILES
# =========================================================================

def test_extreme_vault_memory_bounds():
    """
    Test Case 3.1: Simulate 10,000 files / 100,000 chunks memory footprint:
    Unbounded Queue vs Bounded Backpressure Channel.
    """
    print("="*70)
    print("TEST 3.1: Extreme Vault Indexing (10,000 Files) Memory Bounds & Backpressure")
    print("="*70)

    NUM_FILES = 10_000
    CHUNKS_PER_FILE = 8
    TOTAL_CHUNKS = NUM_FILES * CHUNKS_PER_FILE # 80,000 chunks
    CHUNK_CHARS = 500 # ~500 chars per chunk

    # Theoretical memory calculations:
    raw_text_bytes = TOTAL_CHUNKS * CHUNK_CHARS * 2 # UTF-8/UTF-16 in memory ~ 80MB
    # 512-dim f32 vector: 512 * 4 = 2048 bytes
    raw_vector_bytes = TOTAL_CHUNKS * 512 * 4 # 80,000 * 2048 = 163,840,000 bytes = 163.84 MB
    
    total_unbounded_mb = (raw_text_bytes + raw_vector_bytes) / (1024 * 1024)
    print(f"  • Vault Scale: {NUM_FILES:,} files | {TOTAL_CHUNKS:,} chunks")
    print(f"  • Raw Text Heap in Unbounded Queue: {raw_text_bytes / (1024*1024):.2f} MB")
    print(f"  • Raw Vector Float Buffers (512-dim): {raw_vector_bytes / (1024*1024):.2f} MB")
    print(f"  • Total In-Flight Unbounded Heap: {total_unbounded_mb:.2f} MB (EXCEEDS 200MB LIMIT!)")

    # Simulation with Bounded Queue (Capacity = 64 chunks)
    bounded_channel = queue.Queue(maxsize=64)
    producer_stopped = threading.Event()
    consumed_count = [0]
    max_queue_depth = [0]

    def mock_producer():
        # Scans vault and puts chunks into bounded channel
        for i in range(1000): # Sample 1,000 chunks for quick test
            item = (f"doc_{i//8}.md", f"chunk_{i}", "x" * CHUNK_CHARS)
            bounded_channel.put(item) # Blocks if queue is full (Backpressure!)
            if bounded_channel.qsize() > max_queue_depth[0]:
                max_queue_depth[0] = bounded_channel.qsize()
        producer_stopped.set()

    def mock_consumer():
        # Simulates batch ONNX embedding + SQLite transaction
        while not (producer_stopped.is_set() and bounded_channel.empty()):
            batch = []
            try:
                for _ in range(16): # Batch size 16
                    batch.append(bounded_channel.get_nowait())
            except queue.Empty:
                pass
            
            if batch:
                # Process batch of 16 chunks
                time.sleep(0.005) # Simulate inference
                consumed_count[0] += len(batch)
                for _ in batch:
                    bounded_channel.task_done()

    t_prod = threading.Thread(target=mock_producer)
    t_cons = threading.Thread(target=mock_consumer)
    t_prod.start()
    t_cons.start()
    t_prod.join()
    t_cons.join()

    bounded_max_mb = (64 * CHUNK_CHARS * 2 + 64 * 512 * 4) / (1024 * 1024)
    print(f"  [Bounded Backpressure Architecture (Capacity=64)]")
    print(f"    • Max Channel Depth: {max_queue_depth[0]} chunks")
    print(f"    • In-Flight Queue Memory Peak: {bounded_max_mb:.3f} MB (< 0.2 MB!)")
    print(f"    • Total Chunks Processed: {consumed_count[0]}")
    print("  => CONCLUSION: Ingestion pipeline MUST enforce a bounded mpsc channel (max 64 chunks)")
    print("     to strictly bound heap usage below the 200MB ceiling.\n")


def test_cpu_fan_spin_throttle_calculation():
    """
    Test Case 3.2: Verify CPU Duty Cycle throttle formula (SPEC 3.5 claims 15ms sleep = 25% CPU).
    """
    print("="*70)
    print("TEST 3.2: CPU Fan Spin Throttle Duty Cycle Verification")
    print("="*70)

    # In SPEC line 383 & 691:
    # "每完成一个 Batch (16 chunks) 计算，强行休眠 15ms，限制 CPU 占空比在 25% 以内"
    # Let's test the math:
    # FastEmbed ONNX BGE-small-zh on standard CPU takes ~6-10ms per 20-token sentence.
    # For a 16-chunk batch of ~400 chars (200 tokens) each:
    # 16 chunks * 6ms = ~96ms of intensive CPU SIMD execution time (T_compute).
    
    t_compute_ms = 96.0
    t_sleep_spec_ms = 15.0
    
    duty_cycle_spec = t_compute_ms / (t_compute_ms + t_sleep_spec_ms)
    print(f"  • Estimated Batch Compute Time (16 chunks): {t_compute_ms:.1f} ms")
    print(f"  • SPEC Hardcoded Sleep: {t_sleep_spec_ms:.1f} ms")
    print(f"  • Resulting CPU Duty Cycle: {duty_cycle_spec * 100:.1f}%")
    print(f"  • Claimed Duty Cycle: 25.0%")
    print(f"  • DISCREPANCY: Duty cycle is {duty_cycle_spec * 100:.1f}%, NOT 25% (Fan will spin wildly!)")

    # Correct adaptive sleep formula for target duty cycle D = 0.25:
    # D = T_compute / (T_compute + T_sleep) => T_sleep = T_compute * (1 - D) / D
    target_d = 0.25
    correct_sleep_ms = t_compute_ms * (1.0 - target_d) / target_d
    print(f"  • Required Adaptive Sleep for 25% Duty Cycle: {correct_sleep_ms:.1f} ms")
    print("  => CONCLUSION: SPEC 3.5 hardcoded 15ms sleep is an order-of-magnitude bug.")
    print("     The implementation MUST dynamically measure batch elapsed time and sleep")
    print("     T_sleep = T_batch * 3.0 to genuinely enforce <= 25% CPU duty cycle.\n")


# =========================================================================
# 4. PROCESS CRASH RESILIENCE & ATOMIC RECOVERY
# =========================================================================

def test_atomic_document_transaction_crash():
    """
    Test Case 4.1: Simulate crash during indexing a 5-chunk document.
    Verify atomicity prevents partial/corrupt documents.
    """
    print("="*70)
    print("TEST 4.1: Atomic Document Transaction Crash & Rollback Simulation")
    print("="*70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "crash_test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("""
            CREATE TABLE rag_documents (
                doc_id TEXT PRIMARY KEY,
                rel_path TEXT UNIQUE NOT NULL,
                content_hash TEXT NOT NULL,
                total_chunks INTEGER NOT NULL
            );
        """)
        conn.execute("""
            CREATE TABLE rag_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES rag_documents(doc_id) ON DELETE CASCADE
            );
        """)
        conn.commit()

        # Simulate Crash during File Indexing:
        # File has 5 chunks. Crash happens at chunk 3!
        try:
            conn.execute("BEGIN TRANSACTION;")
            doc_id = "doc_crash_sample"
            conn.execute("INSERT INTO rag_documents VALUES (?, ?, ?, ?)",
                         (doc_id, "notes/crash.md", "hash_full_content", 5))
            
            for i in range(3): # Only 3 inserted
                conn.execute("INSERT INTO rag_chunks VALUES (?, ?, ?, ?)",
                             (f"{doc_id}_{i}", doc_id, i, f"chunk text {i}"))
                
            # CRASH SIMULATION:
            raise RuntimeError("SIMULATED PROCESS CRASH (SIGKILL / OOM)!")
            conn.commit()
        except RuntimeError:
            conn.rollback() # SQLite rollback on crash
            print("  [Simulated Crash Triggered & Rolled Back]")

        # Check DB State:
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM rag_documents WHERE doc_id = 'doc_crash_sample';")
        doc_count = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM rag_chunks WHERE doc_id = 'doc_crash_sample';")
        chunk_count = cur.fetchone()[0]

        print(f"  • Documents in DB: {doc_count} (Expected: 0)")
        print(f"  • Chunks in DB: {chunk_count} (Expected: 0)")
        assert doc_count == 0 and chunk_count == 0, "Partial write leaked into DB!"
        
        # Now simulate restart:
        # Since doc_id is NOT in rag_documents, scanner detects file needs full reindexing
        # and reindexes all 5 chunks completely:
        conn.execute("BEGIN TRANSACTION;")
        conn.execute("INSERT INTO rag_documents VALUES (?, ?, ?, ?)",
                     (doc_id, "notes/crash.md", "hash_full_content", 5))
        for i in range(5):
            conn.execute("INSERT INTO rag_chunks VALUES (?, ?, ?, ?)",
                         (f"{doc_id}_{i}", doc_id, i, f"chunk text {i}"))
        conn.commit()

        cur.execute("SELECT count(*) FROM rag_chunks WHERE doc_id = 'doc_crash_sample';")
        assert cur.fetchone()[0] == 5
        print("  • Recovery Re-index: Successfully indexed all 5 chunks without orphans.")
        conn.close()
        print("  => CONCLUSION: Document indexing MUST be wrapped in a strict atomic transaction")
        print("     per document (or batch of documents) so crash never leaves partial index state.\n")


def test_sqlite_corruption_and_healing_recovery():
    """
    Test Case 4.2: Simulate corrupted database header / sector and auto-recovery.
    """
    print("="*70)
    print("TEST 4.2: SQLite Database Corruption Detection & Auto-Healing")
    print("="*70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "rag.db")
        
        # 1. Create a valid DB
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE valid_test (id INT);")
        conn.commit()
        conn.close()

        # 2. Corrupt the database file (truncate / overwrite header)
        with open(db_path, "wb") as f:
            f.write(b"CORRUPTED_GARBAGE_BYTES_SIMULATING_DISK_SECTOR_FAILURE" * 10)

        # 3. Simulate StuartMD Engine startup integrity check
        def open_or_recover_db(path_str: str) -> sqlite3.Connection:
            c = None
            try:
                c = sqlite3.connect(path_str)
                # Quick integrity check
                cur = c.cursor()
                cur.execute("PRAGMA schema_version;")
                cur.fetchone()
                return c
            except sqlite3.DatabaseError as e:
                print(f"  • Corruption Detected: {e}")
                # CRITICAL WINDOWS FIX: Must explicitly close connection handle
                # otherwise Windows throws WinError 32 (Sharing Violation) on rename!
                if c is not None:
                    c.close()
                    c = None
                
                # Backup corrupted file
                corrupt_backup = f"{path_str}.corrupt.{int(time.time())}"
                if os.path.exists(path_str):
                    shutil.move(path_str, corrupt_backup)
                    print(f"  • Moved corrupt database to: {corrupt_backup}")
                
                # Re-initialize clean DB
                new_conn = sqlite3.connect(path_str)
                new_conn.execute("PRAGMA journal_mode = WAL;")
                new_conn.execute("CREATE TABLE valid_test (id INT);")
                new_conn.commit()
                print("  • Re-initialized fresh database successfully.")
                return new_conn


        recovered_conn = open_or_recover_db(db_path)
        cur = recovered_conn.cursor()
        cur.execute("SELECT count(*) FROM valid_test;")
        count = cur.fetchone()[0]
        recovered_conn.close()

        assert count == 0
        assert os.path.exists(db_path)
        print("  => CONCLUSION: Auto-healing recovery correctly isolates corrupt file and recovers.\n")


def test_two_phase_atomic_note_creation():
    """
    Test Case 4.3: Two-Phase Atomic Note Creation (Disk File + SQLite DB).
    Verifies that if DB transaction fails, disk file is cleanly rolled back (no orphan files).
    """
    print("="*70)
    print("TEST 4.3: Two-Phase Atomic Note Creation Rollback (Disk + DB)")
    print("="*70)

    with tempfile.TemporaryDirectory() as tmpdir:
        vault_root = Path(tmpdir)
        wiki_dir = vault_root / ".stuart" / "wiki" / "concepts"
        wiki_dir.mkdir(parents=True, exist_ok=True)

        db_path = vault_root / "chat_archive.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE organic_memories (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                file_ref TEXT UNIQUE NOT NULL
            );
        """)
        conn.commit()

        # Two-phase note creation function
        def create_concept_note_two_phase(concept_id: str, content: str, simulate_db_error: bool = False):
            note_file = wiki_dir / f"{concept_id}.md"
            temp_file = wiki_dir / f".~stuart_tmp_{concept_id}.tmp"

            # Phase 1: Atomic File Write to Disk
            with open(temp_file, "w", encoding="utf-8") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            temp_file.replace(note_file)

            # Phase 2: Register in SQLite DB
            try:
                conn.execute("BEGIN TRANSACTION;")
                if simulate_db_error:
                    raise sqlite3.OperationalError("Simulated DB Unique Constraint Violation!")
                conn.execute("INSERT INTO organic_memories VALUES (?, ?, ?)",
                             (concept_id, "concept", str(note_file.relative_to(vault_root))))
                conn.commit()
                return True
            except Exception as e:
                conn.rollback()
                # Compensating Action: Rollback disk file
                if note_file.exists():
                    note_file.unlink()
                print(f"  • DB failure occurred ({e}). Successfully unlinked orphan note: {note_file.name}")
                return False

        # Test A: Successful creation
        res1 = create_concept_note_two_phase("concept_001", "# Concept 1\nDetails...", simulate_db_error=False)
        assert res1 is True
        assert (wiki_dir / "concept_001.md").exists()
        print("  • Note 1 created and registered successfully.")

        # Test B: Failure during DB phase -> Disk file rolled back
        res2 = create_concept_note_two_phase("concept_002", "# Concept 2\nDetails...", simulate_db_error=True)
        assert res2 is False
        assert not (wiki_dir / "concept_002.md").exists(), "Orphan file remained on disk!"
        print("  • Note 2 aborted without leaving orphan file.")

        conn.close()
        print("  => CONCLUSION: Note creation requires a two-phase commit with file unlinking")
        print("     compensation to guarantee strict file-system / database consistency.\n")


# =========================================================================
# MAIN EXECUTION ENTRYPOINT
# =========================================================================

if __name__ == "__main__":
    print("="*70)
    print(" StuartMD Concurrency, Lock Contention & Crash Resilience Test Suite")
    print("="*70)
    test_mutex_vs_reader_writer_pool()
    test_missing_busy_timeout()
    test_file_watcher_deletion_and_ghost_chunks()
    test_atomic_save_temp_file_filter()
    test_extreme_vault_memory_bounds()
    test_cpu_fan_spin_throttle_calculation()
    test_atomic_document_transaction_crash()
    test_sqlite_corruption_and_healing_recovery()
    test_two_phase_atomic_note_creation()
    print("="*70)
    print(">> ALL CONCURRENCY & RESILIENCE ADVERSARIAL TESTS COMPLETED <<")
    print("="*70)
