# StuartMD 3.5.12 验证与安装

日期：2026-10-15。

源码指纹：`bc3461579f60a6d14427ee1038a3edf715ab110ed36ad812736703c96c570d10`。

## 功能与数据

问答、知识、记忆和会话页面使用共享问答状态。提问支持选区、章节或页面、整篇文档和独立工作区目标；明确引用核对实际来源、版本、内容和容量。快速问答与完整面板共享输入和归档答案。

文档及工作区草稿分别保存。请求按照实际 draftId 和版本取得材料；首次保存迁移持久身份，另存为保留原会话归属。其他窗口修改草稿时保留双方内容，提供读取已保存草稿或将当前输入保存为新会话的处理入口。

PDF 选区按实际页面分别保存文字、坐标和文件指纹，连续页面逐项核验。归档消息及摘录归属当前用户的本机档案；打开物理来源时继续核对窗口权限、文件存在性和指纹。

记忆采用稳定 recordId 和不可覆盖的版本。读取已有记忆与整理新记忆分别设置；自动整理独立计数并保留来源，需要确认的记录进入候选列表。会话支持搜索、分页、恢复、修改名称和协调删除。单实例启动阶段恢复异常退出遗留的问答、整理和删除状态，保留已经归档的真实内容。

## 实际检查

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 前端核心模块 | Passed | 15 项实际检查 |
| 伴读脚本与资源 | Passed | 10 个脚本语法、CSS、实际示例公式与 Mermaid 源码、无效公式终止、未知来源协议 |
| Rust 主程序 | Passed | 76 项通过；6 个独立模型、接口及子进程入口由对应检查执行 |
| 文档独立程序 | Passed | 11 项真实文件、编码、保存、恢复与 PDF 检查 |
| 实际进程检查 | Passed | 14 项真实文件、权限、中断保存及进程间检查 |
| SQLite 共享状态 | Passed | 两个订阅取得相同序列，持久身份迁移、会话版本与冲突内容保留 |
| 模型与 PDF | Passed | 3 项真实 ONNX、独立参考向量、索引、PDFium、OCR、旋转、裁剪与来源检查 |
| 本轮 DeepSeek 接口 | Failed | 首次流式请求等待 304.97 秒后发生传输中断；官方确认同期 API 故障 |
| 版本与安装资源 | Passed | 3.5.12、PDF.js、PDFium、OCR 和 tokenizer 指纹 |
| 静默安装 | Passed | 3.5.11 升级为 3.5.12，安装包内容及 19 项资源核对通过 |
| 用户数据保留 | Passed | 16 个文件、5 个数据库、92 条记录保持一致 |
| 窗口、浏览器、视觉及安装后启动 | SkippedByUser | 用户禁止 computer use，允许跳过依赖界面的检查 |

Core 和 Models 的记录具有上述源码指纹。Providers 保留 Failed；公开发布检查继续要求全部必要检查通过。

DeepSeek 官方故障记录：[2026-10-15 网页与 API 部分中断](https://status.deepseek.com/incidents/7116348214287)。页面显示 Flash API 受到影响，官方正在处理。确认该状态后停止重复在线验收。历史真实接口结果保存在 `actual-deepseek-2026-10-14.json`，其内容包含实际回答、来源、用量、整理候选、摘要、取消和关闭 AI 的结果；该文件属于 10 月 14 日的实施检查。

## 安装文件

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.12_x64-setup.exe`。

安装包 SHA-256：`ef0c8ce5d696c0367f5c419a8288451bbc4fbd9e61234849993891aed8db5592`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，版本 `3.5.12`。安装后的程序 SHA-256 为 `fca7194b2eb35d3d6ed0a80eb3e6a675bd3f958b0af68b91aac7e4bc6f4c9017`，与安装包中的程序一致。Tauri 按安装包类型处理可执行程序，独立 release 程序指纹记录在 `build-results.json`。

安装过程保留本机资料并取得 SQLite 一致性备份，未启动软件窗口。备份目录见 `installer-results.json`。

## 复核命令

```powershell
pwsh -NoProfile -File scripts/verify-companion-release.ps1
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
pwsh -NoProfile -File scripts/verify-release.ps1 -Publication
```

公开发布命令在必要在线验收失败或界面检查跳过时返回失败。仓库源码提交与本机安装结果单独记录。
