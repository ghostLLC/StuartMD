use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const MD_EXTS: [&str; 5] = [".md", ".markdown", ".mdown", ".mkd", ".txt"];

pub fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") { return format!("\\\\{rest}"); }
    value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()
}

pub fn scan(root: &Path, include_pdf: bool, max_depth: usize, current_file: Option<&Path>) -> Result<Value, String> {
    let mut count = 0;
    let mut truncated = false;
    let items = walk(root, include_pdf, max_depth, &mut count, &mut truncated, current_file)?;
    Ok(json!({"path": display_path(root), "name": root.file_name().unwrap_or(root.as_os_str()).to_string_lossy(), "items": items, "truncated": truncated}))
}

fn walk(root: &Path, include_pdf: bool, depth: usize, count: &mut usize, truncated: &mut bool, current_file: Option<&Path>) -> Result<Vec<Value>, String> {
    let entries = fs::read_dir(root).map_err(|error| format!("无法读取目录 {}：{error}", display_path(root)))?;
    let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| format!("无法读取目录条目：{error}"))?;
    entries.sort_by_key(|entry| (current_file != Some(entry.path().as_path()), entry.file_name().to_string_lossy().to_lowercase()));
    let mut files = vec![];
    let mut directories = vec![];
    // 先收录当前目录的文档，保证深层目录不会占满根目录的显示名额。
    for entry in entries {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') && current_file != Some(path.as_path()) { continue; }
        let kind = entry.file_type().map_err(|error| format!("无法读取文件类型 {}：{error}", display_path(&path)))?;
        if kind.is_symlink() { continue; }
        if kind.is_dir() {
            directories.push(path);
            continue;
        }
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
        if !kind.is_file() || !(current_file == Some(path.as_path()) || MD_EXTS.contains(&format!(".{extension}").as_str()) || include_pdf && extension == "pdf") { continue; }
        if *count >= 2500 { *truncated = true; continue; }
        *count += 1;
        files.push(json!({"name": entry.file_name().to_string_lossy(), "path": display_path(&path), "type": "file"}));
    }
    let mut items = vec![];
    for directory in directories {
        if depth <= 1 || *count >= 2500 { *truncated = true; continue; }
        *count += 1;
        let children = walk(&directory, include_pdf, depth - 1, count, truncated, current_file)?;
        if children.is_empty() { *count -= 1; continue; }
        items.push(json!({"name": directory.file_name().expect("目录名称缺失").to_string_lossy(), "path": display_path(&directory), "type": "dir", "children": children}));
    }
    files.sort_by_key(|item| item["name"].as_str().expect("文件名称缺失").to_lowercase());
    items.extend(files);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_directories_do_not_hide_documents() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..2500 { fs::create_dir(root.path().join(format!("empty-{index:04}"))).unwrap(); }
        let documents = root.path().join("z-documents");
        fs::create_dir(&documents).unwrap();
        fs::write(documents.join("real.md"), "真实文档").unwrap();
        for include_pdf in [false, true] {
            let result = scan(root.path(), include_pdf, 3, None).unwrap();
            assert_eq!(result["items"].as_array().unwrap().len(), 1);
            assert_eq!(result["items"][0]["children"][0]["name"], "real.md");
            assert_eq!(result["truncated"], false);
        }
    }

    #[test]
    fn current_file_is_retained_at_display_limit() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..2500 { fs::write(root.path().join(format!("a-{index:04}.md")), "文档").unwrap(); }
        let current = root.path().join("z-current.md");
        fs::write(&current, "当前文档").unwrap();
        let result = scan(root.path(), true, 3, Some(&current)).unwrap();
        let files = result["items"].as_array().unwrap();
        assert_eq!(files.len(), 2500);
        assert!(files.iter().any(|file| file["name"] == "z-current.md"));
        assert_eq!(result["truncated"], true);
    }

    #[test]
    fn current_document_without_extension_remains_visible() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("README");
        fs::write(&current, "当前说明文档").unwrap();
        fs::write(root.path().join("other.log"), "其他文件").unwrap();
        fs::write(root.path().join(".hidden.md"), "隐藏文档").unwrap();
        let result = scan(root.path(), true, 3, Some(&current)).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["name"], "README");
    }
}
