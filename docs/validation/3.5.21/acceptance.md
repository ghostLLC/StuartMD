# StuartMD 3.5.21 验收

## 实现范围

- 预览区域删除和剪切使用实际选区端点，保留首尾未选择的文字及表格结构。
- 行内格式使用文档身份、修订和 DOM 位置定位，支持重复文字、跨段选择、已有格式及部分行内代码。
- Turndown 与 GFM 插件随程序分发，资源及许可证校验纳入发布检查。
- PDF.js 关闭动态代码执行选项，实际 PDF 文件检查覆盖页数、文字和绘制指令。
- Rust 固定为 1.98.1；验收同时记录软件源码及检查程序指纹。
- 发布检查读取明确的界面检查跳过授权，保留 `SkippedByUser` 状态。

## 检查范围

`tests/repair-preview-commands.cjs` 使用真实 jsdom、Markdown 渲染器、Turndown 和临时文件，17 项检查通过。独立复查还覆盖 105 种部分行内代码选区。

六种模式的当前状态分别保存在本目录的 `*-status.json`。安装资源、实际模型、PDF 提取和 DeepSeek 调用的详细证据分别由对应验证命令生成。

Core 完整检查通过：64 项前端检查、6 项目录检查、86 项 Rust 常规检查、11 项实际文档检查、14 项多进程检查，以及实际配置迁移与 SQLite 记录检查。需要独立资源的 Rust 检查由专门模式执行。

Models 的三项实际检查全部通过：索引取消与资料修改、真实模型多语言向量、PDF 提取与 OCR 来源坐标。Providers 的 DeepSeek 完整调用检查通过。

`pwsh -NoProfile -File scripts/verify-release.ps1 -Publication` 检查通过。Core、Models、Providers、Installer 均为 `Passed`；Browser、Native 为 `SkippedByUser`。六份记录具有相同的软件源码与检查程序指纹。

## 本机安装

安装包构建通过，本机已从 3.5.20 静默升级到 3.5.21。20 项资源校验通过，34 个用户文件、6 个数据库及 264 条记录保持完整。Markdown 文件关联使用 `file-md.ico`，实际关联检查通过。

安装包 SHA-256：`c3bd1a0aab99b5bce3dbf52e20770a4bf9a0459f35790c20e04fe00e9d69c5ef`。

安装后的程序 SHA-256：`7acb6654fbaeed8719278dbf3002bf64233cfd6302326c33169514bc4b818ad5`。

实际安装详情见 `installer-results.json`；启动检查状态为 `SkippedByUser`。

## 验证限制

用户禁止 computer use，Browser、Native 检查按授权跳过。后台 DOM 检查没有验证原生窗口的鼠标操作、输入法及完整撤销交互。安装检查使用 `-SkipStartup`，不会启动软件窗口。

DeepSeek 实际调用检查通过。在线输出存在随机性；摘要引用必须与原始消息匹配，否则拒绝使用该摘要。

PDF.js 当前版本为 3.11.174，已设置 `isEvalSupported: false`。依赖审计仍存在告警；PDF.js 版本迁移及完整渲染、批注验证仍需单独完成。

## 维护入口

[维护交接文档](../../MAINTENANCE_HANDOVER.md) 说明当前调用路径、数据保护要求及后续工程风险。
