# -*- coding: utf-8 -*-
"""Bump StuartMD to 3.5.0 — security + data correctness + design hardening."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")

def rep(path, pairs):
    p = ROOT / path
    t = p.read_text(encoding="utf-8")
    for a, b in pairs:
        if a not in t:
            raise SystemExit(f"missing in {path}: {a[:70]!r}")
        t = t.replace(a, b)
    p.write_text(t, encoding="utf-8")
    print("updated", path)

for f, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.10"', 'version = "3.5.0"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.10"', '"version": "3.5.0"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.10"', 'VERSION: &str = "3.5.0"'),
    ("scripts/bump_lock.py", "3.4.10", "3.5.0"),
]:
    rep(f, [(a, b)])

# samples already may say 3.5.0 from design agent — normalize
for s in ["samples/欢迎使用 StuartMD.md", "samples/示例文档.md"]:
    p = ROOT / s
    t = p.read_text(encoding="utf-8")
    for old in ["**当前版本：** 3.4.10", "**当前版本：** 3.4.9", "**当前版本：** 3.4.8"]:
        t = t.replace(old, "**当前版本：** 3.5.0")
    p.write_text(t, encoding="utf-8")
    print("sample", s)

rep("README.md", [
    ("version-3.4.10-blue", "version-3.5.0-blue"),
    ("StuartMD-Setup-3.4.10.exe", "StuartMD-Setup-3.5.0.exe"),
    ("version-3.4.9-blue", "version-3.5.0-blue"),
    ("StuartMD-Setup-3.4.9.exe", "StuartMD-Setup-3.5.0.exe"),
])

rep("tauri/src-tauri/src/fs_api.rs", [("**当前版本：** 3.4.10", "**当前版本：** 3.5.0")])

cl = ROOT / "CHANGELOG.md"
t = cl.read_text(encoding="utf-8")
block = """## [3.5.0] - 2026-09-29

### 安全（Critical / High）
- **插件**：不再启动即执行；启用需确认 + 源码哈希；沙箱影子 `window`/`eval`/`Function`/`__TAURI__`
- **路径能力**：读写限制在「用户打开/保存过」与工作区内；拒绝 UNC / 设备路径
- **粘贴**：contenteditable 粘贴消毒（DOMPurify + 白名单），杜绝粘贴 XSS
- **HTML 清洗**：内置 DOMPurify；弃用正则黑名单；文档 HTML 不再保留 `<style>`
- **AI base_url**：内置厂商钉死主机；自定义端点变更需确认，并回报密钥发送主机
- **CSP**：`tauri.conf` 与 meta 收紧；`reveal_in_explorer` 拒 UNC（防 NTLM）
- 更新检查改为 Rust `ureq`，去掉 PowerShell

### 数据正确性
- **split/join 字节保真**：硬换行、尾换行、首尾空行、CRLF、围栏内空行往返一致
- **写路径串行**：每路径队列，autosave / 保存不乱序；`saveFileAs` 带 rev 守卫
- **块提交**：索引漂移可按快照恢复；失败提示，禁止静默丢编辑
- **撤销**：切标签前 flush 历史
- **草稿**：`save_draft`/`clear_draft` 后端落地
- 修复标签栏拖入文件 `openDocumentRespectingMode` 未定义崩溃

### 设计
- 产品 UI 去 emoji；统一「问答」；示例版本同步 3.5.0
- 实验模块迁 `web/experimental/`；插件文档写清同意模型

### 测试
- `core-smoke` 金样往返 96 断言；Rust 41 测；插件沙箱探针

"""
if "## [3.5.0]" not in t:
    t = t.replace("## [3.4.10]", block + "## [3.4.10]", 1)
    cl.write_text(t, encoding="utf-8")
    print("changelog ok")
print("DONE 3.5.0")
