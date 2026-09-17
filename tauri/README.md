# StuartMD Tauri shell — **唯一维护线**

Frontend is shared `../web`. Shell is Tauri 2.

```powershell
cd tauri\src-tauri
cargo tauri build
# 产物: target/release/bundle/nsis/StuartMD_1.14.0_x64-setup.exe
```

## 能力对齐

| 能力 | 命令 / 说明 |
|------|-------------|
| 设置读写 + schema 迁移 | `stuart_get_settings` / `stuart_save_settings` |
| 文件/目录树/PDF | `stuart_read_file` / `stuart_read_dir_tree` / `stuart_read_pdf` |
| 最近打开 | `stuart_get_recents`（写文件/开目录自动 push） |
| 导出 HTML | 前端 dialog.save + `write_file` |
| 多窗口 | `stuart_open_new_window` / `stuart_open_in_new_window` |
| 插件启停 | `stuart_set_plugin_enabled` |
| 文件关联 | `stuart_register_file_association`（HKCU + App Paths） |
| CLI 启动文件 | `get_app_info.startup_file` |
| PDF 批注 sidecar | `stuart_*_annotations` |
| 壁纸 | `stuart_import_wallpaper_ex` + 前端 canvas 主色 |

## 前置

- Rust stable + VS Build Tools + Windows SDK  
- `cargo install tauri-cli --locked`（或 npx @tauri-apps/cli）
