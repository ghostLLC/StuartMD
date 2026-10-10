# 3.5.11 验收

本次实际服务商范围为 DeepSeek。Kimi、Qwen、GLM 的在线接口验收没有包含在本次范围内。

软件源代码 SHA-256：`3b7c3ae892fbb4f3ec3a56802527fd6e11328fbd140079aa8f3e40ef126019dc`。该指纹覆盖前端、Rust、样例、依赖锁定文件和资源清单；每个验收脚本记录实际执行前后的指纹。

## 已运行的检查

| 检查 | 结果 | 实际证据 |
| --- | --- | --- |
| 前端文档状态、原文与写入协调 | 15 项通过 | `core-tests.log` |
| Rust 文档、SQLite、记忆、上下文及资源检查 | 63 项通过；5 项需要独立执行 | `core-tests.log` |
| 独立文档程序 | 11 项模块检查和 14 项集成检查通过 | `core-tests.log` |
| 多进程保存冲突 | 真实独立进程检测冲突，保留原文、本地及外部内容 | `core-tests.log` |
| 写入权限拒绝 | 真实 Windows ACL 拒绝写入，原文件及恢复内容保持完整 | `core-tests.log` |
| 保存期间终止进程 | 在 Preparing 阶段终止真实进程，持久化草稿恢复正确，未完成历史内容拒绝读取 | `core-tests.log` |
| Mermaid | 17 项实际 Edge 浏览器检查通过，包括中文、换行、多个图表类型、阅读与分栏、六种主题 | `browser-tests.log`、`mermaid-matrix.json`、`mermaid-current.png` |
| PDF.js | 实际中文与繁体中文 PDF、旋转、CropBox、真实选区、原生批注和本地资源通过 | `browser-tests.log`、`pdf-viewer-results.json` |
| 安装资源 | 版本、原生运行库、PDF.js、168 个 CMaps、16 个字体、tokenizer 文件指纹通过 | `version-resources.json` |
| 嵌入模型及索引 | 3 项真实模型、索引和 PDF 检查通过；独立 ONNX Runtime 参考计算通过；202 个真实文件进入索引 | `models-status.json`、`actual-models.json`、`actual-generations.json`、`actual-pdf.json` |
| DeepSeek | 实际模型 deepseek-flash、32 个流式片段、usage、来源摘要、在线取消及关闭 AI 检查通过 | `providers-status.json`、`actual-deepseek.json` |
| 本机安装及数据保留 | 3.5.10 升级到 3.5.11；安装包内的程序与实际安装文件指纹一致；19 项资源、15 个资料文件、4 个数据库和备份内容检查通过 | `installer-results.json`、`installer-tests.log` |
| 安装后的进程启动 | 在用户资料的独立副本中启动实际安装程序，进程及 WebView2 运行正常，数据库完整性通过 | `installer-results.json` |
| 原生界面完整操作 | 已安装程序的 WebDriver 会话建立超时；文件对话框、连续问答及多窗口操作未验收 | `native-status.json`、`native-ui-tests.log` |
| 公开发布 | 必要原生验收未完成，检查返回失败并阻止发布 | `publication-tests.log` |

## 审查编号验收范围

| 编号 | 当前实现与已有证据 | 仍需验证的操作 |
| --- | --- | --- |
| 01 | 文档身份、切换协调、异步渲染来源检查；前端文档模块通过 | 原生程序连续打开、关闭与切换文档 |
| 02 | UTF-8、UTF-16、GB18030、Big5、BOM、混合换行及不可表示字符检查通过 | 原生编码确认与文件对话框操作 |
| 03 | 单一保存服务、磁盘指纹、真实多进程冲突及版本副本检查通过 | 多个原生窗口同时编辑并保存 |
| 04 | 空文档、未保存文档、较新草稿、进程终止与真实权限检查通过 | 恢复界面操作；其余保存阶段的进程终止及实际磁盘空间耗尽 |
| 05 | 请求编号、消息顺序、完整回答指纹及真实 DeepSeek 流式接口 | 两个原生问答界面的事件显示与取消 |
| 06 | 完整回答持久化、消息幂等和文档来源检查通过 | 连续三次追问及重启后恢复会话的界面操作 |
| 07 | 真实在线生成期间关闭 AI，取消确认及后端拒绝新请求 | 两个问答界面的开关显示 |
| 08 | 实际 PDF 页面文本、页码、坐标和来源指纹 | 在原生程序中选择 PDF 文字并完成 DeepSeek 问答 |
| 09 | 有效记忆的确认状态、作用范围、版本与来源检查通过 | 原生记忆界面的编辑、确认及再次问答 |
| 10 | 会话、记忆、知识索引界面已调用实际服务 | 原生界面检索、跳转与来源显示 |
| 11 | 最终预算、协议余量、模型 tokenizer 和真实来源摘要检查 | 原生超长会话中的预算提示及修正保留 |
| 12 | 真实线程及独立进程创建 100 个会话，编号与数据库记录检查通过 | 无额外界面要求 |
| 13 | 更新记忆正文、类别、层级、FTS 与来源检查通过 | 原生记忆编辑界面操作 |
| 14 | 真实 BGE-M3 与多语言 MiniLM；独立参考计算及索引代际复核 | 原生模型选择和状态显示 |
| 15 | 真实 PDFium 坐标、旋转、CropBox、原生批注，以及真实 OCR | 原生选区与批注修改；低置信度页面提示 |
| 16 | 中文节点标签位于边框内，17 项浏览器检查通过 | 已安装程序中的图表显示 |
| 17 | 原文与未编辑换行完整保留，真实保存字节检查通过 | 原生连续输入、切换与保存 |
| 18 | 快捷键文档和前端行为已采用统一定义 | 已安装程序中实际键盘操作 |
| 19 | Cargo、配置、文档与运行时版本使用 3.5.11；实际安装文件版本已经核对 | 原生运行时接口 |
| 20 | PDF.js 与完整 CMaps、字体来自同版本资源，浏览器资源请求检查通过 | 已安装程序离线打开、复制与搜索中文 PDF |

## 发布条件

`scripts/verify-release.ps1 -Publication` 要求 Core、Browser、Native、Models、Providers、Installer 全部执行通过，并具有当前源代码指纹。

原生 WebDriver 的会话建立目前超时。原生文件对话框、两个问答界面、多窗口完整操作，以及隔离 Windows 环境的 3.5.10 到 3.5.11 升级尚未取得完整验收证据。公开发布检查继续阻止发布。

本机安装检查对原有程序和用户数据建立备份；SQLite 使用在线备份接口，包含已提交的 WAL 内容。结果仅记录文件指纹、数量和数据库完整性，密钥正文及私有文档正文保留在本机。

安装路径：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.11_x64-setup.exe`，SHA-256 为 `f5c8c73dc53542e946af2ce40dc4f7c1d0249f3a0d4cf7801ec7a968a4778ef9`。

实际安装程序 SHA-256：`6221f2e69f0781aa482f3b5823f5f0ef6a332be7a19d9eac4f26fb2f9f65d50c`。
