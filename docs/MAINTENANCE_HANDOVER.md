# StuartMD 开发维护交接

交接日期：2026-10-22，维护更新：2026-10-23。当前开发版本：`3.5.21`；最近发布基线：`d7b60ab6dbef66fde4c79fb7643c2a2fc0424082`，版本 `3.5.20`。本文件依据仓库提交、当前代码、发布元数据及验收记录编写。3.5.21 的执行结果见对应验收文档；窗口检查遵照用户要求跳过。

## 1. 接手时确认的基线

| 项目 | 当前状态 |
| --- | --- |
| 工作目录 | `C:\Users\Administrator\Desktop\Stuart` |
| Git 远程 | `https://github.com/ghostLLC/StuartMD.git` |
| 本地开发分支 | `codex/repair-3.5.11`；分支名称保留了历史版本，不能据此判断软件版本 |
| 已发布版本 | `v3.5.20`，正式发布，安装包与校验文件均已上传 |
| 发布提交 | `d7b60ab6dbef66fde4c79fb7643c2a2fc0424082` |
| 最近产品代码提交 | `39fe4a9b65f9405d712b4355ebb78155a3893b20` |
| 安装包 | `StuartMD_3.5.20_x64-setup.exe`，86,929,257 字节 |
| 安装包 SHA-256 | `1ced1f4b40a723ee681906341c85077034edc8ccb128dba0f2c54e6192aeb03b` |
| 软件源码指纹 | `5b3a7533ccf3b794e9b38af686c06fff625ace46882ddb5c5a15f5ab6e1494d5` |
| 本机安装位置 | `%LOCALAPPDATA%\StuartMD\stuartmd.exe` |

发布和安装详细依据见 [3.5.20 验收](validation/3.5.20/acceptance.md)。后续提交文档不会改变上述发布提交；下次开发需要重新读取 Git 状态和实际安装版本。

当前还登记了两个旧工作目录：`.worktrees/list-empty-one-click` 和 `.worktrees/ux-smooth-edit`，分别停留在 `2500ad9`、`82ef570`。它们用于历史开发，继续产品开发应从当前代码开始。删除这些目录前必须检查其中是否还有用户文件或未提交内容。

## 2. 产品行为与代码入口

产品以本地 Markdown 阅读、编辑和 PDF 阅读批注为基础，AI 问答、伴读和知识检索围绕当前文档及用户明确打开的工作目录提供功能。正文、草稿、文件保存、AI 会话和索引拥有不同的持久化责任，修改功能时需要明确涉及哪些数据。

| 范围 | 主要文件 | 接手时应理解的关系 |
| --- | --- | --- |
| 页面与交互 | `web/index.html`、`web/js/app.js` | 静态页面直接装载脚本；主文件仍承担大量事件、编辑、保存和页面协调逻辑 |
| 文档身份与文字 | `web/js/core/document-session.js`、`text-buffer.js`、`write-coord.js` | 文档身份、修订、换行及异步写入共同决定修改归属 |
| 阅读位置与目录 | `web/js/core/document-viewport.js`、`folder-view.js` | 标签页阅读位置需要独立；目录刷新与 AI 工作目录是不同状态 |
| 选择与格式 | `web/js/core/preview-selection.js`、`selection-formatting.js`，以及 `app.js` | DOM 选区、局部编辑和 Markdown 源码之间需要转换 |
| Mermaid | `web/js/core/mermaid-renderer.js` | 渲染尺寸、字体测量、源码编辑和可用工具栏共同影响结果 |
| 文档保存 | `tauri/src-tauri/src/document/` | 身份、编码、磁盘版本、保存记录、草稿和恢复处理 |
| PDF | `web/js/pdf-viewer.js`、`document/pdf_annotations.rs`、`document/pdf_runtime.rs` | 页面渲染、批注数据、实际 PDF 写入及来源坐标关联 |
| AI 前端 | `web/js/core/ai-service.js`、`ai-context.js`、`ai-client.js`、`conversation-store.js` | 请求配置快照、上下文、流式结果和持久化会话 |
| AI 页面 | `web/js/ui/ai-settings.js`、`model-picker.js`、`companion.js`、`conversation-view.js`、`memory.js` | 多模型选择与连接配置；伴读问答、知识、记忆、会话 |
| AI 后端 | `tauri/src-tauri/src/ai/`、`context/`、`memory/` | 模型能力、请求参数、预算、来源、摘要、会话和记忆版本 |
| 知识检索 | `tauri/src-tauri/src/rag/`、`rag_ipc.rs` | 文本/PDF 提取、OCR、向量、全文检索、索引生成和文件变化 |
| 安装与资源 | `tauri/src-tauri/tauri.conf.json`、`tauri/src-tauri/windows/`、`resources/`、`scripts/` | 程序资源、文件图标、模型资源与实际安装过程 |

