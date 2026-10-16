# StuartMD 3.5.14 验证与安装

交付日期：2026-10-16。

源码指纹：`b01ad29aeee53048941784d3195ff04cdad1cb43cfe77b129c2e739c9a6c2ff6`。

伴读的知识页面自动使用 BGE-M3 建立语义索引。用户打开工作区后可以直接建立索引或搜索资料，索引详情显示检索模型及文件处理结果。

工作区保存的模型配置统一为 BGE-M3，并在重新读取后保持一致。已有索引使用其他模型时，标记需要更新；搜索前按当前配置建立新索引。新索引通过实际向量查询及数据库校验后发布，更新失败或取消时保留原索引文件。旧索引的模型身份及向量维度保持完整。

问答使用的 AI 模型列表继续保留，知识检索模型由软件统一管理。欢迎文档、示例文档及 README 使用相同操作说明。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 工作区模型持久配置 | Passed | 实际 SQLite 保存历史配置、统一为 BGE-M3、关闭后重新读取并核对数据库值 |
| 前端模块 | Passed | 24 项，包括 Mermaid 选区格式限制 |
| 伴读脚本与资源 | Passed | 13 个脚本语法、CSS、实际示例公式与 Mermaid 源码 |
| Rust 主程序 | Passed | 81 项通过；10 个独立文件、模型及在线入口分别执行 |
| 文档及独立进程 | Passed | 11 项与 14 项真实文件、权限、保存、恢复和 PDF 检查 |
| AI 配置及共享状态 | Passed | 真实配置副本、DPAPI 凭据、独立进程、编辑输入保留及 SQLite 会话状态 |
| 模型与 PDF | Passed | 3 项真实 ONNX、参考向量、索引模型变更、取消、来源变化、PDFium、OCR、旋转和裁剪检查 |
| DeepSeek 在线接口 | Passed | 两个型号、真实回答与用量、生成期间切换、归档、摘要、记忆整理、取消和禁用；10.26 秒 |
| 版本及资源 | Passed | 3.5.14、模型目录、PDF.js、PDFium、OCR 和 tokenizer 指纹 |
| 静默安装 | Passed | 3.5.13 升级为 3.5.14，安装包内程序及 20 项资源核对一致 |
| 用户资料保留 | Passed | 30 个文件、6 个数据库及 225 条记录保持一致 |
| 窗口、浏览器、视觉及安装后启动 | SkippedByUser | 按用户要求跳过 computer use 相关检查 |

Core、Models 和 Providers 的状态文件均对应上述源码指纹，实际运行时间记录在各文件内。其他服务商的在线接口未执行验收。

独立代码审查已完成，知识模型配置、历史索引保留、向量维度及前后端调用检查通过。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.14_x64-setup.exe`，大小为 86,913,360 字节，SHA-256 为 `3eb5a6c4c3a63e7794b7d4f162c978e7068f5cc9b147f67481368a8641c692af`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，实际文件版本为 `3.5.14`，SHA-256 为 `2e4d5ce80d33a3a2afb23feb8782337acce9653dc6a02bd162e5feaa9991d564`，与安装包内程序一致。安装后保持程序关闭。

原安装目录及用户资料备份：`tests/native-artifacts/installer-addd96d1-fdc6-4e97-a4b9-71f8ea51012b`。详细结果见 `build-results.json` 和 `installer-results.json`。

复核命令：

```powershell
pwsh -NoProfile -File scripts/verify-companion-release.ps1
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
```
