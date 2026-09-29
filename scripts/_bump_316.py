# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# user-facing 讲解 -> 问答 in live UI strings (not historical changelog body)
repls = [
    ("web/js/ui/ai-ui.js", [
        ("讲解未完成", "问答未完成"),
        ("讲解 · ", "问答 · "),
        ("暂无讲解内容", "暂无问答内容"),
        ("已复制讲解", "已复制问答"),
        ("请先进行一次讲解", "请先进行一次问答"),
        ("请先选中要讲解的内容", "请先选中要问答的内容"),
        ("讲解中", "问答中"),
        ("讲解完成。", "问答完成。"),
    ]),
    ("web/js/app.js", [
        ("讲解启动失败", "问答启动失败"),
    ]),
    ("web/js/core/ai-client.js", [
        ("请先选中要讲解的内容", "请先选中要问答的内容"),
    ]),
    ("tauri/src-tauri/Cargo.toml", [('version = "3.1.5"', 'version = "3.1.6"')]),
    ("tauri/src-tauri/tauri.conf.json", [('"version": "3.1.5"', '"version": "3.1.6"')]),
    ("tauri/src-tauri/src/fs_api.rs", [('VERSION: &str = "3.1.5"', 'VERSION: &str = "3.1.6"')]),
    ("scripts/bump_lock.py", [("3.1.5", "3.1.6")]),
]

for rel, pairs in repls:
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    for a, b in pairs:
        if a in t:
            t = t.replace(a, b)
            print("OK", rel, "->", b[:20])
        else:
            print("skip", rel, a[:24])
    p.write_text(t, encoding="utf-8")

# changelog
p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.1.6] - 2026-09-21

### 文案与布局
- PDF / Markdown 入口按钮文案由「讲解」统一改为「**问答**」（AI 问答）
- 面板标题「AI 问答」；提示同步；按钮禁止换行（修复 PDF 条上「讲/解」竖排）

"""
if "## [3.1.6]" not in t:
    t = t.replace("## [3.1.5]", block + "## [3.1.5]", 1)
    p.write_text(t, encoding="utf-8")
    print("OK CHANGELOG")

# docs
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    t = t.replace("3.1.5", "3.1.6")
    t = t.replace("AI 讲解", "AI 问答").replace("「讲解」", "「问答」")
    p.write_text(t, encoding="utf-8")
    print("OK", rel)

# selftest version strings
p = ROOT / "scripts/selftest_3_0_0.py"
t = p.read_text(encoding="utf-8")
t = t.replace("3.1.5", "3.1.6")
if "nowrap" not in t:
    t += '\ncheck("nowrap" in css, "AI button nowrap")\ncheck("AI 问答" in html, "panel title 问答")\n'
p.write_text(t, encoding="utf-8")
print("OK selftest")
print("done")