修改 `app.js` 前应同时查看调用入口、提交函数、事件绑定顺序和文档切换过程。只修改某个按钮的事件处理，容易遗漏键盘、浮动工具栏或另一个编辑模式的同类入口。

## 3. 维护历史中反复出现的问题

以下记录说明问题类型及已经实施的工作。当前仍然存在的风险在下一节单独列明。

| 阶段 | 主要工作与提交 | 后续开发需要保留的约束 |
| --- | --- | --- |
| 3.5.1—3.5.10 | 多次调整单击编辑、列表空项、表格退出、代码/公式编辑、Mermaid 尺寸 | 阅读时的选择行为与立即进入编辑存在事件竞争；不要只验证输入文字 |
| 3.5.11 | `9656bdd`：文档保存、PDF、Mermaid、DeepSeek；`2345f05`：块手柄 | 文档修改必须归属正确文件；手柄不能遮挡正文；渲染必须在真实布局下核对 |
| 3.5.12 | `4b83005`：伴读完整流程 | 问答入口、上下文范围、来源、会话恢复、记忆与索引需要贯通 |
| 3.5.13 | `78a74c5`、`ae6a52a`、`8feb833`：连接与模型分离、多模型配置、迁移及凭据并发 | 同一连接共享密钥；每个已保存模型拥有独立参数；迁移需要保护用户修改 |
| Mermaid 工具 | `e75e4f7`：限制图表内选择的格式操作 | 图表标签不支持的富文本操作不得暴露为可用功能 |
| 3.5.14 | `1c4c6ef`：知识检索统一 BGE-M3 | 模型维度与索引代次绑定；取消更新必须保留可用索引 |
| 3.5.15 | `c153aac`：不同文档阅读位置隔离 | 滚动事件、延迟恢复和渲染完成回调都需要核对文档身份 |
| 3.5.16 | `00d669b`：开始页面图标 | 页面图标、窗口图标、安装资源需要保持一致 |
| 3.5.17 | `73e224c`：目录刷新跟随当前文件 | 当前文件目录与明确打开的知识工作目录不能相互覆盖 |
| 3.5.18 | `3b4f7fe`：Markdown 文件关联图标 | Windows 文件类型图标通过安装和关联配置生效，修改页面资源无法覆盖这个过程 |
| 3.5.19 | `0ebc9c1`：AI 设置页面、旧默认配置处理 | 默认模型目录会过时；清理旧配置只能处理确认未被用户修改和使用的预置项 |
| 3.5.20 | `39fe4a9`：跨段拖选、分级 Ctrl+A | 选区跨越多个编辑区域后，还必须检查所有消费选区的命令 |

经常出现的共同原因：一个用户操作经过多个独立状态表示。Markdown 源码、渲染 DOM、局部 contenteditable、缓存选区、当前标签页和延迟回调之间，只要某处继续使用旧身份或旧位置，就可能出现内容串入其他文件、光标跳动、文字丢失或操作范围错误。

## 4. 当前选区操作与发布规则

### 4.1 删除与剪切

`web/js/core/preview-commands.js` 在预览 DOM 副本上按 Range 的真实端点执行修改，保留部分选中的首尾段落及表格单元格结构。选区完整覆盖的块可以删除，全文删除允许产生空正文。

页面入口统一经过 `modifyPreviewSelection()`：提交活动编辑并恢复选区，检查文档身份与修订，计算修改，再交给 `setContent()` 更新文档、撤销记录与保存任务。未选中的源码块直接保留。图表、公式等特殊内容的部分删除会明确要求使用源码编辑。

### 4.2 行内格式

格式操作按选区实际覆盖的文字节点执行。重复文字不参与位置推断；跨段格式分别作用于各段实际选中的文字。修改后的块使用 Turndown 和 GFM 插件转换为 Markdown，支持链接、列表、表格及行内样式。依赖版本、分发文件和许可证均纳入校验。

相邻的相同格式会合并。行内代码的部分选区保留独立的代码元素，格式包裹在代码元素外部；包含代码的格式使用 HTML 保存，保持文字及选区边界。

