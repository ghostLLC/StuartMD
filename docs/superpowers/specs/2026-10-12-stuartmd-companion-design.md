# StuartMD 伴读功能设计

日期：2026-10-15。适用版本：3.5.12。

本文件规定完整交付行为。当前任务交付设计和实施计划，产品代码、安装程序和 GitHub 仓库保持当前版本。按照用户要求，依赖 computer use 的界面检查记录为 SkippedByUser。

## 1. 功能定位与页面分工

伴读围绕正在阅读的材料提供解释、连续问答、资料引用、记忆管理和历史恢复。界面始终能够说明当前问答对应哪份文档、使用哪个范围、引用哪些材料，以及回答属于哪个会话。

保留“问答、知识、记忆、会话”四个页面，共用文档身份、工作区身份、会话状态和来源记录。

| 页面 | 主要操作 | 用户能够检查的信息 |
| --- | --- | --- |
| 问答 | 选择提问范围、引用材料、连续提问、停止回答、复制答案、保存笔记、记入记忆 | 当前文档、范围、模型、生成阶段、实际来源、适用记忆、材料不足原因 |
| 知识 | 选择工作区、建立或更新索引、搜索资料、预览来源、加入或移除引用 | 文件名称、章节或页面、片段正文、索引覆盖情况、引用状态 |
| 记忆 | 搜索记录、选择适用范围、编辑内容、固定记录、确认候选内容、查看来源与版本 | 全局或工作区或文档归属、确认方式、当前版本、原始依据 |
| 会话 | 筛选历史、搜索问题和答案、恢复原文与草稿、继续会话、删除会话 | 会话名称、所属文档和工作区、更新时间、最近问题、回答完成状态 |

全部页面使用现有主题、字体、文件打开规则、文档服务和原生来源校验。

## 2. 用户入口

### 2.1 完整伴读入口

顶部工具栏图标增加明确的“伴读”提示，打开后保持选中状态。Alt+I 打开或关闭伴读；再次打开时恢复该文档和工作区最近使用的页面、会话、输入草稿和滚动位置。

仅打开面板不会提交问题、改动提问范围或者替换引用。打开时能够使用的正文选区显示为“可引用的选中内容”，由用户点击“引用选区”加入材料。

面板头部包含“伴读”、当前文档名称、当前工作区和关闭按钮。问答页面在输入区域附近显示提问范围和生效模型；点击模型名称打开现有 AI 设置。

### 2.2 选区快速问答入口

正文选区工具栏的“问答”及现有选区问答快捷键，捕获实际选区后打开快速问答界面。首次打开显示选区、模型和“解释选中内容”操作。该操作向当前会话添加一个问题，范围固定为 selection。

快速问答和完整面板读取同一份消息状态。快速界面提供解释、追问、停止、复制和“在伴读中继续”；完整面板展示相同的会话和回答。用户执行“新建会话”时才建立独立会话。

快捷键登记在同一个配置表中。保存选区问答快捷键时检查 Alt+I 及已有快捷键冲突；冲突配置停止保存并显示冲突操作名称。面板内 Ctrl+Enter 发送问题，提示始终可见。

### 2.3 配置入口与空白页面

AI 未启用时，面板仍能够浏览知识、记忆和会话。问答页面保留输入草稿，显示“启用 AI”操作并打开设置。服务商、模型、密钥或计数资源缺失时显示具体缺失项目，配置完成后继续当前草稿。

没有打开文档时，可以从会话恢复文档，或者打开文件。选择工作区后可以在 workspace 范围提问；该请求使用工作区会话，不伪造当前文档。其余三个范围要求真实文档。

## 3. 提问范围与材料规则

### 3.1 四种范围

| 显示名称 | scope | 必须取得的实际材料 | 不满足条件时的行为 |
| --- | --- | --- | --- |
| 选中内容 | selection | 当前文档中具有位置、版本和指纹的选区；PDF 包含实际页面和选区坐标 | 保留草稿，提示重新选择内容 |
| 当前章节；PDF 显示当前页面 | section | 实际阅读位置所在的 Markdown 章节及其子章节；PDF 使用当前页面正文 | 位置过期、页面无法识别或没有可验证位置时停止发送 |
| 整篇文档 | document | Markdown 完整编辑快照；PDF 全部页面的实际提取结果 | 缺少页面正文或超过模型容量时停止发送，显示具体缺口 |
| 工作区资料 | workspace | 当前工作区针对问题实际检索的资料，以及用户明确加入的引用 | 没有有效索引、检索没有可用结果或者来源过期时停止发送 |

新建文档会话默认 document。选区快速解释明确使用 selection。用户手动选择的范围保存在当前草稿中，跨文档切换恢复各自设置。

