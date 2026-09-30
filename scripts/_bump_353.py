# -*- coding: utf-8 -*-
"""Bump StuartMD 3.5.2 -> 3.5.3 in the ux-smooth-edit worktree."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\.worktrees\ux-smooth-edit")
OLD = "3.5.2"
NEW = "3.5.3"

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

## [3.5.3] - 2026-09-29

### 交互：首次点击即编辑（Typora 手感）
- 单击标题 / 正文 / 富文本混排行：**同步**进入编辑并在点击点落下光标（去掉 320–460ms 延迟）
- 富文本（斜体/加粗/删除线/行内代码）整块可编辑，支持字间 caret
- 拖选保护仅 300ms / 位移 > 4px；双击仍可进表格/代码/公式/图表编辑

### 代码块：语言徽标
- 阅读态 / 编辑态右上角显示 fence 语言（如 `js`）；无语言不显示
- 纯 CSS 徽标，不抢点击，不污染回写源码

### 图表更紧凑
- Mermaid 节点更矮、箭头更细、标签 12px，整体贴合正文栏宽

### 表格退出不抖动
- 未编辑：原位恢复快照；已编辑：只重建当前块（不再整树 remount）
- 单元格 chrome 与阅读态对齐（border-box）

### 稳定性
- `commitBlockSource` 返回真实写入下标，原位重建不贴错块
- 语言徽标在 sanitize 之后盖章；单块重建同样打标

### 调研
- 参照 Typora（Code Fences / Table Editing / Diagrams）交互约定

"""
marker = "## [3.5.2]"
idx = text.find(marker)
if idx < 0:
    raise SystemExit("CHANGELOG missing 3.5.2")
cl.write_text(entry + text[idx:], encoding="utf-8")
print("OK CHANGELOG.md prepended 3.5.3")

spec = ROOT / "docs" / "compose" / "spec" / "ux-smooth-edit.md"
s = spec.read_text(encoding="utf-8")
s = s.replace("status: designed", "status: delivered")
s = s.replace("updated: 2026-09-29", "updated: 2026-09-29")
s = s.replace(
    """## Report
""",
    """## Report

**What was built** — 首次点击即进编辑并落 caret（含富文本混排）；代码块语言徽标；Mermaid 紧凑化；表格退出原位重建消除抖动。多智能体实现 + 独立评审后补下标返回与 border-box 等缺口。

**Verification** — `node --check web/js/app.js` PASS；`node tests/core-smoke.js` ALL PASS。

**Journey log**
1. 320/460ms 延迟进编辑是「要点两次」根因，必须同步 enter。
2. contenteditable 需先 focus 再落 caret，否则像没进编辑。
3. 表格退出抖动来自整树 remount，不是边框；单块重建 + 保 scrollTop 即可。
4. sanitize 之后才能写 `data-lang`（白名单会剥 PRE 自定义属性）。
5. `commitBlockSource` 应返回真实写入下标，供 in-place rebuild 使用。
""",
)
s = s.replace("- [ ] T1:", "- [x] T1:")
s = s.replace("- [ ] T2:", "- [x] T2:")
s = s.replace("- [ ] T3:", "- [x] T3:")
s = s.replace("- [ ] T4:", "- [x] T4:")
s = s.replace("- [ ] T5:", "- [x] T5:")
spec.write_text(s, encoding="utf-8")
print("OK spec delivered")
print("DONE")
