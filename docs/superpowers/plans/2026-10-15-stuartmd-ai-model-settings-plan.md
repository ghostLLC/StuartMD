# StuartMD AI 模型配置实施计划

> 执行要求：使用 superpowers:executing-plans 在当前会话逐项实施；用户选择代理分工时使用 superpowers:subagent-driven-development。按照复选项记录实际完成情况。

**目标：** 提供国内厂商模型预置、同一厂商多个模型保存及跨厂商直接选择模型，交付可安装的 3.5.13。

**结构：** 原生端统一维护厂商连接、模型条目和官方目录，并为每次请求生成固定配置。前端分别提供模型管理、厂商连接和共用模型选择组件。

**使用的技术：** Tauri 2、Rust、serde_json、reqwest、Windows DPAPI、现有 JavaScript 页面、Node.js 及 jsdom 检查环境。

**设计文件：** C:/Users/Administrator/Desktop/Stuart/docs/superpowers/specs/2026-10-15-stuartmd-ai-model-settings-design.md，用户已确认。

## 全部任务共同遵守的要求

- 普通添加过程无需填写 Base URL、模型名称、Token 计数 JSON 或资源路径。
- 同一个连接的多个模型共用一个加密密钥。
- 更新目录保留用户模型编号、用户显示名称、用户参数及当前选择。
- 已经发送的请求保持其模型、参数和密钥快照，新的选择用于后续请求。
- 密钥继续使用 Windows DPAPI 保存。
- 版本变化返回 SettingsVersionConflict，前端保留当前输入并提供重新加载入口。
- 实现前重新读取对应文件，以当前内容为准。
- 使用现有 DeepSeek 凭据执行真实接口验证；测试资料位于独立 STUART_DATA_DIR，真实用户配置只读取并复制到独立目录。
- 依赖 computer use 的窗口、浏览器和视觉检查按照用户指令记录为 SkippedByUser。
- 产品代码通过 apply_patch 修改；JSON、Markdown、模型协议及消息使用已有成熟解析工具。错误在对应操作位置终止并显示实际原因。
- 新增回归检查针对已经确认的问题；功能验证使用真实文件、实际保存结构、真实模型及实际接口。

## 重点检查的实际使用条件

1. 草稿正在编辑时收到其他窗口的模型选择或目录刷新事件：保留用户输入。归属任务 5、6。
2. 目录中没有用户已经保存的型号，或者在线目录只返回名称：保留模型和配置，显示目录来源及配置状态。归属任务 1、4。
3. 更换密钥、修改地址或删除模型时仍有活动请求：保持已发送配置一致，并协调涉及凭据的请求终止。归属任务 3、4。
4. 从旧配置迁移时包含自定义地址、已下线型号及用户计数覆盖项：全部保留，重复打开保持相同编号。归属任务 2。
5. 全局普通设置保存、模型编辑和当前模型选择同时发生：按版本原子提交，避免旧数据覆盖新配置。归属任务 2、3。

## 任务 1：官方目录与模型能力

**文件：**

- 新增 resources/ai-model-catalog.json。
- 新增 tauri/src-tauri/src/ai/model_catalog.rs。
- 修改 tauri/src-tauri/src/ai/mod.rs。
- 修改 resources/tokenizers-manifest.json，按实际需要补充官方分词资源。

**接口：**

- `load_catalog() -> Result<AiModelCatalog, String>`：读取 include_str! 嵌入的正式 JSON。
- `AiModelCatalog::model(provider_type: &str, region: &str, model_id: &str) -> Result<&CatalogModel, String>`。
- `CatalogModel` 包含设计文件 3.2 节规定的能力、参数、容量、计数方式、来源和版本。

- [ ] 重新核对设计文件列出的 12 个型号及对应区域的官方接口、参数、容量和 Token 计数资料，记录核对日期和来源。
- [ ] 实现上述结构和接口，验证型号及区域唯一、容量有效、参数能力相容、计数资源指纹有效。声明的字段必须参与实际请求解析。
- [ ] 运行目录加载和实际资源校验，逐项核对模型名称。对于只取得名称的在线目录，验证其结果保留“容量和参数尚待确认”的状态。
- [ ] 提交目录、资源清单和模型能力代码。

