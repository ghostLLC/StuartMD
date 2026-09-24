// Empirical verification of atomic writing, ReplaceFileW vs fs::rename, and timestamp collision
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

    fn GetLastError() -> u32;
}

fn to_wide(s: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn test_timestamp_collisions() {
    println!("=== TEST 2.1: SystemTime::now() Nanosecond Collision Rate on Windows ===");
    // The roadmap proposes:
    // let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    // let tmp_path = parent.join(format!(".~stuart_tmp_{:x}.tmp", nonce));
    // Let's test how often this produces duplicate values across tight loop and threads:

    let iterations = 100_000;
    let mut timestamps = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        timestamps.push(n);
    }
    
    let mut duplicates = 0;
    for i in 1..timestamps.len() {
        if timestamps[i] == timestamps[i - 1] {
            duplicates += 1;
        }
    }
    println!("Sequential tight loop (100,000 calls):");
    println!("  Total calls: {}", iterations);
    println!("  Duplicate consecutive timestamps: {} ({:.2}%)", duplicates, (duplicates as f64 / iterations as f64) * 100.0);

    // Multi-threaded test (4 threads simulating concurrent autosave / tabs)
    let thread_count = 4;
    let per_thread = 10_000;
    let barrier = Arc::new(Barrier::new(thread_count));
    let mut handles = Vec::new();

    for _ in 0..thread_count {
        let b = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            b.wait();
            let mut list = Vec::with_capacity(per_thread);
            for _ in 0..per_thread {
                list.push(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
            }
            list
        }));
    }

    let mut all_ts = Vec::new();
    for h in handles {
        all_ts.extend(h.join().unwrap());
    }
    all_ts.sort();
    let mut concurrent_dups = 0;
    for i in 1..all_ts.len() {
        if all_ts[i] == all_ts[i - 1] {
            concurrent_dups += 1;
        }
    }
    println!("Concurrent 4 threads (40,000 calls):");
    println!("  Duplicate timestamps: {} ({:.2}%)", concurrent_dups, (concurrent_dups as f64 / all_ts.len() as f64) * 100.0);
    if concurrent_dups > 0 {
        println!("[-] FLAW CONFIRMED: SystemTime alone WILL cause temp file naming collisions under concurrent saves!");
    }
}

