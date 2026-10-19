# StuartMD 3.5.16 验证说明

验证日期：2026-10-19。

源码指纹：`2a352f1b85a645f7dcdedce9597a74d90b60462740dffe81ebedc7cf7607e8da`。

开始页面使用应用的 S 图标，显示尺寸为 64×64，保留图片原始形状、透明边缘及颜色。浅色、灰色、深色、羊皮纸、小黄人和壁纸主题使用同一份图标。

图标来源为 `assets/app.ico`，开始页面引用 `web/assets/app.ico`。资源准备命令复制原文件并核对 SHA-256；版本资源检查同时核对页面引用、图片说明和 Tauri 应用图标配置。前端资源位于 Tauri 的 `frontendDist` 目录中，随可执行程序打包。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 开始页面结构及图标 | Passed | 实际页面 DOM 使用图片，图标文件与应用图标的 SHA-256 相同 |
| 六种主题样式 | Passed | 实际 CSS 计算结果为 64×64、contain、透明背景，图片保持原始形状及颜色 |
| 前端模块 | Passed | 30 项文档状态、阅读位置、选区格式及写入检查 |
| 脚本、CSS 与示例 | Passed | 15 个脚本语法、CSS，以及实际示例中的公式和 Mermaid 源码 |
| 版本及资源 | Passed | 3.5.16、图标、PDF.js、原生资源、模型目录及 tokenizer 指纹 |
| 构建及静默安装 | Passed | 3.5.15 升级至 3.5.16，安装包内程序与 20 项资源核对一致 |
| 用户资料保留 | Passed | 32 个文件、6 个数据库及 240 条记录保持一致 |
| 窗口及视觉 | SkippedByUser | 按用户要求跳过 computer use，未启动应用或浏览器 |

页面结构和主题样式检查使用真实 HTML 与 CSS，通过 jsdom 读取 DOM 和计算样式。资源检查比较实际文件内容，图形环境中的最终显示效果未执行验收。

图标 SHA-256：`fb72cbe118440956eed2234a3824ecc729e0020c11565e1903ced54ae7192bf8`。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.16_x64-setup.exe`，大小为 86,942,787 字节，SHA-256 为 `8877199e9caef9f23d4e4b0a9dc196ce4aed2d6a3b1d3fc704f7a6fa2de34f6d`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，实际文件版本为 `3.5.16`，SHA-256 为 `0fc5aeb85c1c907202da85b9ce3320bf3d07472e4fe7b1aa7752dc733841d185`，与安装包内程序一致。安装后保持软件关闭。

安装及用户资料备份：`tests/native-artifacts/installer-734bce82-f283-4da9-99b4-fb6023c5a347`。详细结果见 `build-results.json` 和 `installer-results.json`。

复核命令：

```powershell
node scripts/verify-release.cjs
pwsh -NoProfile -File scripts/prepare-resources.ps1 -VerifyOnly
npm test
npm run test:companion
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
```

打包命令在 `tauri/src-tauri` 目录中执行：

```powershell
cargo tauri build --bundles nsis
```

打包日志：`tests/native-artifacts/logo-3.5.16-build.log`。
