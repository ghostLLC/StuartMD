# StuartMD

Windows Markdown / PDF 阅读与编辑器。当前代码版本为 **3.5.16**，使用 Tauri 2 和共享前端。

安装文件通过 [GitHub Releases](https://github.com/ghostLLC/StuartMD/releases) 提供。当前分支的构建文件名称为 `StuartMD_3.5.16_x64-setup.exe`；验证范围见 `docs/validation/3.5.16/acceptance.md`。

## 文档编辑

阅读、分栏和源码模式共享同一文档内容。单击段落、表格或代码块可以就地编辑；选中文字后使用浮动工具栏。支持表格、任务列表、代码高亮、LaTeX 和 Mermaid。

编辑保留未修改区域的原文和换行。打开需要确认编码的文件时，先查看编码预览；保存检查实际文件版本，外部修改会暂停自动保存并显示基础内容、本地内容及外部内容。草稿包含未保存文档和空正文，启动恢复界面可以查看与恢复已经持久化的修改。

多标签分别保存编辑状态，多窗口分别管理文档访问权限。支持文件夹目录树、页宽设置、浅色与深色主题，以及简体中文、繁体中文和 English。

## PDF 阅读与批注

支持缩放、适应高度、页面旋转和双页显示。选区工具栏提供高光、下划线、删除线、评论和 AI 问答。

新增批注首先保存在本机资料目录。点击写入 PDF 后，批注成为 PDF 原生批注；修改原生批注的颜色、评论或删除批注会保存 PDF 文件。保存检查文件冲突并保留恢复内容。撤销与重做支持当前文档最近 20 次批注操作，清除操作默认保留评论。

安装资源包含 PDF.js CMaps、字体、PDFium、Tesseract 及简体中文、繁体中文、English OCR 语言资源。扫描页、混合页面和低置信度文字在知识索引中显示相应状态。

## AI 问答、会话和记忆

在设置的“已保存模型”中点击“添加模型”，选择服务商、必要区域，填写 API Key 并勾选一个或多个型号。同一连接的模型共用加密密钥；内置型号已经提供地址、容量、思考能力和计数配置。顶部和伴读输入区直接选择已保存模型，支持搜索、最近使用和默认模型。选中 Markdown 或 PDF 正文后按 `Alt+E` 发起问答；按 `Alt+I` 打开伴读面板。

快速问答与伴读面板共享问题、答案和请求状态。提问范围包含选中内容、当前章节、整篇文档和工作区资料；新建文档会话默认使用整篇文档。各个文档与工作区分别保存输入草稿、引用和阅读位置。

发送前可以查看本次材料；明确加入的引用会核对真实来源并参与容量计算。回答显示准备材料、核算容量、整理对话和生成回答的实际状态，支持停止、追问、重试、复制及保存 Markdown 笔记。失败和停止的回答保留实际内容及状态。

会话页面支持按当前目标、文档、工作区或全部会话筛选，搜索问题与答案，分页读取消息、修改名称、恢复原文及草稿并继续提问。删除会话提供关联记忆处理选项，已经保存的记忆来源摘录可以独立保留。

提供 DeepSeek、Qwen、Kimi、GLM 的十二个预置型号及自定义 OpenAI 兼容服务。模型参数分别保存，修改当前模型用于后续请求，已经发送的请求保留原配置。模型列表、默认选择、当前选择和最近使用在重新启动后恢复。旧设置会迁移并保留已有型号、输出预算、计数覆盖项和加密凭据引用。

“获取模型目录”显示在线目录及获取时间。“验证回答”发送公开测试消息，分别检查计数、实际正文、完成标记与用量。更换密钥、地址、型号或参数后需要重新验证。官方连接中的“添加其他型号”支持填写目录外型号、输出预算、容量、计数资料及请求参数。自定义服务可以新建独立连接，也可以选择已有连接添加模型。思考方式中的“服务默认”保留服务端默认参数，旧版 balanced 配置迁移后使用此状态。当前实际服务商接口验收范围为 DeepSeek，具体结果见验收记录。

“使用已有记忆”与“整理新记忆”分别设置。整理方式包含关闭、询问、自动。询问方式允许选取完整答案中的实际段落并确认保存；自动方式独立核算容量、验证来源并整理记录，需要确认的偏好进入候选列表。

记忆页面支持手工新建、搜索、筛选、编辑、固定、查看来源及历史版本和删除。记录保留稳定身份与不可覆盖的版本，保存检查已确认版本；已确认内容按照文档、工作区或全局归属参与适用请求。API Key 使用当前 Windows 用户的 DPAPI 加密。

## 知识资料

打开工作目录后，在知识页面建立索引。软件统一使用 BGE-M3 进行语义检索，自动准备固定版本的模型资源并校验 SHA-256。已有索引需要更新时，会在新索引成功建立后替换；更新失败或取消时保留原索引文件。

查询结合全文检索与实际语义向量。结果包含来源文件、Markdown 位置或 PDF 页码和矩形，可以打开来源或引用到问答。来源修改、移动和删除均参与索引状态检查；部分索引需要明确确认后引用。

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

实际结果和各项验证范围见 [3.5.16 验收](docs/validation/3.5.16/acceptance.md)。公开发布前执行 `pwsh -File scripts/verify-release.ps1 -Publication`，全部必要检查通过并具有当前源代码指纹后允许发布。用户要求跳过的界面检查记录为 `SkippedByUser`。

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
