# StuartMD 修复实施计划

日期：2026-10-09。代码基线：`07e10aaf0df835040c53edf27b3f418abb9b20bc`，3.5.10。计划修复版本：3.5.11。

目标：文档编辑保持原文，保存检测冲突并提供恢复；Markdown/PDF 伴读完整处理真实请求，知识、会话、记忆和上下文预算在实际界面运行。

使用的技术：现有静态 HTML、CSS、JavaScript，Tauri 2、Rust、SQLite/FTS5/sqlite-vec、fastembed/ONNX Runtime、Markdown-it、Mermaid 和 PDF.js；补充严格编码、真实 PDF 页面解析、OCR、SSE 和测试所需的成熟依赖。

协议与数据行为：[修复设计](C:/Users/Administrator/Desktop/Stuart/docs/superpowers/specs/2026-10-09-stuartmd-repair-design.md)。问题及原始证据：[PRODUCT_AUDIT.md](C:/Users/Administrator/Desktop/Stuart/docs/PRODUCT_AUDIT.md)。以下任务和测试均为拟执行内容。

## T01. 建立文档会话和无损文本编辑

依赖：无。覆盖审查编号：01、02、06、17。

修改文件：

- `C:/Users/Administrator/Desktop/Stuart/web/js/app.js`
- `C:/Users/Administrator/Desktop/Stuart/web/js/core/doc-stats.js`
- `C:/Users/Administrator/Desktop/Stuart/web/js/core/write-coord.js`
- `C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`
- `C:/Users/Administrator/Desktop/Stuart/web/index.html`
- `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs`
- `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs`
- `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.toml`
- `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/capabilities/default.json`

新增文件：

- `C:/Users/Administrator/Desktop/Stuart/web/js/core/document-session.js`
- `C:/Users/Administrator/Desktop/Stuart/web/js/core/text-buffer.js`
- `C:/Users/Administrator/Desktop/Stuart/tests/repair-document-state.cjs`
- `C:/Users/Administrator/Desktop/Stuart/tests/repair-text-buffer.cjs`
- `C:/Users/Administrator/Desktop/Stuart/package.json` 与依赖管理生成的 `C:/Users/Administrator/Desktop/Stuart/package-lock.json`
- `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/app_runtime.rs`
- `C:/Users/Administrator/Desktop/Stuart/rust-toolchain.toml`

实施步骤：

1. 声明并首先初始化 `tauri-plugin-single-instance`，固定 Rust 1.98.1。全部窗口共享 `AppRuntime` 中的后端服务；新窗口及文件关联启动参数创建独立原生窗口，每个窗口的启动文档、访问授权、事件与文档记录分别管理。配置明确的主窗口及应用文档窗口 capabilities；后端根据实际调用窗口验证身份及路径授权。关闭最后一个窗口才终止后台服务。
2. 建立统一文档记录、原始文本缓冲、UTF-16 坐标、编辑版本和磁盘版本；明确新建、打开、另存为及 PDF 文档的身份。
3. 声明并锁定 `diff` 依赖，通过正常依赖构建提供前端可加载版本。使用已有 `markdown-it` token 定位段落，保存原文分隔范围。
4. 将源码输入、就地编辑、撤销、重做和自动保存快照改为同一编辑事务；删除重建全部正文的保存调用关系。
5. 文档切换时提交实际编辑内容，清除当前引用，设置目标文档待渲染状态。所有异步结果验证文档身份和版本。
6. 按照已确定的 `DocumentReadResult` 协议处理编码状态；对应后端读取生产接口由 T02 实现，未确认编码时阻止产生可自动保存的编辑正文。

验收：实际加载产品模块，检查 LF、CRLF、混合换行、无尾部换行、多个尾部空行、嵌套列表、任务列表、表格、代码围栏和 emoji。拆分后无编辑组合的字符串完全相等；编辑一个段落后其余原文完全相等；撤销恢复精确原文。T02、T04 的生产接口完成后执行原生联合验收：源码模式创建文档、打开文件和切换标签后，就地编辑仅作用于当前文档。文件关联和新窗口实际打开独立原生窗口并共享同一后端；窗口授权和事件正确隔离，任一窗口关闭不影响其余窗口。

