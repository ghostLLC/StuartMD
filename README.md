# StuartMD

Windows Markdown / PDF 阅读与编辑器。当前代码版本为 **3.5.11**，使用 Tauri 2 和共享前端。

安装文件通过 [GitHub Releases](https://github.com/ghostLLC/StuartMD/releases) 提供。当前分支的构建文件名称为 `StuartMD_3.5.11_x64-setup.exe`；发布状态与验证结果见 `docs/validation/3.5.11/acceptance.md`。

## 文档编辑

阅读、分栏和源码模式共享同一文档内容。单击段落、表格或代码块可以就地编辑；选中文字后使用浮动工具栏。支持表格、任务列表、代码高亮、LaTeX 和 Mermaid。

编辑保留未修改区域的原文和换行。打开需要确认编码的文件时，先查看编码预览；保存检查实际文件版本，外部修改会暂停自动保存并显示基础内容、本地内容及外部内容。草稿包含未保存文档和空正文，启动恢复界面可以查看与恢复已经持久化的修改。

多标签分别保存编辑状态，多窗口分别管理文档访问权限。支持文件夹目录树、页宽设置、浅色与深色主题，以及简体中文、繁体中文和 English。

## PDF 阅读与批注

支持缩放、适应高度、页面旋转和双页显示。选区工具栏提供高光、下划线、删除线、评论和 AI 问答。

新增批注首先保存在本机资料目录。点击写入 PDF 后，批注成为 PDF 原生批注；修改原生批注的颜色、评论或删除批注会保存 PDF 文件。保存检查文件冲突并保留恢复内容。撤销与重做支持当前文档最近 20 次批注操作，清除操作默认保留评论。

安装资源包含 PDF.js CMaps、字体、PDFium、Tesseract 及简体中文、繁体中文、English OCR 语言资源。扫描页、混合页面和低置信度文字在知识索引中显示相应状态。

## AI 问答、会话和记忆

在设置中启用 AI，配置服务商、模型与 API Key。选中 Markdown 或 PDF 正文后按 `Alt+E` 发起问答；按 `Alt+I` 打开伴读面板，使用问答、知识、记忆和会话页面。

流式回答、追问、取消和关闭 AI 通过共同服务处理。完整回答保存到本机会话数据库；会话页面可以恢复历史。上下文使用文档版本、来源指纹、实际检索结果和模型预算，必要内容超过预算时显示错误。

提供 DeepSeek、Qwen、Kimi、GLM 和 OpenAI 兼容服务配置。模型需要有效的 Token 计数配置；DeepSeek 使用随安装包提供的 tokenizer，其他模型使用已登记的计数接口或用户提供的配置。本次实际服务商验收范围为 DeepSeek。

记忆支持查看来源、编辑、固定和删除，以及关闭学习、询问后保存、自动保存学习记录。已确认偏好按文档、工作目录或全局范围参与适用的请求。API Key 使用当前 Windows 用户的 DPAPI 加密。

## 知识资料

打开工作目录后，在知识页面选择 BGE-M3 或多语言 MiniLM 并建立索引。首次准备模型需要下载清单中固定版本的实际模型资源，程序会校验 SHA-256。

查询结合全文检索与实际语义向量。结果包含来源文件、Markdown 位置或 PDF 页码和矩形，可以打开来源或引用到问答。来源修改、移动、删除以及模型切换均参与索引状态检查；部分索引需要明确确认后引用。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+O` / `Ctrl+N` | 打开文件 / 新建文档 |
| `Ctrl+S` / `Ctrl+Shift+S` | 保存 / 另存为 |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | 阅读 / 分栏 / 源码 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Shift+Z` / `Ctrl+Y` | 重做 |
| `Ctrl+F` | 查找 |
| `Ctrl+E` / `Ctrl+P` | 导出 HTML / 打印 |
| `Alt+E` / `Alt+I` | 选区问答 / 伴读面板 |

## 构建与验证

从仓库根目录安装锁定的 Node 依赖，准备原生资源和 Token 计数资源，再执行测试。需要 Rust 1.98.1、Node.js、PowerShell 7，以及资源准备脚本使用的 7-Zip。

```powershell
npm ci
pwsh -File scripts/prepare-resources.ps1
pwsh -File scripts/prepare-tokenizers.ps1
npm test
cargo test --manifest-path tauri/src-tauri/Cargo.toml --locked -- --test-threads=1
node tests/repair-mermaid-layout.cjs
node tests/repair-pdf-viewer.cjs
pwsh -File scripts/verify-release.ps1
```

完整验收命令由 `scripts/verify-repair.ps1` 的 `Core`、`Browser`、`Native`、`Models`、`Providers`、`Installer` 模式运行。Models 模式需要按照 `tests/model-reference-requirements.txt` 配置独立 Python 环境；Providers 模式使用当前用户已经配置的 DeepSeek 加密密钥和独立测试目录。密钥内容不会进入验证日志。Installer 模式执行本机安装、SQLite 一致性备份、实际用户数据保留和进程启动检查。

实际结果和各项验证范围见 [3.5.11 验收](docs/validation/3.5.11/acceptance.md)。公开发布前执行 `pwsh -File scripts/verify-release.ps1 -Publication`，全部必要检查通过并具有当前源代码指纹后允许发布。

```powershell
Set-Location tauri
cargo tauri build --bundles nsis
```

安装产物位于 `tauri/src-tauri/target/release/bundle/nsis/`。必要验收未完成时保留对应状态并阻止公开发布。

## 本机数据

| 路径 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\StuartMD\` | 默认程序安装目录和内置示例 |
| `%APPDATA%\StuartMD\settings.json` | 窗口、主题、会话与 AI 设置 |
| `%APPDATA%\StuartMD\ai\keys\` | DPAPI 加密的 API Key |
| `%APPDATA%\StuartMD\chat_archive.db` | 会话、记忆和来源 |
| `%APPDATA%\StuartMD\document_journal.db` | 持久化草稿 |
| `%APPDATA%\StuartMD\save_journal.db`、`save_history\` | 保存记录、恢复内容和备份 |
| `%APPDATA%\StuartMD\pdf_annotations\` | PDF 批注资料 |
| `%APPDATA%\StuartMD\plugins\`、`wallpapers\` | 插件与壁纸 |
| 工作目录中的 `.stuart\` | 索引目录与模型选择 |

插件首次启用需要确认授权，源码发生变化后需要重新确认。安装升级保留本机资料；数据库迁移会创建备份并检查完整性。

项目与问题反馈：[StuartMD](https://github.com/ghostLLC/StuartMD)、[GitHub Issues](https://github.com/ghostLLC/StuartMD/issues)。
