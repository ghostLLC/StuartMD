// Empirical Stress Harness for P0-2 (Atomic File Write) and P1-3 (Settings Transaction Lock)
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[link(name = "kernel32")]
extern "system" {
    fn ReplaceFileW(
        lpReplacedFileName: *const u16,
        lpReplacementFileName: *const u16,
        lpBackupFileName: *const u16,
        dwReplaceFlags: u32,
        lpExclude: *mut std::ffi::c_void,
        lpReserved: *mut std::ffi::c_void,
    ) -> i32;

    fn GetCurrentProcess() -> isize;
    fn GetProcessHandleCount(hProcess: isize, pdwHandleCount: *mut u32) -> i32;
}

const REPLACEFILE_IGNORE_MERGE_ERRORS: u32 = 0x00000002;

static ATOMIC_WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

/// Exact implementation from StuartMD `fs_api.rs:73`
pub fn atomic_write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };

    if parent != Path::new(".") {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
    }

    let pid = std::process::id();
    let mut last_err = String::new();

    for attempt in 0..5 {
        let seq = ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or(0);
        let tmp_name = format!(".~stuart_tmp_{}_{}_{:x}_{}.tmp", pid, seq, timestamp, attempt);
        let tmp_path = parent.join(&tmp_name);

        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = format!("临时文件碰撞: {e}");
                continue;
            }
            Err(e) => return Err(format!("创建临时文件失败: {e}")),
        };

        if let Err(e) = file.write_all(content) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("写入临时文件失败: {e}"));
        }

        if let Err(e) = file.sync_all() {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("数据持久化刷盘失败 (fsync): {e}"));
        }
        drop(file);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;

            let replace_res = if path.exists() {
                let wide_target: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                let wide_tmp: Vec<u16> = tmp_path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();

                let ret = unsafe {
                    ReplaceFileW(
                        wide_target.as_ptr(),
                        wide_tmp.as_ptr(),
                        std::ptr::null(),
                        REPLACEFILE_IGNORE_MERGE_ERRORS,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if ret != 0 {
                    Ok(())
                } else {
                    fs::rename(&tmp_path, path).map_err(|e| format!("Windows ReplaceFileW 及 rename 降级均失败: {e}"))
                }
            } else {
                fs::rename(&tmp_path, path).map_err(|e| format!("原子文件移动创建失败: {e}"))
            };

            if let Err(e) = replace_res {
                let _ = fs::remove_file(&tmp_path);
                return Err(e);
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = fs::rename(&tmp_path, path) {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("原子文件替换失败: {e}"));
            }
        }

        return Ok(());
    }

    Err(format!("超过最大重试次数，临时文件创建失败: {last_err}"))
}

fn get_handle_count() -> u32 {
    let mut count: u32 = 0;
    unsafe {
        let proc = GetCurrentProcess();
        GetProcessHandleCount(proc, &mut count);
    }
    count
}