**完成条件：** 四家厂商的正式型号具有准确元数据；目录读取与实际计数配置能够按厂商、区域、型号定位。

## 任务 2：配置结构与旧设置迁移

**文件：**

- 新增 tauri/src-tauri/src/ai/configuration.rs。
- 修改 tauri/src-tauri/src/fs_api.rs、ai_chat.rs。
- 修改 web/js/core/settings-schema.js。

**接口：**

- `AiConfig`：设计文件 5.1 节的 providers、models、active_model_id、default_model_id、recent_model_ids 及全局偏好。
- `AiConfigSnapshot { ai: AiConfig, catalog: AiModelCatalog, settings_revision: String }`，序列化响应字段为 ai、catalog、settingsRevision。
- `load_ai_configuration() -> Result<AiConfigSnapshot, String>`：在已有设置锁和原子写入规则内完成 schema_version 5 到 6 的迁移。
- `resolve_model(config: &AiConfig, model_config_id: &str, catalog: &AiModelCatalog) -> Result<ResolvedModel, String>`。

- [ ] 为当前每厂商单模型的保存限制补充真实配置文件回归检查，使用独立进程和 STUART_DATA_DIR 运行。
- [ ] 实现结构、迁移和解析，按设计保留非空旧型号、原始参数、token_counting、加密密钥引用和当前选择。为模型分配稳定 UUID 并一次性保存。
- [ ] 限定通用 save_settings 接口对 AI 配置的写入，AI 修改统一使用任务 3 的类型化操作；普通外观和文档偏好继续按原流程保存。
- [ ] 使用实际配置副本执行迁移、关闭子进程、再次打开，比较模型编号、参数、凭据密文、会话和记忆。运行自定义连接及已下线型号的迁移检查。
- [ ] 提交配置结构和迁移代码。

**完成条件：** 模型数量与连接数量独立，重复加载不会新增编号或改写已有用户参数。

## 任务 3：原子配置操作与凭据

**文件：**

- 修改 tauri/src-tauri/src/ai/configuration.rs、ai_chat.rs、main.rs。
- 修改 web/js/core/tauri-bridge.js、ai-client.js。

**接口：**

- 保留 `ai_get_config()`，结果采用 AiConfigSnapshot。
- 新增 `ai_update_config(change, expectedRevision, confirm)`，对应 `stuart_ai_update_config(change: AiConfigChange, expected_revision: String, confirm: Option<bool>) -> Result<AiConfigSnapshot, String>`。
- `AiConfigChange` 按 kind 区分 saveProviderModels、editModel、selectModel、setDefaultModel、setModelEnabled、deleteModel、deleteProvider、updatePreferences。
- saveProviderModels 携带连接、所选型号及可选 API Key；缺少新密钥时复用已有凭据。密钥只作为本次操作的输入。
- `ai_set_api_key(providerId, apiKey, expectedRevision)`、`ai_clear_api_key(providerId, expectedRevision)` 返回更新后的 AiConfigSnapshot。
- ai-config-changed 事件采用 `{ revision, providerIds, modelIds, kind }`。

- [ ] 实现锁内版本比较、输入校验、原子保存和成功事件。凭据先写入独立加密资源，配置提交引用其版本；配置提交失败保留旧引用，清理未使用的临时资源。
- [ ] 实现单个模型删除、连接删除、当前及默认模型处理、新主机确认和关联请求协调；删除影响通过明确结果返回前端。
- [ ] 在实际文件上交错执行选择模型、修改偏好和编辑模型，确认旧版本返回 SettingsVersionConflict，已完成的修改保持存在。
- [ ] 检查配置读取、事件、日志和归档数据中的字段，确认不包含 API Key。通过真实 DPAPI 加解密确认凭据一致。
- [ ] 更新全部调用点，移除已无使用者的整份旧 AI 配置写入路径，然后提交。

