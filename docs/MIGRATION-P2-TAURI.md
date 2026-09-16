# StuartMD P2 — Tauri 壳迁移说明

状态：脚手架与 API 兼容层已就绪；**默认启动仍为 pywebview**（`main.py`），避免改变现有功能/UI。

## 目标

用 **Tauri 2** 替换 Python 壳，继续加载同一套 `web/` 前端。

## 目录

```
tauri/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/main.rs      # 窗口 + 命令
    src/fs_api.rs    # 与 pywebview API 对齐的文件/设置命令
  README.md
web/js/core/tauri-bridge.js  # 运行时探测 Tauri，注入 window.pywebview.api
```

## 构建前提

```powershell
winget install Rustlang.Rustup
rustup default stable
npm i -g @tauri-apps/cli
# 或在 tauri/src-tauri 使用 cargo tauri
```

## 本步交付（P2 检查点）

- [x] Tauri 工程骨架（配置 + Rust 源）
- [x] 命令名与现有 `window.pywebview.api.*` 对齐
- [x] 前端 bridge：优先 Tauri，否则回退 pywebview
- [ ] 在装好 Rust 的机器上 `cargo tauri build`（下一步）
- [ ] 默认启动切到 Tauri（P2 收尾 / P3 前）

## API 对齐表

| JS API | Tauri command |
|--------|----------------|
| get_settings / save_settings | stuart_get_settings / stuart_save_settings |
| read_file / write_file | stuart_read_file / stuart_write_file |
| read_pdf | stuart_read_pdf |
| open_file_dialog / save_file_dialog / open_folder_dialog | stuart_open_* |
| open_in_new_window | stuart_open_in_new_window |
| read_dir_tree | stuart_read_dir_tree |
| check_update / open_url | stuart_check_update / stuart_open_url |
| list_plugins / read_plugin_source | stuart_list_plugins / stuart_read_plugin_source |
| import_wallpaper / get_wallpaper | stuart_import_wallpaper / stuart_get_wallpaper |
| register_file_association | stuart_register_file_association |
| get_app_info | stuart_get_app_info |

## 回滚

`git checkout v1.7.1` 或安装包 `StuartMD-Setup-1.7.1.exe`。  
P2 未改默认入口，卸载/覆盖安装即可回 pywebview。