输出约定：T02、T03、T04、T08 使用 `DocumentSession`、`TextEdit` 和不可变版本快照，禁止重新读取全局活动文档来确定已经开始的操作对象。

## T02. 实现严格编码和共同保存服务

依赖：T01 的数据协议。覆盖审查编号：02、03、17。

修改文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/win_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/security/diff_guard.rs`，以及 `C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/write-coord.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/app.js`。

新增后端文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/mod.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/identity.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/encoding.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/save.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/tests.rs`。文件身份、严格编解码和保存模块分别管理授权、字节转换、冲突与持久化操作。

新增测试文件：`C:/Users/Administrator/Desktop/Stuart/tests/native/file-save-worker.rs`、`C:/Users/Administrator/Desktop/Stuart/tests/fixtures/encoding/` 中的真实编码文件及说明。

实施步骤：

1. 直接声明 `encoding` 0.2.33、`sha2`、`uuid` 及所需 Windows API 依赖；使用成熟库验证编码和字符边界。
2. 实现 `DocumentReadResult`、`DiskRevision`、`SaveRequest`、`SaveResult` 和明确错误类型，注册实际 IPC 命令。
3. 实现路径锁、文件身份锁、磁盘原始字节比较、持久化基础及本地内容、同目录临时文件和 `ReplaceFileW` 备份。创建新目标时保留禁止覆盖的语义。
4. 在 `save_journal.db` 与 `save_history` 中持久化每个保存阶段及内容，验证替换前后版本。文件竞争返回冲突，显示实际差异，保留所有尚未解决的内容版本。
5. 全部文档写入入口调用共同服务，包括由真实 PDF/JSON 库生成数据的批注导出；保存成功只确认捕获时的编辑版本。自动保存冲突停止该文档再次写入，AI 修改确认绑定当前文件版本。
6. 保留最近 20 次成功保存的备份，以及全部待解决冲突。备份管理和草稿管理分别列出实际占用，资源不足时在写入之前报错。

验收：使用真实文件读取和保存 UTF-8、UTF-8 BOM、UTF-16LE/BE、GBK、GB18030；原始文件无修改保存字节相等。GBK 中新增无法表示的字符必须停止覆盖；错误编码必须显示确认入口。两个真实进程打开同一文件后分别保存，旧版本保存返回冲突。另一个真实进程持续修改或替换目标，检查外部内容、基础内容和本地内容都可以读取。重复真实进程终止覆盖保存各阶段，重启后能够识别日志阶段及恢复内容。权限拒绝和磁盘空间不足使用隔离测试系统的真实权限与容量限制，禁止改写函数使测试返回指定错误。

输出约定：T03 复用保存操作编号和日志阶段；T08 的 AI 修改应用遵守相同访问授权和版本校验。

## T03. 提供草稿和启动恢复

依赖：T01、T02。覆盖审查编号：04。

修改文件：`C:/Users/Administrator/Desktop/Stuart/web/js/app.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`、`C:/Users/Administrator/Desktop/Stuart/web/index.html`、`C:/Users/Administrator/Desktop/Stuart/web/css/app.css`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs`。

新增文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/journal.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/recovery.js`、`C:/Users/Administrator/Desktop/Stuart/tests/native-ui/recovery.cjs`，以及实际后端 journal 测试。

实施步骤：

1. 建立 `document_journal.db` 的元信息、基础字节、编辑记录、检查点和保存确认结构。使用真实 SQLite 持久化事务，并提供 schema version。
2. 编辑事务捕获原文和文档身份，提交持久化记录；批次等待不超过 250 ms，切换和正常关闭执行 flush。空正文和未保存文档均记录。
3. 注册 list/read/restore/discard/flush 接口，提供实际恢复列表及磁盘冲突视图。
4. 导入旧草稿，保留无法识别原路径的内容；导入指纹防止重复。另存为保持文档身份并更新原文件关联。
5. 仅按已确认保存版本清理日志；计时器和迟到返回不得影响其他标签或更新版本。

