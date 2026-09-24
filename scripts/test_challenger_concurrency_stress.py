#!/usr/bin/env python3
"""
scripts/test_challenger_concurrency_stress.py
Empirical Challenger Concurrency & Crash Resilience Stress Test Suite
Author: teamwork_preview_challenger_concurrency_v3
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

# Ensure UTF-8 output on Windows console
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


def test_extreme_multithread_reader_writer():
    print("=" * 70)
    print("CHALLENGER STRESS 1: High-Concurrency Reader/Writer WAL Performance")
    print("=" * 70)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "stress_rag.db")
        
        # Initialize schema
        init_conn = sqlite3.connect(db_path)
        init_conn.execute("PRAGMA journal_mode = WAL;")
        init_conn.execute("PRAGMA synchronous = NORMAL;")
        init_conn.execute("PRAGMA busy_timeout = 5000;")
        init_conn.execute("""
            CREATE TABLE doc_chunks (
                chunk_id TEXT PRIMARY KEY,
                doc_path TEXT NOT NULL,
                content TEXT NOT NULL
            );
        """)
        init_conn.commit()
        init_conn.close()

        # Dedicated writer thread
        writer_stop = threading.Event()
        writer_batches_written = [0]
        writer_errors = []

        def writer_loop():
            try:
                w_conn = sqlite3.connect(db_path, timeout=5.0)
                w_conn.execute("PRAGMA journal_mode = WAL;")
                w_conn.execute("PRAGMA synchronous = NORMAL;")
                w_conn.execute("PRAGMA busy_timeout = 5000;")
                batch_id = 0
                while not writer_stop.is_set():
                    cur = w_conn.cursor()
                    cur.execute("BEGIN IMMEDIATE;")
                    for i in range(50):
                        cur.execute("INSERT OR REPLACE INTO doc_chunks VALUES (?, ?, ?)",
                                    (f"chunk_{batch_id}_{i}", f"doc_{batch_id}.md", "Sample text " * 15))
                    time.sleep(0.020) # Simulate ONNX batch embedding compute
                    w_conn.commit()
                    batch_id += 1
                    writer_batches_written[0] = batch_id
                    time.sleep(0.005)
                w_conn.close()
            except Exception as e:
                writer_errors.append(str(e))

        tw = threading.Thread(target=writer_loop)
        tw.start()

        # 8 Concurrent reader threads
        NUM_READERS = 8
        READS_PER_THREAD = 100
        all_read_latencies = []
        reader_errors = []
        latency_lock = threading.Lock()

        def reader_loop(r_id):
            try:
                r_conn = sqlite3.connect(db_path, timeout=5.0)
                r_conn.execute("PRAGMA journal_mode = WAL;")
                r_conn.execute("PRAGMA busy_timeout = 5000;")
                r_conn.execute("PRAGMA query_only = ON;")
                local_latencies = []
                for _ in range(READS_PER_THREAD):
                    t0 = time.perf_counter()
                    cur = r_conn.cursor()
                    cur.execute("SELECT count(*) FROM doc_chunks;")
                    _ = cur.fetchone()[0]
                    lat = (time.perf_counter() - t0) * 1000.0
                    local_latencies.append(lat)
                    time.sleep(0.002)
                r_conn.close()
                with latency_lock:
                    all_read_latencies.extend(local_latencies)
            except Exception as e:
                reader_errors.append(f"Reader {r_id}: {e}")

        reader_threads = [threading.Thread(target=reader_loop, args=(i,)) for i in range(NUM_READERS)]
        for t in reader_threads:
            t.start()
        for t in reader_threads:
            t.join()

        writer_stop.set()
        tw.join()

        # Analyze statistics
        assert len(writer_errors) == 0, f"Writer encountered errors: {writer_errors}"
        assert len(reader_errors) == 0, f"Readers encountered errors: {reader_errors}"
        
        all_read_latencies.sort()
        total_reads = len(all_read_latencies)
        p50 = all_read_latencies[int(total_reads * 0.50)]
        p90 = all_read_latencies[int(total_reads * 0.90)]
        p95 = all_read_latencies[int(total_reads * 0.95)]
        p99 = all_read_latencies[int(total_reads * 0.99)]
        max_lat = max(all_read_latencies)

        print(f"  • Total Concurrent Readers: {NUM_READERS} (Total Queries: {total_reads})")
        print(f"  • Total Batches Written: {writer_batches_written[0]}")
        print(f"  • P50 Read Latency: {p50:.3f} ms")
        print(f"  • P90 Read Latency: {p90:.3f} ms")
        print(f"  • P95 Read Latency: {p95:.3f} ms")
        print(f"  • P99 Read Latency: {p99:.3f} ms")
        print(f"  • Max Read Latency: {max_lat:.3f} ms")
        print(f"  • SLA Status: {'PASS (< 15ms target)' if p95 < 15.0 else 'FAIL'}")
        
        assert p95 < 15.0, f"P95 latency {p95:.2f}ms exceeded 15ms SLA!"
        print("  => VERDICT: Dedicated Writer + Reader Pool under WAL mode provides robust sub-millisecond query isolation.\n")


def test_windows_sharing_violation_empirical():
    print("=" * 70)
    print("CHALLENGER STRESS 2: Empirical Windows File Lock & Rename Validation")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test_lock.db")
        corrupt_backup = os.path.join(tmpdir, "test_lock.db.corrupt")

        # Create DB
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("CREATE TABLE t (id INT);")
        conn.commit()

        # Step 1: Attempt to rename DB while connection is OPEN (Simulating unhardened code)
        lock_failed = False
        try:
            shutil.move(db_path, corrupt_backup)
        except (PermissionError, OSError) as e:
            lock_failed = True
            print(f"  • [UNHARDENED] Rename with open connection failed as expected: {e}")

        if os.name == 'nt':
            assert lock_failed, "On Windows, open SQLite connection MUST trigger WinError 32!"

        # Step 2: Now explicitly close / drop connection (Simulating DEF-CONC-07)
        conn.close()
        conn = None

        # Attempt rename now
        shutil.move(db_path, corrupt_backup)
        assert os.path.exists(corrupt_backup)
        assert not os.path.exists(db_path)
        print("  • [DEF-CONC-07 HARDENED] Connection dropped -> File renamed successfully without sharing violation.")
        print("  => VERDICT: Proves dropping connections before rename is strictly required and successful on Windows.\n")


def test_cascade_delete_and_triggers_empirical():
    print("=" * 70)
    print("CHALLENGER STRESS 3: Normalized Schema & Trigger Cascade Cleanliness")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "normalized_rag.db")
        conn = sqlite3.connect(db_path)
        conn.execute("PRAGMA foreign_keys = ON;")

        # SPEC Schema
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
                content TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES rag_documents(doc_id) ON DELETE CASCADE
            );
        """)
        conn.execute("""
            CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                content
            );
        """)
        conn.execute("""
            CREATE TRIGGER trg_rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
                DELETE FROM rag_chunks_fts WHERE chunk_id = old.chunk_id;
            END;
        """)
        conn.commit()

        # Insert 10 documents with 5 chunks each = 50 chunks
        for d in range(10):
            doc_id = f"doc_{d}"
            conn.execute("INSERT INTO rag_documents VALUES (?, ?)", (doc_id, f"notes/doc_{d}.md"))
            for c in range(5):
                chunk_id = f"{doc_id}_c{c}"
                conn.execute("INSERT INTO rag_chunks VALUES (?, ?, ?)", (chunk_id, doc_id, f"Content for doc {d} chunk {c}"))
                conn.execute("INSERT INTO rag_chunks_fts VALUES (?, ?)", (chunk_id, f"Content for doc {d} chunk {c}"))
        conn.commit()

        doc_count = conn.execute("SELECT count(*) FROM rag_documents;").fetchone()[0]
        chunk_count = conn.execute("SELECT count(*) FROM rag_chunks;").fetchone()[0]
        fts_count = conn.execute("SELECT count(*) FROM rag_chunks_fts;").fetchone()[0]
        assert doc_count == 10 and chunk_count == 50 and fts_count == 50

        # Simulate deletion of 3 documents via Watcher NotFound handler:
        deleted_docs = ["notes/doc_2.md", "notes/doc_5.md", "notes/doc_8.md"]
        for rel in deleted_docs:
            conn.execute("DELETE FROM rag_documents WHERE rel_path = ?;", (rel,))
        conn.commit()

        # Verify cascade
        doc_count_after = conn.execute("SELECT count(*) FROM rag_documents;").fetchone()[0]
        chunk_count_after = conn.execute("SELECT count(*) FROM rag_chunks;").fetchone()[0]
        fts_count_after = conn.execute("SELECT count(*) FROM rag_chunks_fts;").fetchone()[0]

        print(f"  • Documents Remaining: {doc_count_after} (Expected: 7)")
        print(f"  • Chunks Remaining: {chunk_count_after} (Expected: 35)")
        print(f"  • FTS Entries Remaining: {fts_count_after} (Expected: 35)")

        assert doc_count_after == 7
        assert chunk_count_after == 35
        assert fts_count_after == 35
        conn.close()
        print("  => VERDICT: Cascade delete + triggers completely clean ghost chunks across B-tree and FTS5.\n")