fn test_replacefile_vs_rename() {
    println!("\n=== TEST 2.2: ReplaceFileW vs std::fs::rename on NTFS ===");

    let target_dir = Path::new("tests/scratch_atomic");
    let _ = fs::create_dir_all(target_dir);

    let target_file = target_dir.join("original_doc.md");
    let tmp_file_rename = target_dir.join(".~stuart_tmp_rename.tmp");
    let tmp_file_replace = target_dir.join(".~stuart_tmp_replace.tmp");

    // --- Scenario A: Creation Time Preservation ---
    // Create original document
    fs::write(&target_file, "Original v1 content").unwrap();
    // Wait a brief moment to differentiate timestamps
    thread::sleep(Duration::from_millis(50));
    let orig_meta = fs::metadata(&target_file).unwrap();
    let orig_created = orig_meta.created().unwrap();

    thread::sleep(Duration::from_millis(100));

    // Method 1: std::fs::rename (MoveFileExW)
    fs::write(&tmp_file_rename, "New v2 content via rename").unwrap();
    let tmp_meta = fs::metadata(&tmp_file_rename).unwrap();
    let tmp_created = tmp_meta.created().unwrap();

    fs::rename(&tmp_file_rename, &target_file).unwrap();
    let after_rename_meta = fs::metadata(&target_file).unwrap();
    let after_rename_created = after_rename_meta.created().unwrap();

    println!("Scenario A: Creation Time Preservation:");
    println!("  Original Created:      {:?}", orig_created);
    println!("  After fs::rename:      {:?}", after_rename_created);
    let rename_preserved = orig_created == after_rename_created;
    println!("  -> fs::rename preserved creation time? {}", rename_preserved);

    // Now test Method 2: ReplaceFileW
    thread::sleep(Duration::from_millis(100));
    fs::write(&tmp_file_replace, "New v3 content via ReplaceFileW").unwrap();

    let target_wide = to_wide(&target_file);
    let replace_wide = to_wide(&tmp_file_replace);

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x01;
    const REPLACEFILE_IGNORE_MERGE_ERRORS: u32 = 0x02;

    let res = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            replace_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH | REPLACEFILE_IGNORE_MERGE_ERRORS,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };

    if res != 0 {
        let after_replace_meta = fs::metadata(&target_file).unwrap();
        let after_replace_created = after_replace_meta.created().unwrap();
        println!("  After ReplaceFileW:    {:?}", after_replace_created);
        let replace_preserved = after_rename_created == after_replace_created;
        println!("  -> ReplaceFileW preserved creation time? {}", replace_preserved);
        if replace_preserved && !rename_preserved {
            println!("  [+] ReplaceFileW PRESERVES NTFS CREATION TIME, whereas fs::rename DESTROYS IT!");
        }
    } else {
        let err = unsafe { GetLastError() };
        println!("  ReplaceFileW failed with error code: {}", err);
    }

    // --- Scenario B: Non-existent destination file ---
    println!("\nScenario B: Behavior when target file does NOT exist:");
    let non_existent_target = target_dir.join("non_existent_doc.md");
    let tmp_new = target_dir.join(".~stuart_tmp_new.tmp");
    fs::write(&tmp_new, "Content for new file").unwrap();

    let non_target_wide = to_wide(&non_existent_target);
    let tmp_new_wide = to_wide(&tmp_new);

    let res_new = unsafe {
        ReplaceFileW(
            non_target_wide.as_ptr(),
            tmp_new_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if res_new == 0 {
        let err = unsafe { GetLastError() };
        println!("  ReplaceFileW on non-existent file failed as expected! Win32 Error: {} (ERROR_FILE_NOT_FOUND = 2)", err);
        println!("  -> Proves ReplaceFileW CANNOT be used standalone for newly created files; requires rename fallback!");
    } else {
        println!("  ReplaceFileW succeeded on non-existent file? Unexpected!");
    }
    let _ = fs::remove_file(&tmp_new);

    // --- Scenario C: Target file open without FILE_SHARE_DELETE ---
    println!("\nScenario C: Target file open by concurrent reader without FILE_SHARE_DELETE:");
    fs::write(&target_file, "Doc content").unwrap();

    // Open target_file with read access and FILE_SHARE_READ only (no FILE_SHARE_DELETE)
    // Standard File::open in Rust opens with FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE.
    // But many Windows apps (antivirus, backup, office) open with only FILE_SHARE_READ.
    // Let's open with custom share flags:
    const FILE_SHARE_READ: u32 = 0x00000001;
    let locked_file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&target_file)
        .unwrap();

    let tmp_test_rename = target_dir.join(".~stuart_tmp_test_rename.tmp");
    fs::write(&tmp_test_rename, "Rename update").unwrap();

    let rename_res = fs::rename(&tmp_test_rename, &target_file);
    println!("  fs::rename result when locked without FILE_SHARE_DELETE: {:?}", rename_res);

    let tmp_test_replace = target_dir.join(".~stuart_tmp_test_replace.tmp");
    fs::write(&tmp_test_replace, "Replace update").unwrap();
    let replace_res = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            to_wide(&tmp_test_replace).as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    let replace_err = if replace_res == 0 { unsafe { GetLastError() } } else { 0 };
    println!("  ReplaceFileW result when locked: return = {}, Win32 error = {}", replace_res, replace_err);

    drop(locked_file);
    let _ = fs::remove_file(&tmp_test_rename);
    let _ = fs::remove_file(&tmp_test_replace);
    let _ = fs::remove_dir_all(target_dir);
}

fn main() {
    test_timestamp_collisions();
    test_replacefile_vs_rename();
}