验收：三个文档交替输入、切换、清空正文；在真实持久化确认后终止进程，重启恢复全部已确认内容。未保存标签、外部删除的文件、外部修改的文件及另存为期间的新编辑均能恢复。保存期间继续输入，旧保存返回后新草稿仍存在。旧草稿导入两次的记录数量保持一致。

## T04. 修复阅读渲染、Mermaid 和快捷键

依赖：T01。覆盖审查编号：01、16、18。

修改文件：`C:/Users/Administrator/Desktop/Stuart/web/js/app.js`、`C:/Users/Administrator/Desktop/Stuart/web/css/app.css`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/html-sanitize.js`、`C:/Users/Administrator/Desktop/Stuart/web/index.html`、`C:/Users/Administrator/Desktop/Stuart/README.md`、`C:/Users/Administrator/Desktop/Stuart/samples/` 中所有现行帮助文档。新增 `C:/Users/Administrator/Desktop/Stuart/web/js/core/mermaid-renderer.js`、`C:/Users/Administrator/Desktop/Stuart/tests/native-ui/rendering.cjs`。

实施步骤：

1. 阅读渲染缓存使用设计规定的完整键，成功更新 DOM 后才记录版本；每个段落控件验证文档与版本。
2. 使用现有中文 Mermaid 复现文档，测量隐藏状态、computed style、字体准备时序、label、rect 和 viewBox，记录实际影响布局的规则。
3. 在具有明确尺寸、独立图表样式的容器中渲染，等待字体准备完成；修改影响测量的 CSS 和时序，再执行 SVG 自适应。
4. 验证 DOMPurify 的 SVG 属性配置、strict Mermaid 配置和文档任务序号。
5. 建立共同快捷键定义，绑定 Ctrl+Z 撤销、Ctrl+Shift+Z/Ctrl+Y 重做；同步所有提示和帮助文档。

验收：实际界面中的中文短标签、长标签、英文、嵌套子图、序列图、明暗主题、字体缩放和快速切换全部正常显示。每个 flowchart 标签矩形位于对应节点边框内；实际图表点击和段落编辑绑定当前文档。真实键盘操作覆盖源码编辑、就地编辑和输入法组合阶段，并核对撤销和重做后的精确原文。

Mermaid 节点尺寸的最终根因以实际测量确定，实施时必须修改产生异常尺寸的对应规则；禁止以固定放大整张 SVG 作为节点尺寸验收。

## T05. 修复会话、记忆和数据库迁移

依赖：T01 的共享后台服务；与 T03 共享迁移执行约定。覆盖审查编号：06、09、10、12、13。

修改文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/models.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/mod.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/evolution.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.toml`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js`。

新增文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/migrations.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/tests.rs`、`C:/Users/Administrator/Desktop/Stuart/tests/fixtures/migration/` 中的真实旧结构数据库与 Markdown 记忆资料。

实施步骤：

1. 使用 UUID v4 创建会话和消息，增加毫秒时间、排序序号、请求编号、完成状态和来源锚点。
2. 记忆增加作用范围、偏好键、有效版本和来源；upsert 更新全部可编辑字段，重复请求保持幂等。
3. 建立 FTS UPDATE 触发器并重建已有索引；旧会话主键继续有效，保持外键关系。
4. 使用 SQLite 在线备份和事务迁移；错误立即停止相关持久化操作，保留原数据库及一致性备份。
5. 使用成熟 Markdown parser 导入旧 profile/activity，保留原始内容及来源，避免未经确认内容成为有效偏好。
6. 返回实际存储错误，提供列出、搜索、编辑、固定、删除及查看来源接口；为 T09 提供按文档和工作区检索有效记忆的接口。