工作区会话的目标身份由 workspaceKey 确定，documentKey 为 null。文档会话的目标身份由 documentKey 和 workspaceKey 共同确定；没有工作区时 workspaceKey 为 null。

### 3.2 当前章节与 PDF 页面

前端传递当前实际阅读锚点：源码光标的 UTF-16 位置，或者阅读区域首个有效正文元素对应的源位置。原生端依据当前文本和 sourceHash 转换位置，使用 pulldown-cmark 的位置范围确定章节。前端 Markdown-it 的 token.map 只用于显示位置映射。

章节包含当前标题直到下一个同级或更高层级标题之前的正文。没有标题的文档视为一个完整章节。正文开头位于首个标题之前时，章节名称显示“文档开头”。表格、列表、代码、公式和图表均保留属于该范围的实际内容。

PDF 的 section 对应阅读器确认的当前页面。selection 保留选区页面、坐标和文件指纹；跨页选择保存多组实际坐标。扫描页面使用已安装的真实识别能力，缺少可靠正文的页面明确列出。

### 3.3 显式引用与自动检索

用户加入的选区、知识片段和固定记忆属于显式材料。每项材料显示名称、章节或页码、简短摘录和移除按钮。重复加入同一项来源更新其显示状态，引用数量与实际清单相符。

workspace 范围调用现有实际检索服务，获取最多 20 项候选结果，按现有检索排序选取最多 5 项有效片段作为自动材料；用户加入的材料另外保留。来源重复时依据文档位置和指纹合并同一范围，合并记录包含原始 chunkId。

用户显式引用的材料必须完整进入本次上下文。容量不足时停止提交模型请求并指出占用材料；自动检索资料和普通知识记忆可以按明确优先级取舍，实际使用与未使用项目分别显示。

### 3.4 材料预览与容量核算

发送前的“查看本次材料”由原生材料解析接口读取实际文档、引用和适用记忆。此操作不请求模型，也不调用服务商的远程计数接口。仅在本地计数资源可用时显示本地计数结果，其余情况显示“发送时核算”。

点击发送后固定文档版本、来源清单、模型、回答风格、记忆设置和输出预算，再执行实际容量核算。界面依次显示“准备材料、核算容量、生成回答”；需要历史摘要时显示“整理已有对话”。

历史记录优先使用全部已完成问题与答案。容量不足时使用现有结构化历史摘要机制，摘要必须能够追溯到原始消息；本次使用的摘要在材料详情中显示，并保留完整原始历史。明确引用的历史消息保持原文。摘要本身无法完成或仍然超出容量时停止请求，允许新建会话或者调整范围。

整篇文档范围始终包含完整正文。模型容量不足时显示所需容量、可用容量和受影响材料，提供“选择当前章节”“调整提问范围”“打开模型设置”操作。

## 4. 会话、草稿与请求状态

### 4.1 身份规则

runtimeDocumentId 仅代表当前窗口内的文档注册实例。documentKey 由原生文档服务提供：已保存文档使用原生规范路径的持久身份；未保存文档使用恢复日志的持久身份。前端将 documentKey 当作不透明字符串。

workspaceKey 使用原生索引和路径服务提供的工作区身份。目录变更发布 workspaceChanged 事件，包含规范路径、身份和版本；面板、资料搜索及记忆过滤共同处理该事件。

首次保存草稿时，文档服务发布持久身份变更，关联会话和文档记忆在事务中更新归属，历史消息的发送版本与来源摘录保留。另存为形成目标文件的文档身份；原文件的会话和记忆继续归属原文件，目标文件恢复自己的会话状态。

sessionId 代表一个持久会话。turnId 代表会话中的一个问题。requestId 代表该问题的一次实际请求。重试沿用 turnId 并产生新的 requestId，每次尝试分别保存状态、时间和错误信息。

草稿键包含 documentKey、workspaceKey 和 sessionId；尚未创建会话时使用独立 draftId。输入问题、提问范围、显式引用、页面选择和滚动位置按照该键保存。正文恢复日志继续由文档服务维护。

输入变化后间隔 300ms 保存草稿，同一草稿按顺序提交版本；发送、切换目标和关闭文档之前完成保存。保存失败保留当前内容并终止相应操作，显示实际原因。问题被接受后清空输入问题，保留当前范围及有效引用，允许编辑下一次问题的草稿。

### 4.2 状态所有权

StuartAIService 负责提交、取消、重试和原生事件核对。ConversationStore 保存可渲染的会话快照。快速问答、伴读面板和历史详情订阅同一个快照。

消息列表、请求状态和最终答案由原生归档数据确认。前端提交 question、scope、实际引用和身份信息；历史消息由原生端从 SQLite 读取并组装。

