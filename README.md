# StuartMD

轻量 **Markdown / PDF** 阅读与编辑器（Windows 桌面）。风格简约，适合读文档、写笔记、批注 PDF，并内置 **选区 AI 讲解**。

![version](https://img.shields.io/badge/version-3.1.5-blue)

**下载：** [GitHub Releases](https://github.com/ghostLLC/StuartMD/releases) · 最新安装包 `StuartMD-Setup-3.1.3.exe`

## 功能概览

### Markdown 编辑与阅读
- 模式：**阅读 · 分栏 · 源码**；点击段落轻量编辑，双击复杂块进源码
- 飞书式交互：块手柄、选中浮动工具栏、右键插入
- 页宽：默认 / 较宽 / 全宽
- 语法：表格、任务列表、代码高亮、**LaTeX**、**Mermaid**、下划线等
- 撤销：`Ctrl+Z` / `Ctrl+Shift+Z`；重做：`Ctrl+Y`
- 自动保存、会话恢复、多标签 / 多窗口、文件夹目录树
- 主题：浅色 / 灰色 / 深色 / 羊皮纸 / 小黄人 / 壁纸；简中 / 繁中 / English
- 插件目录即插即用

### PDF
- 竖版 / 横版阅读，缩放、适应高度、旋转、双页
- 标注：**高光 / 下划线 / 删除线 / 评论**（选区小工具条）
- 评论浮窗可拖动；清除标注默认保留评论
- 选中文字 → 标注条「**讲解**」或 `Alt+E`，结合本页与邻页文本讲解
- 批注侧车存在 AppData，不直接改原文件（导出时才写入）

### AI 讲解（3.0.x / 3.1.x）
- 选中文字 → 浮动栏「**讲解**」或 **Alt+E**（可自定义）；**Markdown 与 PDF 均支持**
- **只讲解、不改写**文档；结合章节 / 邻近块等上下文
- 讲解面板：聊天记录、追问、复制、记入记忆、再讲一次
- 等待时有思考动画；首次回答可反馈 **太短 / 满意 / 太长**
- 右上角 **模型** 图标：切换服务商与模型、思考深度
- 内置预设：**DeepSeek / Qwen / Kimi / GLM** + 自定义 OpenAI 兼容
- API Key **本机 DPAPI** 保存，不进文档与明文备份
- **自定义风格**（设置 → AI）：回答长度、语气、风格说明、长度提示（可编辑）

### 设置
- 设置窗口**默认加宽**，可拖拽调大小、**缩放**（−/＋ 或 Ctrl+滚轮），并记忆
- 打开方式、语言、外观、插件、文件关联、检查更新等

## 快速开始

1. 安装 `StuartMD-Setup-3.1.3.exe`（默认 `%LOCALAPPDATA%\StuartMD`）
2. 打开示例或任意 `.md` / `.pdf`
3. 使用 AI：右上角 **模型** → 配置 API Key → 在 Markdown 或 **PDF** 中选中文字 → **讲解**

静默安装：

```text
StuartMD-Setup-3.1.3.exe /S
```

## 快捷键（常用）

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+O` / `Ctrl+S` | 打开 / 保存 |
| `Ctrl+N` | 新建 |
| `Ctrl+F` | 查找 |
| `Ctrl+B` | 侧栏（编辑器内为加粗） |
| `Ctrl+1/2/3` | 阅读 / 分栏 / 源码 |
| `Ctrl+E` / `Ctrl+P` | 导出 HTML / 打印 |
| **`Alt+E`** | AI 讲解（可自定义） |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 |
| `Ctrl+Y` | 重做 |

## 开发

仓库**只维护 Tauri** 线 + 共享前端：

```bash
cd tauri/src-tauri
cargo tauri build
# 产物: target/release/bundle/nsis/StuartMD_*_x64-setup.exe
```

目录：

```text
web/                 # 前端 UI（app.js、pdf-viewer、AI 模块等）
web/js/core/         # 设置 schema、agent-api、ai-client、ai-context
web/js/ui/           # AI 面板 UI
tauri/               # Rust 壳（fs / win / ai_chat / ai_api）
samples/             # 安装包内置示例
scripts/             # 自测 selftest_*.py、bump_lock.py 等
docs/                # 设计与插件说明
research/            # 中期 AI 调研报告（可选）
```

构建前建议：

```bash
python scripts/bump_lock.py
python scripts/selftest_3_0_0.py
```

## 配置与数据位置

| 路径 | 内容 |
|------|------|
| `%LOCALAPPDATA%\StuartMD\` | 程序安装目录 |
| `%APPDATA%\StuartMD\settings.json` | 主题、会话、AI 配置等（**不含**明文 API Key） |
| `%APPDATA%\StuartMD\ai\keys\` | API Key（DPAPI） |
| `%APPDATA%\StuartMD\ai\memory\` | AI 记忆 |
| `%APPDATA%\StuartMD\` | 插件、壁纸、PDF 批注侧车等 |

## 产品说明

- 维护策略：**仅 Tauri**；功能变更会 bump 版本并更新 [CHANGELOG.md](CHANGELOG.md)
- AI 默认 **BYOK**（用户自备 API Key），不内置计费代理
- 长期路线：选区讲解 → 多厂商与 PDF 讲解完善 → 可感知的记忆「越用越好」

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## License / 仓库

https://github.com/ghostLLC/StuartMD
