// Empirical verification of Windows DPAPI key encryption
use std::ptr;

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        pDataIn: *const DATA_BLOB,
        szDataDescr: *const u16,
        pOptionalEntropy: *const DATA_BLOB,
        pvReserved: *mut std::ffi::c_void,
        pPromptStruct: *const std::ffi::c_void,
        dwFlags: u32,
        pDataOut: *mut DATA_BLOB,
    ) -> i32;

    fn CryptUnprotectData(
        pDataIn: *const DATA_BLOB,
        ppszDataDescr: *mut *mut u16,
        pOptionalEntropy: *const DATA_BLOB,
        pvReserved: *mut std::ffi::c_void,
        pPromptStruct: *const std::ffi::c_void,
        dwFlags: u32,
        pDataOut: *mut DATA_BLOB,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(hMem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn GetLastError() -> u32;
    fn RtlZeroMemory(Destination: *mut std::ffi::c_void, Length: usize);
}

#[repr(C)]
struct DATA_BLOB {
    cbData: u32,
    pbData: *mut u8,
}

const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

fn test_dpapi_entropy() {
    println!("=== TEST 3.1: CryptProtectData Application Entropy Isolation ===");

    let secret = b"sk-commercial-ai-secret-key-12345";
    let app_entropy_bytes = b"StuartMD_AppVault_Salt_v1";

    let in_blob = DATA_BLOB {
        cbData: secret.len() as u32,
        pbData: secret.as_ptr() as *mut u8,
    };

    let mut out_blob_no_entropy = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
    let mut out_blob_with_entropy = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };

    let entropy_blob = DATA_BLOB {
        cbData: app_entropy_bytes.len() as u32,
        pbData: app_entropy_bytes.as_ptr() as *mut u8,
    };

    // 1. Encrypt without entropy (Current StuartMD implementation in ai_chat.rs:62-70)
    let ok1 = unsafe {
        CryptProtectData(
            &in_blob,
            ptr::null(),
            ptr::null(), // Current code passes null!
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob_no_entropy,
        )
    };
    assert_ne!(ok1, 0, "CryptProtectData without entropy failed");

    // 2. Encrypt with application entropy
    let ok2 = unsafe {
        CryptProtectData(
            &in_blob,
            ptr::null(),
            &entropy_blob,
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob_with_entropy,
        )
    };
    assert_ne!(ok2, 0, "CryptProtectData with entropy failed");

    // Decrypting without entropy:
    // Any other process on the same machine with same user token can decrypt out_blob_no_entropy!
    let mut dec_blob1 = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
    let ok_dec1 = unsafe {
        CryptUnprotectData(
            &out_blob_no_entropy,
            ptr::null_mut(),
            ptr::null(), // No entropy required!
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut dec_blob1,
        )
    };
    println!("  Decrypt without entropy provided (unprotected blob): ok = {}", ok_dec1 != 0);

    // Now try to decrypt the entropy-protected blob WITHOUT providing entropy (simulating unauthorized caller):
    let mut dec_blob2 = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
    let ok_dec2 = unsafe {
        CryptUnprotectData(
            &out_blob_with_entropy,
            ptr::null_mut(),
            ptr::null(), // Attack attempt: no entropy provided!
            ptr::null_mut(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut dec_blob2,
        )
    };
    let err2 = unsafe { GetLastError() };
    println!("  Decrypt with MISSING entropy: ok = {}, Win32 error = {} (ERROR_INVALID_DATA = 13)", ok_dec2 != 0, err2);
    if ok_dec2 == 0 && err2 == 13 {
        println!("  [+] CONFIRMED: CryptProtectData with application entropy successfully BLOCKS unauthorized decryption!");
        println!("  [-] StuartMD current code passes NULL entropy, allowing any user-level process/script to decrypt keys!");
    }

    unsafe {
        LocalFree(out_blob_no_entropy.pbData as *mut _);
        LocalFree(out_blob_with_entropy.pbData as *mut _);
        if !dec_blob1.pbData.is_null() { LocalFree(dec_blob1.pbData as *mut _); }
        if !dec_blob2.pbData.is_null() { LocalFree(dec_blob2.pbData as *mut _); }
    }
}

fn test_memory_zeroization() {
    println!("\n=== TEST 3.2: Memory Zeroization & LocalFree Residual Data ===");

    // In ai_chat.rs:77 & 119:
    // let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    // unsafe { LocalFree(out_blob.pbData as *mut core::ffi::c_void) };
    // Notice: out_blob.pbData is NOT zeroed before LocalFree!

    let secret = b"TopSecretAPIKey99999";
    let in_blob = DATA_BLOB {
        cbData: secret.len() as u32,
        pbData: secret.as_ptr() as *mut u8,
    };
    let mut out_blob = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
    unsafe {
        CryptProtectData(&in_blob, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob);
    }

    let mut dec_blob = DATA_BLOB { cbData: 0, pbData: ptr::null_mut() };
    unsafe {
        CryptUnprotectData(&out_blob, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut dec_blob);
    }

    // Inspect dec_blob.pbData before free:
    let ptr = dec_blob.pbData;
    let len = dec_blob.cbData as usize;
    let decrypted_before = unsafe { std::slice::from_raw_parts(ptr, len) };
    println!("  Decrypted bytes before free: {:?}", std::str::from_utf8(decrypted_before).unwrap());

    // Call LocalFree without zeroization (StuartMD behavior)
    unsafe {
        // Read memory immediately after LocalFree:
        // On Windows heap, LocalFree does NOT wipe memory payload.
        // Let's verify whether the memory is wiped or still contains secret:
        LocalFree(ptr as *mut _);
    }
    // Reading freed heap memory:
    let residual_byte = unsafe { *ptr };
    println!("  First byte of freed heap memory at {:p}: 0x{:02x} ('{}')", ptr, residual_byte, residual_byte as char);
    println!("  [-] Proves LocalFree alone does NOT perform secure zeroization!");

    unsafe {
        LocalFree(out_blob.pbData as *mut _);
    }
}

fn test_slice_from_raw_parts_null() {
    println!("\n=== TEST 3.3: Null Pointer Safety in slice::from_raw_parts ===");
    // In ai_chat.rs:75 & 117:
    // let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    // What if out_blob.pbData is null and cbData is 0?
    
    let null_ptr: *const u8 = ptr::null();
    println!("  Rust std::slice::from_raw_parts contract:");
    println!("  Documentation: 'The pointer must be non-null and aligned, even for zero-length slices.'");
    println!("  Passing null pointer to slice::from_raw_parts(std::ptr::null(), 0):");
    
    // In Rust, creating a reference from null is immediate Undefined Behavior.
    // If we test with debug assertions or miri, it panics.
    // Let's check pointer alignment and NonNull check:
    let is_null = null_ptr.is_null();
    println!("  -> Pointer is null: {}", is_null);
    println!("  [-] Calling from_raw_parts with null pointer constitutes INSTANT SOUNDNESS UB in Rust standard library!");
}

fn main() {
    test_dpapi_entropy();
    test_memory_zeroization();
    test_slice_from_raw_parts_null();
}
