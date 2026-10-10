# StuartMD 修复设计

日期：2026-10-09。代码基线：`main`，`07e10aaf0df835040c53edf27b3f418abb9b20bc`，3.5.10。计划修复版本：3.5.11。

审查依据：[PRODUCT_AUDIT.md](C:/Users/Administrator/Desktop/Stuart/docs/PRODUCT_AUDIT.md)。实施任务：[修复实施计划](C:/Users/Administrator/Desktop/Stuart/docs/superpowers/plans/2026-10-09-stuartmd-repair-plan.md)。本文规定拟实现的行为和验收条件；产品修复尚未实施。

## 1. 文档身份、原文和阅读内容

修改 `C:/Users/Administrator/Desktop/Stuart/web/js/app.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/doc-stats.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/write-coord.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/pdf-viewer.js`；新增 `C:/Users/Administrator/Desktop/Stuart/web/js/core/document-session.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/text-buffer.js`。

全部原生窗口共享 Tauri 后端中的设置、AI 请求管理、数据库服务和模型管理。使用 `tauri-plugin-single-instance`，首次启动创建后端，后续启动参数交给后端创建独立原生窗口；文件关联、新窗口和在新窗口打开文件保持各自可见操作。窗口启动文件、授权范围、草稿和文档会话以 `windowId` 区分，事件按目标窗口发送。窗口关闭释放该窗口任务，最后一个窗口关闭后终止后台服务。插件须首先注册；当前 Rust 1.98.1 满足官方要求。插件能力与参数转交见 [Tauri Single Instance 文档](https://v2.tauri.app/plugin/single-instance/)。

每个打开的文档使用独立的 `DocumentSession`：

同一磁盘文件在不同窗口打开时，分别建立独立 `DocumentSession` 和 `documentId`，通过 `fileIdentity` 识别共同保存目标。恢复草稿继续使用原文档身份；复制到另一个编辑窗口时分配新的文档身份。重新打开文件时，历史会话按规范路径与文件身份检索，并以明确的会话关联延续，消息来源保持各自的原始文档版本。

| 字段 | 规定 |
| --- | --- |
| `documentId` | 后端生成 UUID；新建、另存为、切换显示模式时保持文档身份 |
| `kind` | `markdown` 或 `pdf` |
| `path`、`fileIdentity` | 已取得访问授权的规范路径，以及 Windows 卷标识和文件标识；未保存文档允许为空 |
| `revision` | 每次完成编辑事务递增；与磁盘文件版本分别保存 |
| `source`、`textBuffer` | Markdown 原文及原始字节与文本位置的对应关系；PDF 使用二进制版本和页面上下文 |
| `encoding`、`bom` | 确认后的编码和 BOM；无法无损读取时记录阻止编辑的原因 |
| `diskRevision` | 最近确认的磁盘内容指纹及文件身份 |
| `persistedRevision`、`journalRevision` | 已保存到原文件的编辑版本、已持久化到草稿日志的编辑版本 |
| `renderRevision`、`renderEpoch` | 实际阅读内容对应的编辑版本，以及异步渲染任务序号 |
| `selectionRef`、`sessionId` | 当前文档选区和伴读会话；切换文档后根据文档身份恢复 |

源码编辑和就地编辑都生成 `TextEdit { documentId, expectedRevision, from, to, insertedText }`。`from` 和 `to` 使用明确的 UTF-16 code unit 坐标，禁止切断 surrogate pair。Rust 接口转换到字符或原始字节位置时验证边界，禁止混用 UTF-8 字节偏移和前端字符串下标。

`textBuffer` 保留原始字符串和每个换行位置。`textarea.value` 的 LF 视图通过位置映射产生，编辑差异使用成熟的 `diff` 库计算。未编辑的片段直接保留原始内容和原始字节；新增换行使用文档明确记录的默认分隔符。用户主动转换整份文档的编码或换行时，执行独立的编辑事务。

段落范围从现有 `markdown-it` 的 token 和 `map` 获得；复杂容器、嵌套列表、表格、围栏代码和空行保留对应原文范围。段落编辑只替换该范围。删除以重新组合全部段落来保存正文的调用关系，禁止自行编写 Markdown parser。

文档切换依次完成当前编辑事务、提交草稿、激活目标 `documentId`、失效旧阅读缓存、渲染目标文档。渲染缓存键至少包含 `documentId + revision + mode + theme + fontRevision`。只有 DOM、段落范围和异步图表属于同一文档版本且实际完成渲染，才能写入 `renderRevision`。源码模式跳过阅读渲染时，阅读区域进入待渲染状态。

每个段落控件和异步回调携带 `documentId`、`expectedRevision`、`renderEpoch`。目标已经切换或版本已经变化时，禁止将该回调应用到当前文档。进入阅读模式必须检查实际渲染版本。编辑权限仅授予已验证身份的当前段落控件。

## 2. 无损编码与文件保存

修改 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/win_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/security/diff_guard.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`、保存入口和自动保存入口；新增 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/` 的文件身份、编码和保存模块。

### 2.1 编码协议

读取结果为 `DocumentReadResult { documentId, source, encoding, bom, diskRevision, accessState }`。支持 UTF-8、UTF-8 BOM、UTF-16LE、UTF-16BE、GBK、GB18030。

存在 BOM 时按照 BOM 严格解码；不存在 BOM 时先严格验证 UTF-8。其他字节序列显示编码选择及预览，在用户确认可以无损解码的编码后才建立可编辑正文。原始字节持续保留。解码失败、不能编码的字符和不支持的编码都返回明确错误，阻止手动保存和自动保存。

使用 `encoding` 的 `DecoderTrap::Strict` 和 `EncoderTrap::Strict`，直接声明依赖。新文档使用 UTF-8；已有文档保持确认的编码和 BOM。新增字符无法表示时，界面定位相关字符，并提供明确的另存为 UTF-8 操作。未经编辑的读取和保存保持原始字节一致。严格解码及 UTF-16、GBK、GB18030 支持见 [encoding 文档](https://docs.rs/encoding/latest/encoding/)。

### 2.2 保存接口和冲突处理

全部文档写入路径调用共同的 `FileWriteService`，包括手动保存、自动保存、另存为、AI 修改确认和 PDF 批注导出。接口规定为：

```text
save_document(SaveRequest) -> SaveResult
SaveRequest: operationId, documentId, editorRevision, targetPath,
             expectedDiskRevision, payload
SavePayload: TextEdits { encoding, bom, sourceEdits }
             或 ValidatedBytes { bytes, producer, validationHash }
SaveResult: operationId, documentId, savedEditorRevision,
            diskRevision, backupId, result
DiskRevision: exists, volumeId, fileId, rawByteSha256, size, modifiedAt
```

`result` 使用 `Saved`、`Conflict` 或有错误类型的失败结果。错误结果禁止清除 dirty 状态。只有保存结果对应当前文档且 `savedEditorRevision` 等于当前编辑版本时，才显示已保存；保存期间产生的后续编辑继续保持 dirty。

`ValidatedBytes` 由实际 PDF 或 JSON 库生成并经后端验证，用于批注导出及相应文档数据。前端禁止通过这个入口提交任意不受授权的目标；批注记录仍保存实际 PDF 来源版本。应用设置和内部元信息继续使用各自的事务存储接口。

保存过程如下：

1. 验证目标路径授权、文档身份、编辑版本、编码和字节边界；捕获不可变保存快照。
2. 使用规范路径锁和 Windows 文件身份锁协调全部 StuartMD 窗口及进程。路径锁处理不存在的目标和重命名；身份锁处理大小写别名和 hard link。按固定顺序取得锁，避免相互等待。
3. 读取当前磁盘原始字节并核对 `expectedDiskRevision`。文件已经变化、删除或被替换时，返回 `Conflict`，保留本地修改。
4. 在应用数据目录的 `save_journal.db` 持久化写入日志，记录基础版本、本地版本、操作编号、目标路径和替换阶段；在 `save_history` 中持久化基础内容与本地内容。备份或日志写入失败立即终止保存。
5. 在目标文件所在目录创建独占临时文件，写入严格编码后的字节并执行持久化操作。已有目标使用 `ReplaceFileW` 和唯一备份路径完成替换；新目标使用禁止覆盖已存在文件的创建和提交操作。替换失败立即返回具体错误。
6. 检查实际被替换的原文件备份是否等于基础版本，并检查提交后的目标是否仍属于本次保存。外部程序在步骤 3 与步骤 5 之间写入时，保留实际被替换的内容，记录冲突并显示基础内容、本地内容和外部内容。外部程序在提交后再次修改时，返回冲突状态并重新读取实际磁盘版本。
7. 写入持久化完成记录后返回 `Saved`，发送包含文件身份和版本的窗口通知，释放锁。其他 dirty 窗口显示外部修改提示；干净窗口重新读取并验证版本。

任意外部编辑器无法共同遵守应用锁，普通文件系统也无法把内容比较与原子替换组合为通用跨程序事务。本设计通过替换备份和完成后的核对检测这段竞争，保存每个实际内容版本，禁止静默确认覆盖成功。冲突状态下停止该文档自动保存，提供查看差异、合并及保存副本；任何再次覆盖均绑定用户确认时看到的磁盘版本。

`diff_guard` 使用相同保存服务。AI 修改确认凭据绑定 `documentId`、编辑版本、磁盘指纹、修改内容指纹和目标路径；每次应用重新校验。成功保存备份默认保留最近 20 个版本；未解决冲突和未恢复草稿持续保留。备份清理在成功完成记录之后执行，清理失败显示维护错误。

## 3. 草稿、会话和异常恢复

新增 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/journal.rs`，修改 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/app.js` 和 `C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`。

使用独立的 `document_journal.db` 保存文档元信息、基础字节、编辑操作、完整检查点、编码、路径、编辑版本和保存确认版本。采用真实 SQLite 事务、WAL 和持久化设置。多个进程操作同一日志时使用 SQLite 的事务锁和保存操作编号。

每次编辑事务形成不可变日志记录，立即提交后端。连续输入可以合并相邻操作，批次等待上限为 250 ms；文档切换、保存和正常关闭必须等待日志持久化确认。界面分别显示待保存、草稿已保存和原文件已保存。异常恢复能够恢复最近确认持久化的版本；尚未收到持久化确认的输入有明确状态。

草稿键使用 `documentId`，禁止以当前活动标签或延迟执行时的全局状态决定记录对象。空正文、未保存文档和另存为的文档都保存日志。迟到的旧版本草稿不能替换新版本草稿。保存成功后，只清理不晚于已确认保存版本的日志，保留保存期间形成的新编辑。

提供 `journal_list`、`journal_read`、`journal_restore`、`journal_discard`、`journal_flush` 接口。启动恢复界面列出未恢复文档、标题、路径、更新时间、草稿版本和磁盘冲突状态。恢复时保留原文件；未保存文档恢复到独立标签。磁盘已修改的文档进入相同的冲突查看流程。

旧 `drafts/*.md` 按原来的 SHA-1 规则与已知会话路径和最近文件匹配。缺少路径映射的草稿保留为独立恢复文档，显示原草稿文件名和修改时间。成功导入后记录文件指纹；重复启动不重复导入。所有草稿确认恢复或明确丢弃之前，原草稿持续保留。

## 4. AI 请求、回答和选区

修改 `C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-context.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai_chat.rs`。

两个界面入口都由 `StuartAIService` 提交请求、管理当前文档会话和消费统一事件。`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js` 负责配置及服务商设置，禁止另行维护一套聊天历史和流式请求。

选区协议为：

```text
SelectionRef: documentId, kind, path, contentHash, documentRevision,
              quote, textRange, headingPath, pageNumber, pageRects
AIRequest: requestId, sessionId, documentId, selectionRef,
           providerModelSpecId, contextRevision, settingsRevision
AIEvent: requestId, sessionId, documentId, seq, type, text,
         terminalStatus, finalTextHash, error
```

`kind`、页码和真实页内坐标从文档会话取得，禁止由按钮调用者猜测。每次引用都是不可变快照，空选区清除旧引用。切换文档切换对应会话，清除当前引用，取消该视图正在显示的旧文档请求。历史回答保留来源及原文版本，点击引用时检查当前文件指纹。

请求状态使用 `Idle`、`Registering`、`Preparing`、`Streaming`、`Completed`、`Cancelled`、`Failed`。注册全部 Tauri 事件监听并等待成功后，才调用后端开始接口。请求编号使用 UUID。后端累积增量文字并生成递增 `seq`；前端按请求累计文字，再渲染累计正文。完成事件携带完整正文、最终序号和指纹，作为协议明确规定的最终快照，禁止追加第二份回答。

重复事件按请求和序号识别；已经结束的请求、其他文档请求和未知请求禁止修改当前界面。序号缺口通过真实请求状态查询确认，完整快照和序号不能核实时进入 `Failed`。取消必须结束真实 HTTP 任务并确认终止状态；关闭窗口也要释放监听和取消任务。

使用 `reqwest` 的真实字节流和 `eventsource-stream` 处理 SSE，再由 `serde_json` 解析服务商数据，覆盖 UTF-8 跨数据段、SSE 注释和多行 data。服务商 JSON 无效、连接异常、缺少规定的完成标记等情况立即终止请求并报告错误。库接口见 [eventsource-stream 文档](https://docs.rs/eventsource-stream/latest/eventsource_stream/)。

完整回答持久化为 assistant 消息后，后端才返回 `Completed`。失败或取消的部分回答记录 `Failed` 或 `Cancelled` 状态并显示状态，后续上下文只纳入明确完成的消息。每个请求以 `requestId` 保证消息写入幂等；追问包含该会话已经完成的用户消息和 assistant 消息。

AI 开关由后端设置状态统一管理。入口校验、上下文摘要请求以及开始真实 HTTP 请求之前，都检查同一份最新设置。关闭 AI 后取消全部窗口正在准备或发送的 AI 请求；已有请求禁止继续学习记忆。没有启用 AI 的请求返回 `AIDisabled`。本地阅读与本地知识检索保持可用；模型文件下载具有明确的用户触发入口。

## 5. 会话数据库和记忆

修改 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/models.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/mod.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/evolution.rs` 及相关前端记忆入口。

会话和消息编号使用 UUID v4，时间字段保存毫秒时间并提供确定的排序序号。已有会话编号继续有效；按已知旧结构将秒级时间转换为毫秒，保留全部外键关系。消息记录增加请求编号、文档身份、完成状态、来源指纹和 Markdown/PDF 锚点。

记忆记录保存 `scope`、`workspaceId`、`documentId`、`category`、`preferenceKey`、`version`、`content`、`sourceMessageId`、`sourceAnchor`、`confidence`、`pinned`、`supersededBy`。文档记忆、工作区记忆和全局偏好分别检索；同一偏好使用最新已确认的有效版本。相关性、明确确认、固定状态和最近使用时间决定参与上下文的内容。

记忆 upsert 在同一事务内更新正文、层级、类别及其余可编辑属性。FTS5 建立 INSERT、UPDATE、DELETE 触发器，更新已存在的全文索引；迁移后执行 rebuild 并校验索引与正文。相同请求重复执行不重复生成记忆，也不重复增加使用次数。

前端提供列出、搜索、查看来源、编辑、固定和删除记忆的操作。关闭记忆时停止读取记忆及学习记忆；要求确认的学习模式只有在对应条目确认后才生效。最新明确偏好持续进入适用上下文，禁止截取档案开头来决定记忆内容。

使用成熟 Markdown 库读取旧用户档案和活动 Markdown 文件。原始内容和文件指纹进入迁移记录；能够从已有设置明确确认的偏好按对应字段导入，其余内容保留为有来源的待确认记录。数据库损坏、权限错误或初始化失败时返回明确错误，保留原始文件并停止依赖持久化的请求。

## 6. 上下文预算和语义保留

修改 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/pyramid.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/tokenizer.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/budget.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/compressor.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/mod.rs`，由后端生成两个 AI 入口共同使用的上下文。

模型配置记录 `modelId`、`contextWindow`、`maxOutputTokens`、`countMethod`、`tokenizerArtifact`、`tokenizerHash`、`chatTemplate`、服务商计数地址和协议额外开销。公开分词规则的模型使用对应的成熟实现，复用已经解析的 `tokenizers` 0.21.4。提供远程计数的服务商按该模型明确配置的接口执行计数，计数请求遵守相同 AI 开关、授权和取消协议；失败立即终止该请求。加载和分词职责见 [tokenizers 文档](https://docs.rs/tokenizers/latest/tokenizers/)。

Kimi 配置使用其官方计数接口和 `data.total_tokens`，并明确记录其官方标示的估算性质及验证时采用的额外预留，见 [Kimi 计算 Token 文档](https://platform.kimi.com/docs/api/estimate)。界面区分本地分词计数、服务商计数和实际响应 usage，禁止声称估算结果具有所有模型通用的精确性。最终消息预算必须按配置的计数方式执行，服务商实际返回超限或计数不一致时立即报告具体错误，保留对话原文。

新增服务商模型须验证计数方式、消息模板和输出参数；没有可验证配置时返回 `TokenCountingUnavailable`，在服务商设置中显示缺少的配置。禁止使用未经核验的字符比例静默替代所需配置。

远程计数请求只发送当前已授权范围的候选上下文，发往用户配置的对应服务商；发送记录显示计数请求与正式回答请求各自涉及的资料。计数成功后形成不可变预算结果，绑定设置版本、模型配置和完整消息指纹；后续任何消息变化都重新校验。

最终约束为：

```text
countedPromptTokens + requestedOutputTokens + protocolReserve <= contextWindow
```

预算覆盖系统提示、当前问题、选区、邻近正文、大纲、检索结果、会话和记忆。校验最终实际提交的消息结构及消息模板；负值、零预算、输出预留大于窗口、缺少模型配置等情况在发送之前返回错误。

保留当前问题、完整选区、明确用户约束和最近完整对话。其余内容根据相关性和来源优先级分配预算；删除低相关知识片段、无关记忆和重复大纲，允许相关层级为空。每次分配都重新计算完整请求。最低保留条数和最低选区字符数不得突破总预算。

历史摘要保存 `decisions`、`constraints`、`corrections`、`openQuestions`、`sourceMessageIds`、`sourceQuotes` 和 `anchors`。使用已启用的真实模型生成受结构约束的摘要，验证字段、来源引用和原文片段，再保存摘要及来源版本。当前有效约束和最近修正作为原文加入请求，避免仅靠模型摘要决定有效指令。摘要构造自身执行相同预算和开关检查；失败明确终止，禁止将任意字符截取作为语义摘要。

原始对话始终保留。界面提供本次上下文使用的选区、引用、记忆和摘要来源，显示未纳入的相关资料。仅当前问题与必须保留内容就超过预算时，返回 `ContextTooLarge`，列出超限来源，用户可以主动缩小选区或选择匹配的模型配置。服务商返回的实际 token usage 用于核查对应模型配置；配置不一致时阻止继续使用失效配置。

## 7. 知识库模型、索引和状态

修改 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/embedding.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/config.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/storage.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/watcher.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/hybrid_search.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag_ipc.rs`；新增模型资源清单和索引代际管理模块。

`EmbeddingModelSpec` 保存真实基础模型、ONNX 发布者、不可变资源版本、模型文件 SHA-256、tokenizer SHA-256、pooling、normalization、最大输入长度、量化类型和实测维度。配置为 BGE-M3 时加载真实 BGE-M3；使用实际 ONNX 转换模型并记录基础模型与转换模型两个标识。BGE-M3 的 ONNX 模型说明规定 CLS pooling、归一化和 1024 维输出，见 [Xenova 模型说明](https://huggingface.co/Xenova/bge-m3)。

保留明确配置的 BGE-M3 和多语言 MiniLM 模型支持，禁止初始化失败后自动更换模型。BGE-M3 使用真实 ONNX 模型和成熟 `ort` 接口，MiniLM 使用现有 `fastembed` 接口；两者都进行真实中文、英文推理，确认维度、有限数值和归一化结果后，才创建对应数据库。模型资源、运行时和 tokenizer 均固定版本并校验文件指纹。

每个知识库使用 `workspaceId` 和独立的 `indexGeneration`。索引元数据绑定模型全部身份字段、数据库结构版本和解析器版本。索引模型、维度、tokenizer 或解析器变化时创建新的索引代际；工作目录、文件筛选规则和排除原因进入扫描记录。

新代际在独立数据库中构建。所有文档、片段、向量和全文记录写入后，核对数量、外键、向量维度、文件指纹及查询结果，通过 SQLite 完整性检查，然后持久化并切换当前代际指针。切换由工作区锁协调全部进程；已经进行的查询固定使用开始时的代际。失败的新代际保留诊断结果，原有有效代际继续保留其明确模型身份。

文档更新和删除在单个事务中处理关联片段、vec0 向量及全文索引，禁止遗留孤立向量。扫描使用实际内容指纹识别变化；监听使用成熟文件监听库。扫描期间再次修改的文件重新读取，过期任务无法提交到新的索引代际。修改后的正文与已保存磁盘版本分别标记，禁止把编辑器未保存内容伪装为磁盘知识。

索引状态使用 `Uninitialized`、`Downloading`、`Loading`、`Indexing`、`Ready`、`Partial`、`Cancelled`、`Failed`。结果记录 `jobId`、扫描数量、成功数量、排除数量、失败文件、失败阶段、当前代际和耗时。单个文件错误使该文件任务立即失败并进入结果；数据库、模型和资源错误终止本次索引。只有所有纳入范围的文件成功并完成一致性验证后才显示 `Ready`。

扫描数量和体积限制在扫描前及结果中明确显示，超出范围需要用户调整配置或范围，禁止静默遗漏文件。`Partial` 索引明确列出缺失资料，用户确认使用该范围后，查询结果和 AI 上下文继续携带这一状态。取消任务使用各自的取消凭据，确认后台任务结束后才开始同一工作区的新任务。

模型按需要加载并由工作区任务共享实例；限制推理并发，空闲时释放模型。基于真实硬件记录首次加载时间、持续内存、索引吞吐和检索耗时，禁止为大型模型填写未经测量的内存或速度承诺。

## 8. PDF 页面、OCR 和引用位置

修改 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/indexer.rs`、`C:/Users/Administrator/Desktop/Stuart/web/js/pdf-viewer.js` 及 PDF 上下文接口；新增 `C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/pdf_extract.rs`、`C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/ocr.rs`。

使用 `pdfium-render` 0.9.4 和匹配 `pdfium_7881` 接口的固定 PDFium DLL，从实际文本字符或文本片段取得内容与位置。原生依赖随安装程序提供并校验指纹。显式加载安装资源路径，缺少 DLL 时终止对应任务。PDFium 调用使用库规定的互斥保护及后台任务，读取完成后释放文档和页面。依赖与线程约束见 [pdfium-render 文档](https://docs.rs/pdfium-render/latest/pdfium_render/)。

每个 PDF 片段保存页码、原始 page box、rotation、实际文字矩形数组、内容指纹、提取方式和置信度。根据真实水平间距、行距和页面区域确定段落、栏目及阅读顺序；页眉页脚根据跨页重复内容和真实区域判断。跳转和高亮使用 PDF.js viewport 的坐标转换，覆盖 CropBox、页面旋转和多段矩形。

结合实际文本对象和图片区域判断纯文本页面、扫描页面和混合页面。缺少有效文字的页面或图片区域使用真实 Tesseract 5 处理；按照实际渲染分辨率转换识别矩形到 PDF 坐标。使用 300 DPI 页面图像、明确的分段模式、`chi_sim + chi_tra + eng` 语言资源和 TSV 输出；TSV 使用 `csv` 库解析。混合页面按矩形和文本匹配处理重复片段，并保留各自的来源。多语言和 TSV 坐标接口见 [Tesseract 文档](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)。

OCR 页面记录原始输出、语言、识别参数、词语置信度和页面错误。页面平均置信度低于 70 时标记需要检查，展示原图与识别内容，并按部分索引状态报告。密码保护、文字编码缺失、OCR 失败、资源缺失和取消均使用明确状态；禁止生成固定坐标或空正文并确认成功。

PDF 伴读通过 `SelectionRef.kind` 选择 PDF 上下文：当前选区、真实页码、页内正文、相邻页面和文件来源。同页上下文、OCR 文字和知识命中使用同一来源锚点结构。打开命中资料时先验证文件指纹；文件变化后刷新索引并重新定位，禁止展示旧坐标代表当前命中。

## 9. 前端接入知识、会话和记忆

修改 `C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-context.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js`、`C:/Users/Administrator/Desktop/Stuart/web/js/app.js`。

打开工作目录时注册已授权路径并调用 `rag_set_workspace`，展示当前模型及索引状态。知识界面调用真实 `rag_query`，提供 Markdown 和 PDF 命中正文、标题或页码、来源位置及索引状态。关键词检索可以作为明确标示的独立功能保留；语义检索入口始终反映实际语义索引状态。

知识命中可以打开原文件并高亮对应范围，也可以以明确引用加入伴读上下文。后端 ContextService 验证 workspace、文档、文件指纹、索引代际和选区版本，组装 L1 至 L5 上下文，再交给统一预算模块。

会话界面调用 SQLite 会话列表、消息读取、搜索和删除接口；文档切换恢复对应会话。记忆界面调用结构化记忆接口。数据持久化错误、准备模型、索引取消、部分资料缺失和没有检索结果分别显示实际状态，禁止把接口已经注册作为功能完成条件。

AI 自动读取的跨文档资料仅来自当前授权工作区；记忆按照启用状态和作用范围加入。模型下载和远程回答各自显示实际来源。测试和日志仅记录公开样本、操作编号及摘要统计，禁止输出 API 密钥和用户正文。

## 10. Mermaid、快捷键、PDF 资源和版本

修改 `C:/Users/Administrator/Desktop/Stuart/web/js/app.js`、`C:/Users/Administrator/Desktop/Stuart/web/css/app.css`、`C:/Users/Administrator/Desktop/Stuart/web/js/core/html-sanitize.js`、`C:/Users/Administrator/Desktop/Stuart/README.md`、`C:/Users/Administrator/Desktop/Stuart/samples/` 中的帮助文档；新增 `C:/Users/Administrator/Desktop/Stuart/web/js/core/mermaid-renderer.js`。

Mermaid 在具有明确尺寸和图表 CSS 的独立渲染容器中测量；等待 `document.fonts.ready`，容器不得使用 `display:none`。在当前实际运行环境分别测量容器可见性、节点字体、标签宽度、rect 和 viewBox，定位影响测量的 CSS 或渲染时序后修改相应规则。编辑器全局 `.label`、`.node`、`foreignObject` 等规则限制到各自组件范围。

保留当前 Mermaid 版本，完成节点测量后再做整个图表自适应。渲染任务绑定文档和编辑版本。使用 DOMPurify 明确允许所需 SVG 元素与属性，保持 strict 配置并禁止活动链接和脚本。中文长标签、不同图表类型、主题、字体缩放和快速文档切换均进入验收；标签边界必须落在对应节点边框内。

快捷键采用 `Ctrl+Z` 撤销，`Ctrl+Shift+Z` 和 `Ctrl+Y` 重做。编辑器、阅读模式段落控件、界面提示、README 和欢迎文档使用共同快捷键定义。文字输入组合阶段和具有独立撤销行为的系统输入控件按其明确编辑边界处理，避免重复执行同一操作。

PDF.js 保持 3.11.174。由同版本 `pdfjs-dist` 提供 worker、完整 `cmaps` 和 `standard_fonts`，随前端一起打包；`C:/Users/Administrator/Desktop/Stuart/web/js/pdf-viewer.js` 使用安装资源的真实地址。构建校验版本、文件数量和 SHA-256 清单，缺少任何声明资源立即失败。离线验收使用确实依赖 CMap 的中文 PDF，并核对中文显示、复制和检索文字。

运行时版本来自 `env!("CARGO_PKG_VERSION")`。3.5.11 的 Cargo、Tauri 配置、安装程序属性、界面和帮助文档在构建时验证一致；数据库和设置使用独立的整数结构版本。删除独立运行时版本常量，设置迁移写入实际应用版本。版本检查程序只验证文件，版本字段由人工补丁修改。

## 11. 数据迁移和发布

迁移在同一应用数据目录的跨进程锁下执行。升级启动先检查结构版本，使用 SQLite 在线备份接口创建包含 WAL 已提交内容的一致性备份，再执行事务迁移和完整性检查。任一阶段失败停止对应持久化服务，保留原始数据及备份，显示确切原因。

迁移包含会话字段、消息来源、记忆属性、FTS UPDATE 触发器及索引重建、旧 Markdown 记忆导入和旧草稿导入。保留已有主键和外键，建立导入指纹及迁移记录，重复启动保持幂等。RAG 数据按真实模型身份重建到新代际；已有原始文件和旧数据库持续保留。

升级与恢复备份都在实际服务停止并释放数据库连接后执行。旧程序打开较新结构版本时明确拒绝写入；降级需要选择升级前一致性备份，并单独导出升级后新增会话和草稿。禁止直接把包含 WAL 的数据库当作普通单个文件复制。恢复操作验证备份指纹、结构版本和完整性。

全部任务完成并通过本机原生程序、真实模型、真实数据库与安装程序验收后发布 3.5.11。安装包离线打开 Markdown 和 PDF，索引与模型仅在需要时加载。断网影响、模型未准备、资料未索引和 AI 未启用均显示明确状态。

## 12. 审查问题对应关系

| 审查编号 | 目标行为 | 设计章节 | 实施任务 |
| --- | --- | --- | --- |
| 01 | 文档切换后的阅读与编辑对象一致 | 1、10 | T01、T04 |
| 02 | 编码无损读取与保存 | 2 | T01、T02 |
| 03 | 检测普通保存、外部编辑和多个窗口冲突，保留内容 | 2 | T02 |
| 04 | 恢复空文档、未保存文档及有磁盘冲突的草稿 | 3、11 | T03 |
| 05 | 流式增量完整累计，监听完成后才开始请求 | 4 | T08 |
| 06 | 保存完整 assistant 历史，引用与文档对应 | 1、4、5 | T01、T05、T08 |
| 07 | AI 开关由后端执行并取消活动请求 | 4 | T08 |
| 08 | PDF 伴读使用真实页面上下文 | 4、8 | T07、T08、T09 |
| 09 | 最新有效记忆按作用范围参与上下文 | 5、6、9 | T05、T09 |
| 10 | 真实接入 RAG、上下文、会话与记忆界面 | 6、7、9 | T05、T06、T09 |
| 11 | 最终请求满足预算，历史摘要保留来源与修正 | 6 | T09 |
| 12 | 同一秒创建会话具有独立编号 | 5 | T05 |
| 13 | 记忆属性与全文索引随正文更新 | 5、11 | T05 |
| 14 | 实际模型、维度、索引代际和结果状态一致 | 7 | T06 |
| 15 | PDF 坐标与 OCR 来自真实页面 | 8 | T07 |
| 16 | 中文 Mermaid 标签在节点边框内正常显示 | 10 | T04 |
| 17 | 未编辑原文和混合换行完整保留 | 1、2 | T01、T02 |
| 18 | 快捷键、提示及文档使用同一规定 | 10 | T04 |
| 19 | 运行时、设置与安装程序使用统一版本 | 10、11 | T10 |
| 20 | 安装包包含同版本完整 CMaps 和字体资源 | 10 | T07、T10 |

## 13. 验收证据

每个审查编号具有直接验证目标行为的测试、使用的源码提交、实际运行环境和结果文件。使用真实文件、真实 SQLite、真实 PDF、真实嵌入模型以及配置服务商的真实响应。SSE parser 的边界检查可以重分段已取得的真实响应字节，同时保留实际在线取消和错误流程测试。缺少原生 IPC、真实模型或安装包运行结果的项目明确记录未验收。

证据保存在 `C:/Users/Administrator/Desktop/Stuart/docs/validation/3.5.11/`：版本清单、安装资源清单、测试日志、逐项验收表、文件字节与指纹、数据库一致性结果、实际请求事件顺序、PDF 坐标检查和界面截图。真实 AI 请求只使用公开测试资料；密钥禁止进入任何结果文件。已有失败检查的断言继续验证正确行为，禁止改成接受错误结果。
