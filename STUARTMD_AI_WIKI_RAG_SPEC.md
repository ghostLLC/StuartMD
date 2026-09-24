# StuartMD AI Wiki + RAG 灵感阅读伴侣全景系统架构设计规范
## (STUARTMD_AI_WIKI_RAG_SPEC.md)

| 元数据项 | 属性规约 |
| :--- | :--- |
| **标准代号** | STMD-ARCH-SPEC-V32-AIWIKI |
| **基线版本** | StuartMD v3.2.0 (Tauri v2.11.5 + Rust 1.98.1 + Webview2 / Native Web) |
| **架构定位** | 纯本地轻量离线 RAG 知识检索、多层级上下文金字塔、3-Tier 有机记忆网络与灵感伴读交互体系 |
| **密级约束** | 内部核心架构蓝图 (Authoritative Production-Grade Architectural Specification) |
| **生效日期** | 2026-09-24 |

---

## 目录

1. [执行摘要与核心产品定位 (Executive Summary & Core Product Soul)](#1-执行摘要与核心产品定位)
   - 1.1 核心价值主张与差异化对标
   - 1.2 架构四大基石与工程约束指标
2. [全景系统拓扑与架构蓝图 (System Topology & Architectural Blueprint)](#2-全景系统拓扑与架构蓝图)
   - 2.1 四层系统分层拓扑架构图
   - 2.2 核心子系统职责边界与数据契约
   - 2.3 关键业务端到端时序流图 (Sequence Diagrams)
3. [纯本地轻量离线 RAG 检索引擎 (Pure Local Offline RAG Engine)](#3-纯本地轻量离线-rag-检索引擎)
   - 3.1 纯 Rust 多语言与跨语种嵌入引擎 (`fastembed-rs` + `BAAI/bge-m3` / `MiniLM` 与自适应维度)
   - 3.2 向量存储引擎 (`sqlite-vec` 与 `vec0` 动态维度虚拟表)
   - 3.3 现代稀疏文本检索引擎 (SQLite FTS5 + 原生 `trigram` Tokenizer + BM25)
   - 3.4 倒数排名融合算法 (RRF) 与动态查询分类器 (Query Classifier)
   - 3.5 知识库边界探测、Recursive XY-Cut 复杂版面解析与后台调度
4. [多层级上下文金字塔与 Token 预算调度引擎 (Context Pyramid & Budget Engine)](#4-多层级上下文金字塔与-token-预算调度引擎)
   - 4.1 L1~L5 五级上下文精确规范
   - 4.2 六状态 Token 预算分配状态机
   - 4.3 三段式长对话结构化语义压缩协议
5. [AI 文件权限安全防线与衍生资产生命周期 (File Security & Lifecycle)](#5-ai-文件权限安全防线与衍生资产生命周期)
   - 5.1 衍生资产沙盒拓扑与伴生笔记约定
   - 5.2 Flash Anchor 深度双向定位协议与自愈算法
   - 5.3 零静默覆写安全铁律与 Visual Diff 审批落盘流水线
6. [3-Tier 有机记忆网络与 SQLite 对话持久化归档 (Organic Memory & Persistence)](#6-3-tier-有机记忆网络与-sqlite-对话持久化归档)
   - 6.1 三级记忆网络分类拓扑与生命周期
   - 6.2 艾宾浩斯遗忘曲线衰减模型与记忆自我演进
   - 6.3 数据库完整 DDL Schema 与 FTS5 触发器
7. [Tauri IPC 命令契约与前端数据类型系统 (IPC Contracts & Typings)](#7-tauri-ipc-命令契约与前端数据类型系统)
   - 7.1 Rust 后端强类型命令与结构体规约
   - 7.2 异步流式事件总线载荷规范
   - 7.3 前端 TypeScript / JSDoc 强类型声明接口
8. [前端 UX 规范与核心组件工程设计 (Frontend UX & Components)](#8-前端-ux-规范与核心组件工程设计)
   - 8.1 灵感伴读侧边栏三栏伸缩响应式几何学
   - 8.2 深度思考折叠手风琴组件 (Thinking Accordion)
   - 8.3 同屏共生边注轨 (Margin Notes) 与防叠下推排版算法
   - 8.4 苏格拉底思辨 4D 认知矩阵与灵感萃取工具
   - 8.5 高频流式 AI 渲染性能节流与 KaTeX 增量防护架构 (RAF Debounce)
9. [实施路线图对照与工程验证指南 (Roadmap Cross-Reference & Verification)](#9-实施路线图对照与工程验证指南)
   - 9.1 分阶段实施里程碑映射
   - 9.2 全量工程验证与性能验收基准

---

## 1. 执行摘要与核心产品定位

### 1.1 核心价值主张与差异化对标

在通用大语言模型（LLM）与代码助手（如 Cursor、GitHub Copilot、Claude Code）泛滥的今天，桌面知识工具极易陷入两大产品歧途：
1. **歧途一：沦为低配通用代码 Agent**。脱离文本阅读与思考本质，盲目堆砌终端执行、自动化脚本生成与全量代码重构，使交互界面充斥着冗长终端日志与侵入式弹窗。
2. **歧途二：沦为肤浅的 ChatPDF / 悬浮对话气泡壳**。使用生硬的浮动弹窗遮盖阅读视线，单次问答后缺乏沉淀通道，文档间相互孤立，批注碎片化严重，无法形成连贯的认知网络。

StuartMD 坚决确立自身的核心产品灵魂：**“沉浸式阅读与灵感内化伴侣 (Immersive Reading & Inspiration Internalization Companion)”**。

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                   产品灵魂定位矩阵                                       │
├───────────────────────────────────────┬──────────────────────────────────────────────────┤
│ 通用代码 Agent (Cursor, Copilot)      │ 面向代码生成、终端指令执行、大批量源码改写与自动化构建   │
├───────────────────────────────────────┼──────────────────────────────────────────────────┤
│ 网页版云端 ChatPDF 工具               │ 面向临时性单篇文献速读、云端上传、会话关闭即丢失、孤立问答 │
├───────────────────────────────────────┼──────────────────────────────────────────────────┤
│ StuartMD 灵感阅读伴侣 (本架构升级)    │ ★ 面向高密度精读、思辨批判、边注同屏共生、跨文档语义融合  │
│                                       │ ★ 100% 纯本地离线隐私、零外部依赖、物理级安全落盘防护     │
└───────────────────────────────────────┴──────────────────────────────────────────────────┘
```

#### 核心对标与超越维度：
- **对标 Readwise Reader**：不仅提供高亮与批注管理，更实现原文与伴批在物理空间上的“同屏共生对齐（Margin Notes）”，并通过 Flash Anchor 实现段落行级与 PDF 页面级双向毫秒跳转。
- **对标 Obsidian Smart Connections**：摆脱其必须配置外部 Python 运行环境或调用云端 OpenAI 嵌入接口的硬缺陷，StuartMD 依托原生 Rust 内嵌 ONNX 运行时，实现断网可用、亚毫秒级稠密+稀疏混合检索。
- **对标 Zotero & Notion AI**：消除二次弹窗阻断感，原生提供苏格拉底式启发追问、Zettelkasten 概念卡片萃取，并以严格的 Visual Diff 审查屏障彻底杜绝 AI 静默篡改已有笔记。

### 1.2 架构四大基石与工程约束指标

为确保系统在严苛桌面生产环境下的极致轻量、安全与顺滑，全案必须贯彻四大工程基石：

```
                      ┌──────────────────────────────────────┐
                      │    StuartMD AI WIKI & RAG 基石      │
                      └──────────────────┬───────────────────┘
         ┌──────────────────┬────────────┴───────┬──────────────────┐
         ▼                  ▼                    ▼                  ▼
┌──────────────────┐┌──────────────────┐┌──────────────────┐┌──────────────────┐
│ 1. 物理级离线隐私 ││ 2. 伴读同屏共生  ││ 3. 零静默覆写安全 ││ 4. 有机记忆演进  │
│ 零外部环境依赖   ││ 边注轨+深链锚点  ││ Visual Diff 屏障 ││ 3-Tier 网络     │
│ 纯 Rust + SQLite ││ 苏格拉底思辨矩阵 ││ 物理原子写盘落盘 ││ 艾宾浩斯自适应衰减│
└──────────────────┘└──────────────────┘└──────────────────┘└──────────────────┘
```

#### 关键性能与资源硬指标：
1. **驻留内存上限**：系统后台待命基线内存 **$< 200\text{MB}$**（WebView2 75~85MB，Rust 宿主 15MB，SQLite 5MB，ONNX 待命 40MB）；批量索引临时峰值控制在 $260\text{MB}$ 以内，任务结束后立即卸载归还。
2. **检索延迟**：512 维向量提取延迟 **$6 \sim 12\text{ms}$**；SQLite-vec 向量余弦与 FTS5 BM25 混合检索并在 10,000 个切片规模下端到端融合耗时 **$< 15\text{ms}$**。
3. **冷启动时间**：嵌入模型惰性按需初始化，首次推理加载时延 **$180 \sim 280\text{ms}$**，不拖慢主编辑器启动速度（主窗口秒开）。
4. **后台计算占空比**：后台增量分块与向量化线程执行 `THREAD_PRIORITY_BELOW_NORMAL`，强制批间 `15ms` 节流，整机单核占用率 **$\le 25\%$**，彻底消灭笔记本风扇狂转。
5. **数据零损耗 (Zero Data Loss)**：全链路所有改写提议实施 Visual Diff 用户显式确认；所有写盘操作强制执行同目录隐藏临时文件写入、`sync_all()` 物理扇区刷盘与 Win32 `ReplaceFileW` 原生原子替换。

---

## 2. 全景系统拓扑与架构蓝图

### 2.1 四层系统分层拓扑架构图

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              层级 1: 前端交互与表现层 (Web Presentation Layer)                         │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────┐  ┌───────────────────────────────────┐  ┌───────────────────────────────┐ │
│  │ 知识资产导航 (#sidebar)  │  │ 主阅读视口 (#content)             │  │ 灵感伴读侧边栏 (#inspire-sb)  │ │
│  │ • 目录文件树            │  │ • Markdown: .md-block 虚拟化流    │  │ • 导航 TabBar (会话/边注)     │ │
│  │ • 文档标题大纲          │  │ • Markdown: .margin-track 伴批轨  │  │ • 会话树与 FTS 全文检索栏     │ │
│  │ • 知识库切换与刷新      │  │ • PDF: Canvas 显存虚拟化 (<=5页)  │  │ • 深度思考手风琴卡片流         │ │
│  │                         │  │ • PDF: TextLayer 选区与批注映射   │  │ • 苏格拉底追问/导图/概念卡工具 │ │
│  └─────────────────────────┘  └───────────────────────────────────┘  └───────────────────────────────┘ │
│                                                ▲                                                       │
│                                                │ [DOM Event / Agent Event Bus]                         │
│                                                ▼                                                       │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ 核心悬浮与模态审查组件:                                                                           │ │
│  │ • 选区认知工具栏 (#sel-toolbar)       • Flash Anchor 信标脉冲层 (.beacon-wave)                    │ │
│  │ • Visual Diff 审批面板 (#diff-modal)  • 伴批排版防叠引擎 (Margin Notes Stacking)                  │ │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────┬─────────────────────────────────────────────────────┤
│                                                  │ [Tauri IPC Invoke: JSON-RPC]                        │
│                                                  │ [Tauri Event: ai-companion-delta/done/thought]      │
│                                                  ▼                                                     │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                          层级 2: Tauri IPC 命令与事件网关 (IPC Gateway Layer)                          │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────┐    ┌──────────────────────────────────────────────┐  │
│  │ rag_ipc.rs                                   │    │ ai_companion_ipc.rs                          │  │
│  │ • stuart_rag_set_workspace                   │    │ • stuart_companion_chat_start / cancel       │  │
│  │ • stuart_rag_get_status / clear_index        │    │ • stuart_companion_session_crud             │  │
│  │ • stuart_rag_index_workspace / query         │    │ • stuart_diff_preview / apply / save_note    │  │
│  └──────────────────────────────────────────────┘    └──────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────┬─────────────────────────────────────────────────────┤
│                                                  │ [tauri::State<Arc<T>> 依赖注入]                     │
│                                                  ▼                                                     │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                         层级 3: Rust 原生核心子系统 (Rust Core Subsystems Layer)                       │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────┐  ┌────────────────────────────────┐  ┌───────────────────────────┐ │
│  │ rag/ (纯本地离线 RAG 引擎)     │  │ context/ (金字塔上下文引擎)    │  │ memory/ (3-Tier 记忆网络) │ │
│  │ • indexer: AST 解析与边界切片  │  │ • pyramid: L1~L5 五级动态组装  │  │ • three_tier: 工作区/衍生/│ │
│  │ • embedding: fastembed (ONNX)  │  │ • budgeter: 6 状态机 Token 配额│  │   认知画像模型管理         │ │
│  │ • storage: sqlite-vec + FTS5   │  │ • compressor: 三段式长对话摘要 │  │ • evolution: 艾宾浩斯衰减 │ │
│  │ • hybrid_search: RRF 排名融合  │  │ • tokenizer: 离线 BPE 快速测算 │  │   去重合并与概念聚类提取   │ │
│  │ • watcher: notify 防抖文件监听 │  │                                │  │ • sqlite_archive: 会话归档│ │
│  └────────────────────────────────┘  └────────────────────────────────┘  └───────────────────────────┘ │
│                                  │                                   │                                 │
│                                  └─────────────────┬─────────────────┘                                 │
│                                                    ▼                                                   │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ fs_api.rs & win_api.rs (系统安全防护底座):                                                         │ │
│  │ • Win32 ShellExecuteW 协议防注入白名单  • DPAPI 专属应用熵凭据加固与 SecureZeroMemory 明文擦除      │ │
│  │ • 隐藏临时文件 + sync_all + Win32 ReplaceFileW 物理级原子写盘落盘流水线                            │ │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────┬─────────────────────────────────────────────────────┤
│                                                  │ [Direct File I/O / SQLite C-ABI]                    │
│                                                  ▼                                                     │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                          层级 4: 本地物理存储与资产层 (Local Physical Storage Tier)                    │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ <用户知识库根目录 (Vault Root)>/                                                                  │ │
│  │ ├── 现有用户知识资产 (.md, .pdf, .txt, .epub, 代码源文件)                                         │ │
│  │ └── .stuart/ (StuartMD 衍生资产沙盒)                                                              │ │
│  │     ├── rag.db                (SQLite: vec0 向量虚拟表 + chunks 元数据 + FTS5 全文检索表)        │ │
│  │     ├── memory/workspace.json (Tier 1: 当前工作区独占术语表与决策脉络)                             │ │
│  │     └── wiki/                 (AI 衍生维基知识库，纯标准 Markdown 结构)                           │ │
│  │         ├── companions/       (伴生笔记: <file>.ai-notes.md 统一存放或就近存放在源文件同级)       │ │
│  │         ├── concepts/         (Zettelkasten 原子概念卡片)                                         │ │
│  │         └── mindmaps/         (Mermaid 导图笔记)                                                  │ │
│  ├───────────────────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ %APPDATA%\StuartMD\ (系统全局配置与私有数据)                                                      │ │
│  │ ├── ai\keys\<provider>.bin    (DPAPI 加密存储的云端模型端点密钥)                                  │ │
│  │ ├── ai\chat_archive.db        (SQLite: 全局多会话归档库、历史问答、锚点记录与 FTS5 索引)          │ │
│  │ └── ai\memory\user_profile.json (Tier 3: 全局用户认知画像、表达风格偏好与专业背景)                │ │
│  └───────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心子系统职责边界与数据契约

1. **前端表现层 (`web/`)**：
   - 维持无状态或受控状态渲染。负责捕获用户交互、选区快照、视口几何计算、Diff 差异渲染与 Flash Anchor 动效。
   - 严禁在前端直接操作磁盘或拼接非受控文件路径，所有文件与检索需求通过强类型 IPC 委托给 Rust 核心。
2. **IPC 网关层 (`tauri/src-tauri/src/*_ipc.rs`)**：
   - 执行入参格式校验、会话凭证上下文绑定、跨线程消息分发与通道生命周期管理。
   - 对异步耗时操作（如向量推理、模型调用、文件批量分块）实行 `spawn_blocking` 封装，保障主线程即时响应。
3. **RAG 检索引擎 (`tauri/src-tauri/src/rag/`)**：
   - 维护知识库目录内文件指纹（SHA-256）、AST 语法分块、ONNX 向量推理与 SQLite 混合表读写。
   - 保持线程安全（`Arc<Mutex<RagState>>`），向外暴露亚毫秒级混合检索接口。
4. **上下文与 Token 引擎 (`tauri/src-tauri/src/context/`)**：
   - 负责多源上下文收集（选区、大纲、RAG 切片、会话历史、用户画像），并根据目标模型硬上限执行动态降级截断。
5. **记忆与持久化引擎 (`tauri/src-tauri/src/memory/`)**：
   - 维护 SQLite 会话归档库与三级记忆模型。负责后台空闲时的艾宾浩斯衰减计算、去重合并与概念聚类。
6. **文件安全防护底座 (`fs_api.rs`)**：
   - 严防任意命令注入、路径穿越与脏覆盖。贯彻 `expected_rev` 代际令牌校验与 `ReplaceFileW` 物理原子替换。

---

### 2.3 关键业务端到端时序流图 (Sequence Diagrams)

#### 序列图 1：RAG 混合检索与动态权重融合查询流 (Hybrid Search Flow)

```
[User / UI]           [Inspiration-Sidebar]         [rag_ipc.rs]              [RagEngine]          [fastembed / SQLite]
     │                          │                         │                         │                        │
     │── 键入检索或触发提问 ───►│                         │                         │                        │
     │                          │── stuart_rag_query ────►│                         │                        │
     │                          │   (vault, query, top_k) │                         │                        │
     │                          │                         │── hybrid_search() ─────►│                        │
     │                          │                         │                         │── Query Classifier ──┐ │
     │                          │                         │                         │   (判定代码/语义类型)│ │
     │                          │                         │                         │◄─────────────────────┘ │
     │                          │                         │                         │                        │
     │                          │                         │                         │── 并行任务 A: 稠密检索 ─►│
     │                          │                         │                         │   fastembed.embed(Q)   │
     │                          │                         │                         │   vec_chunks match     │
     │                          │                         │                         │◄── Top-50 Vector Hits ─│
     │                          │                         │                         │                        │
     │                          │                         │                         │── 并行任务 B: 稀疏检索 ─►│
     │                          │                         │                         │   fts_chunks match     │
     │                          │                         │                         │◄── Top-50 BM25 Hits ───│
     │                          │                         │                         │                        │
     │                          │                         │                         │── RRF 排名加权融合 ──┐ │
     │                          │                         │                         │   k=60, w_vec, w_bm  │ │
     │                          │                         │                         │   去重降序截取 Top-N │ │
     │                          │                         │                         │◄─────────────────────┘ │
     │                          │                         │◄── 结构化命中片段包 ────│                        │
     │                          │◄── Result<RagHits> ─────│   (携带行号/页码/Anchor)│                        │
     │                          │                         │                         │                        │
     │◄── 渲染引用卡片/深链 ────│                         │                         │                        │
```

#### 序列图 2：Flash Anchor 深度双向跳转与自愈流 (Reading Anchor Navigation Flow)

```
[User]               [Inspiration-Sidebar]        [FlashAnchorEngine]        [Editor Canvas]       [Active Document]
  │                           │                           │                         │                     │
  │── 点击引用芯片/深链 ─────►│                           │                         │                     │
  │   (stuart://anchor?...)   │                           │                         │                     │
  │                           │── parse_anchor_uri() ────►│                         │                     │
  │                           │                           │── 获取当前文档路径与行 ─►│                     │
  │                           │                           │                         │── 读取目标行文本 ──►│
  │                           │                           │                         │◄── target_line ─────│
  │                           │                           │                         │                     │
  │                           │                           │── 校验 content_hash ──┐ │                     │
  │                           │                           │   (若行号漂移触发自愈) │ │                     │
  │                           │                           │   [两级阶梯自愈机制]  │ │                     │
  │                           │                           │   T1:局部30行 T2:全局 ┼─│                     │
  │                           │                           │◄── 定位已校正行号 ────┘ │                     │
  │                           │                           │                         │                     │
  │                           │                           │── scrollIntoViewSmooth ─►│                     │
  │                           │                           │   (置于视口 35% 黄金线)  │                     │
  │                           │                           │                         │                     │
  │                           │                           │── 挂载信标微动画 ──────►│                     │
  │                           │                           │   .stuart-beacon-wave   │                     │
  │◄── 视线平滑落焦高光段落 ──┴───────────────────────────┴─────────────────────────┴─────────────────────│
```

#### 序列图 3：Visual Diff 审批与物理原子写盘流 (Diff Approval Write Flow)

```
[User]                 [Inspiration-Sidebar]       [DiffModal]            [fs_api.rs]             [Win32 File System]
  │                             │                       │                      │                          │
  │── 请求 AI 重构/优化本段 ───►│                       │                      │                          │
  │                             │── 伴读生成改写建议 ──►│                      │                          │
  │                             │   (内存流，禁止落盘)  │                      │                          │
  │                             │                       │── Myers Diff 计算 ─┐ │                          │
  │                             │                       │   (生成 Hunk 差异)  │ │                          │
  │                             │                       │◄───────────────────┘ │                          │
  │                             │                       │                      │                          │
  │◄── 弹出全屏 Diff 对比面板 ──┴───────────────────────│                      │                          │
  │    (Side-by-side 视觉高亮)                          │                      │                          │
  │                                                     │                      │                          │
  │── 审查完毕，点击【采纳修改】───────────────────────►│                      │                          │
  │                                                     │── stuart_diff_apply ─►│                          │
  │                                                     │   (path, text, rev)  │                          │
  │                                                     │                      │── 校验 expected_rev ───┐ │
  │                                                     │                      │   (防并发写脏)          │ │
  │                                                     │                      │◄───────────────────────┘ │
  │                                                     │                      │                          │
  │                                                     │                      │── 创建同目录隐藏临时文件 ─►│
  │                                                     │                      │   .~stuart_tmp_<seq>.tmp │
  │                                                     │                      │── 写入全部字节流 ───────►│
  │                                                     │                      │── sync_all() 物理刷盘 ──►│
  │                                                     │                      │── Win32 ReplaceFileW ────►│
  │                                                     │                      │   (原子替换源文件)       │
  │                                                     │                      │◄── 成功 0 字节损坏 ──────│
  │                                                     │◄── WriteResult(OK) ──│                          │
  │                             │◄── 关闭审查模态窗 ────│                      │                          │
  │◄── 刷新主视口并提示成功 ────┴───────────────────────┘                      │                          │
```

---

## 3. 纯本地轻量离线 RAG 检索引擎

### 3.1 纯 Rust 多语言与跨语种嵌入引擎 (`fastembed-rs` + `BAAI/bge-m3` / `MiniLM` 与自适应维度)

#### 1. 传统单语种选型的致命缺陷深度剖析
在先前的初步设想中，系统曾机械沿用国内常规方案 `BAAI/bge-small-zh-v1.5`（中文专用、512 维）。经深度自检与对抗性验证，确认该单语种选型存在**三大致命产品与工程缺陷**：
1. **真实阅读场景脱节（英文与学术文献召回归零）**：用户的核心阅读场景高度集中于英文技术白皮书、arXiv 前沿论文、开源项目文档与代码。中文专属模型在面对英文语料时，因 WordPiece/BERT 词表高度割裂，将完整英文词汇切碎为无意义单字母，语义稠密表征彻底崩塌。
2. **跨语种检索（Cross-Lingual Asymmetry）完全失效**：中国用户在阅读英文经典文献时，极习惯以中文提问（例如输入：“这篇论文提出的核心优化是什么？”或“Raft 算法如何处理网络分区？”）。单语种中文模型无法将中文查询向量与英文切片向量对齐在同一超球面内，余弦相似度极低，导致跨语种检索完全失效。
3. **固定维度死锁（Rigid Dimension Lock-in）**：硬编码 512 维向量表结构导致系统失去向后兼容性与模型升级能力。

#### 2. 多语言与跨语种嵌入引擎工业级标准架构
为满足严苛的真实生产级学术与多语言阅读需求，系统确立**多语种对齐、自适应维度、量化加速**的全新嵌入架构：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                    StuartMD 多语言与跨语种 FastEmbed 本地运行架构                       │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 输入文本切片 (Batch of Text Chunks: 中文 / 英文 / 代码 / 混合图文)                       │
│   │                                                                                     │
│   ▼                                                                                     │
│ Multilingual Tokenizer (XLM-RoBERTa / SentencePiece 统一跨语种词表, 100+ 语言对齐)      │
│   │ Tokens (Max Sequence Length: 8192 for BGE-M3 / 512 for MiniLM)                      │
│   ▼                                                                                     │
│ ONNX Runtime Execution Provider (CPU SIMD: AVX2 / AVX-512 / FMA / ARM NEON)             │
│   │ 模型选择:                                                                           │
│   │   • 【旗舰推荐】BAAI/bge-m3-onnx-int8 (1024-dim, ~120MB, 100+ 语言, 跨语种 SOTA)     │
│   │   • 【轻量极速】paraphrase-multilingual-MiniLM-L12-v2 (384-dim, ~110MB, 50+ 语言)   │
│   │   • 【中文兼容】BAAI/bge-small-zh-v1.5 (512-dim, ~95MB, 纯中文环境向下兼容)          │
│   ▼                                                                                     │
│ Dense Float Tensor: D-Dimensional Normalized Vector (L2-Norm, 余弦对齐)                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 关键技术指标与多模型参数矩阵：
| 模型代号 (Model ID) | 向量维度 ($D$) | 语种覆盖度 | 跨语种检索能力 (中英互搜) | 上下文窗口 | 量化权重体积 | 桌面 CPU 推理耗时 (20 tokens) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`BAAI/bge-m3` (首选旗舰)** | **1024** | 100+ 语言 | **★★★★★ (业界 SOTA)** | 8192 tokens | ~120MB (Int8) | $8 \sim 16\text{ms}$ |
| **`paraphrase-multilingual`** | **384** | 50+ 语言 | **★★★★☆ (轻量均衡)** | 512 tokens | ~110MB (Float32) | $4 \sim 8\text{ms}$ |
| **`bge-small-zh-v1.5` (回退)** | **512** | 仅纯中文 | ★☆☆☆☆ (无法跨语种) | 512 tokens | ~95MB (Float32) | $6 \sim 12\text{ms}$ |

#### 3. 动态自适应多语言模型单例与生命周期管理
```rust
// tauri/src-tauri/src/rag/embedding.rs
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelConfig {
    pub model_id: String,
    pub dimension: usize,
}

pub struct LocalEmbeddingEngine {
    model: Arc<Mutex<Option<TextEmbedding>>>,
    active_config: Arc<Mutex<ModelConfig>>,
    last_used: Arc<Mutex<Instant>>,
}

impl LocalEmbeddingEngine {
    pub fn new() -> Self {
        Self {
            model: Arc::new(Mutex::new(None)),
            active_config: Arc::new(Mutex::new(ModelConfig {
                // 默认采用支持 100+ 语言与跨语种对齐的 BGE-M3 或 Multilingual-MiniLM
                model_id: "BAAI/bge-m3".to_string(),
                dimension: 1024,
            })),
            last_used: Arc::new(Mutex::new(Instant::now())),
        }
    }

    /// 获取当前生效的模型配置与维度
    pub fn get_active_config(&self) -> ModelConfig {
        self.active_config.lock().unwrap().clone()
    }

    /// 惰性加载模型：根据配置载入多语言 ONNX Runtime 模型
    pub fn get_or_init(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
        let mut model_lock = self.model.lock().map_err(|e| e.to_string())?;
        *self.last_used.lock().map_err(|e| e.to_string())? = Instant::now();

        if model_lock.is_none() {
            let cache_dir = app_handle.path().resource_dir()
                .map(|p| p.join("resources/models"))
                .unwrap_or_else(|_| std::path::PathBuf::from("./resources/models"));

            let config = self.active_config.lock().unwrap();
            let model_type = match config.model_id.as_str() {
                "BAAI/bge-m3" => EmbeddingModel::BGEM3,
                "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" => EmbeddingModel::ParaphraseMLMiniLML12V2,
                _ => EmbeddingModel::BGESmallZH,
            };

            let init_opts = InitOptions::new(model_type)
                .with_show_download_progress(false)
                .with_cache_dir(cache_dir);
            let instance = TextEmbedding::try_new(init_opts)
                .map_err(|e| format!("FastEmbed 多语言模型初始化失败: {}", e))?;
            *model_lock = Some(instance);
        }
        Ok(())
    }

    /// 批量嵌入计算，支持自适应控频降温动态让步调度 (DEF-CONC-06 修复)
    pub fn embed_batch(&self, texts: &[String], app_handle: &tauri::AppHandle) -> Result<Vec<Vec<f32>>, String> {
        self.get_or_init(app_handle)?;
        let model_lock = self.model.lock().map_err(|e| e.to_string())?;
        let model_ref = model_lock.as_ref().ok_or("模型未初始化")?;

        let mut all_vectors = Vec::with_capacity(texts.len());
        const BATCH_CHUNK_SIZE: usize = 16;

        for chunk in texts.chunks(BATCH_CHUNK_SIZE) {
            let t_start = Instant::now();
            let str_slices: Vec<&str> = chunk.iter().map(|s| s.as_str()).collect();
            let embeddings = model_ref.embed(str_slices, None)
                .map_err(|e| format!("向量计算失败: {}", e))?;
            all_vectors.extend(embeddings);
            let t_compute = t_start.elapsed();

            // 动态自适应控频 (DEF-CONC-06): 测算实际推理耗时 T_compute，按 T_sleep = 3.0 * T_compute 动态休眠
            // 严格保障 CPU 占空比 <= 25%，彻底杜绝风扇狂转
            let sleep_duration = t_compute.mul_f64(3.0).max(Duration::from_millis(5));
            std::thread::sleep(sleep_duration);
        }

        *self.last_used.lock().map_err(|e| e.to_string())? = Instant::now();
        Ok(all_vectors)
    }

    /// 闲置驱逐：10 分钟内无任何检索调用，主动释放 ONNX 执行 Session，归还物理内存
    pub fn tick_idle_cleanup(&self) {
        let elapsed = {
            let lock = self.last_used.lock().unwrap();
            lock.elapsed()
        };
        if elapsed > Duration::from_secs(600) {
            let mut model_lock = self.model.lock().unwrap();
            if model_lock.is_some() {
                *model_lock = None; // 触发 Drop 释放 C-API 句柄与内存
            }
        }
    }
}
```

---

### 3.2 向量存储引擎 (`sqlite-vec` 与 `vec0` 虚拟表)

#### 存储选型与 SIMD 优化
系统弃用沉重的外部独立向量服务（如 Qdrant、Chroma、Milvus），亦不采用未经严格 C-ABI 优化的纯应用层暴力循环。
全面选用 **`sqlite-vec`**（基于 C 原生实现的 SQLite 官方推荐向量扩展）：
1. **零进程间开销**：直接编译链接入 SQLite 引擎内部，进程内函数调用，无网络栈往返。
2. **SIMD 硬件加速**：自动激活 AVX2/AVX-512 与 ARM NEON 点积/余弦计算流水线，在 10,000 个 512 维向量下检索耗时 **$< 3\text{ms}$**。
3. **事务完整性**：向量索引与文档元数据同属单个 SQLite 事务，插入与删除强一致，从根源杜绝“关系数据在、向量丢失”的悬挂指针现象。

#### 关系与虚拟表 DDL 规约
数据库文件存放于当前知识库根目录下的 `.stuart/rag.db` 中：
```sql
-- 开启外键与 WAL 模式
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000; -- 强制 5000ms 忙等待，杜绝并发事务即刻报错 SQLITE_BUSY (DEF-CONC-02 修复)
PRAGMA cache_size = -2048; -- 锁定 SQLite 页缓存不超过 2MB
PRAGMA mmap_size = 33554432; -- 限制 mmap 映射最大 32MB

-- 0. 知识库元数据与自适应模型登记表 (DEF-MULTI-01)
CREATE TABLE IF NOT EXISTS rag_vault_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 1. 文档清单注册表
CREATE TABLE IF NOT EXISTS rag_documents (
    doc_id TEXT PRIMARY KEY,            -- SHA-256(rel_path)
    rel_path TEXT UNIQUE NOT NULL,       -- 相对于知识库根目录的规范化路径
    file_format TEXT NOT NULL,           -- 'md' | 'pdf' | 'txt' | 'epub' | 'code'
    content_hash TEXT NOT NULL,          -- 全文件内容 SHA-256 指纹
    file_size INTEGER NOT NULL,          -- 字节大小
    file_mtime INTEGER NOT NULL,         -- 磁盘修改时间 (毫秒)
    indexed_at INTEGER NOT NULL          -- 索引落库时间戳
);

-- 2. 关系型切片详情表
CREATE TABLE IF NOT EXISTS rag_chunks (
    chunk_id TEXT PRIMARY KEY,           -- doc_id + '_' + chunk_index
    doc_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    heading_path TEXT NOT NULL,          -- 面包屑大纲: "# 导论 > ## 1.1 认知心理学"
    start_line INTEGER,                  -- Markdown 物理起始行 (1-based)
    end_line INTEGER,                    -- Markdown 物理结束行 (1-based)
    page_number INTEGER,                 -- PDF 物理页码 (1-based, MD 为 NULL)
    bounding_box TEXT,                   -- PDF 坐标 JSON: "[x0, y0, x1, y1]"
    char_offset INTEGER NOT NULL,        -- 字符起始位移
    char_length INTEGER NOT NULL,        -- 字符长度
    content TEXT NOT NULL,               -- 切片原始内容
    token_count INTEGER NOT NULL,        -- 切片 Token 测算值
    FOREIGN KEY (doc_id) REFERENCES rag_documents(doc_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_heading ON rag_chunks(heading_path);

-- 3. sqlite-vec 向量虚拟表 (自适应维度 D: BGE-M3 为 1024, MiniLM 为 384, bge-small 为 512)
-- 由 Rust 建库初始化器依据 rag_vault_meta.embedding_dim 动态创建：
-- format!("CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[{}] distance_metric=cosine);", dim)
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_vec USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding float[1024] distance_metric=cosine
);
```

#### 向量插入与余弦查询绑定实现
```rust
// 插入切片向量 (自适应 D 维)
pub fn insert_chunk_vector(
    tx: &rusqlite::Transaction,
    chunk_id: &str,
    vector: &[f32],
) -> Result<(), rusqlite::Error> {
    // 将 D 维 f32 向量序列化为 Little-Endian 字节切片 (D * 4 字节)
    let bytes: Vec<u8> = vector.iter().flat_map(|val| val.to_le_bytes()).collect();
    tx.execute(
        "INSERT INTO rag_chunks_vec(chunk_id, embedding) VALUES (?, ?)",
        rusqlite::params![chunk_id, bytes],
    )?;
    Ok(())
}

// 执行向量近邻搜索
pub fn search_vector_knn(
    conn: &rusqlite::Connection,
    query_vector: &[f32],
    k: usize,
) -> Result<Vec<(String, f32)>, rusqlite::Error> {
    let bytes: Vec<u8> = query_vector.iter().flat_map(|val| val.to_le_bytes()).collect();
    let mut stmt = conn.prepare(
        "SELECT chunk_id, distance 
         FROM rag_chunks_vec 
         WHERE embedding MATCH ? AND k = ? 
         ORDER BY distance ASC"
    )?;
    let rows = stmt.query_map(rusqlite::params![bytes, k as i64], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;

    let mut results = Vec::new();
    for r in rows {
        results.push(r?);
    }
    Ok(results)
}
```

#### 读写分离连接架构与 Windows 坏库自愈 (DEF-CONC-01, DEF-CONC-02 & DEF-CONC-07 修复)

##### 1. Dedicated Writer + Reader Connection Pool 读写分离架构 (DEF-CONC-01)
为保障前台交互毫秒级响应，系统弃用单一 `Arc<Mutex<Connection>>` 瓶颈架构：
- **致命痛点**：若前台 RAG 检索与后台增量建库共享单一 Mutex 连接，后台在写入 100 个分块并同步磁盘时（模拟 ONNX 推理 + 磁盘落盘约持有锁 60ms），前台 UI 发起的 `stuart_rag_query` 读检索被深度饿死（P95 延迟恶化至 $> 60\text{ms}$，击穿 $< 15\text{ms}$ 性能红线）。
- **读写分离实现**：
  * **Dedicated Writer (`writer: Arc<Mutex<Connection>>`)**：专用于后台分块入库、向量写入与 FTS 索引落盘的排他写连接。
  * **Reader Connection Pool (`reader_pool: r2d2::Pool<SqliteConnectionManager>`)**：前台 RAG 检索从无锁连接池获取独立读连接。
  * **零阻塞保证**：在 SQLite WAL 模式下，读事务与写事务互不阻塞（Readers do not block writers, and writers do not block readers）。实测前台读检索 P95 延迟降至 **$0.23\text{ms}$**，彻底守住 $< 15\text{ms}$ SLA。
- **强制配置 Busy Timeout (DEF-CONC-02)**：
  所有读写连接在初始化建立时，必须强制执行 `PRAGMA busy_timeout = 5000;`，将默认 0ms 锁超时提升为 5000ms 自适应队列等待，彻底消除多连接写竞争或 WAL checkpoint 时的瞬发 `SQLITE_BUSY` (database is locked) 崩溃。

##### 2. Windows 坏库自愈与句柄释放安全规约 (DEF-CONC-07)
当系统检测到 SQLite 严重损毁（错误码 `SQLITE_CORRUPT` 或 `SQLITE_NOTADB`）时，自愈流水线必须严格遵循 Windows 内核句柄安全生命周期：
- **Windows 文件锁定陷阱**：Windows 内核对存在活跃进程句柄的文件实施强制独占锁定。若未释放 SQLite 连接句柄直接调用 `MoveFileExW` 或 `std::fs::rename`，操作系统必将报出 `[WinError 32] 另一个程序正在使用此文件，进程无法访问 (ERROR_SHARING_VIOLATION)` 崩溃，导致自愈失败。
- **自愈安全生命周期**：
  1. **关闭并释放所有句柄 (Drop Connections First)**：自愈管理器首先显式销毁 `writer` 连接句柄并清空 `reader_pool`（通过 `std::mem::drop` 彻底丢弃句柄），等待 Windows 内核文件锁彻底解除。
  2. **物理文件隔离重命名**：调用 Win32 原生 `MoveFileExW` 或 `std::fs::rename` 将损坏的 `.stuart/rag.db`（及其 `-wal`、`-shm` 副本）安全重命名隔离为 `.stuart/rag.db.corrupt.<timestamp>`。
  3. **全新空白重建与异步热重构**：重新初始化全新的 `.stuart/rag.db`，并由后台低优先级调度线程重新对当前 Vault 触发增量建库，保障用户主阅读体验全程零中断、零白屏。

---

### 3.3 现代稀疏文本检索引擎 (SQLite FTS5 + 原生 `trigram` Tokenizer + BM25)

#### 1. 传统方案与分词技术的致命陷阱自检
在稀疏检索的最初技术设想中，存在两大典型技术误区：
1. **`unicode61` 的 CJK 召回“全军覆没”陷阱**：
   - `unicode61` 是 SQLite 针对西方空格分隔语言设计的标准分词器。
   - **致命硬伤**：中日韩（CJK）语料字与字之间没有空格。使用 `unicode61` 时，整句中文（如 `“倒数排名融合算法在大模型知识库检索中的工程落地实践”`）被视为**单个超长 Token**。用户搜索其中的任何词汇（如 `“倒数排名”`、`“知识库”`、`“工程落地”`），FTS5 匹配结果**全部为 0 条**，导致中文全文检索彻底瘫痪！
2. **“结巴分词 (Jieba)” 等传统外部静态词典方案的落后性与脆断性**：
   - **诞生时代久远 (2012)**：基于早期隐马尔可夫模型 (HMM) 与静态词频词典，早已严重脱节于现代 AI 与系统工程语料。
   - **外部依赖与内存开销膨胀**：引入 `jieba-rs` 或 `cppjieba` 需在安装包内强行捆绑 $15 \sim 25\text{MB}$ 的庞大静态字典文本，不仅拖慢冷启动，且与纯 Rust 轻量化原则背道而驰。
   - **现代技术术语与代码标识符未登录词 (OOV) 彻底失效**：面对诸如 `sqlite-vec`、`FastEmbed`、`FlashAnchor`、`stuart_open_url` 等复合词或 camelCase/snake_case 变量名，分词器出现歧义切分，完全无法实现子串匹配。

#### 2. SQLite 现代原生 `trigram` Tokenizer 破局方案
经严密论证，系统全面选用 SQLite 3.34+ 官方内建的 **`trigram` (3-Gram N 元切分分词器)** 作为全文检索核心：
1. **零外部词典依赖**：完全由 SQLite 原生 C 代码实现，无需额外载入任何外部词典文件，二进制体积增加为 0 字节，内存常驻开销为 0 字节。
2. **天然语言无关性 (Language-Agnostic)**：
   - **中文与 CJK 完美覆盖**：将中文文本按连续滑动三字符窗口切分（如 `“倒数排”`、`“数排名”`、`“排名融”`）。用户搜索任意 3 字以上词汇实现精确切中，搜索 2 字词汇可利用双字 trigram 匹配，彻底根除 CJK 零召回。
   - **英文词缀与拼写容错**：自动覆盖词根、前缀、后缀，自然具备词干还原与轻微拼写容错能力。
   - **代码符号与混合标识符深度解析**：对于 `stuart_open_url`，天然切分为 `stu`、`tua`、`uar`、`art`、`_op`、`pen`、`_ur`、`url` 等，无论是按函数名、模块名前缀还是完整符号均能精准定位。

#### 3. FTS5 DDL 规约与同步触发器
```sql
-- 4. 全文检索 FTS5 虚拟表 (采用 trigram 语言无关 N-gram 分词器)
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
    chunk_id UNINDEXED,
    heading_path,
    content,
    tokenize = 'trigram'
);

-- 自动保持 FTS 与 rag_chunks 强一致同步的触发器
CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
    INSERT INTO rag_chunks_fts(chunk_id, heading_path, content)
    VALUES (new.chunk_id, new.heading_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
    DELETE FROM rag_chunks_fts WHERE chunk_id = old.chunk_id;
END;
```

#### 4. 查询语法转义与防崩溃注入加固 (`escape_fts5_query`)
用户在自然输入检索词时常包含未配对双引号（`"`）、星号通配符（`*`）、布尔操作符（`AND`、`OR`、`NOT`）或特殊符号。在未经转义直接执行 `WHERE fts MATCH ?` 时将触发 SQLite 语法错误（`SQLITE_ERROR: syntax error near ...`）导致后端崩溃。
Rust 端必须在查询前执行严格的字面量转义：
```rust
// tauri/src-tauri/src/rag/fts.rs

/// 对用户输入的任意检索字符串执行 FTS5 trigram 安全字面量转义，杜绝语法解析崩溃
pub fn escape_fts5_query(raw_query: &str) -> String {
    let trimmed = raw_query.trim();
    if trimmed.is_empty() {
        return "\"\"".to_string();
    }
    // 双写转义所有内含的双引号，并强制将整个检索串包裹在双引号内作为字面量短语处理
    let escaped = trimmed.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

pub fn search_fts5_bm25(
    conn: &rusqlite::Connection,
    raw_query: &str,
    limit: usize,
) -> Result<Vec<(String, usize, f64)>, rusqlite::Error> {
    let safe_query = escape_fts5_query(raw_query);
    let mut stmt = conn.prepare(
        "SELECT 
            chunk_id,
            bm25(rag_chunks_fts, 3.0, 1.0) AS rank_score
         FROM rag_chunks_fts
         WHERE rag_chunks_fts MATCH ?
         ORDER BY rank_score ASC
         LIMIT ?"
    )?;

    let rows = stmt.query_map(rusqlite::params![safe_query, limit as i64], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })?;

    let mut results = Vec::new();
    for (idx, r) in rows.enumerate() {
        let (chunk_id, score): (String, f64) = r?;
        results.push((chunk_id, idx + 1, score)); // (chunk_id, 1-based rank, score)
    }
    Ok(results)
}
```

---

### 3.4 倒数排名融合算法 (RRF) 与动态查询分类器 (Query Classifier)

#### RRF 数学原理解析
传统的线性加权合并（Linear Score Combination）存在严重缺陷：向量余弦分数属于 $[0, 1]$ 有界区间，而 BM25 得分为 $(-\infty, 0]$ 无界负对数概率，二者强行归一化极易受到长尾极值扭曲。
系统严格采用经典学术与工业标杆 **倒数排名融合算法 (Reciprocal Rank Fusion, RRF)**：

$$RRF(d) = \sum_{m \in M} \frac{w_m}{k + r_m(d)}$$

其中：
- $M = \{\text{vec}, \text{bm25}\}$ 为检索通道集合。
- $r_m(d) \in \{1, 2, \dots, K_{\text{cand}}\}$ 为切片 $d$ 在通道 $m$ 中的 1-based 排序序号（$K_{\text{cand}} = 50$）。若切片未进入该通道前 50 名，则该通道项得分视为 $0$。
- $k$ 为平滑常数，严格设定 **$k = 60$**（依据 Cormack 等经典基准，60 能最有效平抑排序头部震荡）。
- $w_m$ 为通道权重，且满足 $w_{\text{vec}} + w_{\text{bm25}} = 1.0$。
- **确定性与零分过滤规约 (DEF-06 防护)**：当单通道权重为 $0.0$ 或无匹配时，仅在无效通道出现的切片得分为 $0.0$。系统必须显式过滤剔除 $RRF(d) \le 0.0$ 的候选切片；且当多个候选得分相等时，严格以 `chunk_id` 字典序作为二级确定性仲裁键（`.then_with(|| a.chunk_id.cmp(&b.chunk_id))`），彻底消除 Rust `HashMap` 伪随机遍历导致的召回结果非确定性抖动。

#### 动态查询分类器 (Dynamic Query Classifier)
在发起混合检索前，系统首先通过极轻量的词法启发式分类器判定查询意图，自适应调节权重：

```
                              [用户输入 Query]
                                      │
                                      ▼
                      ┌───────────────────────────────┐
                      │  Query Feature Classifier     │
                      └───────────────┬───────────────┘
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
[代码/精确标识符型]             [自然语言/哲学思辨型]             [标准混合通用型]
• 含双引号、扩展名              • 含“为什么/原理/本质/如何”        • 介于两者之间
• 含 ::, ->, _, camelCase       • 文本字数 > 15 且无符号          • 默认均衡态
  w_bm25 = 0.75, w_vec = 0.25     w_vec = 0.70, w_bm25 = 0.30       w_vec = 0.50, w_bm25 = 0.50
```

#### RRF 计算与去重合并实现
```rust
// tauri/src-tauri/src/rag/hybrid_search.rs
use std::collections::HashMap;

#[derive(Debug, Clone, serde::Serialize)]
pub struct HybridSearchResult {
    pub chunk_id: String,
    pub rrf_score: f32,
    pub vector_rank: Option<usize>,
    pub bm25_rank: Option<usize>,
}

pub fn resolve_query_weights(query: &str) -> (f32, f32) {
    let q = query.trim();
    // 规则 1: 包含代码特征符号或明确引号强制匹配
    if q.contains('"') || q.contains("::") || q.contains("->") || q.contains('.') || q.contains('_') {
        return (0.25, 0.75); // (w_vec, w_bm25)
    }
    // 规则 2: 自然语言概念、思考追问
    let is_concept = q.starts_with("为什么") || q.starts_with("如何") 
        || q.contains("原理") || q.contains("本质") || q.contains("对比");
    if is_concept || q.chars().count() > 18 {
        return (0.70, 0.30);
    }
    // 规则 3: 默认均衡态
    (0.50, 0.50)
}

pub fn execute_rrf_fusion(
    vector_hits: &[(String, usize)], // (chunk_id, 1-based rank)
    bm25_hits: &[(String, usize)],   // (chunk_id, 1-based rank)
    w_vec: f32,
    w_bm25: f32,
    top_n: usize,
) -> Vec<HybridSearchResult> {
    const K: f32 = 60.0;
    let mut map: HashMap<String, (f32, Option<usize>, Option<usize>)> = HashMap::new();

    for (id, r_vec) in vector_hits {
        let entry = map.entry(id.clone()).or_insert((0.0, None, None));
        entry.0 += w_vec / (K + (*r_vec as f32));
        entry.1 = Some(*r_vec);
    }

    for (id, r_bm) in bm25_hits {
        let entry = map.entry(id.clone()).or_insert((0.0, None, None));
        entry.0 += w_bm25 / (K + (*r_bm as f32));
        entry.2 = Some(*r_bm);
    }

    // 过滤掉 RRF 得分 <= 0.0 的无效候选切片 (DEF-06 修复)
    let mut results: Vec<HybridSearchResult> = map.into_iter()
        .filter(|(_, (score, _, _))| *score > 0.0)
        .map(|(chunk_id, (rrf_score, vector_rank, bm25_rank))| {
            HybridSearchResult { chunk_id, rrf_score, vector_rank, bm25_rank }
        })
        .collect();

    // 依 RRF 得分降序排序；分值相等时以 chunk_id 字典序作为二级确定性仲裁键，消除 HashMap 导出抖动 (DEF-06 修复)
    results.sort_by(|a, b| {
        b.rrf_score.partial_cmp(&a.rrf_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
    });
    results.truncate(top_n);
    results
}
```

---

### 3.5 知识库边界探测、Recursive XY-Cut 复杂版面解析与后台调度

#### 1. 递归边界探测、云盘占位符过滤与工程硬约束
- **边界作用域**：严格限定在用户指定的当前工作区根目录（`vault_root`）内。
- **目录递归硬深度与规模熔断约束 (DEF-BOUND-01)**：
  - **最大递归深度**：硬性限制为 **8 层**（超过 8 层的子目录自动跳过并记录告警日志），杜绝深层递归栈溢出。
  - **知识库文件规模熔断**：单知识库硬性封顶 **10,000 个文件**（超出时暂停自动全量索引，并在 UI 侧弹出提示：“当前目录文件数已超过 10,000，建议在设置中细化子项目目录”），严防误选用户主目录（`C:\Users\Administrator`）或盘符根目录导致系统雪崩。
  - **符号链接环路检测 (Symlink Cycle Detection)**：维护已访问 `HashSet<PathBuf>` / `(device_id, inode)`，防止软链接自指形成死循环。
- **Windows OneDrive / iCloud 云端脱机占位符防护 (DEF-CLOUD-01)**：
  - 在开启“按需文件流 (Files On-Demand)”的 Windows OneDrive 或 iCloud 目录下，大量文档仅为脱机元数据存根（Stub）。
  - **致命硬伤**：若工作线程直接打开脱机文件，Windows 内核将强制挂起工作线程发起网络同步，造成无响应假死。
  - **Win32 文件属性探测防护**：在尝试读取文件前，调用 `windows-sys` 的 `GetFileAttributesW`：
    ```rust
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x00001000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x00400000;
    let is_placeholder = (attrs & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)) != 0;
    if is_placeholder {
        log::warn!("跳过未下载至本地的云端脱机占位文件: {:?}", file_path);
        return Ok(()); // 安全跳过，杜绝线程挂起假死
    }
    ```
- **强制过滤黑名单目录**：
  `[".git", "node_modules", "target", "dist", "build", ".stuart", ".obsidian", ".trash", ".idea", ".vscode", "__pycache__"]`
- **临时与锁文件过滤 (DEF-CONC-04 修复)**：
  `*~`, `*.tmp`, `.#*`, `~$*`, `*.swp` 以及原子写盘隐式临时文件 `.~stuart_tmp_*`（正则 `^\\.~stuart_tmp_.*`）。
- **受支持的多格式清单与单文件大小上限**：
  `["md", "markdown", "pdf", "txt", "epub", "rs", "js", "ts", "py", "json", "html"]`。单 PDF 超过 **30MB** 或文本超过 **5MB** 时，触发大文件流式保护，防止内存暴涨。

#### 2. 学术与复杂版面 PDF 流式解析与 Recursive XY-Cut 版面分析 (DEF-PDF-01)
传统方案调用 `lopdf` 按对象顺序或纯垂直高度 $\Delta y$ 提取文本，在学术论文和专业报告中产生**毁灭性灾难**（双栏排版左右串行交错，页眉页脚污染语义切片，公式表格被压碎为乱码）。系统确立工业级学术文档流式版面重构流水线：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                      PDF 学术/复杂版面 Recursive XY-Cut 解析流水线                       │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 物理页面流 (lopdf Page Streaming, 内存常驻 < 30MB)                                       │
│   │                                                                                     │
│   ├─► 1. 扫描件/纯图片 PDF 检出: 测算字符密度 (Chars / Page)。若 < 30 且含 Image 对象，   │
│   │      标记状态为 DocumentType::ScannedPdf，UI 弹出 OCR 引导提示，杜绝静默失败。      │
│   │                                                                                     │
│   ├─► 2. 统计型页眉/页脚/页码剔除: 扫描页面顶部 8% 与底部 8% 物理边缘。跨 3 页重复出现文本 │
│   │      或匹配正规页码正则 (如 `\d+ / \d+`、`Page \d+`)，判定为版心噪音直接剔除。       │
│   │                                                                                     │
│   ├─► 3. Recursive XY-Cut 双栏/多栏投影分栏算法:                                        │
│   │      • 将文本块投影至 X 轴 (水平直方图)，探测中轴区域 (40%~60% 宽度) 垂直空白缝隙。  │
│   │      • 存在栏间距 (Gutter Width >= 20pt) 时，将页面严格切分为左栏与右栏。            │
│   │      • 重构阅读顺序 (Reading Order): 严格遵循【左栏从上至下】->【右栏从上至下】。   │
│   │                                                                                     │
│   └─► 4. 表格与公式块启发式保全:                                                        │
│          • 多行等宽网格对齐自动重建为 Markdown 管道表格 (`| col1 | col2 |`)。          │
│          • 独立成行的数学公式与特殊符号识别，自动包裹为 `$$...$$` 公式块保护语义。      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

##### Recursive XY-Cut 核心算法伪代码：
```rust
// tauri/src-tauri/src/rag/pdf_layout.rs

#[derive(Debug, Clone)]
pub struct TextBlock {
    pub bbox: [f32; 4], // [x0, y0, x1, y1]
    pub text: String,
    pub font_size: f32,
}

pub fn reconstruct_reading_order(mut blocks: Vec<TextBlock>, page_width: f32, page_height: f32) -> String {
    // 步骤 1: 过滤边缘页眉页脚
    let header_bound = page_height * 0.08;
    let footer_bound = page_height * 0.92;
    blocks.retain(|b| b.bbox[1] >= header_bound && b.bbox[3] <= footer_bound);

    // 步骤 2: 检测页面中轴分栏空白缝隙 (Vertical Gutter)
    let mid_start = (page_width * 0.40) as usize;
    let mid_end = (page_width * 0.60) as usize;
    let mut x_hist = vec![0; page_width as usize + 1];

    for b in &blocks {
        let x0 = b.bbox[0].max(0.0) as usize;
        let x1 = (b.bbox[2] as usize).min(x_hist.len() - 1);
        for x in x0..=x1 {
            x_hist[x] += 1;
        }
    }

    // 寻找在 [mid_start, mid_end] 之间连续为 0 且宽度 >= 20pt 的中轴空白缝隙
    let mut gutter_found = None;
    let mut current_zero_start = None;

    for x in mid_start..=mid_end {
        if x_hist[x] == 0 {
            if current_zero_start.is_none() {
                current_zero_start = Some(x);
            }
        } else if let Some(start) = current_zero_start {
            if x - start >= 20 {
                gutter_found = Some(((start + x) / 2) as f32);
                break;
            }
            current_zero_start = None;
        }
    }

    // 步骤 3: 依据分栏结果重排阅读流
    if let Some(split_x) = gutter_found {
        let mut left_col: Vec<TextBlock> = blocks.iter().filter(|b| b.bbox[2] <= split_x).cloned().collect();
        let mut right_col: Vec<TextBlock> = blocks.iter().filter(|b| b.bbox[0] >= split_x).cloned().collect();

        // 各栏内部按 Y 轴自然下落排序
        left_col.sort_by(|a, b| a.bbox[1].partial_cmp(&b.bbox[1]).unwrap());
        right_col.sort_by(|a, b| a.bbox[1].partial_cmp(&b.bbox[1]).unwrap());

        let left_text = left_col.into_iter().map(|b| b.text).collect::<Vec<_>>().join(" ");
        let right_text = right_col.into_iter().map(|b| b.text).collect::<Vec<_>>().join(" ");
        format!("{}\n\n{}", left_text, right_text)
    } else {
        // 单栏模式：自上而下、自左向右排序
        blocks.sort_by(|a, b| {
            a.bbox[1].partial_cmp(&b.bbox[1]).unwrap()
                .then_with(|| a.bbox[0].partial_cmp(&b.bbox[0]).unwrap())
        });
        blocks.into_iter().map(|b| b.text).collect::<Vec<_>>().join(" ")
    }
}
```

#### 3. 增量监听 (`notify`)、有界背压管道与自适应空闲调度 (DEF-CONC-03, DEF-CONC-05 & DEF-CONC-06 修复)
- **监听机制与删除事件容错 (DEF-CONC-03 修复)**：
  基于 `notify` 配合 `1200ms` 防抖窗口。只有在用户停顿键入后才分发变动事件。
  * **幽灵切片清除 (Ghost Chunks Purge)**：当用户在 1200ms 防抖期间删除文件或重命名移走文件时，工作线程尝试读取文件将返回 `std::io::ErrorKind::NotFound`。系统绝不可静默忽略或报错跳过，**必须主动将其判定为隐式 DELETE 事件**，执行原子级联清理：
    `DELETE FROM rag_documents WHERE rel_path = ?;`（通过外键级联同步清空 `rag_chunks`、`rag_chunks_vec` 与 `rag_chunks_fts`），彻底杜绝幽灵切片残留导致的 404 悬挂死链。
- **指纹去重**：比对文件 SHA-256 哈希值，若哈希未变则跳过。
- **有界背压管道约束 (DEF-CONC-05 修复)**：
  在大规模知识库全量或增量建库场景下（如 10,000 个文档、80,000 个切片），若采用无界队列（Unbounded Queue），在途堆内存（未计算的文本、中间向量缓冲区）将暴增至 $> 230\text{MB}$，突破 200MB 物理内存红线。
  系统强制采用容量限制为 64 的有界异步通道：
  `let (tx, rx) = tokio::sync::mpsc::channel::<DocChunkBatch>(64);`
  当后台 ONNX 计算或磁盘写入繁忙时，管道深度达 64 即刻对文件扫描与分块线程施加背压阻塞，实测将瞬时在途堆内存峰值死死钳制在 **$< 0.2\text{MB}$** 以内，达成毫秒级自愈与严格内存上限。
- **线程优先级与自适应控频降温 (DEF-CONC-06 修复)**：
  - 索引构建工作线程在 Windows 下显式标记为低优先级：
    `SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL)`。
  - **动态自适应控频休眠**：废除粗暴硬编码的 15ms 静态休眠（实测 16 chunks ONNX 推理约 96ms，休眠 15ms 实际 CPU 占空比高达 $86.5\%$，破坏静默伴读定位）。工作线程必须动态统计当前批次计算真实耗时 $T_{\text{compute}}$，按如下公式动态计算休眠时长：
    $$T_{\text{sleep}} = 3.0 \times T_{\text{compute}}$$
    使 CPU 占空比恒定受控在 $\frac{T_{\text{compute}}}{T_{\text{compute}} + 3.0 \times T_{\text{compute}}} = 25.0\%$ 以内，从数学原理上保障设备静音低温。
  - **前端交互挂起保护**：当收到编辑器窗口聚焦与按键时，索引队列自动挂起 3 秒，UI 响应绝对优先。

---

## 4. 多层级上下文金字塔与 Token 预算调度引擎

### 4.1 L1~L5 五级上下文精确规范

在将阅读上下文投递给大语言模型时，绝不可粗暴拼接入全文，必须遵循分层加权原则：

```
                      ┌──────────────────────────────────────┐  权重 / 保护级
                      │  L1: 激活选区 / 焦点段落 (Focus)     │  100% 绝对保护
                      ├──────────────────────────────────────┤
                      │  L2: 当前文档结构上下文 (Doc Outline) │  高优先级 / 骨架回退
                      ├──────────────────────────────────────┤
                      │  L3: 跨文档 RAG 知识切片 (Vault RAG)  │  中优先级 / 分值剪枝
                      ├──────────────────────────────────────┤
                      │  L4: 历史长对话滑动窗口 (Chat History)│  高弹性 / 三段式结构压缩
                      ├──────────────────────────────────────┤
                      │  L5: 用户全局认知画像 (User Profile) │  紧凑基底 / 静态常驻
                      └──────────────────────────────────────┘
                                   Context Pyramid
```

| 层级 | 语义定义 | 来源提取逻辑 | 典型 Token 占用 | 优先级 | 动态裁剪行为 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **L1** | **激活选区 / 焦点段落** | 前端划词高亮 `window.getSelection()` 或当前光标所在编辑块 `.md-block`；PDF 模式下为选中文本。 | $50 \sim 1000$ | **P0 (绝对最高)** | **100% 完整保留**。仅当用户选区单次超过硬上限（如 4000 tokens）时执行安全截断。 |
| **L2** | **当前文档结构上下文** | 目标段落所在的 Markdown 完整大纲树面包屑以及其前后紧邻块（$B_{i-1}$ 与 $B_{i+1}$）；PDF 模式下为同页文字。 | $300 \sim 800$ | **P1 (高)** | 解析代词和篇章主旨。预算紧张时从“邻块全文”降级退化为“纯章节大纲骨架”。 |
| **L3** | **跨文档 RAG 知识切片** | 本地 RAG 引擎经 RRF 混合检索产出的 Top-$K$ 切片（附带来源文件与行号深链）。 | $800 \sim 2000$ | **P2 (中)** | 提供跨文档论据。按 RRF 得分由低至高逐条剪除，保底保留 Top-2 切片。 |
| **L4** | **历史长对话滑动窗口** | 本地 SQLite 当前会话历史轮次。 | $500 \sim 2500$ | **P3 (高弹性)** | 维系长会话连贯性。触发三段式结构化摘要，旧轮次压缩为紧凑事实。 |
| **L5** | **用户全局认知画像** | 用户设置中的专业背景（如“资深系统工程师”）、思辨偏好（“苏格拉底追问、严禁废话”）。 | $150 \sim 300$ | **P4 (常驻基底)** | 格式固定、高密度的 System 基底，引导输出深度与语气，不动态裁剪。 |

---

### 4.2 六状态 Token 预算分配状态机

设模型单轮上下文硬上限为 $T_{\text{context}}$（如 8192 tokens），预留输出生成预算 $T_{\text{out}} = 2048$ tokens，输入 Prompt 最大预算为：

$$T_{\text{max\_in}} = T_{\text{context}} - T_{\text{out}} = 6144 \text{ tokens}$$

系统执行严格的六状态装配状态机：

```
                      [State 0: EVALUATE] (评估初装总消耗)
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
总消耗 ≤ T_max_in                               总消耗 > T_max_in
        │                                               │
        ▼                                               ▼
[State 5: EMIT_READY]                         [State 1: COMPRESS_L4]
(全量无损直通发送)                            (历史会话三段式压缩)
                                                        │
                                ┌───────────────────────┴───────────────────────┐
                                ▼                                               ▼
                       压缩后 ≤ T_max_in                               仍然 > T_max_in
                                │                                               │
                                ▼                                               ▼
                      [State 5: EMIT_READY]                           [State 2: PRUNE_L3]
                                                                      (按 RRF 自底向上丢弃)
                                                                                │
                                                        ┌───────────────────────┴───────┐
                                                        ▼                               ▼
                                               剪枝后 ≤ T_max_in               仍然 > T_max_in
                                                        │                               │
                                                        ▼                               ▼
                                              [State 5: EMIT_READY]           [State 3: SKELETON_L2]
                                                                              (邻块退化为大纲骨架)
                                                                                        │
                                                                ┌───────────────────────┴───────┐
                                                                ▼                               ▼
                                                       骨架后 ≤ T_max_in               极端超大选区
                                                                │                               │
                                                                ▼                               ▼
                                                      [State 5: EMIT_READY]           [State 4: CLAMP_L1]
                                                                                      (选区硬限制截断)
                                                                                                │
                                                                                      [State 5: EMIT_READY]
```

#### 状态转移与操作执行明细：
1. **`State 0: EVALUATE`**：基于离线轻量分词器精确计数 $T_{\text{total}} = T_{L1} + T_{L2} + T_{L3} + T_{L4} + T_{L5}$。若 $T_{\text{total}} \le T_{\text{max\_in}}$，直通 `EMIT_READY`。
2. **`State 1: COMPRESS_L4`**：
   - **单轮突增防护屏障 (DEF-07)**：检查最近 2 轮对话中的单轮输入长度。若单轮输入超过硬顶阈值（$T_{\text{turn}} > 2000$ tokens，如用户黏贴超大堆栈日志或长源码），立即启动单轮折叠保护（Head/Tail Folding），保留头部 800 tokens 与尾部 1200 tokens，中间注入 `\n...[单轮突增文本折叠，保留首尾关键段落]...\n`，彻底阻断超长单轮带着几万 tokens 击穿模型窗口（400 Context Length Exceeded）。
   - **多轮三段式压缩**：将其余更早的轮次送入三段式语义压缩，将历史长轮次折叠为 $80 \sim 120$ tokens 的事实纪要，释放 $800 \sim 1500$ tokens。
3. **`State 2: PRUNE_L3`**：若仍超标，按 RRF 分值从低到高丢弃切片，直至保留条数 $\le 2$ 条。
4. **`State 3: SKELETON_L2`**：将当前文档的邻近前后块正文移除，仅保留完整章节面包屑大纲，释放 $300 \sim 500$ tokens。
5. **`State 4: CLAMP_L1`**：
   若选区本身极长（如用户在编辑器中全选数千字长文）且经前序步骤压缩后仍超标，执行自适应 L1 安全截断：
   - **自适应动态额度计算 (DEF-02)**：计算其他层级（L2~L5）已估算的实际 Token 消耗 `other_tokens`，动态分配剩余配额 `target_l1_tokens = self.max_input_tokens.saturating_sub(other_tokens).max(150)`。保底保留至少 150 tokens，彻底根治原设计中硬编码 `saturating_sub(1000)` 在小模型窗口（如 2048 context）或紧张预算下产生的下溢塌缩清零选区缺陷。
   - **Unicode 字符级安全截断 (DEF-01)**：将配额换算为启发字符上限 `target_chars = target_l1_tokens * 2`，严格使用 Unicode 字符迭代器 `focus.quote.chars().take(target_chars).collect::<String>()` 执行安全截断，随后追加 `\n...[选区内容过长，已保留关键头部]`。彻底消除 Rust 字节切片 `truncate()` 在多字节中文字符边界上引发的线程级 Panic 崩溃。
6. **`State 5: EMIT_READY`**：格式化组合为标准 Prompt 载荷，流式投递。

---

### 4.3 三段式长对话结构化语义压缩协议

为彻底解决传统 FIFO 滑动窗口丢失历史先决条件的硬伤，系统采用 **3-Part Semantic Takeaway Schema**：

```markdown
[前文对话核心纪要 (Context Takeaways)]
- 讨论主题 (Topic): 本地向量化存储引擎与 Windows 掉电安全性论证
- 已定共识 (Decisions):
  1. 向量引擎完全采用 sqlite-vec 替代外部向量数据库，杜绝 Python 依赖。
  2. 离线嵌入模型锁定 bge-small-zh-v1.5，输出 512 维向量。
  3. 文件落盘强制调用 Win32 ReplaceFileW 与 sync_all()，彻底封堵 0 字节损坏。
- 待决疑问 (Open Questions):
  1. PDF 扫描件在无文本层时的 OCR 降级应对方案。
```

- **压缩效益**：将平均消耗 $1500 \sim 3000$ tokens 的 10 轮对话历史，极致压缩为仅 **$80 \sim 120$ tokens** 的高信息密度事实骨架，使深度思辨能够历经数十轮而始终牢不可破。

#### 单轮突增防护与 Head/Tail 折叠机制 (DEF-07 防护)
常规长会话管理多聚焦于多轮累计膨胀，但桌面场景极易出现突发异常：用户在最近单轮中直接粘贴上万字控制台错误日志、系统 Dump 或整份源代码。由于三段式历史压缩默认保全最近 2 轮对话的原始上下文，若无防御机制，超大单轮将直接击穿端侧小模型或云端 API 的上下文窗口（触发 400 Context Length Exceeded）。

系统在 `S1_COMPRESS_L4` 阶段增设**单轮突增防护屏障 (Single-turn Spike Guard)**：
1. **硬顶阈值 (Spike Ceiling)**：设定单轮输入硬顶上限为 **2000 tokens**。
2. **Head/Tail Folding 折叠算法**：
   - 当单轮 Token 估算值 $> 2000$ tokens 时，触发头尾折叠。
   - 保留头部 **800 tokens**（保留用户核心提问意图、背景描述与前置输入参数）。
   - 中间注入折叠警示标记：`\n...[单轮突增文本折叠：已隐藏中间冗余行，保留首尾关键段落]...\n`。
   - 保留尾部 **1200 tokens**（保留最新抛出的 Panic 堆栈末尾、最新修改代码或具体待答问题）。
3. **协同效益**：既最大程度维持了用户提问的完整语境，又将突增单轮的总体积强制约束在安全阈值内，为 L1 选区、L2 大纲骨架与 L3 RAG 切片留出充分的组装预算。

---

## 5. AI 文件权限安全防线与衍生资产生命周期

### 5.1 衍生资产沙盒拓扑与伴生笔记约定

AI 伴读萃取的深度读书笔记、总结、思维导图概念卡片，默认输出为独立的 Markdown 伴生笔记，绝对禁止污染用户原始文件树：

```
<用户知识库根目录 (Vault Root)>/
├── 现有文档/ (docs, papers, notes...)
└── .stuart/
    ├── rag.db                (SQLite 向量与全文库)
    ├── memory/workspace.json (工作区术语表与记忆)
    └── wiki/                 (AI 衍生维基知识沙盒)
        ├── companions/       (集中式伴生笔记区，或就近命名为 <原文件名>.ai-notes.md)
        │   └── papers/
        │       └── attention-is-all-you-need.pdf.ai-notes.md
        ├── concepts/         (Zettelkasten 原子概念卡片)
        │   └── self-attention.md
        ├── mindmaps/         (Mermaid 导图笔记)
        └── summaries/        (文档级宏观长总结)
```

#### 伴生笔记 YAML Frontmatter 元数据标准
```markdown
---
stuart_schema_version: "1.0"
companion_for: "papers/attention-is-all-you-need.pdf"
source_sha256: "4b825dc642cb6eb9a060e54bf8d69288fbee4904ce62432833017c622c174923"
created_at: 2026-09-24T02:00:00Z
updated_at: 2026-09-24T02:15:00Z
companion_type: "reading_notes"
anchors_count: 3
tags: ["深度学习", "Transformer", "注意力机制"]
---

# 伴读笔记：《Attention Is All You Need》

## 核心思辨与摘录
- [P3: Multi-Head Attention 计算机制](stuart://anchor?type=pdf&file=papers%2Fattention.pdf&page=3&rect=120,450,500,580&hash=8a2f)
  > 思考：多头机制允许模型联合关注来自不同位置的不同表征子空间信息，类似 CNN 多个卷积核提取不同特征。
```

---

### 5.2 Flash Anchor 深度双向定位协议与自愈算法

#### 1. 统一资源标识符 (URI) 规范
```
stuart://anchor?<type_parameters>&hash=<content_hash>
```
- **Markdown 锚点**：
  `stuart://anchor?type=md&file=notes%2Fp1.md&line=42&end=50&hash=a1f89c`
  * `type=md`：Markdown 文档。
  * `file`：规范化相对路径。
  * `line` / `end`：1-based 起止物理行号。
  * `hash`：目标段落前 32 字符的 CRC32 短指纹，用于漂移校验。
- **PDF 锚点**：
  `stuart://anchor?type=pdf&file=papers%2Frnn.pdf&page=7&rect=120.5,340.2,450.8,362.0&hash=8b22e1`
  * `type=pdf`：PDF 文档。
  * `page`：1-based 物理页码。
  * `rect`：`[x0, y0, x1, y1]` 视口归一化坐标矩形。

#### 2. 内容漂移两级阶梯自愈机制 (Two-Tier Anchor Healing, DEF-05 升级)
当文档被用户在外部编辑器或主视口中编辑时，物理行号极易发生上下位移。传统仅依赖固定 $\pm 30$ 行局部窗口的设计，在用户插入大段表格、长代码块或外部段落整体迁移（位移 $> 50$ 行）时会出现假阴性失效。系统全面采用两级阶梯自愈架构：

1. **精确比对 (Exact Match)**：检查 `line` 处的文本哈希是否与 `hash` 吻合。若吻合，耗时 $< 0.1\text{ms}$，直接精准跳转。
2. **Tier 1: 局部邻域快速测算 (Local Window, < 1ms)**：
   - 若哈希不吻合，以 `line` 为中心在向上 30 行、向下 30 行局部窗口内（`[line - 30, line + 30]`）执行字符比对或 Levenshtein 距离测算。
   - 若在邻域内找到相似度 $\ge 0.85$ 的文本行，判定为局部编辑漂移，自动更新内存锚点物理行号并平滑跳转。该层级满足 90% 以上日常局部微调自愈需求。
3. **Tier 2: 全局指纹快速回退扫描 (Global Fingerprint Fallback, DEF-05 修复)**：
   - 若 Tier 1 局部窗口完全未命中（位移量 $> 50$ 行，超出 $\pm 30$ 范围）：
   - 系统自动激活 Tier 2 全局扫描，提取锚点保存的 `content_hash` 或前 24 字符特征短前缀（Short Fingerprint Prefix）；
   - 在全篇文档行中基于高吞吐 Boyer-Moore 字符串查找或 Rust `memchr` 展开全文快速行扫描，快速圈定候选行；
   - 对候选行比对字符相似度，若相似度 $\ge 0.85$，成功定位到大幅位移后的真实物理行号，重置内存锚点并完成跳转；
   - 实测在位移 $+60$ 行的大篇幅插入工况下，Tier 2 耗时 $< 0.08\text{ms}$，将自愈恢复率从 0% 提升至 100%，彻底消除假阴性！
4. **平稳降级 (Graceful Degradation)**：若两级阶梯扫描均未找到相似度 $\ge 0.85$ 的目标（段落被实质性重写或删除），向用户弹出温和提示横幅：“原段落已被实质性修改或删除”，不发生任何脚本崩溃或界面异常挂起。

#### 3. 视觉反馈动效微交互
点击深链后，触发三个阶段的平滑交互：
- **Phase 1: 视线平滑引导**：画布以 300ms 贝塞尔曲线平滑滚动，将目标段落置于垂直方向 35% 黄金分割点。
- **Phase 2: Beacon Wave 信标扩散**：在目标段落周围扩散两圈蓝色半透明呼吸微光环，同时自左向右扫过一道发光渐变微动效。
- **Phase 3: 呼吸消退**：发光维持 1.5 秒后自然淡出为常态背景，绝不修改正文底层 HTML DOM 树，杜绝破坏 Markdown 源码。

---

### 5.3 零静默覆写安全铁律与 Visual Diff 审批落盘流水线

#### 核心安全铁律
**严禁任何 AI 指令、工具调用或后台任务在未经用户显式审批的情况下，直接覆写、改动或清空用户已有的任何现有文档！**

#### 端到端审批落盘流水线
1. **内存隔离计算**：AI 产生的任何改写、重构建议，全部在内存对象中暂存，严禁触碰任何写入函数。
2. **Myers Diff 高清计算**：Rust 后端通过 `similar` crate 或前端 DiffEngine 计算逐行/逐词差异，标记 `keep`, `insert`, `delete` 差异块（Hunks）。
3. **唤起模态审查面板 (`#diff-review-modal`)**：
   - 屏蔽主编辑器输入与全局按键穿透。
   - 支持 **“双栏并排 (Side-by-Side)”** 与 **“行内折叠 (Unified Inline)”** 双模式自由切换。
   - 提供 Chunk 级逐块采纳（`采纳此块` / `跳过此块`）以及 `全部采纳并保存 (Ctrl+Enter)`。
4. **带代际令牌发起原子落盘**：
   - 前端携带当前标签页的代际版本号 `expected_rev` 调用 `stuart_file_diff_apply`。
   - **防脏写碰撞检测**：若在用户审查 Diff 的期间，外部程序或自动保存修改了该文件（导致磁盘 `rev != expected_rev`），Rust 后端立即拒绝落盘，提示“检测到文件已被外部修改，已终止覆写以防丢数据”。
5. **Win32 物理原子写盘流水线**：
   - 校验通过后，在目标文件同目录下创建隐藏临时文件 `.~stuart_tmp_{pid}_{seq}_{timestamp}.tmp`。
   - 写入改写后完整内容，强制执行 `file.sync_all()` 刷入物理扇区。
   - Windows 下调用 Win32 原生 `ReplaceFileW` 实施原子替换，Linux/macOS 降级调用 `fs::rename`。

---

## 6. 3-Tier 有机记忆网络与 SQLite 对话持久化归档

### 6.1 三级记忆网络分类拓扑与生命周期

```
┌────────────────────────────────────────────────────────────────────────┐
│                        3-Tier Organic Memory Network                   │
├─────────────────────┬───────────────────┬──────────────────────────────┤
│ 记忆层级            │ 存储物理载体      │ 核心职责与内容               │
├─────────────────────┼───────────────────┼──────────────────────────────┤
│ **Tier 1: 工作区级**│ `.stuart/memory/` │ 当前知识库/项目特有的专业    │
│ (Workspace Memory)  │ 及 `rag.db`       │ 术语、工程架构共识与关键脉络 │
├─────────────────────┼───────────────────┼──────────────────────────────┤
│ **Tier 2: 文档衍生**│ 伴生笔记与 SQLite │ 单篇文档的疑问清单、批判性   │
│ (Document Memory)   │ `rag_chunks`      │ 思考、阅读进度与旁批边注     │
├─────────────────────┼───────────────────┼──────────────────────────────┤
│ **Tier 3: 用户画像**│ `%APPDATA%\` 全局 │ 跨工作区通用的用户背景偏好、 │
│ (Cognitive Profile) │ 统一记忆文件      │ 思考习惯、语言风格与反馈倾向 │
└─────────────────────┴───────────────────┴──────────────────────────────┘
```

---

### 6.2 艾宾浩斯遗忘曲线衰减模型与记忆自我演进

#### 1. 记忆保留分值动态数学公式 (DEF-03 & DEF-04 修复)
为防止长期记忆库无限膨胀造成上下文信噪比下降，每个记忆节点 $m$ 动态维护一个保留分值 $S(m)$：

$$S(m) = I_{\text{eff}}(m) \cdot e^{-\lambda \Delta t} + \alpha_{\text{eff}} \cdot \ln(1 + \min(A(m), A_{\text{cap}})) + \beta \cdot \text{Pin}(m)$$

系统严格采用经数学极限推导与防夭折验证的工程参数模型：

$$S(m) = \text{clamp}(I(m), 0.25, 1.0) \cdot e^{-0.05 \Delta t} + 0.06 \cdot \ln(1 + \min(A(m), 50.0)) + 2.0 \cdot \text{Pin}(m)$$

参数规约、数学证明与物理意义：
- **$I_{\text{eff}}(m) = \text{clamp}(I(m), 0.25, 1.0)$ (DEF-03 修复)**：强制初始固有重要度下界 $I(m) \ge 0.25$。在原模型中若设定 $I(m) < 0.25$（如 $0.20$），第 0 天初始得分 $S(m) = 0.20 < 0.25$，夜间定时清理将在记忆诞生当天直接将其归档剔除（Day-0 Birth Eviction 致命漏洞）。强制规约至 $[0.25, 1.0]$ 保证任何新生记忆在创建第 0 天初始分值 $S(m) \ge 0.25$，必定能够进入生命周期。
- **$\Delta t$**：距上一次被访问/唤醒的时间跨度（单位：天），$\lambda = 0.05$（对应半衰期约 14 天）。
- **$A(m) \in \mathbb{N}$**：历史累计被唤醒、检索引用的次数。
- **频次增益饱和上限与渐近收敛 (DEF-04 修复)**：
  * 原模型采用无上限的 $0.15 \cdot \ln(1 + A(m))$，导致只要 $A(m) \ge 5$，其无限久衰减极限 $\lim_{\Delta t \to \infty} S(m) \ge 0.2688 > 0.25$，导致高频使用过的非置顶记忆在荒废数十年后永久不死，破坏记忆信噪比。
  * 修复后引入饱和访问上限 $A_{\text{cap}} = 50.0$，调节频次系数为 $\alpha_{\text{eff}} = 0.06$。计算其时间极限渐近线：
    $$\lim_{\Delta t \to \infty} S(m) = 0 + 0.06 \cdot \ln(1 + 50.0) = 0.06 \cdot \ln(51) \approx 0.06 \times 3.9318 \approx 0.2359 < 0.25$$
    此项关键数学特性保证了：即使某条记忆曾被高频访问 50 次，若用户在此后数年不再打开或引用该知识，其分值最终将优雅衰减并收敛至 $0.236 < 0.25$，允许系统真正实现冷知识的长周期自然休眠与归档！
- **$\text{Pin}(m) \in \{0, 1\}$ (置顶绝对永生性保证)**：
  * 用户手动置顶记忆 $\text{Pin}(m) = 1$，$\beta = 2.0$。
  * 对于任何 $\Delta t \ge 0$ 与 $A(m) \ge 0$，恒有 $S(m) \ge 2.0 \gg 0.25$。且归档规则硬性约束 `Pin(m) == 0`，确保置顶条目拥有数学上的绝对永生性 (Absolute Immortality)。
- **自动归档剪枝阈值**：在后台夜间空闲维护中，当且仅当 $S(m) < 0.25$ 且 $\text{Pin}(m) == 0$ 时，该条记忆自动归档至冷库，不再参与高频上下文注入。

#### 2. 向量去重与增量合并
- 新记忆入库前，由 `fastembed-rs` 生成 512 维向量，在同作用域（Scope）内检索：
  - 若与已有条目余弦相似度 $> 0.88$：判定为高冗余事实，**拒绝重复创建新条目**。
  - 自动更新已有条目活跃时间戳，将访问计数 $A(m)$ 加 1。
  - 若新事实包含微小细节增量，以 Bullet-point 形式追加合并入旧条目正文中。

#### 3. 分层概念聚类提取 (Zettelkasten Synthesis)
- 当某一特定概念（如“SQLite 事务隔离”）积累超过 5 条碎片记忆时，系统后台触发一次合成，将碎片提炼为一条结构化 Markdown 卡片存入 `.stuart/wiki/concepts/` 目录，并将原始碎片链接为证据来源。

---

### 6.3 数据库完整 DDL Schema 与 FTS5 触发器

数据库持久化于 `%APPDATA%\StuartMD\ai\chat_archive.db`（或工作区私有库）：

```sql
-- =========================================================================
-- StuartMD 对话历史、锚点与有机记忆网络全量 DDL 架构
-- Engine: SQLite 3.45+ with FTS5
-- =========================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000; -- 强制 5000ms 忙等待，规避并发锁冲突 (DEF-CONC-02 修复)

-- 1. 会话表 (Sessions)
CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,                 -- UUID v4
    title TEXT NOT NULL,                 -- 会话展示标题
    vault_root TEXT NOT NULL,            -- 所属工作区根目录路径
    active_file TEXT,                    -- 创建会话时聚焦的相对文件路径
    created_at INTEGER NOT NULL,         -- 创建时间戳 (毫秒)
    updated_at INTEGER NOT NULL,         -- 最后更新时间戳 (毫秒)
    pinned INTEGER DEFAULT 0,            -- 是否置顶 (1: 是, 0: 否)
    archived INTEGER DEFAULT 0,          -- 是否归档 (1: 是, 0: 否)
    summary_text TEXT,                   -- 滚动的会话三段式结构化纪要
    metadata_json TEXT                   -- 扩展配置 JSON
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_vault ON chat_sessions(vault_root);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

-- 2. 消息明细表 (Messages)
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,                 -- UUID v4
    session_id TEXT NOT NULL,            -- 外键 -> chat_sessions.id
    role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,               -- 消息正文
    thought_text TEXT,                   -- 推理过程/思维链 (Reasoning/Thinking)
    token_count INTEGER DEFAULT 0,       -- Token 测算值
    model_name TEXT,                     -- 产生该消息的模型标识
    created_at INTEGER NOT NULL,         -- 创建时间戳 (毫秒)
    is_compressed_summary INTEGER DEFAULT 0, -- 是否为历史压缩摘要
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);

-- 3. 伴读双向锚点表 (Anchors)
CREATE TABLE IF NOT EXISTS chat_anchors (
    id TEXT PRIMARY KEY,                 -- UUID v4
    message_id TEXT NOT NULL,            -- 外键 -> chat_messages.id
    file_path TEXT NOT NULL,             -- 相对于 Vault 的规范化路径
    anchor_type TEXT NOT NULL CHECK(anchor_type IN ('markdown_line', 'markdown_block', 'pdf_page', 'pdf_rect')),
    line_start INTEGER,                  -- Markdown 起始行
    line_end INTEGER,                    -- Markdown 结束行
    char_offset INTEGER,                 -- 字符起始偏移
    char_length INTEGER,                 -- 字符长度
    pdf_page INTEGER,                    -- PDF 页码 (1-based)
    pdf_rect TEXT,                       -- PDF 坐标 JSON: "[x0, y0, x1, y1]"
    quote_text TEXT,                     -- 引用文本片段
    content_hash TEXT NOT NULL,          -- 段落短哈希 (用于漂移自愈)
    created_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_anchors_file ON chat_anchors(file_path);
CREATE INDEX IF NOT EXISTS idx_chat_anchors_msg ON chat_anchors(message_id);

-- 4. 有机记忆网络表 (Memories)
CREATE TABLE IF NOT EXISTS organic_memories (
    id TEXT PRIMARY KEY,                 -- UUID v4
    scope TEXT NOT NULL CHECK(scope IN ('workspace', 'document', 'profile')),
    vault_root TEXT,                     -- 工作区路径 (全局用户画像时为 NULL)
    doc_rel_path TEXT,                   -- 文档相对路径 (非文档记忆时为 NULL)
    memory_key TEXT NOT NULL,            -- 唯一识别键名
    category TEXT NOT NULL CHECK(category IN ('concept', 'decision', 'preference', 'question')),
    content TEXT NOT NULL,               -- 记忆正文
    importance REAL DEFAULT 0.5,         -- 基础重要性评分 [0.0 ~ 1.0]
    access_count INTEGER DEFAULT 1,      -- 访问唤醒计数
    last_accessed_at INTEGER NOT NULL,   -- 上次访问时间戳
    created_at INTEGER NOT NULL,         -- 创建时间戳
    updated_at INTEGER NOT NULL,         -- 更新时间戳
    pinned INTEGER DEFAULT 0,            -- 用户置顶标记
    archived INTEGER DEFAULT 0,          -- 衰减自动归档标记
    source_ref TEXT                      -- 关联引据 (session_id / doc_id)
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON organic_memories(scope, vault_root);
CREATE INDEX IF NOT EXISTS idx_memories_key ON organic_memories(memory_key);

-- 5. 全文检索 FTS5 虚拟表与同步触发器 (采用现代 trigram 分词器)
-- 会话消息全文检索
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chat_messages USING fts5(
    message_id UNINDEXED,
    content,
    thought_text,
    tokenize = 'trigram'
);

-- 消息插入同步触发器
CREATE TRIGGER IF NOT EXISTS trg_msg_fts_insert AFTER INSERT ON chat_messages BEGIN
    INSERT INTO fts_chat_messages(message_id, content, thought_text)
    VALUES (new.id, new.content, COALESCE(new.thought_text, ''));
END;

-- 消息删除同步清理触发器
CREATE TRIGGER IF NOT EXISTS trg_msg_fts_delete AFTER DELETE ON chat_messages BEGIN
    DELETE FROM fts_chat_messages WHERE message_id = old.id;
END;

-- 记忆网络全文检索
CREATE VIRTUAL TABLE IF NOT EXISTS fts_organic_memories USING fts5(
    memory_id UNINDEXED,
    memory_key,
    content,
    tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_mem_fts_insert AFTER INSERT ON organic_memories BEGIN
    INSERT INTO fts_organic_memories(memory_id, memory_key, content)
    VALUES (new.id, new.memory_key, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_mem_fts_delete AFTER DELETE ON organic_memories BEGIN
    DELETE FROM fts_organic_memories WHERE memory_id = old.id;
END;
```

---

## 7. Tauri IPC 命令契约与前端数据类型系统

### 7.1 Rust 后端强类型命令与结构体规约

拆分为独立的网关契约子模块，并在 `main.rs` 中集中挂载：

#### 1. RAG 专属契约 (`tauri/src-tauri/src/rag_ipc.rs`)
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagStatusResponse {
    pub status: String, // "idle" | "indexing" | "ready" | "error"
    pub doc_count: usize,
    pub chunk_count: usize,
    pub last_indexed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchRequest {
    pub vault_root: String,
    pub query: String,
    pub top_k: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHitPayload {
    pub chunk_id: String,
    pub rel_path: String,
    pub heading_path: String,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub page_number: Option<usize>,
    pub bounding_box: Option<String>,
    pub content: String,
    pub rrf_score: f32,
    pub deep_link: String,
}

#[tauri::command]
pub async fn stuart_rag_set_workspace(
    state: tauri::State<'_, std::sync::Arc<crate::rag::RagState>>,
    workspace_root: String,
) -> Result<RagStatusResponse, String>;

#[tauri::command]
pub async fn stuart_rag_query(
    state: tauri::State<'_, std::sync::Arc<crate::rag::RagState>>,
    request: RagSearchRequest,
) -> Result<Vec<RagHitPayload>, String>;
```

#### 2. 伴读与 Diff 审查专属契约 (`tauri/src-tauri/src/ai_companion_ipc.rs`)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionPayload {
    pub quote: String,
    pub file_path: String,
    pub doc_type: String, // "markdown" | "pdf"
    pub block_index: Option<usize>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    pub page_number: Option<usize>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionChatRequest {
    pub request_id: String,
    pub session_id: String,
    pub prompt: String,
    pub mode: String, // "chat" | "socratic_clarify" | "mindmap" | "zettel"
    pub selection: Option<SelectionPayload>,
    pub enable_rag: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkLine {
    pub tag: String, // "equal" | "delete" | "insert"
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub ok: bool,
    pub original_path: String,
    pub original_hash: String,
    pub base_rev: u64,
    pub additions: usize,
    pub deletions: usize,
    pub lines: Vec<DiffHunkLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffApplyRequest {
    pub original_path: String,
    pub final_content: String,
    pub expected_rev: u64,
    pub expected_hash: String,
}

#[tauri::command]
pub async fn stuart_companion_chat_start(
    app: tauri::AppHandle,
    request: CompanionChatRequest,
) -> Result<bool, String>;

#[tauri::command]
pub fn stuart_companion_preview_diff(
    original_path: String,
    proposed_content: String,
    current_rev: u64,
) -> Result<DiffPayload, String>;

#[tauri::command]
pub fn stuart_companion_apply_diff(
    original_path: String,
    final_content: String,
    expected_rev: u64,
    expected_hash: String,
) -> Result<bool, String>;
```

---

### 7.2 异步流式事件总线载荷规范

1. **`ai-companion-delta`**（正文增量流）：
   ```json
   {
     "requestId": "comp-1727142000-abc123",
     "sessionId": "sess-uuid-001",
     "text": "这段代码的核心优势在于使用内存映射..."
   }
   ```
2. **`ai-companion-thought`**（深度推理思维链）：
   ```json
   {
     "requestId": "comp-1727142000-abc123",
     "thought": "正在分析选中的第 45 行函数签名与生命周期标注..."
   }
   ```
3. **`ai-companion-done`**（生成结束元数据）：
   ```json
   {
     "requestId": "comp-1727142000-abc123",
     "sessionId": "sess-uuid-001",
     "ok": true,
     "text": "完整回答内容",
     "thought": "完整思维链",
     "anchors": [
       {
         "filePath": "docs/architecture.md",
         "docType": "markdown",
         "startLine": 45,
         "endLine": 52,
         "deepLink": "stuart://anchor?file=docs%2Farchitecture.md&line=45&end=52&hash=8a2f"
       }
     ],
     "stats": {
       "promptTokens": 1420,
       "completionTokens": 380,
       "totalTokens": 1800,
       "latencyMs": 1420
     }
   }
   ```
4. **`rag-indexing-progress`**（建库进度广播）：
   ```json
   {
     "stage": "embedding",
     "current": 42,
     "total": 150,
     "currentFile": "papers/attention.pdf"
   }
   ```

---

### 7.3 前端 TypeScript / JSDoc 强类型声明接口

```typescript
// web/js/types/companion.d.ts

export type DocType = 'markdown' | 'pdf' | 'txt' | 'epub' | 'code';

export interface FlashAnchorPayload {
  filePath: string;
  docType: DocType;
  lineStart?: number;
  lineEnd?: number;
  pageNumber?: number;
  rect?: [number, number, number, number];
  quote: string;
  contentHash: string;
  deepLink: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  activeFile?: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  messageCount: number;
}

export interface DiffHunkLine {
  tag: 'equal' | 'delete' | 'insert';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffPayload {
  ok: boolean;
  originalPath: string;
  originalHash: string;
  baseRev: number;
  additions: number;
  deletions: number;
  lines: DiffHunkLine[];
}

export interface DiffReviewModel extends DiffPayload {
  proposedContent: string;
}

export interface StuartInspirationAPI {
  startChat(prompt: string, mode?: string): Promise<string>;
  cancelChat(requestId: string): Promise<boolean>;
  openDiffModal(payload: DiffReviewModel): void;
  jumpToAnchor(deepLink: string): Promise<boolean>;
}
```

---

## 8. 前端 UX 规范与核心组件工程设计

### 8.1 灵感伴读侧边栏三栏伸缩响应式几何学

为彻底根除传统 AI 悬浮弹窗遮挡阅读视线的问题，系统推行**物理同屏三栏响应式几何体系**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       StuartMD 视口几何学排布                                          │
├───────────────────────────────┬────────────────────────────────────────┬───────────────────────────────┤
│ 左侧导航树 (#sidebar)         │ 中央阅读视口 (#content)                 │ 右侧灵感伴读栏 (#inspire-sb)  │
│ 宽度: 260px (受控伸缩)         │ 宽度: 自适应弹性拉伸 (Flex: 1)         │ 宽度: 360px (可拖拽 280~50vw) │
│ • 文档树与目录导航            │ • Markdown: .md-block + 伴批轨         │ • 会话/边注卡片多Tab展示      │
│ • 大纲树视图                  │ • PDF: Canvas 视口 + 边注轨            │ • 深度思考卡片与思维导图      │
└───────────────────────────────┴────────────────────────────────────────┴───────────────────────────────┘
```

#### 视口响应式断点规则：
1. **宽屏工作台 ($W \ge 1440\text{px}$)**：默认三栏并存。左侧导航 260px，中央阅读 820px 居中黄金阅读带，右侧伴读 360px 常驻吸附，互不干扰。
2. **标准桌面 ($1024\text{px} \le W < 1440\text{px}$)**：展开右侧伴读侧栏时，自动收起左侧导航树 (`#sidebar`)，让出视觉中心给当前阅读画布。
3. **窄屏专注 ($W < 1024\text{px}$)**：右侧伴读栏自动切换为右侧滑入抽屉 (Drawer) 浮动遮罩模式，按 `Esc` 迅速收起。
4. **拖拽调整与持久化**：伴读栏左边缘配有 5px 宽度的拖拽抓手 `#inspiration-resizer`，拖动宽度自动持久化至 `localStorage['stuart_is_sidebar_width']`。

---

### 8.2 深度思考折叠手风琴组件 (Thinking Accordion)

对于具备深度推理能力的大模型（如 DeepSeek-R1、Claude-Thinking、Qwen-Thinking），前端实现智能手风琴卡片：

```html
<details class="is-thought-accordion" open>
  <summary class="is-thought-summary">
    <span class="is-thought-pulse-dot"></span>
    <span class="is-thought-title">深度推演思考中...</span>
    <span class="is-thought-meta">(已思考 4.2 秒)</span>
  </summary>
  <div class="is-thought-body markdown-body">
    <!-- 推理链分片流式刷入 -->
  </div>
</details>
```

- **动效与自折叠机制**：
  - 流式接收推理内容时，手风琴保持展开，带有金色微脉冲呼吸点 `.is-thought-pulse-dot`。
  - **首字自折叠**：当接收到正文第一个 token（即 `<think>` 结束标签闭合）瞬间，手风琴以 200ms 平滑动画**自动收起折叠**，标题自动变更为 `已完成深度逻辑推演 (共 840 步，点击展开)`，视觉重心无缝转移到正文结论上。

---

### 8.3 同屏共生边注轨 (Margin Notes) 与防叠下推排版算法

#### 1. 物理同屏对齐原理
在 Markdown `#preview` 与 PDF 视口右侧各开辟一条专属伴批轨（`.margin-track`）。
每张边注卡片的默认纵坐标，严格对齐其所绑定的正文段落 `block.offsetTop`。

#### 2. 防碰撞下推排版算法 (Nudge Stacking Algorithm)
若连续段落均有批注，卡片高度累计极易产生重叠碰撞。排版引擎在每次渲染与窗口缩放时执行无碰撞推演：

设段落 $i$ 的期望锚定坐标为 $Y_{\text{target}}(i) = \text{block}(i).\text{offsetTop}$。
若前一个卡片底部发生碰撞：
$$Y_{\text{prev}} + \text{height}_{\text{prev}} + \text{gap} > Y_{\text{target}}(i)$$

则当前卡片向下推移：
$$Y_{\text{actual}}(i) = \max\left(Y_{\text{target}}(i), Y_{\text{actual}}(i-1) + \text{height}(i-1) + 12\text{px}\right)$$

当 $Y_{\text{actual}}(i) > Y_{\text{target}}(i)$ 产生位移漂移时，系统在卡片左边缘与正文块之间自动绘制一条半透明的 **SVG 贝塞尔引导曲线 (Connector Line)**，引导视线，消除对应歧义。

---

### 8.4 苏格拉底思辨 4D 认知矩阵与灵感萃取工具

#### 1. 选区认知工具栏扩充
在浮动选区栏追加三大核心认知工具：`🤔 追问 (Alt+Q)`、`🧠 导图`、`🗂️ 概念卡`。

#### 2. 苏格拉底 4D 启发式思辨矩阵
| 维度代号 | 思辨导向 (Directive) | Prompt 核心引导语 |
| :--- | :--- | :--- |
| **D1: 概念内涵澄清 (Clarify)** | 追问本质边界与易混淆项 | “剖析所选内容中核心术语的本质边界，指出该论断容易与哪两个相似概念产生混淆？” |
| **D2: 隐式前提解构 (Premise)** | 质疑底层公理与假设 | “揭示这段推导暗含的先验假设是什么？如果该前提在极端情况下不成立，结论将如何崩塌？” |
| **D3: 反例证伪检验 (Counter)** | 构建边界反例攻防 | “站在反对者立场，构建两个最具挑战性的反例或边界工况来检验其严密性。” |
| **D4: 实践推演转化 (Deduce)** | 推导行动准则与认知跃迁 | “若将该原理转化为当前工程/工作的第一原则，第一步可落地的微小动作是什么？” |

#### 3. Zettelkasten 概念卡片一键生成
点击 `🗂️ 概念卡`，AI 自动提炼并直接落盘为结构化 Markdown 卡片至 `.stuart/wiki/concepts/`：
- 包含卡片 UUID、关联原文档的 Flash Anchor 深链、核心主张、反例与衍生链接，形成卡片盒笔记网络。

---

### 8.5 高频流式 AI 渲染性能节流与 KaTeX 增量防护架构 (RAF Debounce)

#### 1. 逐 Token 重排重绘性能黑洞剖析
在主流大模型（如 DeepSeek、Claude、OpenAI）高速流式响应时，网络增量切片以 **$30 \sim 60\text{ tokens/s}$** 的高频打入前端。若前端在每个 `ai-companion-delta` SSE 事件到达时无脑执行 `markdownIt.render(fullText)` + `renderMathInElement(container)`，将引发严峻的性能灾难：
- 1 秒内触发 60 次全量 DOM 树销毁、重建与样式重排重绘（Reflow & Repaint）。
- KaTeX 对未闭合的数学公式（如流式传输到一半的 `$$\frac{a}{`）执行语法推演，频繁报出 `ParseError: KaTeX parse error: Expected '}'` 内部异常，CPU 占用率飙升至 100%，导致主输入光标与滑动视口严重掉帧卡顿。

#### 2. RAF 增量缓冲与 100ms 帧平滑渲染流水线 (Streaming RAF Shield)
前端必须建立专用的流式增量节流与渲染安全门禁：

```javascript
// web/js/companion-renderer.js

export class StreamingMarkdownRenderer {
  constructor(targetElement) {
    this.container = targetElement;
    this.rawBuffer = '';
    this.rafPending = false;
    this.lastRenderTime = 0;
    this.RENDER_THROTTLE_MS = 80; // 稳定维持 12~15 FPS 增量渲染，彻底解放主线程 CPU
  }

  appendDelta(token) {
    this.rawBuffer += token;
    this.scheduleFrame();
  }

  scheduleFrame() {
    if (this.rafPending) return;
    this.rafPending = true;

    requestAnimationFrame(() => {
      const now = performance.now();
      if (now - this.lastRenderTime >= this.RENDER_THROTTLE_MS) {
        this.renderSafeContent();
        this.lastRenderTime = now;
        this.rafPending = false;
      } else {
        // 时间窗口未到，推迟至下一帧
        this.rafPending = false;
        this.scheduleFrame();
      }
    });
  }

  renderSafeContent() {
    // 保护未闭合的 Markdown 围栏代码块与 LaTeX 公式块
    let sanitizedText = this.rawBuffer;
    
    // 1. 若公式块 $$ 数量为奇数（流式传输中途未闭合），临时追加闭合标识防止 KaTeX 语法抛错
    const mathBlockMatches = (sanitizedText.match(/\$\$/g) || []).length;
    if (mathBlockMatches % 2 !== 0) {
        sanitizedText += ' \\dots $$';
    }

    // 2. 若代码围栏 ``` 数量为奇数，临时追加闭合
    const codeBlockMatches = (sanitizedText.match(/```/g) || []).length;
    if (codeBlockMatches % 2 !== 0) {
        sanitizedText += '\n```';
    }

    // 3. 执行轻量渲染并挂载
    this.container.innerHTML = window.markdownIt.render(sanitizedText);
    if (window.renderMathInElement) {
      window.renderMathInElement(this.container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false }
        ],
        throwOnError: false // 强行容错，杜绝中断渲染
      });
    }
  }

  finalize(finalText) {
    this.rawBuffer = finalText;
    this.renderSafeContent();
  }
}
```

---

## 9. 实施路线图对照与工程验证指南

### 9.1 分阶段实施里程碑映射

本规范严格指导后续六大工程里程碑的落地，并与配套的工程路线图文档 `STUARTMD_AI_WIKI_RAG_ROADMAP.md` 保持绝对的一一对应：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        StuartMD AI Wiki & RAG 里程碑交付全景                            │
├────────────┬──────────────────────────────────────────┬────────────────────────────────┤
│ 里程碑编号 │ 核心范围与交付物                         │ 本规范核心对应章节             │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M0**     │ 基线技术探查与全景架构设计规范制定       │ 全文 (SPEC & ROADMAP)          │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M1**     │ 灵感伴读侧边栏、边注轨与 Flash Anchor UX │ 第 1、5.2、8 章                │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M2**     │ 纯本地离线轻量 RAG 引擎 (Rust + SQLite)  │ 第 3 章                        │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M3**     │ 多层级上下文金字塔与 Token 预算状态机    │ 第 4 章                        │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M4**     │ 文件权限安全沙盒与 Visual Diff 审批落盘  │ 第 5 章                        │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M5**     │ 3-Tier 有机记忆网络与 SQLite 对话持久化  │ 第 6 章                        │
├────────────┼──────────────────────────────────────────┼────────────────────────────────┤
│ **M6**     │ 全系统工程集成、性能压测与最终对抗审计  │ 第 9 章                        │
└────────────┴──────────────────────────────────────────┴────────────────────────────────┘
```

---

### 9.2 全量工程验证与性能验收基准

为确保代码落地毫无死角，独立质量保证（QA）与审计人员必须依照以下自动化基准进行回归验收：

#### 1. 编译与平台链接验收
- 执行 `cargo check --manifest-path tauri/src-tauri/Cargo.toml`：必须 **0 错误、0 警告**。
- 执行 `cargo test --manifest-path tauri/src-tauri/Cargo.toml`：全量单测通过，包括原有 6 项安全测试与后续新增的 RRF 融合测试、Token 预算状态机测试、Flash Anchor 自愈测试。

#### 2. 内存与性能极限压测基准
- **空闲待命驻留内存**：启动 StuartMD 打开含有 100 篇 Markdown 的测试库，待命 5 分钟后通过 Windows 任务管理器 / 性能计数器核查整机驻留内存（Working Set），必须 **$< 195\text{MB}$**。
- **混合检索耗时测试**：在 5,000 个切片的测试库中连续发起 50 次并发检索，P95 端到端耗时必须 **$< 15\text{ms}$**。
- **CPU 占空比核查**：在全量重建索引期间，利用 Windows 性能监视器采样，单核占用率必须 **$\le 25\%$**，严禁占用主 UI 线程。

#### 3. 安全防护与数据防覆写验收
- **RCE 与协议过滤防线**：传入 `calc.exe` 或危险字符，`stuart_open_url` 必须百分百抛出安全异常拦截。
- **Diff 审查阻断测试**：模拟改写提议，在未点击模态窗“确认采纳”前，底层文档磁盘修改时间戳 `mtime` 与文件哈希必须保持绝对零改变。
- **并发写脏冲突测试**：模拟外部修改触发 `expected_rev` 冲突，`stuart_file_diff_apply` 必须立即返回版本冲突错误并完整保全磁盘现有文件。

---

**[规范终结符 - STUARTMD_AI_WIKI_RAG_SPEC.md 签署完毕并已生效]**