**完成条件：** 每次模型选择只修改相关字段；多个模型可以安全共用连接和凭据。

## 任务 4：模型发现、验证与请求配置

**文件：**

- 修改 tauri/src-tauri/src/ai/configuration.rs、ai_chat.rs、ai/mod.rs、ai/companion.rs。
- 修改 tauri/src-tauri/src/context/model_spec.rs、context/service.rs、context/mod.rs。
- 修改 tauri/src-tauri/src/memory/models.rs 及实际保存请求配置的调用点。
- 修改 web/js/core/tauri-bridge.js、ai-service.js。

**接口：**

- `capture_request_model(model_config_id: &str, expected_revision: &str) -> Result<ResolvedRequestModel, String>`：返回固定的路由、参数、计数身份和独立密钥字段；密钥字段禁止序列化。
- `ai_discover_models(providerId, expectedRevision)`：返回 `{ providerId, fetchedAt, source, models }`，仅用于声明支持发现接口的连接。
- `ai_verify_model(modelConfigId, expectedRevision)`：返回 `{ modelConfigId, configIdentity, credentialRevision, checkedAt, stages, usage }`，失败返回实际阶段及原因。
- `ProviderModelSpec::from_model(model: &ResolvedModel) -> Result<ProviderModelSpec, String>`，替换按单个服务商的 model 字段解析。

- [ ] 将提问、快速问答、上下文预览、摘要和记忆整理接入统一模型解析，归档实际模型配置身份。
- [ ] 按具体模型能力产生 thinking、reasoning_effort、enable_thinking、输出限制和 JSON 参数。完成多轮消息中所需 reasoning_content 等字段的真实保存、计数和传递。
- [ ] 实现目录获取和模型回答验证的独立流程；验证使用实际计数、实际流式正文、结束标记与 usage。关键配置变化使对应验证记录失效。
- [ ] 在真实请求进行期间选择其他模型，检查请求归档仍属于原配置；后续请求采用新的选择。
- [ ] 运行现有真实 DeepSeek 接口入口，使用两个已保存型号分别验证选择、调用和归档信息。其他厂商依据实际凭据记录在线验证范围。
- [ ] 提交请求、发现和验证代码。

**完成条件：** 前端选择、实际请求、计数配置与历史归档对应同一模型，目录获取与实际回答验证分别反映真实结果。

## 任务 5：共用模型选择组件

**文件：**

- 新增 web/js/ui/model-picker.js。
- 修改 web/js/ui/ai-ui.js、companion.js。
- 修改 web/js/core/ai-client.js、ai-service.js。
- 修改 web/index.html、web/css/app.css、web/css/companion.css。

**接口：**

- `StuartModelPicker.create({ anchor, onSelect, onManage })` 返回 `{ open(snapshot), refresh(snapshot), close(), dispose() }`。
- snapshot 使用 AiConfigSnapshot；onSelect 接收 modelConfigId，由配置服务执行 selectModel。
- 顶部入口与伴读入口分别创建组件实例，共用配置快照及当前模型状态。

- [ ] 为当前需要先选厂商并手输名称的选择过程增加回归检查，使用实际页面结构和 jsdom DOM。
- [ ] 实现跨厂商列表、搜索、最近使用、默认及当前标记、不可用原因和管理入口；实现方向键、Enter、Escape 与关闭后的焦点恢复。
- [ ] 接入两个现有入口和 ai-config-changed；更新时保留搜索文字和焦点。选择失败保留当前模型并显示实际错误。
- [ ] 使用实际保存配置运行两个组件，检查选择结果、列表顺序及重启后读取结果；窗口操作记录为 SkippedByUser。
- [ ] 提交共用选择组件和入口变更。

**完成条件：** 日常选择模型只需打开列表并选择一个条目，两个入口始终显示同一个当前选择。

## 任务 6：模型管理、连接管理与编辑状态

**文件：**