验收：同一自然秒及多进程并发创建 100 个会话，全部编号独立且能够读回。更新正文后新词命中、旧词失效，层级、类别和来源同步更新。重复同一请求只生成一份消息和记忆。迁移后旧会话和全文记录数量一致，外键与完整性检查通过。数据库损坏、锁竞争超时、权限失败和迁移期间真实进程终止都返回实际状态。旧资料重复导入保持幂等，最新确认偏好生效且可以定位来源。

将 `C:/Users/Administrator/Desktop/Stuart/tests/project-audit-native.rs` 的会话、FTS 和预算正确行为断言迁入实际 memory/context 模块的 `#[cfg(test)]` 测试，并注册到常规 Cargo 测试流程。

## T06. 固定实际嵌入模型并完成索引代际管理

依赖：T02 的文件版本协议。覆盖审查编号：10、14。

修改文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/embedding.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/config.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/storage.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/watcher.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/hybrid_search.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag_ipc.rs`。

新增文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/generation.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/model_registry.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/tests.rs`、`C:/Users/Administrator/Desktop/Stuart/resources/models/manifest.json`。

实施步骤：

1. 建立不可变模型资源清单，记录基础模型、转换发布者、具体资源版本、SHA-256、pooling、normalization、tokenizer 和输入长度。
2. 加载真正的 BGE-M3 与明确配置的多语言 MiniLM，直接声明现有实际版本的 `ort` 和 `tokenizers` 依赖。使用真实推理确认维度后建立存储结构。
3. 在独立数据库构建索引代际，验证模型和存储维度、外键、全文索引、向量数量及实际查询；持久化后切换当前代际指针。
4. 更新及删除文档时在一个事务中处理关联向量和全文记录。采用内容指纹和成熟文件监听库，处理索引期间再次变化的文件。
5. 状态和结果记录真实任务编号、扫描范围、排除数量、失败文件及阶段；模型与数据库错误终止任务，单个文件错误形成明确 Partial 结果。
6. 任务独立取消，过期任务禁止修改活动代际；跨窗口共享工作区索引状态和实际模型身份。按需要加载和释放模型，限制并发。

验收：下载并运行两个真实模型，确认模型资源指纹、输出维度、有限数值和归一化；BGE-M3 的参考向量使用同一权重的真实官方实现核对。使用至少 201 个真实 Markdown 文件及真实 PDF，目标文件全部进入索引范围；超过配置限制时显示具体范围。修改、删除和重命名后查询结果与实际文件一致，孤立向量数量为零。更换模型后完成独立代际构建及切换，查询固定正确模型。实际资源缺失、无权限文件、损坏 PDF、磁盘不足和取消操作显示真实结果，失败代际不能显示 Ready。

## T07. 实现真实 PDF 布局、OCR 及完整 PDF.js 资源

依赖：T01、T06。覆盖审查编号：08、15、20。

修改文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/indexer.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/config.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.toml`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/tauri.conf.json`、`C:/Users/Administrator/Desktop/Stuart/web/js/pdf-viewer.js`。

