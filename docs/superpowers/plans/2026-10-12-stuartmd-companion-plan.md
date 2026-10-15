# StuartMD 伴读实施计划

日期：2026-10-12。目标版本：3.5.12。完整交互、数据和接口规则见[伴读功能设计](C:/Users/Administrator/Desktop/Stuart/docs/superpowers/specs/2026-10-12-stuartmd-companion-design.md)。

执行方式：在当前工作区按照依赖顺序完成全部任务。当前用户请求交付方案；以下实施步骤在执行代码改进任务时使用。

使用的技术：现有 Tauri 2、Rust、rusqlite、SQLite、普通 JavaScript、Markdown-it、DOMPurify、KaTeX、MermaidRenderer；增加锁定版本的 markdown-it-texmath。

## 实施约束

- 每次修改文件前读取实际内容，保留用户当前编辑和未提交文件。代码通过 apply_patch 编辑。
- 使用现有成熟库解析 Markdown、JSON、TOML、PDF 及数学语法，直接加载必需依赖。
- 文档身份、来源版本、索引覆盖、计数资源、数据库版本和类型错误，在对应操作中终止并展示具体原因。
- 配置、请求和归档统一由原生接口确认。验证使用真实文件、SQLite、实际模型和已配置的 DeepSeek，不替换实际服务或伪造通过记录。
- 已确认问题可以添加回归用例；新功能使用实际结果和已有检查验证，出现具体错误后再添加对应回归用例。
- computer use、浏览器交互、窗口操作、视觉检查及键盘体验检查按照用户要求跳过，保留 SkippedByUser 状态及其范围。
- 每项任务完成相应非界面检查后继续后续任务，全部必要结果形成同一个完整交付。

## 任务 1：确定接口、身份和事件

文件：

- C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/mod.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/service.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/models.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/mod.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/main.rs

步骤：

1. 读取当前分支、版本、模块、命令登记、文档打开与保存事件、设置模型和数据库结构，确认设计所需字段与实际命名。
2. 在原生文档服务实现 documentKey 解析，保留 runtimeDocumentId 与 windowId 的权限校验；工作区身份使用现有规范路径和索引服务。
3. 定义 ConversationTarget、ConversationDraft、RequestIntent、SourceInput、SourceRef、RequestSnapshot、MemoryRecord 和 MemoryProposal 的 serde 类型及 JS JSDoc 类型。
4. 明确每项字段的可空条件、版本默认值、枚举与错误类型；显式区分文档会话和工作区会话。
5. 集中登记设计中的 companion 接口和事件，现有内部调用经统一类型适配；替换完成后移除闲置调用。

完成条件：原生和桥接接口名称、参数和结果对应；反馈接口收到实际文档身份；缺少身份或必需字段的调用在本层终止。真实窗口之间的桥接行为按用户指令保留跳过记录。

## 任务 2：数据库结构与已有数据迁移

文件：

- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/migrations.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/models.rs
- C:/Users/Administrator/Desktop/Stuart/web/js/core/settings-schema.js
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/fs_api.rs

步骤：

1. 在当前 schema version 4 之后增加 version 5 迁移，保持锁、在线备份、完整性检查和事务规则；已经达到目标版本时不重复转换数据。
2. 创建 conversation_turns、request_attempts、conversation_drafts、memory_records、memory_proposals 和 memory_sources；扩展 chat_sessions、chat_messages、organic_memories、context_records 和 document_paths。
3. 根据真实请求和消息顺序建立问题与尝试；根据已有记忆替换关系生成稳定 recordId。保留正文、来源、时间、原 messageId 和 memoryId；缺少归属的记录保留待恢复状态。
4. 设置记录有效键、版本唯一约束、请求尝试唯一约束、来源外键、查询索引及全文索引更新规则；旧 idx_memory_request 改为来源查询索引，候选来源通过请求与候选序号唯一约束。删除来源消息只移除对应关联，已经保存的记忆摘录继续保留。
5. 迁移范围和记忆配置；保留原加密密钥、服务商、模型及回答风格。
6. 使用实际已有数据库的一致性副本运行迁移，比较转换前后的记录数量、完整正文、来源归属、有效版本、外键和重新打开结果。生产数据库保持完整。

完成条件：重复打开不重复迁移；实际数据能够逐项对应；旧记录没有被重新生成或扩大归属；不支持的数据库结构拒绝写入。

## 任务 3：会话、草稿与删除服务

文件：

- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/session_service.rs，新增
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/mod.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/mod.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/mod.rs

步骤：

