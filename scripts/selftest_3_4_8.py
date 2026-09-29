# -*- coding: utf-8 -*-
"""Selftest 3.4.8 — selection-safe click edit + in-place table/code edit."""
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
conf = (ROOT / "tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
cargo = (ROOT / "tauri/src-tauri/Cargo.toml").read_text(encoding="utf-8")
sample = (ROOT / "samples/欢迎使用 StuartMD.md").read_text(encoding="utf-8")
readme = (ROOT / "README.md").read_text(encoding="utf-8")
cl = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

check('"version": "3.4.8"' in conf, "tauri.conf 3.4.8")
check('version = "3.4.8"' in cargo, "Cargo.toml 3.4.8")
check("VERSION: &str = \"3.4.8\"" in (ROOT / "tauri/src-tauri/src/fs_api.rs").read_text(encoding="utf-8"), "fs_api VERSION 3.4.8")
check("**当前版本：** 3.4.8" in sample, "welcome sample version")
check("3.4.8" in readme, "README version")
check("## [3.4.8]" in cl, "CHANGELOG 3.4.8")

# interaction contracts
check("function hasLivePreviewSelection" in app, "hasLivePreviewSelection helper")
check("function recentlyHadSelection" in app, "recentlyHadSelection helper")
check("function commitBlockSource" in app, "commitBlockSource helper")
check("function enterTableEdit" in app, "enterTableEdit")
check("function enterCodeEdit" in app, "enterCodeEdit")
check("recentlyHadSelection(1500)" in app, "1.5s selection grace")
check("Double-click = native word selection only" in app, "dblclick no longer hijacks edit")
check("enterBlockSourceEdit(node)" in app, "source edit still available for math/mermaid")

# dblclick must NOT call enterBlockSourceEdit
dbl = app.split('addEventListener("dblclick"', 1)
if len(dbl) > 1:
    chunk = dbl[1][:800]
    check("enterBlockSourceEdit" not in chunk, "dblclick handler free of source-edit")
else:
    check(False, "dblclick handler present")

# table / code single-click routing
check('node.querySelector("table")' in app and "enterTableEdit(node)" in app, "table routes to enterTableEdit")
check('node.querySelector("pre")' in app and "enterCodeEdit(node)" in app, "code routes to enterCodeEdit")

# safety
check("allowEmpty !== true" in app, "empty wipe guard")
check("pushHistory(prev)" in app, "history snapshot before write")
check("contenteditable" in app and "table, pre" in app, "never contenteditable table/pre shell")

# css
check("code-edit-wrap" in css, "code edit CSS")
check("table-edit" in css, "table edit CSS")

# sample copy
check("单击表格" in sample, "sample documents table single-click")
check("双击**：只选中词" in sample or "双击**：只选中" in sample, "sample documents dblclick-select-only")

print()
print("FAILED" if failed else "ALL OK", failed)
raise SystemExit(1 if failed else 0)