工具栏点击保持活动选区；链接执行一次；已经处理的快捷键不会再次进入窗口级处理。已有链接内的链接地址修改、图表和公式内部修改需要使用源码。转换可能规范化被编辑块的 Markdown 写法，未编辑块保留原始源码。

### 4.3 发布规则与界面授权

`scripts/release-policy.json` 保存允许跳过的模式、授权日期、原因和范围。当前只授权 Browser、Native；其状态保持 `SkippedByUser`。公开发布检查逐项检查六种模式，失败、缺失、无授权跳过或授权不一致都会终止检查。

用户恢复界面检查授权时移除相应授权项，再执行真实检查。历史 3.5.20 记录保留原有事实，不可直接用作新版本通过依据。

### 4.4 编译器版本

`rust-toolchain.toml` 固定 `1.98.1-x86_64-pc-windows-msvc`，与 README、版本校验脚本一致。后续升级需要同时修改三处要求并重新构建、测试和验证安装。

### 4.5 软件与检查程序追溯

每次验收同时记录 `sourceFingerprint` 与 `verificationFingerprint`。后者覆盖 Git 管理及尚未提交、未被忽略的 `scripts/` 和 `tests/` 文件；临时产物与私人资料由忽略规则排除。检查结束时重新计算两种指纹，过程中发生变化会使结果失败；公开发布也重新核对两种指纹。

添加验证程序时必须将文件纳入仓库管理范围，避免错误的忽略规则使文件遗漏。改变发布规则同样会改变检查程序指纹，需要重新验收。

### 4.6 PDF 与依赖更新

PDF 入口明确设置 `isEvalSupported: false`，关闭 PDF.js 的动态代码执行选项。实际 PDF 的页数、文字提取和绘制指令读取拥有后台检查。该设置遵循 [PDF.js 官方安全通告](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq) 的配置要求；当前仍使用 3.11.174，版本升级需要验证页面渲染、选区、批注坐标及原生资源兼容性。

本次 `npm audit --omit=dev` 还报告了 diff 和 PDF.js 的可选 Node canvas 安装依赖中的 tar 告警。桌面应用通过 `web/libs/` 装载前端资源，Node 安装依赖不直接等于桌面运行时依赖；更新时应分别核对实际调用和构建环境。当前不能宣称依赖告警已经全部消除。

## 5. 后续修改容易再次引入的工程风险

| 范围 | 风险触发条件 | 必须保留的实现与验收要求 |
| --- | --- | --- |
| 文档异步操作 | 保存、渲染、滚动恢复或 AI 请求期间切换标签页 | 捕获文档身份与修订；回调提交前重新核对；覆盖快速切换、关闭、另存为 |
| 编辑提交 | blur、mousedown、mouseup、快捷键同时触发 | 一次用户操作只提交一次；DOM 重建后恢复真实选区；覆盖输入法、反向拖选和表格 |
| Markdown 往返 | 未编辑内容经过 HTML 转换；换行、列表、空段被重新组织 | 未修改块保存原始源码；编辑块保留换行及结构；比较保存前后真实文件字节 |
| 文件保存 | 外部修改、多窗口写入、异常退出、编码转换 | 保留磁盘版本检查、保存记录和恢复；不要绕开统一保存入口直接写文件 |
| Mermaid | 容器隐藏、字体尚未完成测量、全局 CSS 影响标签 | 检查实际渲染尺寸和标签范围；同时验证阅读、分栏、源码编辑与主题 |
| PDF | 旋转、缩放、裁剪框、双页显示、原生批注重新写入 | 坐标转换双向一致；修改实际 PDF 后重新提取；覆盖外部文件修改和撤销 |
| AI 配置 | 修改默认项、连接密钥或请求参数；旧配置迁移 | 保护用户自定义内容；请求使用一致配置快照；配置变化使旧验证结果失效 |
| 模型目录 | 厂商更新模型名、能力、上下文容量或接口行为 | 从官方资料核对并维护 `resources/ai-model-catalog.json`；区分预置配置与真实接口验收 |
| Token 预算 | 新模型换用不同 tokenizer；摘要及附件增加 | 计数资源和模型能力一致；预览预算与实际发送内容一致；明确失败原因 |
| 会话与记忆 | 切换文档、恢复会话、删除来源、并发编辑 | 明确文档/工作区/全局归属；来源有效性和记忆版本受检查；关闭功能后停止相关请求 |
| 知识索引 | 更新中取消、文件改名删除、模型维度变化 | 新代次完整成功后发布；保留旧索引；明确部分索引和失效来源 |
| 安装与图标 | 只替换程序、资源遗漏、文件关联注册变化 | 验证实际安装目录、资源清单与 Windows 文件关联；升级前备份用户资料 |
| 错误处理 | 编辑和保存路径使用空 catch，调用方误以为完成 | 逐处审查提交结果及错误传播；失败应明确阻止后续成功状态，保留可恢复内容 |
| 模块规模 | 在 `app.js` 增加另一组独立监听器或全局状态 | 先检查现有入口和状态所有权；逐项提取职责时保留真实行为检查 |

