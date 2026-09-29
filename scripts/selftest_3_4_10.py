# -*- coding: utf-8 -*-
from pathlib import Path
ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
failed = 0

def check(c, n):
    global failed
    print(("OK " if c else "FAIL"), n)
    if not c: failed += 1

app = (ROOT / "web/js/app.js").read_text(encoding="utf-8")
css = (ROOT / "web/css/app.css").read_text(encoding="utf-8")
conf = (ROOT / "tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")

check('"version": "3.4.10"' in conf, "version 3.4.10")
check("sanitizeMermaidSvg" in app, "mermaid svg sanitizer")
check("sanitizeRenderedHtml(wrap)" not in app.split("function runMermaidRender")[1][:800], "mermaid not HTML-whitelisted")
check("mermaidReady = null" in app and "setTimeout(r, 50)" in app, "mermaid wait/retry")
check("280" in app and "double-click gap" in app, "280ms enter-edit delay")
check("resolveBlockSource" in app and "_stuartSrc" in app, "block source snapshot")
check("!String(original).trim() && String(node.textContent" in app, "refuse wipe when DOM has content")
check("code-edit-wrap" in css and "var(--code-bg)" in css, "code edit matches reading pre")
check("background: transparent" in css and "table-edit" in css, "table edit no tint")
print()
print("FAILED" if failed else "ALL OK", failed)
raise SystemExit(1 if failed else 0)
