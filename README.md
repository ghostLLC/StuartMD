# StuartMD

轻量 Markdown 阅读与编辑器（Windows 桌面应用）。风格简约，适合日常读文档、写笔记、批注 PDF。

![version](https://img.shields.io/badge/version-1.12.0-blue)

## 功能

- Markdown：阅读 / 分栏 / 源码，点击段落直接编辑
- 快捷键：`Ctrl+B/I` 加粗斜体、`Ctrl+Alt+1..4` 标题、`Ctrl+Shift+7/8/9` 列表（类似飞书）
- 语法：表格、任务列表、代码高亮、LaTeX、Mermaid
- PDF：竖版横版阅读，标黄 / 擦除（批注存 AppData，不改原文件）
- 打开方式：智能新窗口 / 标签页；打开文件夹会在侧栏显示目录树
- 自动保存、多语言（简/繁/英）、主题与壁纸取色
- 插件：`%APPDATA%\StuartMD\plugins`，见 [docs/PLUGINS.md](docs/PLUGINS.md)

## 下载（双轨）

详见 [docs/PARALLEL-TRACKS.md](docs/PARALLEL-TRACKS.md)。

| 轨道 | 下载文件 | 说明 |
|------|----------|------|
| **Stable 稳定** | `StuartMD-Setup-*.exe` | pywebview 壳，日常使用 |
| **Beta 测试** | `StuartMD-Tauri-*-setup.exe` | Tauri 壳，尝鲜 / 反馈 |

- 安装向导可自定义路径  
- 静默示例：`StuartMD-Setup-1.12.0.exe /VERYSILENT /DIR="D:\Apps\StuartMD"`

## 开发（仓库以 Tauri 为主）

| 轨道 | 目录 | 说明 |
|------|------|------|
| **Beta / 主线** | `tauri/` + `web/` | 日常开发与 PR 以这里为准 |
| **Stable** | `main.py` + Inno | 仅用于打稳定安装包，功能冻结节奏更稳 |

```bash
# Beta: Tauri
cd tauri/src-tauri
cargo tauri dev
cargo tauri build

# Stable: 仍可用 pywebview 出包
pip install pywebview pyinstaller
python main.py
build-installer.bat
```

## 配置位置

`%APPDATA%\StuartMD\`（settings.json、插件、壁纸、PDF 批注）

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

见仓库说明；默认个人/学习使用，请自行补充 LICENSE。
