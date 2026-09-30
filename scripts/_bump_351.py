# -*- coding: utf-8 -*-
"""Bump StuartMD 3.5.0 -> 3.5.1 and refresh docs/samples."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
OLD = "3.5.0"
NEW = "3.5.1"

replacements = [
    (ROOT / "tauri" / "src-tauri" / "tauri.conf.json", f'"version": "{OLD}"', f'"version": "{NEW}"'),
    (ROOT / "tauri" / "src-tauri" / "Cargo.toml", f'version = "{OLD}"', f'version = "{NEW}"'),
    (ROOT / "README.md", f"version-{OLD}-blue", f"version-{NEW}-blue"),
    (ROOT / "README.md", f"StuartMD-Setup-{OLD}.exe", f"StuartMD-Setup-{NEW}.exe"),
    (ROOT / "samples" / "示例文档.md", f"**当前版本：** {OLD}", f"**当前版本：** {NEW}"),
    (ROOT / "samples" / "欢迎使用 StuartMD.md", f"**当前版本：** {OLD}", f"**当前版本：** {NEW}"),
    (ROOT / "samples" / "欢迎使用 StuartMD.md", f"StuartMD-Setup-{OLD}.exe", f"StuartMD-Setup-{NEW}.exe"),
]

for path, old, new in replacements:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        print(f"WARN missing {old!r} in {path}")
        continue
    path.write_text(text.replace(old, new), encoding="utf-8")
    print(f"OK {path.name}: {old} -> {new}")

# CHANGELOG prepend
cl = ROOT / "CHANGELOG.md"
text = cl.read_text(encoding="utf-8")
entry = """# 更新日志 / Changelog

本文件记录 StuartMD 的版本变更，便于开发与发布对照。

## [3.5.1] - 2026-09-29

### 修复：图表节点文字丢失
- Mermaid v10+ 标签在 `foreignObject` 中；清洗器整块删除导致流程图只剩空框
- 保留 `foreignObject` 与标签文本，仅剥离脚本向量 / `on*` / 危险 URL
- 显式 `htmlLabels: true`；CSS 兜底保证明暗主题下标签可见

### 修复：代码 / LaTeX 双击后点别处整块丢失
- 进入编辑定时器 280ms 短于 Windows 双击间隔（约 500ms），慢双击会先清空 DOM
- 改为 **520ms** + `mousedown detail>1` 立即取消 + 双击后 800ms 抑制窗口
- 未编辑一律写回原文；`allowEmpty` 仅在用户真正输入后生效
- commit 失败恢复 `_stuartSnapshotHtml`；成功后强制全量重建（`invalidatePreviewBlocks`）
- 代码围栏按 parts 重建，保留 lang / EOL / 尾随空行；KaTeX 优先从 annotation 恢复 TeX

### 设计：功能按键去汉字
- 块菜单 / 插入菜单的按键面改为 16px 细描边 SVG（引用、复制、剪切、删除、对齐等）
- 中文仅保留在 `title` 提示；`data-bm` / `data-ins` 动作 ID 不变

### 测试
- core-smoke 新增围栏往返、数学块存活、空提交防抹、fence 重建字节安全等 P0 用例，全部通过

"""
# Replace the first heading block (title + intro) with new entry
marker = "## [3.5.0]"
idx = text.find(marker)
if idx < 0:
    raise SystemExit("CHANGELOG missing 3.5.0 section")
# Keep everything from 3.5.0 onward; replace the header/intro before it
cl.write_text(entry + text[idx:], encoding="utf-8")
print("OK CHANGELOG.md prepended 3.5.1")
print("DONE")
