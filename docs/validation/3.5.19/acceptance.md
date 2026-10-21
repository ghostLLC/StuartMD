# StuartMD 3.5.19 验证说明

回归检查日期：2026-10-20。构建与安装验证日期：2026-10-21。

源码指纹：`dfb7f56b246e4b6c1e488130219577c5135fb0700f0342d6fbc02fec16678d0c`。

AI 设置分为“我的模型”“连接管理”和“对话偏好”。模型名称、当前使用、默认选择和配置状态优先显示；状态同时提供文字和颜色。常用操作直接显示，验证、默认选择、启停及删除操作放在“更多”中。连接地址与在线目录信息按需展开。分类支持方向键、Home、End 和键盘焦点导航，展开状态在配置刷新后保留。

服务商推荐卡片与添加表单共同读取内置模型目录，提供 DeepSeek、通义千问、Kimi 和智谱的十二个型号。卡片直接打开对应服务商的多选表单，已经保存的型号明确标记并禁止重复勾选。深色和灰色主题使用相应的状态文字颜色。

设置结构升级至 schema 7。迁移仅处理符合旧版默认名称、官方地址、参数和迁移元数据的未配置 Qwen、Kimi 条目，并检查密钥、默认选择、当前选择、最近使用、验证和在线目录记录。用户修改名称、预算、启停状态或具有独立思考参数的配置继续保留。现有 DeepSeek 模型和加密密钥继续使用。

2026-10-20 核对的官方型号包括 Qwen3.8 Max、Qwen3.8 Flash、Qwen3.7 Plus，Kimi K3、K2.6、K2.7 Code 系列，以及 GLM-5.3。对应资料：[阿里云模型目录](https://help.aliyun.com/zh/model-studio/models)、[Kimi 模型参数参考](https://platform.kimi.com/docs/api/models-overview.md)、[GLM-5.3 官方说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md)。本次继续使用已有目录的容量、计数与请求参数，没有改动模型调用协议。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 前端文档模块 | Passed | 30 项文档状态、阅读位置、选区格式和文件写入检查 |
| 目录刷新 | Passed | 6 项真实目录扫描与页面状态检查 |
| Rust 主程序 | Passed | 86 项通过；10 项依赖独立入口的检查默认忽略 |
| 文件和进程 | Passed | 11 项文件检查与 14 项真实进程检查 |
| 配置迁移 | Passed | 实际用户配置的独立副本，迁移后保留 DeepSeek，重复读取保持稳定；密钥密文保持完整 |
| 配置保护 | Passed | 模型名称、连接名称、当前选择、最近使用、输出预算、停用和思考参数修改保护 |
| AI 页面操作 | Passed | jsdom 中运行实际页面代码和实际配置快照；分类键盘导航、推荐入口、重复添加限制、展开状态、冲突重载及未保存输入保护 |
| 模型配置保存 | Passed | 通过 Rust 实际配置操作检查多模型选择、独立连接、版本冲突、密钥轮换和重新读取 |
| 脚本与资源 | Passed | 伴读脚本、CSS、示例文档以及 3.5.19 版本和资源检查 |
| 构建和安装 | Passed | 3.5.18 静默升级至 3.5.19；实际安装程序与安装包内程序一致，20 项资源核对通过 |
| 用户资料保留 | Passed | 32 个文件、6 个数据库及 256 条记录保持一致 |
| Markdown 文档图标 | Passed | Windows 实际关联继续指向安装目录中的 `file-md.ico` |
| 窗口和视觉检查 | SkippedByUser | 按用户要求跳过 computer use |

真实配置副本：`tests/native-artifacts/ai-configuration-a6189976-dbf6-4220-a1c4-e54719810744`。副本中的原有三个模型经迁移保留一个已配置的 DeepSeek 模型，现有用户目录在测试过程中保持完整。

回归命令：

```powershell
pwsh -NoProfile -File scripts/verify-repair.ps1 -Mode Core
node scripts/verify-release.cjs
pwsh -NoProfile -File scripts/prepare-resources.ps1 -VerifyOnly
```

构建命令在 `tauri/src-tauri` 目录执行：

```powershell
cargo tauri build --bundles nsis
```

安装命令：

```powershell
pwsh -NoProfile -File scripts/verify-installer.ps1 -SkipStartup
pwsh -NoProfile -File tests/verify-file-icons.ps1
```

安装包：`tauri/src-tauri/target/release/bundle/nsis/StuartMD_3.5.19_x64-setup.exe`，大小为 86,924,612 字节，SHA-256 为 `04daec991d13d370186240a6e41e1e044b2d308f88b8ad25cc43e0c9d8cd0382`。

本机程序：`C:/Users/Administrator/AppData/Local/StuartMD/stuartmd.exe`，文件版本为 `3.5.19`，SHA-256 为 `bcad3aa238c05241ce497b10d902d10c41e5da1d0c3f14e01632b702166e8cee`。

安装及用户资料备份：`tests/native-artifacts/installer-bf21aa42-0d8e-45f0-ae09-f27e9eb68afc`。

详细记录见 `core-status.json`、`version-resources.json`、`build-results.json`、`installer-results.json` 和 `file-icons.json`。回归、构建和安装日志分别为 `tests/native-artifacts/ai-settings-3.5.19-core.log`、`tests/native-artifacts/ai-settings-3.5.19-build.log` 和 `tests/native-artifacts/ai-settings-3.5.19-installer.log`。

本次没有重新调用在线模型，也没有执行窗口视觉检查。实际设置迁移在软件读取配置时完成，安装程序保留用户设置文件。
