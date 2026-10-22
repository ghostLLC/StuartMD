# StuartMD 3.5.20 验收

阅读和分栏模式支持鼠标跨段选择。鼠标按下时暂时解除活动段落及表格单元格的编辑边界，鼠标松开后恢复段落内编辑，或提交跨段选择涉及的活动编辑。提交后按照文字变化恢复选区及选择方向，段落边界和排版替换保持明确的起止位置。

Ctrl+A 根据当前选区选择本段；本段已经全部选中时选择全文。重复按键保持全文选区。源码区域、搜索和设置输入框使用各自的全选行为。代码和 Mermaid 的局部源码编辑先选择编辑区域，再扩展到全文。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 选择专项 | Passed | 12 项 DOM 检查：连续全选、手动全选、反向选择、富文本段落、跨段、跨单元格、节点替换、段落边界、窗口失焦、排版替换、输入框和局部源码 |
| 前端回归 | Passed | 42 项，包含选择专项，以及文档状态、阅读位置、换行、格式限制与文件写入 |
| 文件目录 | Passed | 6 项真实目录扫描与前端状态检查 |
| Rust 主程序 | Passed | 86 项通过，10 项具有独立验证入口的检查默认忽略 |
| 文件与进程 | Passed | 11 项文件检查及 14 项实际多进程检查 |
| 配置与草稿 | Passed | 真实配置副本的迁移和原子修改，以及实际 SQLite 草稿数据检查 |
| 版本和资源 | Passed | 3.5.20 版本、PDF 与原生资源校验 |
| 代码审查 | Passed | 选择控制、端点映射、事件顺序及全文选择范围 |
| 构建和安装 | Passed | 3.5.19 静默升级至 3.5.20；本机程序与安装包内程序一致，20 项资源核对通过 |
| 用户资料 | Passed | 32 个文件、6 个数据库及 260 条记录保持一致 |
| 文件图标 | Passed | Windows Markdown 文件关联继续使用安装目录中的 `file-md.ico` |
| 模型和资料 | Passed | 独立 Python ONNX 参考计算及 3 项真实 Rust 检查，覆盖语义向量、索引生成与取消、PDFium 和 OCR |
| DeepSeek 在线接口 | Passed | 实际配置副本与真实接口，覆盖流式回答、预算、摘要、取消及停用行为 |
| 窗口交互 | SkippedByUser | 用户禁止 computer use；未启动应用或浏览器执行交互验证 |

DOM 检查使用 jsdom 的实际 Range 和 Selection，并通过 DOM 节点重建验证端点恢复。该检查不提供浏览器原生拖选、contenteditable 焦点或应用整体提交过程的运行证据。文件保存和撤销相关的底层行为由现有前端、Rust、文件及进程检查覆盖。

回归命令：

```powershell
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Core
node scripts/verify-release.cjs
pwsh -NoProfile -File scripts/prepare-resources.ps1 -VerifyOnly
```

回归日志：`tests/native-artifacts/selection-3.5.20-core.log`。

源代码指纹：`5b3a7533ccf3b794e9b38af686c06fff625ace46882ddb5c5a15f5ab6e1494d5`。各项状态及资源检查保存在本目录的 JSON 文件中。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.20_x64-setup.exe`，大小 86,929,257 字节，SHA-256 为 `1ced1f4b40a723ee681906341c85077034edc8ccb128dba0f2c54e6192aeb03b`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，文件版本 `3.5.20`，SHA-256 为 `97590977043c10aca92b2ca52e84a81d8cc1c658a68f7db5b360c3826b9fd894`。

安装与用户资料备份：`tests/native-artifacts/installer-c0356f60-75a6-49f3-b87d-4e14cae65e82`。构建和安装日志分别为 `tests/native-artifacts/selection-3.5.20-build.log` 与 `tests/native-artifacts/selection-3.5.20-installer.log`。安装采用 `scripts/verify-installer.ps1 -SkipStartup`，没有启动应用窗口。

2026-10-22 发布前完成 Models 与 Providers 检查，记录与上述源代码指纹一致。日志为 `tests/native-artifacts/release-3.5.20-models.log` 和 `tests/native-artifacts/release-3.5.20-providers.log`；在线服务商验收范围为 DeepSeek。Browser 与 Native 状态按照用户明确要求保留为 `SkippedByUser`。
