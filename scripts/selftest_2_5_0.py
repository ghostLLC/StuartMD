# -*- coding: utf-8 -*-
"""Self-test StuartMD 2.5.0 — split layout + gray theme."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
ok = True


def fail(msg):
    global ok
    ok = False
    print("FAIL:", msg)


def check(cond, msg):
    if cond:
        print("OK  :", msg)
    else:
        fail(msg)


html = (ROOT / "web/index.html").read_text(encoding="utf-8")
css = (ROOT / "web/css/app.css").read_text(encoding="utf-8")
app = (ROOT / "web/js/app.js").read_text(encoding="utf-8")
i18n = (ROOT / "web/js/i18n.js").read_text(encoding="utf-8")
fs = (ROOT / "tauri/src-tauri/src/fs_api.rs").read_text(encoding="utf-8")
conf = (ROOT / "tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
cargo = (ROOT / "tauri/src-tauri/Cargo.toml").read_text(encoding="utf-8")
lock = (ROOT / "tauri/src-tauri/Cargo.lock").read_text(encoding="utf-8")
changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
sample = (ROOT / "samples/欢迎使用 StuartMD.md").read_text(encoding="utf-8")

# Split: preview left, source right
pi = html.find('id="preview-pane"')
si = html.find('id="source-pane"')
ri = html.find('id="split-resizer"')
check(0 < pi < ri < si, "HTML order: preview → resizer → source")
check(pi > 0 and ri > pi and si > ri, "HTML order confirmed")
check('mode-split #preview-pane' in css and "flex: 1 1 auto" in css, "split preview flexes")
check("fromRight" in app or "rect.right - e.clientX" in app, "resizer sizes source from right")

# Gray theme
check('[data-theme="gray"]' in css, "gray theme CSS block")
check("--bg: #2b2b2e" in css, "gray bg is mid-gray not near-black")
check("--text: #b4b4b8" in css, "gray text is dimmer than dark #d4d4d4")
check('data-theme-choice="gray"' in html, "theme menu has gray")
check('data-theme="gray"' in html and 'data-i18n="gray"' in html, "settings has gray pick")
check('"light", "gray", "dark"' in app, "THEMES includes gray between light and dark")
check('gray: "灰色"' in app, "themeLabel gray")
check('gray: "灰色"' in i18n and 'gray: "Gray"' in i18n, "i18n gray labels")
check("theme === \"dark\" || theme === \"gray\"" in app, "highlight css uses dark for gray")
check("state.theme === \"gray\"" in app, "mermaid dark for gray")

# Versions
check('"version": "2.5.0"' in conf, "tauri.conf 2.5.0")
check('version = "2.5.0"' in cargo, "Cargo.toml 2.5.0")
check(re.search(r'name = "stuartmd"\nversion = "2\.5\.0"', lock), "Cargo.lock 2.5.0")
check('VERSION: &str = "2.5.0"' in fs, "fs VERSION 2.5.0")
check("2.5.0" in changelog and "灰色" in changelog, "CHANGELOG 2.5.0 + gray")
check("灰色" in sample, "sample mentions gray theme")

print()
if ok:
    print("SELF-TEST PASSED")
    sys.exit(0)
print("SELF-TEST FAILED")
sys.exit(1)
