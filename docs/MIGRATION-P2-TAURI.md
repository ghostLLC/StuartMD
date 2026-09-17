# StuartMD — Tauri 为唯一维护线

状态：**Tauri 是主开发线**；pywebview Stable 冻结在 1.13.1。当前主版本 **2.0.0**。

## 目录

```
tauri/src-tauri/     # Rust 壳（唯一维护）
web/                 # 共享前端
samples/             # 打包进 resources
```

## 本版交付（1.14.0）

- [x] API 与 pywebview 对齐（最近文件、导出、新建窗口、插件启停、CLI 启动）
- [x] 设置 schema 迁移
- [x] withGlobalTauri 系统对话框
- [x] NSIS 中/英 + 当前用户安装
- [ ] 真机完整清单自测后发 GitHub Release
