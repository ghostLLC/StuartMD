# StuartMD 3.5.15 验证说明

验证日期：2026-10-19。

源码指纹：`82198c99225238d668f8b02c1a9ee6c9afa7471a726f6174b07616db89c9df5e`。

每份已打开的文档独立保留阅读位置。Markdown 预览使用正文块的源码偏移及视口距离恢复位置；源码区域使用可见字符的偏移及视口距离，同时保留光标选区。正文编辑会更新这些偏移。阅读、源码、分栏模式切换，以及窗口宽度和字体变化，使用当前布局重新计算位置。

标签切换、新建文件、关闭当前标签后显示相邻文件和侧边栏替换文件，经过统一的位置保存及恢复流程。首次打开的文件显示顶部。异步恢复检查文档身份、编辑版本及切换编号；滚动、搜索、目录和来源跳转可以终止待执行的恢复。

PDF 分别保留页码、页内位置、缩放、旋转及单页或双页显示方式。连续重绘继承待恢复位置，异步页面任务检查当前文档及渲染编号。

阅读位置保存在文档会话中，文件正文及保存快照继续使用文档内容协议。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 前端模块 | Passed | 30 项，包括 6 项文档位置回归检查 |
| 脚本、CSS 与示例 | Passed | 15 个脚本语法、CSS 及实际示例中的公式和 Mermaid 源码 |
| Rust 主程序 | Passed | 81 项通过，10 项独立验收入口未由普通测试调用 |
| 独立文档模块 | Passed | 11 项实际文件、编码、保存和恢复检查 |
| 独立进程 | Passed | 14 项实际进程、权限、恢复、并发保存和 PDF 检查 |
| 模型设置 | Passed | 独立目录中的实际配置副本、DPAPI 凭据、多进程读写及页面输入保留 |
| 会话共享状态 | Passed | 实际 SQLite 草稿、订阅通知、持久身份、版本及修改冲突保护 |
| 版本及资源 | Passed | 3.5.15、PDF.js、原生资源、模型目录、tokenizer 和源码测量依赖指纹 |
| 构建及静默安装 | Passed | 3.5.14 升级至 3.5.15，安装包内程序和 20 项资源核对一致 |
| 用户资料保留 | Passed | 32 个文件、6 个数据库及 240 条记录保持一致 |
| 独立代码审查 | Passed | 文件切换、模式变化、恢复任务归属、源码字符定位和 PDF 重绘流程 |
| 窗口、浏览器及视觉 | SkippedByUser | 用户禁止 computer use，未启动应用或浏览器 |

回归检查使用真实的 DocumentSession、TextBuffer 和页面 DOM，验证文档状态隔离、正文编辑后的偏移更新、任务失效、源码选区恢复和隐藏区域的状态保护。DOM 环境没有页面排版能力，测试没有提供虚构的尺寸数据；实际 WebView2 的换行测量、滚动事件顺序及 PDF 显示效果属于未执行的图形检查。

源码坐标测量采用 [textarea-caret 3.1.0](https://github.com/component/textarea-caret-position)。分发文件和 MIT 许可证随前端资源提供，并与安装的依赖核对 SHA-256。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.15_x64-setup.exe`，大小为 86,918,706 字节，SHA-256 为 `149c7bad942278b937895c4a391f37ea19762ea5ea367238a463da1046c0ed13`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，实际文件版本为 `3.5.15`，SHA-256 为 `3aa2f9b66ea6ce2586d769422cc5f6ee68cf9020f08db67bb13c67bbe04b8413`，与安装包内程序一致。安装在原有进程关闭后执行，安装后保持软件关闭。

安装及用户资料备份：`tests/native-artifacts/installer-4a06392f-78ff-4146-94ee-bb0396a75173`。详细结果见 `build-results.json` 和 `installer-results.json`。

复核命令：

```powershell
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Core
node scripts/verify-release.cjs
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
cargo tauri build --bundles nsis
```

打包命令在 `tauri/src-tauri` 目录中执行。完整后台日志保存在 `tests/native-artifacts/scroll-3.5.15-core.log` 和 `tests/native-artifacts/scroll-3.5.15-build.log`。