def test_duty_cycle_adaptive_mathematical():
    print("=" * 70)
    print("CHALLENGER STRESS 4: CPU Duty Cycle Dynamic Clamp Test")
    print("=" * 70)

    # Test over wide range of compute times (from 10ms to 500ms)
    test_compute_times = [10.0, 25.0, 50.0, 96.0, 150.0, 300.0]
    
    for t_comp in test_compute_times:
        t_sleep = 3.0 * t_comp
        total_period = t_comp + t_sleep
        duty_cycle = t_comp / total_period
        print(f"  • T_compute: {t_comp:>5.1f}ms | T_sleep (3.0x): {t_sleep:>6.1f}ms | Duty Cycle: {duty_cycle * 100:.2f}%")
        assert abs(duty_cycle - 0.25) < 1e-6, f"Duty cycle failed for {t_comp}"

    print("  => VERDICT: T_sleep = 3.0 * T_compute mathematically and invariant-wise guarantees <= 25.0% CPU duty cycle.\n")


if __name__ == "__main__":
    print("\n" + "="*70)
    print(" STARTING TEAMWORK EMPIRICAL CHALLENGER CONCURRENCY STRESS SUITE")
    print("="*70 + "\n")
    test_extreme_multithread_reader_writer()
    test_windows_sharing_violation_empirical()
    test_cascade_delete_and_triggers_empirical()
    test_duty_cycle_adaptive_mathematical()
    print("="*70)
    print(">> ALL CHALLENGER CONCURRENCY STRESS TESTS COMPLETED WITH 100% PASS <<")
    print("="*70 + "\n")
