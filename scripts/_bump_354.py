# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\.worktrees\list-empty-one-click")
OLD = "3.5.3"
NEW = "3.5.4"

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

## [3.5.4] - 2026-09-29

### 列表空行 / 空行按键
- **空列表项**（`-` `*` `1.` `- [ ]`）：回车 / Delete / Backspace 一律去掉序号或点号，退出列表
- **普通空行**：回车加一空行，Delete/Backspace 减一空行
- 补齐 Delete 键；空 `li`（含 `<br>`/零宽字符）不再误判；定位失败时 DOM 兜底，圆点不再卡死
- 源码模式 / 块编辑 / 阅读模式三端行为一致

### 一次点击切换编辑
- 从富文本等 A 块点到标题等 B 块：**一次点击**完成退出 A + 进入 B（原先要点两次）
- 根因：commit 整树重挂载导致 click 丢失；改为 mouseup + `elementFromPoint` 同手势进入

### 图表与示例
- Mermaid 再缩小：标签 11px、节点更贴字、容器更紧
- 示例图改为带分支的复杂流程图

### 测试
- core-smoke 新增列表标记契约用例，全部通过

"""
marker = "## [3.5.3]"
idx = text.find(marker)
if idx < 0:
    raise SystemExit("CHANGELOG missing 3.5.3")
cl.write_text(entry + text[idx:], encoding="utf-8")
print("OK CHANGELOG.md prepended 3.5.4")
print("DONE")
