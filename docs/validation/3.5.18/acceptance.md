# StuartMD 3.5.18 验证说明

验证日期：2026-10-20。

源码指纹：`e1f8bf02eef8557d03b87b787f15f8cc8ccccf8e5db2a4f130451638f4468f6c`。

Markdown 文件关联使用随安装包提供的 `file-md.ico`。安装程序完成文件部署后注册文档图标，并发送 Windows 文件关联变更通知。软件内部的关联注册同步维护自身文件类型；更新 `Markdown` 文件类型前检查打开命令是否属于当前程序。图标资源缺失或注册失败时返回具体错误。

应用程序图标保留原有资源。Windows 默认打开方式由用户已有选择决定。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Windows 注册表回归 | Passed | 生产函数读写实际临时注册表目录；包含有空格路径、两种打开命令、其他程序的关联保留、应用图标保留及图标资源缺失 |
| 前端文档模块 | Passed | 30 项文档状态、阅读位置、选区格式和文件写入检查 |
| 版本和资源 | Passed | 3.5.18 版本信息、文档图标及打包资源完整性 |
| Windows 实际文件关联 | Passed | `AssocQueryStringW` 返回 `Markdown` 文件类型、安装目录中的 `file-md.ico` 和 `stuartmd.exe` |
| 默认打开方式保留 | Passed | 升级前后的 `UserChoice` 类型与校验值完全相同 |
| 构建和安装 | Passed | 3.5.17 静默升级至 3.5.18；安装后的程序与安装包内程序一致，20 项资源核对通过 |
| 用户资料保留 | Passed | 32 个文件、6 个数据库和 254 条记录保持一致 |
| 窗口和视觉检查 | SkippedByUser | 按用户要求跳过 computer use |

Windows 返回的图标为 `"C:\Users\Administrator\AppData\Local\StuartMD\file-md.ico",0`。实际图标文件与项目设计资源一致，SHA-256 为 `48dd3332cc1f4558f89b1c56606859ea6abf176efd8913bd3fa9eddceef53de8`。资源管理器窗口中的显示未执行视觉检查。

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.18_x64-setup.exe`，大小为 86,945,262 字节，SHA-256 为 `98b536164cf9e1a752bc01cd79ccb48a684b4a28db525a0a1df0bb9391e87450`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，文件版本为 `3.5.18`，SHA-256 为 `90139b1ec01845cccbe8acf8384c5bf5f6be110e8884cadfcb4de2ab68778775`。安装后保持软件关闭。

安装和用户资料备份：`tests/native-artifacts/installer-b1934412-9df1-4843-b513-54010061b3ce`。

执行命令：

```powershell
cargo test --manifest-path tauri/src-tauri/Cargo.toml --locked markdown_icons_update_owned_registry_types_and_preserve_other_handlers -- --test-threads=1
npm test
node scripts/verify-release.cjs
pwsh -NoProfile -File scripts/prepare-resources.ps1 -VerifyOnly
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
pwsh -NoProfile -File tests/verify-file-icons.ps1 -BaselinePath tests/native-artifacts/icons-3.5.18-before.json
```

构建命令在 `tauri/src-tauri` 目录执行：

```powershell
cargo tauri build --bundles nsis
```

检查日志：`tests/native-artifacts/icons-3.5.18-unit.log`、`tests/native-artifacts/icons-3.5.18-frontend.log`、`tests/native-artifacts/icons-3.5.18-build.log` 和 `tests/native-artifacts/icons-3.5.18-installer.log`。详细结果见 `version-resources.json`、`build-results.json`、`installer-results.json` 和 `file-icons.json`。

本次执行图标关联专项检查、前端回归检查、构建和本机安装验证。在线模型调用、完整功能验收及隔离 Windows 环境升级检查未重新执行。
