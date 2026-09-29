# -*- coding: utf-8 -*-
"""Selftest 3.4.9 — code double-click, lists, mermaid, empty lines, memory UX."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
failed = 0


def check(cond, name):
    global failed
    if cond:
        print("OK ", name)
    else:
        failed += 1
        print("FAIL", name)


app = (ROOT / "web/js/app.js").read_text(encoding="utf-8")
css = (ROOT / "web/css/app.css").read_text(encoding="utf-8")
doc = (ROOT / "web/js/core/doc-stats.js").read_text(encoding="utf-8")
comp = (ROOT / "web/js/ui/companion.js").read_text(encoding="utf-8")
pdf = (ROOT / "web/js/pdf-viewer.js").read_text(encoding="utf-8")
conf = (ROOT / "tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
sample = (ROOT / "samples/欢迎使用 StuartMD.md").read_text(encoding="utf-8")
cl = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
readme = (ROOT / "README.md").read_text(encoding="utf-8")

check('"version": "3.4.9"' in conf, "tauri.conf 3.4.9")
check("**当前版本：** 3.4.8" in sample or "**当前版本：** 3.4.9" in sample, "sample version")
check("## [3.4.9]" in cl, "CHANGELOG 3.4.9")
check("3.4.9" in readme, "README 3.4.9")

# 1. code double-click loss
check("userEdited" in app, "code edit tracks userEdited")
check("!userEdited && !nextBody.trim()" in app, "no accidental empty code wipe")
check("if (e.detail > 1) return;" in app and "clearTimeout(bindPreviewDelegates._clickTimer)" in app, "multi-click cancels enter-edit")

# 2. list empty line
check("rewriteListLine" in app, "rewriteListLine helper")
check("stripListMarker" in app, "stripListMarker helper")
check('e.key === "Enter"' in app and "liEmpty" in app, "Enter on empty list item")
check('e.key === "Backspace"' in app and "strip-marker" in app, "Backspace two-step list")

# 3. mermaid SVG
check("svg: true" in app, "DOMPurify allows svg")
check('"svg"' not in app.split("FORBID_TAGS")[1][:200] if "FORBID_TAGS" in app else True, "svg not forbidden")
check('"SVG"' in app, "fallback sanitizer allows SVG tags")

# 4. heading lag
check("caretRangeFromPoint" in app, "caret at click point")
check("}, 90);" in app, "faster enter-edit delay")

# 5. empty lines
check('blocks.push("")' in doc or 'blocks.push("")' in app, "empty blocks preserved in split")
check("md-empty" in app and "md-empty" in css, "empty block UI")
check("extra blank line" in doc or "empty block" in doc, "join documents empty-block model")

# 6. memory UX
check("confirmMemoryDelete" in comp, "memory delete confirm")
check("StuartUIConfirm" in pdf, "shared uiConfirm export")
check("sc-mem-new" in comp, "create memory entry")
check("sc-detail-actions" in comp and "sc-detail-actions" in css, "actions under content")
check("readonly" in comp and "armEdit" in comp, "lazy edit arm")

print()
print("FAILED" if failed else "ALL OK", failed)
raise SystemExit(1 if failed else 0)
