#!/usr/bin/env python3
"""
scripts/test_challenger_m1_deep_adversarial.py
Deep Adversarial Stress and Verification Harness for Challenger M1 WAL
Tests:
1. High-concurrency Reader P95 Latency (< 15ms target) under active writer load.
2. busy_timeout = 5000ms prevents SQLITE_BUSY crashes under lock contention.
3. Windows file locking & corruption recovery handle-drop (WinError 32 prevention).
4. Foreign key cascades (PRAGMA foreign_keys=ON) and trigger cleanup of FTS5 tables on cascade.
5. FTS5 Trigram & Query Sanitization robustness against adversarial queries.
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

# Force UTF-8 output
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def run_test_1_reader_p95_under_heavy_writer():
    print("=" * 70)
    print("CHALLENGER DEEP TEST 1: Concurrent Reader P95 Latency Under Heavy Writer")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "stress_p95.db")

        # Initialize WAL database
        init_conn = sqlite3.connect(db_path)
        init_conn.execute("PRAGMA journal_mode = WAL;")
        init_conn.execute("PRAGMA synchronous = NORMAL;")
        init_conn.execute("PRAGMA busy_timeout = 5000;")
        init_conn.execute("""
            CREATE TABLE rag_documents (
                doc_id TEXT PRIMARY KEY,
                rel_path TEXT UNIQUE NOT NULL
            );
        """)
        init_conn.execute("""
            CREATE TABLE rag_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                content TEXT NOT NULL
            );
        """)
        # Prepopulate with 500 chunks
        for d in range(10):
            init_conn.execute("INSERT INTO rag_documents VALUES (?, ?)", (f"doc_{d}", f"path/doc_{d}.md"))
            for c in range(50):
                init_conn.execute("INSERT INTO rag_chunks VALUES (?, ?, ?)",
                                  (f"chunk_{d}_{c}", f"doc_{d}", f"Content sample line {c} " * 10))
        init_conn.commit()
        init_conn.close()

        # Dedicated continuous writer thread
        writer_stop = threading.Event()
        writer_errors = []
        writer_batches = [0]

        def heavy_writer():
            try:
                w_conn = sqlite3.connect(db_path, timeout=5.0)
                w_conn.execute("PRAGMA journal_mode = WAL;")
                w_conn.execute("PRAGMA synchronous = NORMAL;")
                w_conn.execute("PRAGMA busy_timeout = 5000;")
                batch = 0
                while not writer_stop.is_set():
                    cur = w_conn.cursor()
                    cur.execute("BEGIN IMMEDIATE;")
                    for i in range(25):
                        cur.execute("INSERT OR REPLACE INTO rag_chunks VALUES (?, ?, ?)",
                                    (f"dynamic_chunk_{batch}_{i}", f"doc_{batch % 10}", "Updated heavy text payload " * 12))
                    # Simulate batch computation / fsync
                    time.sleep(0.015)
                    w_conn.commit()
                    batch += 1
                    writer_batches[0] = batch
                    time.sleep(0.005)
                w_conn.close()
            except Exception as e:
                writer_errors.append(f"Writer error: {e}")

        tw = threading.Thread(target=heavy_writer)
        tw.start()

        # 12 Concurrent readers performing 100 queries each = 1,200 reads
        NUM_READERS = 12
        QUERIES_PER_READER = 100
        latencies = []
        lat_lock = threading.Lock()
        reader_errors = []

        def reader_worker(r_id):
            try:
                r_conn = sqlite3.connect(db_path, timeout=5.0)
                r_conn.execute("PRAGMA journal_mode = WAL;")
                r_conn.execute("PRAGMA busy_timeout = 5000;")
                r_conn.execute("PRAGMA query_only = ON;")
                local_lats = []
                for _ in range(QUERIES_PER_READER):
                    t0 = time.perf_counter()
                    cur = r_conn.cursor()
                    cur.execute("SELECT count(*), max(chunk_id) FROM rag_chunks;")
                    _ = cur.fetchone()
                    lat_ms = (time.perf_counter() - t0) * 1000.0
                    local_lats.append(lat_ms)
                    time.sleep(0.001)
                r_conn.close()
                with lat_lock:
                    latencies.extend(local_lats)
            except Exception as e:
                reader_errors.append(f"Reader {r_id} error: {e}")

        reader_threads = [threading.Thread(target=reader_worker, args=(i,)) for i in range(NUM_READERS)]
        for t in reader_threads:
            t.start()
        for t in reader_threads:
            t.join()

        writer_stop.set()
        tw.join()

        assert len(writer_errors) == 0, f"Writer failed: {writer_errors}"
        assert len(reader_errors) == 0, f"Readers failed: {reader_errors}"

        latencies.sort()
        n = len(latencies)
        p50 = latencies[int(n * 0.50)]
        p90 = latencies[int(n * 0.90)]
        p95 = latencies[int(n * 0.95)]
        p99 = latencies[int(n * 0.99)]
        max_lat = max(latencies)

        print(f"  • Concurrent Reader Threads: {NUM_READERS} (Total queries executed: {n})")
        print(f"  • Writer Batches Committed Concurrently: {writer_batches[0]}")
        print(f"  • P50 Latency: {p50:.3f} ms")
        print(f"  • P90 Latency: {p90:.3f} ms")
        print(f"  • P95 Latency: {p95:.3f} ms (Target: < 15.0 ms)")
        print(f"  • P99 Latency: {p99:.3f} ms")
        print(f"  • Max Latency: {max_lat:.3f} ms")

        assert p95 < 15.0, f"P95 latency {p95:.2f}ms violated SLA (> 15.0ms)!"
        print(f"  => RESULT: PASS (P95={p95:.3f}ms < 15ms target)\n")


def run_test_2_busy_timeout_contention():
    print("=" * 70)
    print("CHALLENGER DEEP TEST 2: busy_timeout = 5000 Contention & SQLITE_BUSY")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "busy_test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("CREATE TABLE counter (id INT PRIMARY KEY, val INT);")
        conn.execute("INSERT INTO counter VALUES (1, 0);")
        conn.commit()
        conn.close()

        # Part A: With timeout=0 (no busy_timeout), immediate lock collision raises OperationalError
        conn_holder = sqlite3.connect(db_path, timeout=0.0)
        conn_holder.execute("BEGIN EXCLUSIVE;")
        conn_holder.execute("UPDATE counter SET val = val + 1 WHERE id = 1;")

        conn_intruder = sqlite3.connect(db_path, timeout=0.0)
        sqlite_busy_occurred = False
        try:
            conn_intruder.execute("BEGIN EXCLUSIVE;")
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e) or "busy" in str(e).lower():
                sqlite_busy_occurred = True
                print(f"  • Confirmed immediate failure without busy_timeout: {e}")

        conn_intruder.close()
        conn_holder.rollback()
        conn_holder.close()
        assert sqlite_busy_occurred, "Expected SQLITE_BUSY without busy_timeout!"

        # Part B: With busy_timeout = 5000ms, second connection waits for lock release
        lock_acquired_event = threading.Event()
        writer_released_event = threading.Event()

        def slow_writer():
            c = sqlite3.connect(db_path, timeout=5.0)
            c.execute("BEGIN EXCLUSIVE;")
            c.execute("UPDATE counter SET val = 100 WHERE id = 1;")
            lock_acquired_event.set()
            time.sleep(0.150) # Hold lock for 150ms
            c.commit()
            writer_released_event.set()
            c.close()

        t = threading.Thread(target=slow_writer)
        t.start()
        lock_acquired_event.wait()

        # Competing connection with timeout=5.0 should wait up to 5000ms and succeed
        t0 = time.perf_counter()
        c2 = sqlite3.connect(db_path, timeout=5.0)
        c2.execute("PRAGMA busy_timeout = 5000;")
        c2.execute("BEGIN EXCLUSIVE;")
        c2.execute("UPDATE counter SET val = 200 WHERE id = 1;")
        c2.commit()
        c2.close()
        wait_duration_ms = (time.perf_counter() - t0) * 1000.0

        t.join()
        print(f"  • With busy_timeout=5000: Waited {wait_duration_ms:.1f}ms and acquired lock without crash.")
        assert wait_duration_ms >= 140.0, f"Expected wait of at least 140ms, got {wait_duration_ms:.1f}ms"
        print("  => RESULT: PASS (busy_timeout=5000 successfully prevents SQLITE_BUSY crash)\n")


def run_test_3_windows_error_32_and_corruption_recovery():
    print("=" * 70)
    print("CHALLENGER DEEP TEST 3: Windows Handle Release & Corruption Recovery")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "corrupt_target.db")

        # Create valid database
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("CREATE TABLE status (msg TEXT);")
        conn.execute("INSERT INTO status VALUES ('healthy');")
        conn.commit()

        # Step 1: Prove that an OPEN handle triggers WinError 32 on Windows
        corrupt_dest = os.path.join(tmpdir, "corrupt_target.db.corrupt")
        win_error_32_triggered = False
        try:
            shutil.move(db_path, corrupt_dest)
        except (PermissionError, OSError) as e:
            win_error_32_triggered = True
            print(f"  • Open handle rename threw expected OS error: {e}")

        if os.name == 'nt':
            assert win_error_32_triggered, "Expected WinError 32 on Windows while handle is open!"

        # Step 2: Simulate DEF-CONC-07 handle drop
        conn.close()
        conn = None

        # Step 3: Now corrupt file and execute recovery
        with open(db_path, "wb") as f:
            f.write(b"CORRUPTED_DISK_HEAD_BYTES_FAIL" * 16)

        # Execute recovery logic (same as RagStorage::heal_and_reopen)
        def recover_database(path_to_db: str):
            c = None
            try:
                c = sqlite3.connect(path_to_db)
                c.execute("PRAGMA schema_version;").fetchone()
                return c
            except sqlite3.DatabaseError as err:
                print(f"  • Detected corruption: {err}")
                # Handle must be dropped before rename!
                if c is not None:
                    c.close()
                    c = None
                
                # Rename corrupt database
                ts = int(time.time())
                backup_name = f"{path_to_db}.corrupt.{ts}"
                if os.path.exists(path_to_db):
                    shutil.move(path_to_db, backup_name)
                    print(f"  • Corrupt database cleanly moved to: {os.path.basename(backup_name)}")
                
                # Reopen fresh database
                fresh = sqlite3.connect(path_to_db)
                fresh.execute("PRAGMA journal_mode = WAL;")
                fresh.execute("CREATE TABLE status (msg TEXT);")
                fresh.execute("INSERT INTO status VALUES ('recovered');")
                fresh.commit()
                return fresh

        recovered = recover_database(db_path)
        row = recovered.execute("SELECT msg FROM status;").fetchone()
        assert row[0] == "recovered", f"Expected 'recovered', got {row[0]}"
        recovered.close()
        print("  => RESULT: PASS (Connection handle cleanly dropped, no WinError 32, DB auto-healed)\n")


def run_test_4_fk_cascades_and_fts_triggers():
    print("=" * 70)
    print("CHALLENGER DEEP TEST 4: Foreign Key Cascades & FTS5 Trigram Trigger Cleanup")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "fk_test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")

        # Exact schema from RagStorage::init_schema
        conn.execute("""
            CREATE TABLE rag_documents (
                doc_id TEXT PRIMARY KEY,
                rel_path TEXT UNIQUE NOT NULL
            );
        """)
        conn.execute("""
            CREATE TABLE rag_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                heading_path TEXT NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES rag_documents(doc_id) ON DELETE CASCADE
            );
        """)
        conn.execute("""
            CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                heading_path,
                content,
                tokenize = 'trigram'
            );
        """)
        conn.execute("""
            CREATE TRIGGER trg_rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
                INSERT INTO rag_chunks_fts(chunk_id, heading_path, content)
                VALUES (new.chunk_id, new.heading_path, new.content);
            END;
        """)
        conn.execute("""
            CREATE TRIGGER trg_rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
                DELETE FROM rag_chunks_fts WHERE chunk_id = old.chunk_id;
            END;
        """)
        conn.commit()

        # Insert 3 documents with 5 chunks each = 15 chunks
        for d in range(3):
            doc_id = f"doc_{d}"
            conn.execute("INSERT INTO rag_documents VALUES (?, ?)", (doc_id, f"notes/doc_{d}.md"))
            for c in range(5):
                chunk_id = f"chunk_{d}_{c}"
                conn.execute("INSERT INTO rag_chunks VALUES (?, ?, ?, ?)",
                             (chunk_id, doc_id, f"Section {c}", f"Artificial Intelligence Concept {d}-{c}"))
        conn.commit()

        # Verify initial counts
        doc_count = conn.execute("SELECT count(*) FROM rag_documents;").fetchone()[0]
        chunk_count = conn.execute("SELECT count(*) FROM rag_chunks;").fetchone()[0]
        fts_count = conn.execute("SELECT count(*) FROM rag_chunks_fts;").fetchone()[0]
        print(f"  • Initial counts -> Docs: {doc_count}, Chunks: {chunk_count}, FTS rows: {fts_count}")
        assert doc_count == 3 and chunk_count == 15 and fts_count == 15

        # Query FTS to confirm trigram search is working
        cur = conn.cursor()
        cur.execute("SELECT chunk_id, content FROM rag_chunks_fts WHERE rag_chunks_fts MATCH 'Artificial';")
        matches = cur.fetchall()
        print(f"  • FTS MATCH 'Artificial' found: {len(matches)} entries")
        assert len(matches) == 15

        # Test CASCADE DELETE: Delete 1 document directly from rag_documents
        print("  • Executing: DELETE FROM rag_documents WHERE doc_id = 'doc_1';")
        conn.execute("DELETE FROM rag_documents WHERE doc_id = 'doc_1';")
        conn.commit()

        # Check remaining counts
        docs_left = conn.execute("SELECT count(*) FROM rag_documents;").fetchone()[0]
        chunks_left = conn.execute("SELECT count(*) FROM rag_chunks;").fetchone()[0]
        fts_left = conn.execute("SELECT count(*) FROM rag_chunks_fts;").fetchone()[0]

        print(f"  • After CASCADE -> Docs: {docs_left} (Exp: 2), Chunks: {chunks_left} (Exp: 10), FTS: {fts_left} (Exp: 10)")
        assert docs_left == 2, f"Expected 2 docs left, got {docs_left}"
        assert chunks_left == 10, f"Expected 10 chunks left, got {chunks_left}"
        assert fts_left == 10, f"Expected 10 FTS rows left, got {fts_left} (Trigger trg_rag_chunks_ad fired on CASCADE!)"

        # Check that specific deleted chunks are gone from FTS
        cur.execute("SELECT count(*) FROM rag_chunks_fts WHERE chunk_id LIKE 'chunk_1_%';")
        ghost_fts_count = cur.fetchone()[0]
        print(f"  • Ghost FTS entries for doc_1: {ghost_fts_count} (Exp: 0)")
        assert ghost_fts_count == 0, f"Ghost FTS entries remained: {ghost_fts_count}"

        conn.close()
        print("  => RESULT: PASS (FK CASCADE + AFTER DELETE Trigger cleanly synchronized FTS5)\n")


def run_test_5_fts_trigram_adversarial_queries():
    print("=" * 70)
    print("CHALLENGER DEEP TEST 5: FTS5 Trigram Adversarial Query Syntax Fuzzing")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "fuzz_fts.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE VIRTUAL TABLE test_fts USING fts5(
                content,
                tokenize = 'trigram'
            );
        """)
        conn.execute("INSERT INTO test_fts VALUES ('fn stuart_open_url(url: &str) -> Result<(), String> {');")
        conn.execute("INSERT INTO test_fts VALUES ('深度学习与知识图谱混合检索模型研究与实践');")
        conn.execute("INSERT INTO test_fts VALUES ('Unicode test: 💖 emojis and 123 numbers.');")
        conn.commit()

        # Sanitizer implementation identical to rag::fts::escape_fts5_query
        def escape_fts5_query(raw: str) -> str:
            sanitized = "".join(
                c for c in raw
                if c != '\0' and (not (ord(c) < 32 or ord(c) == 127) or c in ('\t', '\n', '\r'))
            )
            trimmed = sanitized.strip()
            if not trimmed:
                return '""'
            escaped = trimmed.replace('"', '""')
            return f'"{escaped}"'

        adversarial_inputs = [
            'normal query',
            '',
            '   ',
            'a',
            'ab',
            'abc',
            '"',
            '""',
            '"""',
            'unmatched " quote',
            'AND OR NOT',
            'NEAR(a, b)',
            'col:value',
            'C++ and C#',
            'file.rs:42:15',
            '*** wildcard ***',
            'SELECT * FROM users WHERE 1=1;',
            'DROP TABLE test_fts;',
            '<script>alert(1)</script>',
            '💖 emojis',
            '深度学习',
            'stuart_open_url',
            'open_url',
            '() -> Result',
            '\\\\\\///&&&^^^$$$###@@@!!!~~~```',
            '\x00\x01\x02\x03',
        ]

        fuzz_passes = 0
        try:
            for raw in adversarial_inputs:
                sanitized = escape_fts5_query(raw)
                if sanitized == '""':
                    # Rust returns Ok(Vec::new()) for empty query
                    fuzz_passes += 1
                    continue
                try:
                    cur = conn.cursor()
                    cur.execute("SELECT count(*) FROM test_fts WHERE test_fts MATCH ?;", (sanitized,))
                    _ = cur.fetchone()[0]
                    fuzz_passes += 1
                except Exception as e:
                    print(f"  • FAIL on input {repr(raw)} -> sanitized {repr(sanitized)}: {e}")
                    raise AssertionError(f"FTS5 syntax error on input {repr(raw)}: {e}")
        finally:
            conn.close()

        print(f"  • Tested {len(adversarial_inputs)} adversarial query patterns. All {fuzz_passes} executed without syntax error.")
        print("  => RESULT: PASS (All adversarial FTS queries safely escaped)\n")


if __name__ == "__main__":
    print("\n" + "=" * 70)
    print(" STARTING CHALLENGER M1 WAL DEEP ADVERSARIAL STRESS SUITE")
    print("=" * 70 + "\n")
    run_test_1_reader_p95_under_heavy_writer()
    run_test_2_busy_timeout_contention()
    run_test_3_windows_error_32_and_corruption_recovery()
    run_test_4_fk_cascades_and_fts_triggers()
    run_test_5_fts_trigram_adversarial_queries()
    print("=" * 70)
    print(">> ALL CHALLENGER M1 DEEP ADVERSARIAL TESTS COMPLETED WITH 100% PASS <<")
    print("=" * 70 + "\n")
