# -*- coding: utf-8 -*-
"""Bump StuartMD to 3.4.10: mermaid visible, edit looks like read, no wipe on multi-click."""
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

rep("tauri/src-tauri/Cargo.toml", [('version = "3.4.9"', 'version = "3.4.10"')])
rep("tauri/src-tauri/tauri.conf.json", [('"version": "3.4.9"', '"version": "3.4.10"')])
rep("tauri/src-tauri/src/fs_api.rs", [('VERSION: &str = "3.4.9"', 'VERSION: &str = "3.4.10"')])
rep("scripts/bump_lock.py", [("3.4.9", "3.4.10")])
rep("samples/欢迎使用 StuartMD.md", [("**当前版本：** 3.4.9", "**当前版本：** 3.4.10")])
rep("README.md", [
    ("version-3.4.9-blue", "version-3.4.10-blue"),
    ("StuartMD-Setup-3.4.9.exe", "StuartMD-Setup-3.4.10.exe"),
])
rep("tauri/src-tauri/src/fs_api.rs", [("**当前版本：** 3.4.9", "**当前版本：** 3.4.10")])

cl = ROOT / "CHANGELOG.md"
t = cl.read_text(encoding="utf-8")
block = """## [3.4.10] - 2026-09-29

### 修复：图表一直不可见
- HTML 清洗器剥掉 SVG 的 `<style>` / `fill` / `stroke` / `viewBox`，Mermaid 渲染完即“空白”
- Mermaid 输出改为仅去 script，不再走 HTML 白名单
- `ensureMermaid` 曾把“脚本尚未加载”缓存成永久失败（defer 加载）→ 现会等待并重试

### 修复：代码/图表双击后再单击丢失
- 单击进编辑延迟 90ms 落在双击两击之间 → 误进编辑并清空 DOM
- 延迟改为 **280ms**（越过双击间隔），多击一律取消
- 块源码增加渲染快照 `_stuartSrc`；索引漂移时按快照恢复
- 源丢失但 DOM 仍有内容时**禁止**进入破坏性编辑
- 未输入禁止空写回

### 编辑态保持阅读样式
- 代码编辑：外观对齐 `.markdown-body pre`（同底色/字号/边距），去掉额外标题条
- 表格编辑：去掉高亮底色，仅焦点内描边

"""
if "## [3.4.10]" not in t:
    t = t.replace("## [3.4.9]", block + "## [3.4.9]", 1)
    cl.write_text(t, encoding="utf-8")
    print("changelog ok")
print("DONE 3.4.10")
