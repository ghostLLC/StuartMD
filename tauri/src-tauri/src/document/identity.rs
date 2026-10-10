use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskRevision {
    pub exists: bool,
    pub volume_id: Option<u64>,
    pub file_id: Option<u64>,
    pub raw_byte_sha256: String,
    pub size: u64,
    pub modified_at: u64,
}

impl DiskRevision {
    pub fn absent() -> Self {
        Self { exists: false, volume_id: None, file_id: None, raw_byte_sha256: sha256(&[]), size: 0, modified_at: 0 }
    }
    pub fn same_content_and_identity(&self, other: &Self) -> bool {
        self.exists == other.exists && self.volume_id == other.volume_id && self.file_id == other.file_id && self.raw_byte_sha256 == other.raw_byte_sha256 && self.size == other.size
    }
}

pub fn sha256(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

pub fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    path.strip_prefix("\\\\?\\").unwrap_or(&path).replace('\\', "/")
}

pub fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() { return Err("文档保存路径必须为绝对路径".into()); }
    if path.exists() { return fs::canonicalize(path).map_err(|error| format!("规范化文档路径失败: {error}")); }
    let parent = path.parent().ok_or("文档路径缺少父目录")?;
    let filename = path.file_name().ok_or("文档路径缺少文件名")?;
    Ok(fs::canonicalize(parent).map_err(|error| format!("规范化父目录失败: {error}"))?.join(filename))
}

pub fn read_disk(path: &Path) -> Result<(DiskRevision, Vec<u8>), String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((DiskRevision::absent(), vec![])),
        Err(error) => return Err(format!("打开文档失败: {error}")),
    };
    let before = file.metadata().map_err(|error| format!("读取文件属性失败: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|error| format!("读取文档原始字节失败: {error}"))?;
    let after = file.metadata().map_err(|error| format!("再次读取文件属性失败: {error}"))?;
    if before.len() != after.len() || before.modified().map_err(|error| error.to_string())? != after.modified().map_err(|error| error.to_string())? { return Err("读取期间文件发生变化，请重新打开文档".into()); }
    #[cfg(windows)]
    let (volume_id, file_id) = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 { return Err(format!("读取 Windows 文件身份失败: {}", std::io::Error::last_os_error())); }
        (Some(information.dwVolumeSerialNumber as u64), Some(((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64))
    };
    #[cfg(not(windows))]
    let (volume_id, file_id) = { use std::os::unix::fs::MetadataExt; (Some(after.dev()), Some(after.ino())) };
    let modified_at = after.modified().map_err(|error| error.to_string())?.duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis().try_into().map_err(|_| "文件修改时间溢出")?;
    Ok((DiskRevision { exists: true, volume_id, file_id, raw_byte_sha256: sha256(&bytes), size: bytes.len() as u64, modified_at }, bytes))
}

#[cfg(windows)]
pub struct FileLocks { handles: Vec<windows_sys::Win32::Foundation::HANDLE> }

#[cfg(windows)]
impl FileLocks {
    pub fn acquire(path: &Path, revision: &DiskRevision) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        let mut keys = vec![format!("path:{}", path.to_string_lossy().to_ascii_lowercase())];
        if let (Some(volume), Some(file)) = (revision.volume_id, revision.file_id) { keys.push(format!("identity:{volume}:{file}")); }
        keys.sort();
        let mut locks = Self { handles: vec![] };
        for key in keys {
            let name: Vec<u16> = format!("Local\\StuartMD-document-{}", sha256(key.as_bytes())).encode_utf16().chain(std::iter::once(0)).collect();
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() { return Err(format!("创建文件互斥对象失败: {}", std::io::Error::last_os_error())); }
            let status = unsafe { WaitForSingleObject(handle, 30_000) };
            if status != WAIT_OBJECT_0 && status != WAIT_ABANDONED { unsafe { CloseHandle(handle); } return Err(format!("文件保存锁等待失败: {status}")); }
            locks.handles.push(handle);
        }
        Ok(locks)
    }
}

#[cfg(windows)]
impl Drop for FileLocks {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        for handle in self.handles.iter().rev() { unsafe { ReleaseMutex(*handle); CloseHandle(*handle); } }
    }
}

#[cfg(not(windows))]
pub struct FileLocks;
#[cfg(not(windows))]
impl FileLocks { pub fn acquire(_: &Path, _: &DiskRevision) -> Result<Self, String> { Err("当前保存服务要求 Windows 文件锁和原子替换接口".into()) } }