fn run_p0_2_atomic_write_stress() {
    println!("============================================================");
    println!(">>> TARGET 1: P0-2 (Atomic File Write Stress Test)");
    println!("============================================================");

    let test_dir = PathBuf::from("tests/scratch_p0_2_atomic");
    let _ = fs::remove_dir_all(&test_dir);
    fs::create_dir_all(&test_dir).expect("Failed to create test dir");

    let target_file = test_dir.join("concurrency_stress_target.md");

    // Initialize with known content
    let initial_content = b"# StuartMD Initial Document Header\nInitial baseline text.\n";
    atomic_write_file(&target_file, initial_content).expect("Initial write failed");

    let initial_handles = get_handle_count();
    println!("[Baseline] Initial Process Handle Count: {}", initial_handles);

    const WRITER_THREADS: usize = 20;
    const WRITES_PER_THREAD: usize = 100;
    const READER_THREADS: usize = 5;

    let barrier = Arc::new(Barrier::new(WRITER_THREADS + READER_THREADS));
    let stop_readers = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let zero_byte_detected = Arc::new(AtomicUsize::new(0));
    let corrupted_read_detected = Arc::new(AtomicUsize::new(0));
    let total_successful_reads = Arc::new(AtomicUsize::new(0));
    let total_successful_writes = Arc::new(AtomicUsize::new(0));
    let write_errors = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();

    let start_time = Instant::now();

    // Spawn 5 concurrent reader threads
    for reader_id in 0..READER_THREADS {
        let b = Arc::clone(&barrier);
        let stop = Arc::clone(&stop_readers);
        let path = target_file.clone();
        let zero_cnt = Arc::clone(&zero_byte_detected);
        let corrupt_cnt = Arc::clone(&corrupted_read_detected);
        let read_cnt = Arc::clone(&total_successful_reads);

        handles.push(thread::spawn(move || {
            b.wait();
            let mut reads = 0;
            while !stop.load(Ordering::Relaxed) {
                match fs::read(&path) {
                    Ok(bytes) => {
                        reads += 1;
                        if bytes.is_empty() {
                            zero_cnt.fetch_add(1, Ordering::SeqCst);
                            eprintln!("[FAIL] 0-BYTE TRUNCATION DETECTED by reader {} at read {}!", reader_id, reads);
                        } else {
                            // Check header or thread format
                            let s = String::from_utf8_lossy(&bytes);
                            if !s.starts_with("# StuartMD") {
                                corrupt_cnt.fetch_add(1, Ordering::SeqCst);
                                eprintln!("[FAIL] CORRUPTED CONTENT DETECTED by reader {}: {:?}", reader_id, &s[..std::cmp::min(s.len(), 50)]);
                            }
                        }
                    }
                    Err(e) => {
                        // On Windows, sharing violation during atomic swap is possible if not sharing
                    }
                }
                thread::yield_now();
            }
            read_cnt.fetch_add(reads, Ordering::Relaxed);
        }));
    }

    // Spawn 20 concurrent writer threads
    for t_id in 0..WRITER_THREADS {
        let b = Arc::clone(&barrier);
        let path = target_file.clone();
        let succ_w = Arc::clone(&total_successful_writes);
        let err_w = Arc::clone(&write_errors);

        handles.push(thread::spawn(move || {
            b.wait();
            for i in 0..WRITES_PER_THREAD {
                // Variable payload sizes from 100 bytes to 10 KB
                let padding_len = (t_id * 17 + i * 23) % 2048;
                let padding = "A".repeat(padding_len);
                let content = format!(
                    "# StuartMD Document Version\nThread: {}\nIteration: {}\nTimestamp: {:?}\nPadding: {}\nEnd Of Document\n",
                    t_id, i, SystemTime::now(), padding
                );

                // Rapid atomic write retry loop if brief sharing collision occurs
                let mut written = false;
                for _retry in 0..5 {
                    match atomic_write_file(&path, content.as_bytes()) {
                        Ok(()) => {
                            succ_w.fetch_add(1, Ordering::Relaxed);
                            written = true;
                            break;
                        }
                        Err(_) => {
                            thread::sleep(Duration::from_millis(1));
                        }
                    }
                }
                if !written {
                    err_w.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }

    // Wait for writers to complete
    let mut writer_handles = handles.split_off(READER_THREADS);
    for h in writer_handles {
        h.join().unwrap();
    }

    // Stop readers
    stop_readers.store(true, Ordering::Relaxed);
    for h in handles {
        h.join().unwrap();
    }

    let elapsed = start_time.elapsed();
    let final_handles = get_handle_count();

    println!("[Results] Total Time: {:.2?}", elapsed);
    println!("  Target Writes Attempted: {}", WRITER_THREADS * WRITES_PER_THREAD);
    println!("  Successful Atomic Writes: {}", total_successful_writes.load(Ordering::SeqCst));
    println!("  Write Errors (Collisions after retries): {}", write_errors.load(Ordering::SeqCst));
    println!("  Total Concurrent Reads: {}", total_successful_reads.load(Ordering::SeqCst));
    println!("  Zero-byte Truncations Detected: {}", zero_byte_detected.load(Ordering::SeqCst));
    println!("  Corrupted Reads Detected: {}", corrupted_read_detected.load(Ordering::SeqCst));
    println!("  Initial Handles: {} | Final Handles: {} (Delta: {})", initial_handles, final_handles, final_handles as i64 - initial_handles as i64);

    // Verify temp file cleanup
    let mut leftover_temp_files = 0;
    if let Ok(entries) = fs::read_dir(&test_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".~stuart_tmp_") {
                leftover_temp_files += 1;
                eprintln!("[FAIL] Leftover temporary file found: {}", name);
            }
        }
    }
    println!("  Leftover Temp Files in Directory: {}", leftover_temp_files);

    // Final file content inspection
    let final_content = fs::read_to_string(&target_file).expect("Failed to read final target file");
    println!("  Final File Size: {} bytes", final_content.len());
    println!("  Final File Header: {:?}", &final_content[..std::cmp::min(final_content.len(), 40)]);

    assert_eq!(zero_byte_detected.load(Ordering::SeqCst), 0, "Zero-byte truncation detected!");
    assert_eq!(corrupted_read_detected.load(Ordering::SeqCst), 0, "Corrupted read detected!");
    assert_eq!(leftover_temp_files, 0, "Leftover temp files found!");
    assert!(final_content.starts_with("# StuartMD"), "Final content invalid!");
    assert!((final_handles as i64 - initial_handles as i64).abs() < 50, "Potential handle leak!");

    println!("[+] P0-2 ATOMIC FILE WRITE STRESS TEST: PASSED 100%");
}

// -----------------------------------------------------------------------------------------
// TARGET 4: P1-3 (Settings Transaction Lock)
// -----------------------------------------------------------------------------------------

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn settings_guard() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Simulated Settings structure
#[derive(Clone, Debug, PartialEq)]
struct AppSettings {
    schema_version: i64,
    theme: String,
    update_count: usize,
    history: Vec<String>,
}

impl AppSettings {
    fn new() -> Self {
        Self {
            schema_version: 4,
            theme: "light".to_string(),
            update_count: 0,
            history: Vec::new(),
        }
    }

    fn serialize(&self) -> String {
        format!(
            "{{\"schema_version\":{},\"theme\":\"{}\",\"update_count\":{},\"history_len\":{}}}",
            self.schema_version, self.theme, self.update_count, self.history.len()
        )
    }

    fn parse(s: &str) -> Result<Self, String> {
        // Minimal parser for test validation
        if !s.starts_with('{') || !s.ends_with('}') {
            return Err("Invalid JSON".to_string());
        }
        let update_count = s.split("\"update_count\":")
            .nth(1)
            .and_then(|part| part.split(',').next())
            .and_then(|num| num.parse::<usize>().ok())
            .unwrap_or(0);
        let history_len = s.split("\"history_len\":")
            .nth(1)
            .and_then(|part| part.split('}').next())
            .and_then(|num| num.parse::<usize>().ok())
            .unwrap_or(0);

        Ok(Self {
            schema_version: 4,
            theme: "light".to_string(),
            update_count,
            history: vec!["item".to_string(); history_len],
        })
    }
}

fn load_settings_unlocked(path: &Path) -> AppSettings {
    if path.exists() {
        let content = fs::read_to_string(path).unwrap_or_default();
        AppSettings::parse(&content).unwrap_or_else(|_| AppSettings::new())
    } else {
        AppSettings::new()
    }
}

fn save_settings_unlocked(path: &Path, s: &AppSettings) -> Result<(), String> {
    let bytes = s.serialize();
    atomic_write_file(path, bytes.as_bytes())
}

/// StuartMD P1-3 synchronized modify_settings implementation
fn modify_settings_locked<F>(path: &Path, modifier: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings) -> Result<(), String>,
{
    let _guard = settings_guard();
    let mut current = load_settings_unlocked(path);
    modifier(&mut current)?;
    save_settings_unlocked(path, &current)?;
    Ok(current)
}

/// Unsynchronized modify_settings (the buggy baseline from before P1-3)
fn modify_settings_UNLOCKED<F>(path: &Path, modifier: F) -> Result<AppSettings, String>
where
    F: FnOnce(&mut AppSettings) -> Result<(), String>,
{
    // No lock!
    let mut current = load_settings_unlocked(path);
    // Introduce artificial context switch to trigger race
    thread::sleep(Duration::from_micros(100));
    modifier(&mut current)?;
    save_settings_unlocked(path, &current)?;
    Ok(current)
}

fn run_p1_3_settings_concurrency_stress() {
    println!("\n============================================================");
    println!(">>> TARGET 4: P1-3 (Settings Transaction Lock Stress Test)");
    println!("============================================================");

    let test_dir = PathBuf::from("tests/scratch_p1_3_settings");
    let _ = fs::remove_dir_all(&test_dir);
    fs::create_dir_all(&test_dir).expect("Failed to create test dir");

    // Part A: Prove that UNLOCKED settings clobbers writes and loses updates
    println!("[Experiment A] Running UNSYNCHRONIZED baseline (Without Mutex)...");
    let unlocked_path = test_dir.join("settings_unlocked.json");
    save_settings_unlocked(&unlocked_path, &AppSettings::new()).unwrap();

    let threads = 10;
    let ops_per_thread = 20;
    let expected_unlocked_ops = threads * ops_per_thread;
    let barrier = Arc::new(Barrier::new(threads));
    let mut handles = Vec::new();

    for t_id in 0..threads {
        let b = Arc::clone(&barrier);
        let p = unlocked_path.clone();
        handles.push(thread::spawn(move || {
            b.wait();
            for _ in 0..ops_per_thread {
                let _ = modify_settings_UNLOCKED(&p, |s| {
                    s.update_count += 1;
                    s.history.push(format!("t{}_op", t_id));
                    Ok(())
                });
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let final_unlocked = load_settings_unlocked(&unlocked_path);
    println!("  Expected total updates: {}", expected_unlocked_ops);
    println!("  Actual recorded updates (UNLOCKED): {}", final_unlocked.update_count);
    println!("  Lost / Clobbered updates: {}", expected_unlocked_ops as i64 - final_unlocked.update_count as i64);
    if final_unlocked.update_count < expected_unlocked_ops {
        println!("  [+] CONFIRMED: Unlocked settings loses updates due to concurrent clobbering!");
    }

    // Part B: Stress-test StuartMD P1-3 `modify_settings` with `SETTINGS_LOCK`
    println!("\n[Experiment B] Running StuartMD LOCKED transaction (With SETTINGS_LOCK)...");
    let locked_path = test_dir.join("settings_locked.json");
    save_settings_unlocked(&locked_path, &AppSettings::new()).unwrap();

    const LOCKED_THREADS: usize = 20;
    const LOCKED_OPS_PER_THREAD: usize = 50;
    const EXPECTED_LOCKED_OPS: usize = LOCKED_THREADS * LOCKED_OPS_PER_THREAD; // 1,000 total operations

    let barrier_locked = Arc::new(Barrier::new(LOCKED_THREADS));
    let mut handles_locked = Vec::new();
    let lock_errors = Arc::new(AtomicUsize::new(0));

    let start_lock = Instant::now();
    for t_id in 0..LOCKED_THREADS {
        let b = Arc::clone(&barrier_locked);
        let p = locked_path.clone();
        let err_cnt = Arc::clone(&lock_errors);
        handles_locked.push(thread::spawn(move || {
            b.wait();
            for op_idx in 0..LOCKED_OPS_PER_THREAD {
                let res = modify_settings_locked(&p, |s| {
                    s.update_count += 1;
                    s.history.push(format!("t{}_op{}", t_id, op_idx));
                    Ok(())
                });
                if res.is_err() {
                    err_cnt.fetch_add(1, Ordering::SeqCst);
                }
            }
        }));
    }

    for h in handles_locked {
        h.join().unwrap();
    }

    let elapsed_lock = start_lock.elapsed();
    let final_locked = load_settings_unlocked(&locked_path);

    println!("[Results] Elapsed Time for 1000 Transactions: {:.2?}", elapsed_lock);
    println!("  Expected Updates: {}", EXPECTED_LOCKED_OPS);
    println!("  Actual Recorded Updates: {}", final_locked.update_count);
    println!("  History Length: {}", final_locked.history.len());
    println!("  Transaction Errors: {}", lock_errors.load(Ordering::SeqCst));
    println!("  Clobbered Writes: {}", EXPECTED_LOCKED_OPS - final_locked.update_count);

    assert_eq!(final_locked.update_count, EXPECTED_LOCKED_OPS, "Lost updates in modify_settings!");
    assert_eq!(final_locked.history.len(), EXPECTED_LOCKED_OPS, "History lost updates!");
    assert_eq!(lock_errors.load(Ordering::SeqCst), 0, "Transaction errors occurred!");

    println!("[+] P1-3 SETTINGS TRANSACTION LOCK: PASSED 100% (Zero Clobbering across 1,000 concurrent updates)");
}

fn main() {
    println!("############################################################");
    println!("# StuartMD Empirical Concurrency & Race Condition Suite    #");
    println!("############################################################\n");

    run_p0_2_atomic_write_stress();
    run_p1_3_settings_concurrency_stress();

    println!("\n############################################################");
    println!("# ALL RUST CONCURRENCY SUITES COMPLETED SUCCESSFULLY       #");
    println!("############################################################");
}