这些条目描述未来风险，不代表每项当前均已发生。特别是 PDF、索引和保存已有实际文件检查，后续修改仍需重新验证对应的数据边界。

## 6. 数据位置与迁移注意事项

| 位置 | 内容及注意事项 |
| --- | --- |
| `%LOCALAPPDATA%\StuartMD\` | 程序、安装资源和示例；程序文件与用户数据分别备份 |
| `%APPDATA%\StuartMD\settings.json` | 页面、会话及 AI 设置；迁移保留用户实际修改 |
| `%APPDATA%\StuartMD\ai\keys\` | DPAPI 加密密钥，依赖 Windows 用户环境；不要输出到日志或提交仓库 |
| `%APPDATA%\StuartMD\chat_archive.db` | 会话、记忆及来源；使用 SQLite 一致性备份 |
| `%APPDATA%\StuartMD\document_journal.db` | 持久化草稿，包含未保存文档 |
| `%APPDATA%\StuartMD\save_journal.db`、`save_history\` | 保存过程记录和恢复内容 |
| `%APPDATA%\StuartMD\pdf_annotations\` | PDF 批注资料，需与实际 PDF 文件版本共同处理 |
| `%APPDATA%\StuartMD\plugins\`、`wallpapers\` | 用户插件与壁纸；插件授权随源码变化重新检查 |
| 工作目录的 `.stuart\` | 知识索引与相关配置；删除前说明是否会失去可用索引 |
| `tests/native-artifacts/` | 本机验证日志、实际配置副本、安装备份；可能含私人资料，不得整体上传 |

数据库迁移需要包含旧版本真实副本、迁移中断、再次打开及备份恢复。复制正在使用的 SQLite 文件时应使用一致性备份接口，避免只复制主文件造成遗漏。

## 7. 已有验证范围与证据强度

下列数字取自 3.5.20 已保存的验收记录，本次文档编写没有重新运行这些产品检查。

| 验证 | 记录结果 | 能够说明的范围 |
| --- | --- | --- |
| Core | Passed | 42 项前端检查、6 项目录检查、86 项 Rust 主程序检查；另有 11 项文件与 14 项多进程检查，以及真实配置和 SQLite 检查 |
| 选择专项 | 12 项 DOM 检查通过 | jsdom Range/Selection、端点恢复及节点替换；没有证明原生拖选、焦点和整个应用提交过程 |
| Models | Passed，2026-10-22 | 独立 Python ONNX 参考及 3 项实际 Rust 检查；覆盖向量、索引代次与取消、PDFium/OCR |
| Providers | Passed，2026-10-22 | DeepSeek 真实接口的流式回答、预算、摘要、取消与停用 |
| Installer | Passed | 3.5.19 升级至 3.5.20，20 项资源检查；32 个文件、6 个数据库、260 条记录保持一致 |
| Browser / Native | SkippedByUser | 用户禁止 computer use；当前版本没有相应窗口交互运行证据 |

Qwen、Kimi、GLM 的预置和配置检查不等同于真实服务商调用成功。独立 Windows 环境的全新安装、原生窗口关闭及重启后的完整交互，也不能由上述结果推定已经验证。

常规 Rust 测试中有 10 项默认忽略的检查，具有单独执行入口。只运行 `cargo test` 不会自动取得真实模型与在线服务的证据。检查结果必须结合模式、命令和具体用例阅读。

## 8. 开发、构建和发布操作

从仓库根目录执行后台检查；需要 Node.js、PowerShell 7、Rust/MSVC、Tauri 构建条件及资源脚本使用的 7-Zip。Rust 版本要求见第 4.4 节。

```powershell
npm ci
pwsh -NoProfile -File scripts/prepare-resources.ps1
pwsh -NoProfile -File scripts/prepare-tokenizers.ps1
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Core
node scripts/verify-release.cjs
```

真实模型验证需要先按 `tests/model-reference-requirements.txt` 准备 `tests/native-artifacts/model-reference/Scripts/python.exe`。在线验证使用当前用户已配置的 DeepSeek 密钥和独立目录，执行前核对网络及实际请求范围。

```powershell
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Models
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Providers
```

构建安装包：

```powershell
Set-Location tauri/src-tauri
cargo tauri build --bundles nsis
```

产物位于 `tauri/src-tauri/target/release/bundle/nsis/`。验证安装会修改本机安装；必须检查运行中的程序、备份用户资料并核对安装资源。用户禁止界面操作时，使用 `scripts/verify-installer.ps1 -SkipStartup`。`verify-repair.ps1 -Mode Installer` 默认会进入启动检查，不能直接用于当前禁止启动窗口的情形。

发布前逐项检查：

1. 读取工作区状态，只提交本次明确修改的文件；核对源码提交与版本号。
2. 同步 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json、版本校验脚本、README 和示例中的适用版本。
3. 运行受影响的检查，记录真实执行状态；按照第 4.3 节执行统一发布检查。
4. 构建并验证实际安装包，检查升级后的用户资料和文件关联。
5. 对安装包计算 SHA-256，上传安装包和校验文件；核对远端大小、摘要及上传状态。
6. 核对 Git 标签指向实际发布提交，再公开 Release；不上传配置副本、密钥或用户文档。

NSIS 会改变可执行文件中的安装类型标识。校验本机安装程序时，应与安装包解压出的程序比较。原始编译输出与最终安装程序的哈希可能不同，不能只凭这个差异判断安装错误。

当前仓库没有 `.github/` 目录，不能假定 GitHub Actions 会自动补做这些检查。仓库中的脚本和保存的验收记录承担主要验证责任。

## 9. 历史资料与本机文件保护

历史接手从 3.5.10 开始，原目录为 `C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD`。初始复制与完整性记录位于本机 `docs/handover/`，包含大量构建及工作目录内容；其中的版本、问题和环境记录均需要按日期阅读。

当前本机存在尚未纳入 Git 的历史文件：`docs/PROJECT_HANDOVER.md`、`docs/PRODUCT_AUDIT.md`、`docs/COMPANION_REVIEW.md`、`docs/audit/`、`docs/handover/`，以及部分 3.5.11 Mermaid 图片和测量文件。本文件没有覆盖这些资料。新电脑仅克隆仓库时可能缺少这些文件。

可优先阅读的仓库资料：

- [当前产品说明](../README.md)：用户入口、快捷键、数据目录。
- [3.5.20 验收](validation/3.5.20/acceptance.md)：最近版本的具体检查及安装记录。
- `docs/validation/`：各版本实际验收，需同时核对状态文件和源码指纹。
- `docs/superpowers/specs/`、`docs/superpowers/plans/`：此前已经确认的功能设计和实施计划；功能现状以当前源码及验收为准。
- Git 提交历史：追踪一次修复涉及的前端、后端、资源和安装变更。

后续维护继续遵守用户已明确的要求：禁止使用 computer use 或启动窗口影响办公；可以记录并跳过依赖界面的检查；真实在线服务验收范围为 DeepSeek；仓库修改直接提交，不创建 PR；不要终止用户正在使用的软件，不覆盖用户自行修改的内容。

## 10. 接手后的工作顺序与完成条件

1. 确认当前版本、工作区修改、实际安装和用户资料备份，阅读第 4 节的选区与发布规则。
2. 继续修改编辑功能时保留统一选区入口及文档版本检查，检查真实内容保留、撤销及文件保存。
3. 核对发布规则、工具链版本和验证程序追溯信息，使发布命令与实际授权范围一致。
4. 每次修改依据第 5 节选择受影响的检查，记录不能执行的部分。获得界面操作授权后，补充原生跨段选择、输入法、标签切换、PDF 批注与重启恢复验证。
5. 持续维护模型目录与依赖资源；更新服务商、模型或 tokenizer 时，分别记录配置检查和真实调用证据。

3.5.21 的执行结果以 [验收记录](validation/3.5.21/acceptance.md) 为准。原生窗口交互、输入法及特殊内容编辑仍需在获得界面操作授权后验证。