- 修改 web/js/ui/ai-ui.js、memory.js。
- 修改 web/js/core/ai-client.js、settings-schema.js。
- 修改 web/index.html、web/css/app.css。

**接口：**

- 模型管理通过任务 3 的 AiConfigChange 和任务 4 的发现、验证接口操作。
- 编辑状态包含编辑对象编号、开始时 settingsRevision、当前输入及 dirty 状态；配置事件只更新已保存列表。

- [ ] 实现“已保存模型”“服务商连接”“对话偏好”及添加面板，支持一个厂商勾选多个模型。
- [ ] 实现密钥复用、区域选择、重复添加定位、取消编辑、保存失败保留输入及未保存输入的切换处理。
- [ ] 根据目录能力生成思考和容量字段；将自定义地址、型号及计数字段放入高级设置，显示完整字段校验信息。
- [ ] 实现删除、停用、默认模型、密钥清除及目录刷新反馈。配置冲突保留输入并提供重新加载操作。
- [ ] 使用实际 DOM 和独立保存文件验证编辑中收到更新事件、添加多个型号、修改单个模型及取消保存；检查主题变量与窄宽度换行规则。真实视觉检查记录为 SkippedByUser。
- [ ] 提交设置页面和编辑状态管理。

**完成条件：** 普通配置只要求必要输入，参数和验证状态归属正确模型，页面更新保留正在编辑的内容。

## 任务 7：版本、使用说明与整体检查

**文件：**

- 修改 README.md、samples/示例文档.md、samples/欢迎使用 StuartMD.md。
- 修改 package.json、package-lock.json、tauri/src-tauri/Cargo.toml、Cargo.lock、tauri.conf.json。
- 修改 tests/verify-companion.cjs、scripts/verify-providers.ps1、scripts/verify-release.cjs、scripts/validation-state.cjs、scripts/verify-companion-release.ps1。
- 新增 docs/validation/3.5.13/ 中与实际运行对应的验证记录。

- [ ] 更新版本为 3.5.13，并在示例中说明添加多个模型、直接切换、连接复用及验证状态。
- [ ] 更新检查脚本的配置结构、源文件、资源范围和版本，纳入共用模型组件与正式目录；源码指纹包含 resources/ai-model-catalog.json。
- [ ] 运行 pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Core，检查前端、Rust、实际文件与进程以及共享会话状态；通过后分别运行同一脚本的 -Mode Models 和 -Mode Providers。
- [ ] 核对设计文件第 8 节的十项验收要求，将结果、源码指纹和验证范围写入对应记录；外部服务失败时保留真实失败状态。
- [ ] 进行独立代码审查，处理影响使用或数据一致性的发现，重新运行受影响检查，然后提交。

**完成条件：** 功能、文档、版本和检查脚本一致，验证结论能够对应到实际源代码。

## 任务 8：构建与本机安装

**文件：**

- tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.13_x64-setup.exe，构建生成。
- docs/validation/3.5.13/build-results.json、installer-results.json，按实际结果生成。

- [ ] 运行 cargo tauri build --bundles nsis，核对安装包版本、大小、SHA-256 和资源清单。
- [ ] 使用现有脚本执行静默升级及用户文件、数据库和记录保留检查，安装后启动检查使用 -SkipStartup。
- [ ] 目标文件被用户应用占用时保留安装文件并报告实际状态，保持用户窗口和文档完整。
- [ ] 核对安装结果与安装包中的程序及资源，记录安装路径和恢复备份位置。
- [ ] 按用户的仓库更新指令直接提交，不创建 PR；公开 Release 按用户的发布指令执行。

**完成条件：** 构建及允许执行的安装检查具有真实结果，用户现有资料保持完整。

## 设计覆盖检查

设计第 2 节对应任务 5、6；第 3 节对应任务 1、4；第 4 节对应任务 3、5；第 5 节对应任务 2、3；第 6 节对应任务 4；第 7 节文件范围对应任务 1 至 7；第 8 节验收要求对应任务 2 至 8。
