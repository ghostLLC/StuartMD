# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
OLD = "3.5.4"
NEW = "3.5.5"

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

cl = ROOT / "CHANGELOG.md"
text = cl.read_text(encoding="utf-8")
entry = """# 更新日志 / Changelog

本文件记录 StuartMD 的版本变更，便于开发与发布对照。

## [3.5.5] - 2026-09-29

### 图表：限制为文档插图尺寸
- Mermaid **不再被拉满栏宽放大**：容器最大 560×320，SVG 不放大、可滚动
- 节点/标签 11px，间距更紧；示例改为横向紧凑分支图（可一屏看全）

### 空列表回车
- 空列表项回车：**只去掉序号/点号**，变成普通空行（不再连带删掉该行）

"""
marker = "## [3.5.4]"
idx = text.find(marker)
if idx < 0:
    raise SystemExit("missing 3.5.4")
cl.write_text(entry + text[idx:], encoding="utf-8")
print("OK CHANGELOG 3.5.5")
print("DONE")
