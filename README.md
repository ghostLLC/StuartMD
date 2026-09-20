# StuartMD

轻量 Markdown 阅读与编辑器（Windows 桌面应用）。风格简约，适合日常读文档、写笔记、批注 PDF。

![version](https://img.shields.io/badge/version-2.8.2-blue)

## 功能

- Markdown：阅读 / 分栏 / 源码，点击段落直接编辑
- 飞书式交互：块手柄、选中浮动栏、右键插入菜单
- 页宽：默认 / 较宽 / 全宽（工具栏可切换）
- 快捷键：`Ctrl+Z` / `Ctrl+Shift+Z` 撤销，`Ctrl+Y` / `Ctrl+Shift+Y` 重做
- 语法：表格、任务列表、代码高亮、LaTeX、Mermaid
- PDF：竖版横版阅读，标黄 / 擦除（批注存 AppData，不改原文件）
- 打开方式：智能新窗口 / 标签页；文件夹目录树
- 自动保存、多语言、主题与壁纸、插件

## 下载

| 资产 | 说明 |
|------|------|
| **`StuartMD-Setup-2.8.2.exe`** | Tauri 主版本（唯一维护线） |

- 默认安装：`%LOCALAPPDATA%\StuartMD`
- 静默安装：`StuartMD-Setup-2.8.2.exe /S`

## 开发

仓库只维护 **Tauri** 壳 + 共享前端：

```bash
cd tauri/src-tauri
cargo tauri build
# 产物: target/release/bundle/nsis/StuartMD_*_x64-setup.exe
```

目录：

```
web/          # 前端 UI
tauri/        # Rust 壳
samples/      # 打包进安装包的示例
docs/         # 设计与插件说明
scripts/      # 图标等工具
```

## 配置位置

`%APPDATA%\StuartMD\`（settings.json、插件、壁纸、PDF 批注）

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