1. 实现目标身份、会话创建、窗口绑定、草稿保存和 sessionVersion 检查。未保存文档关联真实恢复日志身份；首次保存关联持久文件身份。
2. 将会话归档组织为问题及请求尝试；重试当前最后一次失败或停止问题产生新的 requestId，先前尝试保持可查询。
3. 原生端按会话读取已完成历史；活动请求使用会话租约及窗口所有权，归档完成后释放。
4. 实现删除状态锁定、请求取消、真实终态等待、关联记录删除及 sessionDeleted。发生错误时返回实际状态，删除完成事件只在事务完成后发布。
5. 使用实际文件和 SQLite 的已存储会话，执行当前会话删除及再次创建操作，验证新请求获得新 sessionId，未发送草稿继续存在。

完成条件：删除后的会话编号不能继续提交；草稿与原会话历史各自保存；原生权限与会话版本检查覆盖所有修改入口。

## 任务 4：范围解析、来源校验与预算

文件：

- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/sources.rs，新增
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/service.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/mod.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/mod.rs
- C:/Users/Administrator/Desktop/Stuart/web/js/core/reading-context.js，新增
- C:/Users/Administrator/Desktop/Stuart/web/js/app.js

步骤：

1. 使用 pulldown-cmark 的真实位置范围建立章节目录，接收实际阅读锚点并核对 revision、sourceHash、选区和 PDF 页面。
2. 实现 selection、section、document、workspace 四种范围，文档范围取得完整 Markdown 编辑快照或全部实际 PDF 页面正文。
3. 复用实际 RAG 搜索与索引覆盖检查，将显式材料设为必须使用，将最多 5 项自动检索结果设为可选择材料。
4. 实现只执行本地解析的 companion_prepare_context；发送阶段固定设置和来源，使用现有真实计数与结构化历史摘要服务。
5. 在 context_records 保存 sourceId、来源位置、指纹、摘录、实际使用与未使用状态、适用记忆、摘要及容量结果。
6. 使用真实已有 Markdown 在没有选区时提交正文相关问题，直接检查实际上下文包含正文；使用实际 PDF 检查页面来源。超过容量或来源校验失败时停止对应请求。

完成条件：界面范围对应实际材料；显式引用没有在容量取舍中丢失；整篇范围包含完整正文；自动材料取舍和历史摘要能够查询实际记录。

## 任务 5：统一状态与两个问答入口

文件：

- C:/Users/Administrator/Desktop/Stuart/web/js/core/conversation-store.js，新增
- C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/conversation-view.js，新增
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js

步骤：

1. 实现 ConversationStore 的快照、订阅、目标切换、草稿保存、引用操作和终态处理。全部状态修改通过明确定义的操作执行。
2. 将请求发起与完成交给 StuartAIService；从真实原生状态更新消息、材料和阶段。两个界面仅订阅相同的 ConversationStore。
3. 快速解释向当前会话增加一个问题；打开面板只恢复状态；新建会话建立独立草稿目标。
4. 实现 PreparingSources、Counting、Summarizing、Streaming 及真实终态。先确认问题接受结果，再显示已提交消息。
5. 每次目标切换保存原草稿，取消当前窗口所属请求，恢复目标状态。材料固定后正文修改保持发送快照并显示版本提示。
6. 针对已查明的两个入口消息不同步问题，使用实际归档消息和真正的状态模块验证所有订阅者取得相同的序列、答案和请求状态；窗口订阅显示与原生消息桥接保留独立跳过记录。

完成条件：两个入口从同一个会话快照取得数据；显示历史与后端实际会话一致；关闭面板后生成状态能够从真实请求恢复；失败重试保留正确问题和尝试。

## 任务 6：知识页面、引用清单与来源预览

文件：

- C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/conversation-store.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/reading-context.js
- C:/Users/Administrator/Desktop/Stuart/web/js/app.js
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/sources.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/rag/，使用现有索引服务

步骤：

1. 将索引状态转换为面向用户的工作区、覆盖数量、更新时间、阶段及失败文件信息，模型和详细诊断放入详情。
2. 统一引用状态，所有结果根据 SourceRef 清单显示“加入引用”或“已引用”；逐项移除同时更新结果与问答页。
3. 部分索引确认绑定真实工作区、代际和未完成清单；索引变化使相关引用明确失效，保留材料供用户更新或移除。
4. 预览取得真实文件片段或发送摘录；“打开原文”保存草稿并调用现有核验与定位能力。
5. 工作区变更递增查询序号，过期异步结果不更新当前页面；目标和引用草稿共同恢复。
6. 针对重复搜索引用状态及来源跳转问题，使用真实索引结果和实际文件验证清单变化；来源读取操作完成后，当前问答目标、问题和引用保持一致。

完成条件：引用按钮、引用数量、材料清单及实际上下文对应；预览保持会话目标；完整文件打开后原草稿能够恢复。