每个窗口最多存在一个活动问答请求。每个会话最多存在一个活动请求，并使用原生请求所有权和 sessionVersion 防止多个窗口交错写入。会话在其他窗口变更后发布元数据事件，各窗口在权限核对后重新读取会话。

### 4.3 请求生命周期

~~~mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> PreparingSources: 接受有效问题
    PreparingSources --> Counting: 来源校验完成
    Counting --> Summarizing: 需要整理历史
    Summarizing --> Counting: 摘要核验完成
    Counting --> Streaming: 容量核算完成
    Streaming --> Completed: 保存最终答案
    PreparingSources --> Failed: 来源不可用
    Counting --> Failed: 容量不足
    Summarizing --> Failed: 摘要无法核验
    Streaming --> Failed: 接口请求失败
    PreparingSources --> Cancelled: 停止请求
    Counting --> Cancelled: 停止请求
    Summarizing --> Cancelled: 停止请求
    Streaming --> Cancelled: 停止请求
    Failed --> PreparingSources: 重试当前问题
    Cancelled --> PreparingSources: 重试当前问题
~~~

配置或文档身份检查尚未通过时，问题保持为输入草稿。原生端接受问题后创建 turnId，再显示用户消息及准备状态；准备过程失败保留该问题和明确失败原因。

取消和失败保存已经收到的真实部分答案，标明“回答已停止”或“回答未完成”。部分答案可以复制和保存为带状态的笔记；自动记忆整理仅处理已完成答案。

当前最后一个失败或停止的问题可以重试，界面显示一个问题及其当前尝试，详情可以查看每次真实尝试。较早的问题使用“重新提问”创建新的 turnId，后续已完成历史保持原有顺序。

流式事件同时核对 requestId、turnId、sessionId、windowId、顺序编号和最终内容指纹。出现编号缺口时读取现有真实状态快照并核对；快照仍无法核对时终止该操作，显示具体原因。

### 4.4 切换与关闭行为

关闭伴读面板保留草稿和会话。已经接受的请求继续生成，工具栏提示“伴读正在回答”，再次打开后恢复实时状态。

切换问答目标文档、切换工作区或者关闭所属文档时，取消当前窗口拥有的活动请求，并将部分结果写入原会话，再显示目标状态。资料预览不改变问答目标。

当前文档在材料准备完成之前发生修改时，来源检查停止本次请求并提示更新材料。材料准备完成后的请求使用已经固定的真实快照；界面显示“正文已更新，本次回答依据发送时版本”，并将答案保存在原会话。

关闭 AI 功能终止问答请求和自动记忆整理任务，保留已经保存的数据及输入草稿。

## 5. 问答页面

### 5.1 阅读与输入区域

消息按问题组成连续记录。用户消息显示问题、范围和发送时间。助手消息显示阶段、正文、来源及操作按钮。输入区域固定在面板底部，输入框从 3 行自动增长至 8 行，其余文字在输入框内滚动。

没有问题时，selection 范围可以执行“解释选中内容”；其他范围要求输入具体问题。生成期间保留输入下一次问题的能力；“发送”在当前问答完成后恢复，草稿独立保存。

选区引用默认显示最多 3 行，展开区域最大高度为 160px，并拥有自己的滚动区域。多项资料引用显示逐项可移除的材料清单。点击“查看本次材料”检查实际上下文。

### 5.2 答案操作

完整答案提供“复制、保存笔记、记入记忆、重新提问”操作。复制默认取得原始 Markdown，另提供“复制纯文本”。保存笔记使用现有原生文档保存能力，在用户指定的位置创建 Markdown 文件，包含问题、答案、完成状态和实际来源；已有文件进入现有明确的覆盖确认流程。

回答风格操作沿用“更简短、增加细节”等现有功能。反馈写入当前实际 documentKey 和 workspaceKey，并显示保存结果；对应原生接口接收正确的文档身份类型。

关闭快速问答界面后，完整伴读仍能显示同一答案。任何界面执行复制、停止、重新提问或记入记忆，操作结果同步至其他界面。

### 5.3 自动滚动

用户距离消息底部不超过 48px 时，回答继续生成并保持跟随。用户查看较早消息、展开来源或选择文本时保持当前阅读位置，并显示“查看最新回答”。点击后恢复跟随。

消息新增和阶段变化使用温和的 aria-live 通知；正文片段持续更新时避免逐字朗读。

## 6. 知识页面与来源阅读

### 6.1 工作区状态

页面顶部显示工作区名称、索引覆盖文件数量、最后更新时间和主要操作“建立索引”或“更新索引”。嵌入模型选择、失败文件清单和诊断信息放入可展开的“索引详情”。