新增文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/pdf_extract.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/ocr.rs`、`C:/Users/Administrator/Desktop/Stuart/resources/native-manifest.json`、`C:/Users/Administrator/Desktop/Stuart/scripts/prepare-resources.ps1`、`C:/Users/Administrator/Desktop/Stuart/tests/fixtures/pdf/` 和页面文字/矩形验收资料。

安装资源：`C:/Users/Administrator/Desktop/Stuart/web/libs/pdfjs/cmaps/`、`C:/Users/Administrator/Desktop/Stuart/web/libs/pdfjs/standard_fonts/`、匹配的 PDF.js worker、固定 PDFium DLL、真实 Tesseract 可执行程序及其运行依赖、`chi_sim`、`chi_tra`、`eng` 语言资源和许可证文件。

实施步骤：

1. 声明 `pdfium-render` 0.9.4、匹配 `pdfium_7881` 的接口 feature 和成熟 `csv` 依赖；资源清单固定真实文件版本与指纹。
2. 实际取得文字片段、页面矩形及 rotation，根据真实几何关系形成段落和栏目，并保存多段高亮矩形。
3. 按页面及图片区域分类，使用 300 DPI 图像与真实 OCR，解析 TSV、置信度和坐标；处理混合页面重复内容。
4. PDF.js 坐标转换统一用于选区、知识跳转和伴读上下文；来源变更后重新解析并定位。
5. 从同版本 `pdfjs-dist` 3.11.174 提供完整 CMaps 和字体，资源准备只复制真实依赖资源并校验指纹。源代码和配置修改通过补丁完成。

验收：真实单栏、双栏、横向页面、旋转页面、不同 CropBox、简繁中文、纯扫描和混合页面 PDF。人工标注的页面区域与提取矩形计算交并比，文本片段主要区域交并比至少 0.8；OCR 结果包含预先标注的关键语句，并正确报告低置信度区域。知识命中打开正确页码并高亮实际语句。离线运行安装后的程序，确实依赖 CMap 的中文 PDF 显示、复制和搜索正常；资源请求无缺失。

密码文件、损坏文件、OCR 语言资源缺失和任务取消均验证明确状态。低置信度资料进入待检查范围，禁止改写验收文字来接受错误识别。

## T08. 统一 AI 服务、流式事件和开关执行

依赖：T01、T02、T05；PDF 上下文验收依赖 T07。覆盖审查编号：05、06、07、08。

修改文件：`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-context.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai_chat.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.toml`。

新增文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/mod.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/request_registry.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/provider_stream.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/tests.rs`、`C:/Users/Administrator/Desktop/Stuart/tests/native-ai.cjs`。

实施步骤：

1. 两个前端入口只通过共同服务提交请求；注册并等待真实监听，生成 UUID，请求绑定文档、会话、选区和设置版本。
2. 使用真实异步 HTTP 字节流、`eventsource-stream` 0.2.3 和 `serde_json`；按真实服务商协议处理普通正文、必要的推理状态和完成标记。协议异常在发生位置终止。
3. 后端累计正文并提供有序增量与最终快照；前端累计正文后渲染，验证请求与序号，释放监听和请求状态。
4. 完整回答入库后返回完成状态；取消及失败明确保存状态，禁止当作完整历史参与追问。
5. 后端协调最新启用状态和活动请求。关闭 AI 的确认结果必须对应全部已注册任务停止；发送之前再次验证启用状态和设置版本。
6. `SelectionRef` 从实际文档取得；空选区及切换文档清除引用，PDF 请求使用真实页面上下文。

验收：预设 DeepSeek、Qwen、Kimi、GLM 以及项目承诺支持的兼容服务，各自使用已配置凭据和公开样本文档发送真实请求。检查完整流式回答、至少三次追问、关闭 AI、取消、窗口关闭、文档切换和第二次请求。两个界面入口的最终文字、数据库完整回答与请求对应一致。取消后旧事件无法修改当前请求；AI 关闭确认后外部 AI 请求数量不再增加。

捕获真实 SSE 字节，并通过同一 parser 检查任意 UTF-8 边界重分段；每次得到同一正文。实际断网、无效凭据和服务商明确报错验证 Failed 状态，日志保留错误类型和请求编号，清除凭据及用户正文。没有实际服务商运行条件的测试不能标记通过。

## T09. 执行共同预算并连接知识、会话和记忆界面

依赖：T01、T05、T06、T07、T08。覆盖审查编号：08、09、10、11。

修改文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/pyramid.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/tokenizer.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/budget.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/compressor.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/mod.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai_chat.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag_ipc.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-context.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/app.js`、`C:/Users/Administrator/Desktop/Stuart/web/index.html`、`C:/Users/Administrator/Desktop/Stuart/web/css/app.css`。

新增文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/model_spec.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/service.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/tests.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/memory.js`、`C:/Users/Administrator/Desktop/Stuart/tests/native-knowledge.cjs`。

实施步骤：