## 任务 7：记忆版本、整理方式与反馈

文件：

- C:/Users/Administrator/Desktop/Stuart/web/js/ui/memory.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/conversation-view.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/settings-schema.js
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/mod.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/learning.rs，新增
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/service.rs

步骤：

1. 实现 recordId 与 expectedVersion 的编辑接口。修改内容、键名和固定状态时生成新版本；归属修改由编辑表单提供明确目标。
2. 实现有效记录查询、偏好范围优先级、相关知识全文检索、固定记录和实际使用记录清单。
3. 分离读取与整理设置。询问操作创建编辑候选，确认前不进入有效读取集合。
4. 自动整理使用独立真实模型请求，严格解析最多 3 项候选，核对依据并保存自动知识；偏好、人物信息和决定进入待确认集合。
5. 记忆来源直接查询消息及实际摘录，记录编辑、确认、删除与恢复发布版本事件。
6. 回答风格反馈传入原生文档服务确认的实际身份和工作区，保存结果在两个入口同步显示。
7. 在一致性数据库副本上验证跨文档记忆编辑、键名修改、版本读取、询问确认和反馈参数，比较原始归属与新有效版本。

完成条件：编辑保持记录身份、来源和所属文档；有效版本唯一；询问内容经确认后生效；自动内容具有明确确认方式及真实依据；整理任务失败单独报告。

## 任务 8：会话列表、搜索和历史恢复

文件：

- C:/Users/Administrator/Desktop/Stuart/web/js/ui/memory.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/session_service.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/mod.rs

步骤：

1. 实现目标、文档、工作区和全部范围过滤，一次查询取得 30 项列表摘要及游标。
2. 原生端执行全文搜索，短查询通过参数化数据库查询取得结果；点击详情后按问题分页读取消息。
3. 恢复使用现有真实文件和日志入口，再核对当前窗口绑定、工作区及 sessionVersion。
4. 来源缺失时保留历史阅读；继续提问要求实际来源恢复完成。
5. 删除入口使用任务 3 的协调服务，确认后更新列表和统一会话状态；关联记忆选项使用实际来源记录查询。

完成条件：列表刷新通过单次分页读取返回摘要；搜索范围与实际保存内容一致；恢复结果使用真实源文件或草稿，活动会话删除后全部状态清除相应 sessionId。

## 任务 9：共享渲染、布局与键盘规则

文件：

- C:/Users/Administrator/Desktop/Stuart/package.json
- C:/Users/Administrator/Desktop/Stuart/package-lock.json
- C:/Users/Administrator/Desktop/Stuart/web/libs/，加入实际依赖资源
- C:/Users/Administrator/Desktop/Stuart/web/js/core/message-renderer.js，新增
- C:/Users/Administrator/Desktop/Stuart/web/js/core/mermaid-renderer.js
- C:/Users/Administrator/Desktop/Stuart/web/js/core/html-sanitize.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/conversation-view.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js
- C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js
- C:/Users/Administrator/Desktop/Stuart/web/js/app.js
- C:/Users/Administrator/Desktop/Stuart/web/css/companion.css，新增
- C:/Users/Administrator/Desktop/Stuart/web/css/app.css
- C:/Users/Administrator/Desktop/Stuart/web/index.html

步骤：

1. 使用包管理器安装锁定的 markdown-it-texmath 1.0.0，按照官方用法与现有 Markdown-it、KaTeX 集成，加入资源和许可清单。
2. MessageRenderer 共用 Markdown、DOMPurify、公式、图表和经核验的来源操作。请求终态取得真实最终正文并统一渲染。
3. 将伴读放入主内容区域；实现统一宽度规则、实际顶部和底部尺寸及单区域切换。移除已经替换的独立布局分支。
4. 按设计实现字体、主题、引用展开、代码和表格滚动、输入高度及流式阅读位置。
5. 集中登记快捷键，实现冲突检查、tab 关系、焦点恢复、分隔区域键盘调整、aria-live 阶段通知和明确的按钮名称。
6. 使用现有解析器读取真实示例文档和已归档答案，检查来源映射、公式输出与资源完整性。实际窗口尺寸、交互及视觉验收记录为 SkippedByUser。

完成条件：两个入口使用相同的渲染和样式实现；所有依赖随安装提供；实际视觉与操作结果只在获得相应证据后报告通过。

## 任务 10：文档、版本和验证记录

文件：

- C:/Users/Administrator/Desktop/Stuart/README.md
- C:/Users/Administrator/Desktop/Stuart/samples/欢迎使用 StuartMD.md
- C:/Users/Administrator/Desktop/Stuart/samples/示例文档.md
- C:/Users/Administrator/Desktop/Stuart/package.json
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.toml
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/Cargo.lock
- C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/tauri.conf.json
- C:/Users/Administrator/Desktop/Stuart/scripts/verify-release.cjs
- C:/Users/Administrator/Desktop/Stuart/scripts/validation-state.cjs
- C:/Users/Administrator/Desktop/Stuart/docs/validation/3.5.12/，新增实际记录