首次建立索引前，缺少模型资源时明确显示资源名称及现有安装操作。索引开始后显示阶段、当前文件和取消操作。搜索可以继续使用此前完整可用的索引；结果标明其建立时间。

新索引只有完成实际提交后才替换当前索引代际。取消时保留此前已提交的可用代际；首次建立且尚无可用代际时显示未完成状态。

部分索引列出未完成文件。用户点击“使用已完成的资料”后，确认记录绑定 workspaceKey、indexGeneration 和未完成文件清单指纹。覆盖范围变化后需要重新确认。

### 6.2 搜索和引用

搜索结果显示文件名称、章节或页面、片段正文和两个操作：“预览来源”“加入引用”。已经引用的片段显示“已引用”，点击后明确移除。

显示状态完全由统一引用清单决定。重新搜索、返回页面、切换索引覆盖确认均重新计算按钮状态。清单失效时保留原项目并显示具体过期原因，允许更新或移除。

每次异步搜索包含工作区身份和查询序号。工作区变更后，旧查询结果不能替换新工作区页面。

### 6.3 来源预览

预览在伴读内容区域显示文件名称、章节或页码、发送时摘录和来源状态，保留当前问题及引用。返回问答恢复原来的输入和滚动位置。

“打开原文”执行现有原生文件打开和指纹核对，跳转实际位置，并保存原会话草稿。用户返回原文档时恢复原会话。

来源已经修改或删除时，发送时摘录仍能够查看，原文入口显示当前实际状态。当前文件核验失败时停止定位操作；用户可以打开当前文件自行查看，其内容不会冒充发送时材料。

### 6.4 答案引用

后端为实际使用的每项来源生成本次请求内的 sourceId，并提供来源映射。模型通过普通 Markdown 链接引用 sourceId。渲染完成后，只为来源映射中存在的编号绑定预览操作。

无法匹配的引用显示“来源未核验”；保留回答文本和实际材料清单。历史回答展示归档的 sourceId、位置、指纹及摘录。

## 7. 记忆管理

### 7.1 两项独立设置

“使用已有记忆”决定本次请求是否读取适用记录。“整理新记忆”包含关闭、询问、自动三个选项。新安装默认使用已有记忆，整理方式为询问。

关闭整理时仍允许用户主动执行“记入记忆”。询问方式在完整答案下显示保存提示，用户点击后建立可编辑的候选记录；选中的答案片段作为内容草稿。没有选区且完整答案不超过 800 个 Unicode 字符时，使用完整答案作为草稿；超过限制时要求选择具体段落或输入要点。确认前不进入有效记忆。

自动方式在答案归档完成后调用独立的真实整理请求，使用当前配置的服务商和模型。任务最多产生 3 项候选内容，每项不超过 800 个 Unicode 字符，包含类别、内容、建议范围和实际依据。通过 serde_json 解析结构，并核对引用来源和请求身份。

能够对应实际依据的知识要点可以按自动方式保存，界面标注“自动整理”。用户偏好、人物信息和决定均显示为待确认内容，用户确认后才按这些类别生效。整理失败显示独立任务错误；已经完成的答案保持完成状态。

### 7.2 适用范围和读取规则

记录归属显示为“全局、工作区、文档”。编辑表单显示具体工作区或文档名称。修改正文、分类和名称时，原有归属与来源保持完整；修改归属需要在表单中明确选择目标。

对同一个 preferenceKey，文档偏好优先于工作区偏好，工作区偏好优先于全局偏好。固定记录以及适用的偏好和决定优先进入上下文。普通知识要点通过真实全文检索选择与问题相关的有效版本。

不关联当前文档或工作区的记录不能进入材料清单。使用的记录在本次材料详情中显示内容、归属、版本及确认方式。关闭读取后保留记录，后续请求按照该设置处理。

### 7.3 稳定记录与版本

recordId 标识一条记忆，version 标识该记录的一次完整内容版本。每个版本使用独立 memoryId，版本正文、类别、归属和来源不可覆盖。

编辑、修改 preferenceKey、固定和取消固定都提交 recordId 及 expectedVersion。数据库在事务中创建新版本并更新当前版本。发现并发修改时停止保存，显示当前版本内容供用户重新编辑。

同一归属范围内有效的 preferenceKey 唯一。修改键名或归属发生冲突时，显示具体已存在记录，允许用户打开该记录编辑。删除通过记录状态停用全部版本，历史版本只用于查看。

### 7.4 候选内容与来源

记忆页面提供“有效记录、待确认内容”切换，并按当前文档、当前工作区和全局过滤。候选内容可以编辑、确认或删除；确认完成后两个问答界面的保存提示同步更新。

来源详情直接定位 sourceMessageId、原会话、文档或知识片段，显示可阅读的原始摘录。来源编号和诊断字段置于详情中。