1. 模型配置登记本地 tokenizer 或明确的服务商计数接口、计数方式、消息模板、上下文长度、输出预留和协议开销。Kimi 使用其官方计数接口，并在界面标示估算及实际 usage；全部承诺支持的模型配置进入实际 provider 验证。缺少可靠配置的自定义模型显示具体配置错误。
2. 后端 ContextService 校验工作区授权、选区版本、文件指纹、索引代际和记忆作用范围，组装 L1 至 L5。
3. 保留完整焦点与有效用户约束，对所有可调整部分执行统一分配；最终实际消息再次核对总预算，超限明确终止。
4. 实现具有原文来源的结构摘要及验证，保留全部原始历史、当前约束和最新修正；摘要请求遵守同一预算和开关。
5. 工作目录打开入口调用真实工作区初始化；知识列表使用 rag_query，支持查看原文、高亮和引用。搜索及引用携带真实索引状态。
6. 实际接入会话列表、恢复历史、搜索、删除与记忆查看、编辑、固定、删除、来源及学习模式。
7. 新有效偏好按作用范围检索并在下一次适用请求中使用；已有长档案和更新历史禁止按开头字符决定内容。

验收：原有 500 token 预算与大用户档案用例，在保留必须内容后产生符合预算的结果或明确超限错误。增加仅有档案、仅有大纲、巨大选区、多段检索、中文、emoji、零预算和输出预留异常；成功结果全部满足最终完整消息约束。与完整选区规则有关的预算检查使用真实 tokenizer：窗口足够时保留完整选区，窗口不足时断言 `ContextTooLarge`。真实模型摘要保留已标注的决定、否定和最新修正，原文及引用可以查看。

实际界面完成工作区索引、查询、打开 Markdown/PDF 来源、引用问答、追问、会话恢复、编辑记忆以及后续请求使用新偏好。重启程序后历史和记忆保持有效。跨工作区测试禁止混入无授权资料和其他工作区记忆；关闭记忆后请求内容与学习记录都符合开关状态。

## T10. 完成版本、安装程序和全部验收

依赖：T01 至 T09。覆盖审查编号：19、20，并验证全部编号。

