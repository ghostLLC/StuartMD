# StuartMD 3.5.17 验证说明

验证日期：2026-10-19。

源码指纹：`459861e8506aaff6be70bc4c53f217279bd60bea6d0ff1413b24173c07f93a0b`。

左侧刷新按钮读取当前标签页已保存文档的父目录，并高亮当前文件。目录相同时保留已有展开状态和列表滚动位置，目录变化时将当前文件移动到可见区域。未保存文档和没有打开文档时禁用按钮；刷新期间提供等待状态。目录访问失败时保留原有列表并显示具体原因。

目录扫描在后台线程执行，根据文档所属窗口检查访问权限，读取成功后授予该窗口父目录访问权限。刷新过程独立于知识库和伴读工作区设置。文档切换、另存为和后续目录操作会使旧请求失效。

列表支持 Markdown、TXT 和 PDF，并保留当前打开的其他文本文件。当前目录文档优先计入显示数量，当前文件在达到 2500 个条目的限制时仍然显示；空目录不会占用显示数量。侧栏扫描深度为三层，达到深度或数量限制时显示提示。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 前端文档模块 | Passed | 30 项文档状态、阅读位置、选区格式与文件写入检查 |
| 目录刷新 | Passed | 6 项检查使用真实 Rust 扫描结果和实际 HTML，通过 jsdom 检查目录切换、文件增删改名、PDF 定位、展开状态、滚动属性、请求身份和按钮状态 |
| Rust 主程序 | Passed | 85 项通过；10 项需要独立入口的检查默认忽略 |
| 目录边界与权限 | Passed | 主程序测试包含文档所属窗口、未保存文档、目录删除、2500 个空目录、2501 个文件以及无扩展名当前文件 |
| 独立文件和进程 | Passed | 11 项文件检查与 14 项真实进程检查 |
| AI 配置与会话 | Passed | 实际配置副本、配置页面 DOM、SQLite 草稿及会话状态；没有调用在线模型 |
| 脚本、CSS 与示例 | Passed | 16 个脚本、应用 CSS、伴读 CSS，以及实际示例中的公式和 Mermaid 源码 |
| 版本和资源 | Passed | 3.5.17、应用图标、PDF.js、原生资源、模型目录与 tokenizer 文件 |
| 构建与安装 | Passed | 3.5.16 静默升级至 3.5.17，安装程序和 20 项资源核对一致 |
| 用户资料保留 | Passed | 32 个文件、6 个数据库及 250 条记录保持一致 |
| 窗口和视觉检查 | SkippedByUser | 按用户要求跳过 computer use，安装后保持软件关闭 |

目录检查调用生产使用的 Rust 扫描模块，操作实际临时目录，并将其结果交给生产使用的 `FolderView`。jsdom 检查 DOM 状态和滚动属性；实际窗口中的点击、滚动布局和等待动画未执行视觉验收。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.17_x64-setup.exe`，大小为 86,849,475 字节，SHA-256 为 `b9278fe230e3e01fc55f617d6c4e9938a757fda573e6bc96c21c217266d93524`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，文件版本为 `3.5.17`，SHA-256 为 `7bd7cce63d1e6ed0ac02c2214c94c6d98893f08ed283022e932a8dc2a2cd7fe6`，与安装包内程序一致。

安装和用户资料备份：`tests/native-artifacts/installer-c405c5ba-ebc6-47dc-abb4-93c05bd74ed5`。

验证命令：

```powershell
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Core
node scripts/verify-release.cjs
pwsh -NoProfile -File scripts/prepare-resources.ps1 -VerifyOnly
npm run test:folder
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
```

构建命令在 `tauri/src-tauri` 目录执行：

```powershell
cargo tauri build --bundles nsis
```

详细记录见 `core-status.json`、`build-results.json` 和 `installer-results.json`。后台检查、构建及安装日志分别位于 `tests/native-artifacts/folder-3.5.17-core.log`、`tests/native-artifacts/folder-3.5.17-build.log` 和 `tests/native-artifacts/folder-3.5.17-installer.log`。