用户主动保存记忆时，来源摘录随记录保存。以后删除来源会话时，明确选择继续保留相关记忆或同时删除；继续保留的记忆显示“来源会话已删除”及其真实保存摘录。

## 8. 会话历史与删除

### 8.1 列表和搜索

默认显示当前目标的会话，能够切换“当前文档、当前工作区、全部会话”。卡片显示名称、文档、更新时间、最近问题摘要和状态，支持修改名称。

列表由 SQLite 查询一次返回 30 项摘要，使用 updatedAt 和 sessionId 游标读取更多。搜索在原生端使用现有全文索引查询正文；短查询使用带参数的数据库文本检索。选中会话后才读取消息，消息按问题分页。

### 8.2 恢复与继续

恢复会话先核对会话记录，打开实际源文件或者恢复日志草稿，恢复其工作区，然后建立当前窗口绑定。聊天消息、来源、失败状态和草稿一起恢复。

原文件不存在时能够查看已保存的会话和来源摘录；继续提问需要用户通过现有文件选择流程指定实际文档，并通过原生身份和来源检查。未解决的归属在列表中显示明确状态。

### 8.3 删除协调

删除入口说明将删除的会话及其消息，并提供“同时删除来自此会话的记忆”选项，默认保留用户已经保存的记忆。

原生端锁定 sessionVersion，阻止新请求；取消当前窗口属于该会话的请求，等待真实终态归档后删除数据。其他窗口拥有的活动请求需要先在所属窗口停止，删除操作返回具体原因。

删除完成后发布 sessionDeleted。全部绑定界面清除该 sessionId，恢复为独立草稿；尚未发送的问题及其有效引用继续保留。后续发送创建新会话。

删除过程中出现取消、版本或数据库错误时，该操作就地终止并显示原因，界面仅依据原生返回的实际会话状态刷新。

## 9. 显示规格与键盘操作

### 9.1 布局

伴读作为主内容区域的独立栏，正文重新计算可用宽度。面板上边缘位于工具栏及文档标签栏下方，下边缘位于状态栏上方，跟随实际布局尺寸。

保存的首选宽度默认 380px，可调范围为 340–600px，调整分隔区域宽度为 6px。阅读和源码模式保留至少 480px 主内容空间；分栏模式保留至少 800px。面板实际宽度取首选宽度与剩余空间允许宽度中的较小值。

主内容可用宽度不足“对应主内容最小宽度 + 340px + 6px”时，使用“文档／伴读”单区域切换，两个区域的内容、输入和滚动状态持续保留。窗口扩大后恢复独立栏布局；单区域伴读占据全部可用宽度。

快速问答在能够容纳的窗口中定位于真实选区附近；空间不足时进入完整伴读页面。快捷入口只响应实际选区操作。

### 9.2 字体与主题

| 内容 | 规格 |
| --- | --- |
| 面板界面文字 | 现有 font-ui，13px |
| 回答正文 | 现有 font-body，14px，行高 1.7 |
| 时间、来源和版本信息 | 现有 font-ui，12px |
| 代码 | 现有 font-mono，独立横向滚动 |
| 表格和大型公式 | 独立横向滚动，保留面板宽度 |
| 控件 | 至少 28px 高度，主要发送操作至少 32px |

颜色来自现有主题变量。快速问答、伴读回答、记忆卡片及历史详情共享组件样式，深色及全部现有主题统一适用。

### 9.3 内容渲染

新增共享 MessageRenderer，使用现有 Markdown-it、DOMPurify、KaTeX 和 MermaidRenderer。回答的原始 HTML 关闭；公式通过 markdown-it-texmath 解析，再由 KaTeX 使用 trust:false 渲染。HTML 与 MathML 通过对应 DOMPurify 配置检查。Mermaid 延续现有独立渲染和 SVG 检查，来源链接只绑定经过核验的映射。