修改文件：`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.toml`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.lock`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/tauri.conf.json`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/win_api.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/settings-schema.js`、`C:/Users/Administrator/Desktop/Stuart/README.md` 和现行版本帮助文档。

新增文件：`C:/Users/Administrator/Desktop/Stuart/scripts/verify-release.ps1`、`C:/Users/Administrator/Desktop/Stuart/scripts/verify-release.cjs`、`C:/Users/Administrator/Desktop/Stuart/scripts/verify-repair.ps1`、`C:/Users/Administrator/Desktop/Stuart/tests/wdio.native.conf.cjs`、`C:/Users/Administrator/Desktop/Stuart/tests/native-ui/`、`C:/Users/Administrator/Desktop/Stuart/docs/validation/3.5.11/acceptance.md`。

实施步骤：

1. 运行时直接使用 Cargo 版本；统一修改 3.5.11 的版本字段。Node 验证程序使用 `@iarna/toml` 和 JSON 标准库读取真实配置，PowerShell 脚本调用该程序并核对退出状态。数据库与设置结构版本独立迁移。
2. 资源准备、版本检查、测试执行和安装构建由真实工具完成；脚本禁止程序化替换任何源代码。
3. 建立 Node 模块测试、正常 Cargo 测试和真实 Tauri WebDriver 测试。Windows 使用 tauri-driver 及匹配运行环境版本的 Microsoft Edge Driver，运行实际 Tauri 可执行程序。测试方式见 [Tauri 原生 WebDriver 设置](https://v2.tauri.app/develop/tests/webdriver/manual-setup/)。
4. 原生系统对话框在隔离 Windows 测试桌面使用成熟 Windows UI Automation 工具选择真实文件，检查实际文件授权、打开和另存为结果。测试可执行程序不得替换产品 IPC 或提供伪造后端返回。
5. 在隔离 Windows 用户环境或测试虚拟机中安装真实 3.5.10，创建真实文档、草稿、会话和记忆，再升级真实 3.5.11 安装包。测试保留数据、幂等迁移、异常恢复和备份恢复。
6. 对全部 20 个编号逐项保存运行证据；测试缺少环境、模型、凭据或原生操作条件时记录未验收并阻止发布。

验收命令由 `C:/Users/Administrator/Desktop/Stuart/scripts/verify-repair.ps1` 执行并记录每条命令退出状态。新增 Node 测试使用 Node 内置 test runner；原生前端测试使用锁定版本的 WebdriverIO 和真实驱动。测试隔离目录只承载本次实际数据，禁止修改系统 `HOME`、`CODEX_HOME` 或用户现有应用目录。

## 检查命令与预期结果

实施后新增脚本接受固定的模式参数；脚本校验路径、真实运行环境与资源清单。任何必要检查失败立即停止该模式，并保存日志。

```powershell
Set-Location -LiteralPath "C:\Users\Administrator\Desktop\Stuart"
npm ci
node --test "C:\Users\Administrator\Desktop\Stuart\tests\project-audit-core.cjs" "C:\Users\Administrator\Desktop\Stuart\tests\repair-document-state.cjs" "C:\Users\Administrator\Desktop\Stuart\tests\repair-text-buffer.cjs"
cargo test --manifest-path "C:\Users\Administrator\Desktop\Stuart\tauri\src-tauri\Cargo.toml" --locked -- --test-threads=1
pwsh -File "C:\Users\Administrator\Desktop\Stuart\scripts\prepare-resources.ps1"
pwsh -File "C:\Users\Administrator\Desktop\Stuart\scripts\verify-repair.ps1" -Mode Native
pwsh -File "C:\Users\Administrator\Desktop\Stuart\scripts\verify-repair.ps1" -Mode Models
pwsh -File "C:\Users\Administrator\Desktop\Stuart\scripts\verify-repair.ps1" -Mode Providers
pwsh -File "C:\Users\Administrator\Desktop\Stuart\scripts\verify-release.ps1"
Set-Location -LiteralPath "C:\Users\Administrator\Desktop\Stuart\tauri"
cargo tauri build --bundles nsis
pwsh -File "C:\Users\Administrator\Desktop\Stuart\scripts\verify-repair.ps1" -Mode Installer
```

`npm ci` 从工作区根目录运行。依赖未锁定、测试驱动与运行环境不匹配、实际服务不可用或模型文件不存在时，相关脚本返回失败。`cargo tauri build --bundles nsis` 从 `C:/Users/Administrator/Desktop/Stuart/tauri` 执行，其参数已依据本机实际 CLI 帮助确认；构建所得安装文件必须报告版本 3.5.11。

各模式含义：Native 运行真实文件、多进程、数据库和原生界面；Models 运行实际嵌入、PDF/OCR 和检索；Providers 运行真实服务商请求及摘要；Installer 验证安装、升级、离线资源、数据保留和异常恢复。模式之间保留真实运行结果，禁止重复测试时抹去未验收状态。

## 发布验收条件

- 20 个审查编号全部关联实际运行的正确行为检查和证据；现有 41 项 Rust 测试及纳入常规流程的新增检查通过。
- 未编辑字符和文件字节得到保留；所有写入入口检测文件版本，冲突内容与恢复草稿可读取。
- 真实流式回答、完成历史、取消和 AI 开关在两个入口及多个窗口中一致。
- 知识命中来自实际模型与实际文件，PDF 坐标有效；索引完成状态反映真实结果，重新索引不破坏原有有效代际。
- 最终实际请求满足模型预算，最新有效偏好和用户修正被保留，来源可以查看。
- 安装后的离线阅读、CMap 中文 PDF、快捷键、Mermaid 和全部数据迁移完成验收。
- 版本、资源指纹、数据库结构、测试环境、源码提交及安装文件进入证据清单；没有必要项目处于未验收状态。