步骤：

1. 用真实入口和最终行为更新欢迎文档、示例文档和 README，说明范围、来源、记忆设置、历史和快捷键。
2. 同步产品版本至 3.5.12，通过真实包管理器更新依赖锁定信息。
3. 更新版本、资源、数据库与源码指纹检查，加入共享渲染依赖及其许可信息。
4. 验证状态明确区分 Passed、Failed、SkippedByUser 和 NotRun。用户授权跳过的记录包含原始指令、检查范围、日期、版本和源码指纹；发布检查只接受明确授权的对应跳过项目。
5. 直接读取本次实际生成的记录进行交付核验，其他必要检查必须取得成功证据。

完成条件：功能说明对应实现；版本和资源完整；所有结果对应同一源码指纹；跳过结果保留真实状态。

## 任务 11：实际综合验证与构建交付

下列命令用于检查 3.5.12 的实际功能、文件、数据库与模型接口。

~~~powershell
npm test
cargo test --manifest-path tauri/src-tauri/Cargo.toml --locked -- --test-threads=1
cargo test --manifest-path tests/native-documents/Cargo.toml --locked -- --test-threads=1 --nocapture
powershell -NoProfile -File scripts/verify-providers.ps1
npm run verify:release
~~~

安装包构建在 C:/Users/Administrator/Desktop/Stuart/tauri 目录执行：

~~~powershell
cargo tauri build --bundles nsis
~~~

产物路径：C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.12_x64-setup.exe。通过实际文件属性和 SHA-256 记录确认构建结果。

步骤：

1. 执行现有前端、Rust 和实际文档检查，检查每项命令的真实退出结果；出现错误后在当前文件状态上定位并完成对应修复。
2. 完成下面列出的已知问题回归；对需要实际窗口的环节保留跳过范围，非界面结果只证明对应服务或数据层行为。
3. 使用本机真实 DeepSeek 配置验证发送、追问、取消、上下文、实际来源、回答归档和自动整理。服务返回内容与 SQLite 请求记录逐项对应。
4. 通过现有打包方式构建完整安装文件，核对源码、资源、版本及 SHA-256；保持用户文件和设置的既有安装保留规则。
5. 当前 computer use 限制期间不启动窗口验收；安装启动与视觉检查保留明确跳过记录，安装包和构建记录单独交付。需要停止正在运行程序的安装动作等待相应操作条件。
6. 仓库提交前核对实际修改清单，仅提交本次功能与文档；读取远程 main 并处理实际差异后正常推送 main，核对远程提交编号。

### 已知问题回归要求

| 已查明的问题 | 非界面回归证据 | 依赖界面的部分 |
| --- | --- | --- |
| 无选区问答缺少正文 | 实际文档的 ValidatedContext 含正文与来源指纹；真实 DeepSeek 问答记录 | 输入操作和范围显示 |
| 两个入口消息不同步 | 同一个 ConversationStore 的真实订阅取得一致序列与归档内容 | 原生事件桥接、两个窗口区域的实际显示 |
| 重新搜索的引用状态错误 | 真实 RAG 结果重复引用和移除后，SourceRef 清单与材料记录一致 | 按钮文字和点击反馈 |
| 来源操作或目标切换丢失草稿 | 真实文件预览保持 target，文档和工作区草稿独立保存 | 原文打开、页面返回、焦点与滚动位置 |
| 删除活动会话留下编号 | 真实取消归档、删除事务、清除 sessionId 及新会话创建记录 | 删除弹窗及页面更新 |
| 记忆编辑改变归属或保留旧有效版本 | 实际记录编辑后 recordId、归属、sourceAnchor 保留，新版本唯一有效 | 编辑表单与版本详情 |
| 询问方式缺少保存入口 | 候选、确认及有效读取集合的真实数据库变化 | 答案保存提示和确认操作 |
| 风格反馈提交错误身份 | 实际 documentKey、runtimeDocumentId 和 workspaceKey 经原生接口校验并保存 | 风格按钮的操作结果 |

### 交付内容

- 完整产品源码、数据库迁移、共享页面与实际资源。
- 更新后的欢迎文档、示例文档、使用说明和 3.5.12 版本信息。
- 真实非界面验证、DeepSeek、迁移、构建及资源指纹记录。
- 用户授权跳过的界面检查清单及其实际状态。
- 正常提交并推送 main 的仓库提交编号及完整安装包。