markdown-it-texmath 锁定已发布的 1.0.0，使用 dollars 与 brackets 分隔符，资源随安装程序提供。[项目文档](https://github.com/goessner/markdown-it-texmath/blob/master/readme.md)说明了 Markdown-it、KaTeX 集成及分隔符配置；[发行包](https://www.npmjs.com/package/markdown-it-texmath/v/1.0.0)提供版本和许可信息。

流式输出每 200ms 以内合并一次视图更新，将当前完整累计文本交给 Markdown-it 解析。数学插件只处理其能够完整识别的数学表达式；生成期间的 Mermaid 代码保持代码显示，答案完成后执行实际图表渲染。最终答案使用同一个渲染器和真实最终文本。公式或图表语法错误显示明确错误和对应源码，其操作就地停止。

### 9.4 键盘与焦点

四个页面提供 tablist、tab、tabpanel 和 aria-controls，支持方向键、Home、End 及 Enter。打开面板前保存焦点及真实选区，关闭后恢复焦点。Escape 优先关闭内部弹窗或来源预览，再关闭面板。

拖动宽度操作同时提供键盘调整：分隔区域取得焦点后，左右方向键每次调整 16px。所有图标具有操作名称，所有按钮具有可见焦点。

## 10. 代码职责与数据接口

### 10.1 模块调整

使用现有 Tauri、Rust、SQLite 和普通 JavaScript 模块组织方式。

| 文件 | 职责 |
| --- | --- |
| C:/Users/Administrator/Desktop/Stuart/web/js/core/conversation-store.js，新增 | 会话快照、草稿、引用、页面状态和订阅 |
| C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-service.js | 请求协调、真实状态核对、提交和取消 |
| C:/Users/Administrator/Desktop/Stuart/web/js/core/reading-context.js，新增 | 从文档服务和阅读器取得实际位置，处理目标和工作区变更 |
| C:/Users/Administrator/Desktop/Stuart/web/js/core/message-renderer.js，新增 | 共享 Markdown、数学、图表和来源绑定 |
| C:/Users/Administrator/Desktop/Stuart/web/js/ui/conversation-view.js，新增 | 两个问答入口共享的消息、状态和操作视图 |
| C:/Users/Administrator/Desktop/Stuart/web/js/ui/companion.js | 四个页面导航、独立栏布局及组合 |
| C:/Users/Administrator/Desktop/Stuart/web/js/ui/ai-ui.js | 快速问答入口、模型配置与回答风格界面 |
| C:/Users/Administrator/Desktop/Stuart/web/js/ui/memory.js | 记忆与会话列表、详情和编辑表单 |
| C:/Users/Administrator/Desktop/Stuart/web/js/core/ai-client.js | 配置、实际文档反馈和记忆操作 |
| C:/Users/Administrator/Desktop/Stuart/web/js/app.js | 宿主事件、主区域尺寸、原生文档及资料入口 |
| C:/Users/Administrator/Desktop/Stuart/web/js/core/tauri-bridge.js | 新接口与类型的集中绑定 |
| C:/Users/Administrator/Desktop/Stuart/web/css/companion.css，新增 | 伴读及共享问答组件样式 |
| C:/Users/Administrator/Desktop/Stuart/web/css/app.css | 主内容区域和主题变量 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/sources.rs，新增 | 来源解析、章节位置、引用清单和范围解析 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/context/service.rs | 真实材料组装、计数、摘要与最终来源记录 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/ai/mod.rs | 问题、尝试、请求所有权及阶段事件 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/session_service.rs，新增 | 会话身份、分页、恢复、删除和草稿 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/learning.rs，新增 | 候选内容、真实整理请求、来源核对和任务取消 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/models.rs | 会话、来源、记忆版本和候选内容类型 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/sqlite_archive.rs | 参数化查询、事务、版本检查及来源直接查询 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/memory/migrations.rs | 第 5 版数据库结构及一致性迁移 |
| C:/Users/Administrator/Desktop/Stuart/tauri/src-tauri/src/document/mod.rs | 持久文档身份与实际窗口绑定 |

### 10.2 核心数据

| 类型 | 必需字段 |
| --- | --- |
| ConversationTarget | documentKey 可空、workspaceKey 可空、runtimeDocumentId 可空、windowId；documentKey 和 workspaceKey 至少一项有效 |
| ConversationDraft | draftId、target、sessionId 可空、question、scope、readingAnchor 可空、explicitSources、viewState、draftVersion、updatedAt |
| ConversationSnapshot | target、sessionId 可空、sessionVersion、turns、activeRequest 可空、draft、references、learningActions |
| RequestIntent | requestId、turnId 可空、sessionId 可空、expectedSessionVersion、draftId、draftVersion、target、question、scope、readingAnchor 可空、selection 可空、explicitSources、settingsRevision、editorRevision、sourceHash |
| SourceInput | inputId、kind、实际对象编号、实际来源位置及版本；explicitSources 使用该类型 |
| SourceRef | sourceId、inputId 可空、kind、excerpt、来源指纹及位置；其他字段按来源类别确定 |
| RequestSnapshot | requestId、turnId、sessionId、status、phase、seq、text、finalHash 可空、validatedContext 可空、error 可空 |
| MemoryRecord | recordId、currentVersion、status、scope、workspaceKey、documentKey、preferenceKey、currentContent、approvalKind、sources |
| MemoryProposal | proposalId、sourceRequestId、sourceMessageId、content、category、suggestedScope、status、proposalVersion |

新旧字段的映射集中定义。JS 使用明确的 JSDoc 类型，Rust 使用 serde 类型和枚举。缺少必需字段、未知枚举或版本不一致时停止当前操作。

来源类型采用明确的枚举及不同字段：selection、section、document 包含 documentKey、编辑快照 sourceHash、revision 和实际位置；已经保存的文件另含原始字节 fileFingerprint。knowledge 包含 chunkId、workspaceKey、indexGeneration、fileFingerprint 和实际片段位置。memory 包含 recordId、version 和内容指纹。message 包含 sessionId、messageId 和归档内容指纹。path 在没有对应物理文件时为空。输入引用经原生核对后转换为 SourceRef，sourceId 仅用于本次实际材料映射。

新建草稿的 draftVersion 为 0，创建会话前 expectedSessionVersion 为 0；已有对象必须使用最近确认的版本。viewState 包含页面选择、滚动锚点和是否跟随最新消息。RequestSnapshot 的 seq 随本次请求的状态和内容事件递增；正文终态核对 finalHash，归档消息的 sequence 独立维护。

### 10.3 原生接口

| 接口 | 行为与约束 |
| --- | --- |
| companion_prepare_context(intent) | 本地解析来源和材料清单，核对身份，不产生会话写入或远程请求 |
| companion_send_question(intent) | 校验目标和版本，创建问题或重试尝试，从归档取得历史，启动真实请求 |
| companion_get_conversation(sessionId, cursor, target) | 返回当前会话快照及消息分页 |
| companion_save_draft(draft, expectedDraftVersion) | 事务保存独立草稿，返回新版本 |
| companion_list_sessions(options) | 按 options 中的筛选、query、cursor 和 limit 返回摘要与下一页游标 |
| companion_rename_session(sessionId, expectedSessionVersion, title) | 修改会话名称并返回新版本 |
| companion_delete_session(sessionId, expectedSessionVersion, deleteLinkedMemories) | 协调取消、版本和删除，发布真实完成事件 |
| companion_preview_source(target, sourceInput) | 只读核对尚未发送的真实来源，返回可阅读内容，不改变问答目标 |
| companion_get_source(sourceId, requestId) | 返回归档摘录及当前来源核验结果 |
| companion_list_memories(options) | 按 options 中的筛选、query、cursor 和 limit 返回有效版本 |
| companion_save_memory(recordId 可空, expectedVersion, edit) | 保留身份和原有归属，显式处理字段变更，返回当前版本 |
| companion_delete_memory(recordId, expectedVersion) | 停用指定记录及其全部版本 |
| companion_update_memory_proposal(proposalId, expectedProposalVersion, edit) | 编辑候选内容或明确删除候选，确认操作由独立接口执行 |
| companion_confirm_memory(proposalId, expectedProposalVersion, edit) | 创建或更新指定记录，并保存确认来源 |
| companion_get_memory_source(recordId) | 直接取得来源记录与消息，包含实际摘录 |

上述名称为 JS 桥接方法，Rust 命令统一使用 stuart_ 前缀并在 main.rs 登记。现有 ai_chat_status、取消接口、实际 RAG、文档打开、PDF 定位、session_open_document 及笔记保存能力继续复用。旧内部接口通过统一类型适配迁移，完成调用替换后删除闲置分支。

所有持久修改发布 conversationChanged、draftChanged、sessionDeleted、memoryChanged 或 workspaceChanged。事件包含对象身份和版本，视图通过统一状态更新。

### 10.4 错误和任务边界

原生错误返回 code、message、目标身份、请求编号及相关来源；界面根据实际类型提供对应操作。主要类型为 SourceChanged、SourceUnavailable、IndexCoverageChanged、CapacityExceeded、SessionVersionConflict、MemoryVersionConflict、DraftVersionConflict、ConfigurationIncomplete 和 DatabaseFailure。

问答生成、记忆整理、笔记保存和来源定位各自具有独立的状态。发生错误时终止所属操作并报告实际原因，其他已经完成的数据继续保持已确认状态。

模型、风格和预算修改在后续请求生效；活动请求使用接受时的设置快照。关闭 AI 及撤销来源访问权限立即取消对应活动操作。密钥通过现有加密设置读取，不写入草稿、会话、材料详情或验证日志。

## 11. 数据库与已有数据迁移

### 11.1 第 5 版结构

| 数据对象 | 结构变化 |
| --- | --- |
| chat_sessions | 增加 document_key、workspace_key、session_version 和 deletion_state；保留标题、路径及时间 |
| conversation_turns，新增 | turn_id、session_id、ordinal、kind、question、current_request_id、created_at；没有原始问题的早期消息使用 LegacyMessages 类别并保留原始角色 |
| request_attempts，新增 | request_id、turn_id、attempt_no、status、phase、错误及时间；每次请求独立 |
| chat_messages | 增加 turn_id、attempt_no；保留原 message_id、内容、顺序和来源 |
| conversation_drafts，新增 | 目标身份、session_id 可空、draft_id、question、scope、引用和位置及 viewState JSON、draft_version、时间 |
| memory_records，新增 | record_id、当前 version、status、归属和 preference_key，用于版本检查及有效键唯一约束 |
| organic_memories | 增加 record_id、approval_kind；各行作为不可覆盖的版本快照，使用 record_id 与 version 唯一约束 |
| memory_proposals，新增 | 候选内容、来源、建议范围、状态、proposal_version 和时间 |
| memory_sources，新增 | 记录身份、来源消息可空、request_id、真实 source_anchor、source_excerpt、source_hash |
| context_records | 继续保存每次请求的真实材料清单，补充 sourceId、实际使用状态和摘录 |
| document_paths | 保留历史 runtimeDocumentId 与路径关系，增加持久身份映射及身份解析状态 |

JSON 字段使用 serde_json 解析。来源消息删除时 memory_sources 的消息关联置空，已经由用户保存的实际摘录继续归属对应记忆。会话自身的请求材料通过现有外键关系随会话删除。

conversation_drafts 的会话关联在删除后置空，保留 draftId、问题和引用；对应界面将其作为新会话草稿。sourceHash 与 fileFingerprint 分别核对编辑正文和文件原始字节，迁移及来源恢复保持两种指纹的用途。

第 5 版以 recordId 和 version 约束记忆版本，将旧 idx_memory_request 的唯一约束改为来源查询索引；候选记录通过 sourceRequestId 与候选序号唯一约束防止同一次整理重复创建记录。chat_messages 的 requestId 与 role 唯一规则继续覆盖每次实际尝试，当前历史从 conversation_turns 的当前完成尝试读取。

### 11.2 迁移过程

沿用实际迁移锁、SQLite 在线备份、完整性检查、外键检查和 Immediate 事务。备份失败、结构异常、身份冲突或非法版本链在对应步骤终止，原数据库保持原有有效结构。

已有会话按照真实 request_id、角色和 sequence 生成问题与尝试；没有 request_id 的早期记录通过原始顺序保存关联，标记“早期归档”，原文完整保留。

旧记忆按照已有 superseded_by 关系形成 recordId 和版本。每个有明确当前版本的记录保留当前有效状态；链条缺少有效末端时停用该记录并保留可查看版本，避免重新启用已经替换的内容。独立旧记录保持独立身份，已有正文和来源不重新生成。

有效物理路径通过原生路径服务生成 documentKey；缺失路径保留原始归属并标记“来源待恢复”。未恢复的文档记忆不会自动归属当前文档，也不会自动扩大适用范围。

旧 confirmed 状态按原值保留，approvalKind 标为 legacy，界面显示“已有记录”。新记录区分 user、automatic 和 legacy，不推断旧记录的确认方式。

AI 配置迁移：full 映射 document；neighborhood 映射 document，并保留既有来源锚点用于历史显示。memory_mode=always 映射“读取开启、自动整理”；ask 映射“读取开启、询问”；off 映射“读取关闭、整理关闭”。原密钥和加密方式继续由现有设置服务管理。

迁移后执行实际数量、正文、来源、版本和外键检查。低版本程序遇到第 5 版数据库时，沿用已有高版本结构拒绝写入规则。

## 12. 验证与交付要求

已经查明的范围取材、共享消息、重复引用、目标切换、活动会话删除、跨文档记忆编辑、询问保存及反馈身份问题，分别通过真实文件、原生服务和 SQLite 操作进行复现与回归验证。

新功能按照实际操作结果和现有检查验证；遇到具体错误后才添加相应回归用例。接口请求使用本机已配置的真实 DeepSeek 服务，密钥只从现有加密设置读取。

源码检查、现有前端检查、Rust 检查、实际数据迁移、来源校验及 DeepSeek 请求可以在用户办公期间通过非界面方式执行。原生窗口操作、浏览器交互、实际视觉和键盘体验检查依照用户指令记录为 SkippedByUser，记录包含具体检查名称、原因、日期和源码指纹。

版本检查区分 Passed、Failed、SkippedByUser 和 NotRun；公开交付记录保留实际状态。源码、构建、资源清单和安装文件的版本及指纹相符后才报告对应结果。

欢迎文档和示例文档说明四种范围、两个问答入口、来源阅读、记忆设置、历史恢复及完整快捷键。版本号随实施完成统一更新至 3.5.12。

仓库更新沿用用户要求：完成必要的非界面验证后直接提交并正常推送 main。提交仅包含本次实施内容及实际交付文档。
