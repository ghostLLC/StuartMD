# -*- coding: utf-8 -*-
from pathlib import Path
root = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")

# HTML: drop outline icon button
p = root / "web/index.html"
t = p.read_text(encoding="utf-8")
import re
t2, n = re.subn(
    r'[ \t]*<button class="icon-btn" id="btn-outline"[\s\S]*?</button>\n',
    "",
    t,
    count=1,
)
print("html removed", n)
p.write_text(t2, encoding="utf-8")

# JS: drop handler
p = root / "web/js/app.js"
t = p.read_text(encoding="utf-8")
t2, n = re.subn(
    r'[ \t]*\$\("#btn-outline"\)\.addEventListener\([\s\S]*?\}\);\n',
    "",
    t,
    count=1,
)
print("js removed", n)
p.write_text(t2, encoding="utf-8")

# guard remaining refs
t = (root / "web/js/app.js").read_text(encoding="utf-8")
print("btn-outline left in app.js", t.count("btn-outline"))
t = (root / "web/index.html").read_text(encoding="utf-8")
print("btn-outline left in html", t.count("btn-outline"))

# version 3.4.4
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.3"', 'version = "3.4.4"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.3"', '"version": "3.4.4"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.3"', 'VERSION: &str = "3.4.4"'),
    ("scripts/bump_lock.py", "3.4.3", "3.4.4"),
]:
    pp = root / rel
    pp.write_text(pp.read_text(encoding="utf-8").replace(a, b), encoding="utf-8")
print("version 3.4.4")

p = root / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.4.4] - 2026-09-29

### 界面
- **移除右上角「大纲」图标**：侧栏「文件 / 大纲」已可切换，避免重复入口

"""
if "## [3.4.4]" not in t:
    p.write_text(t.replace("## [3.4.3]", block + "## [3.4.3]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    pp = root / rel
    pp.write_text(pp.read_text(encoding="utf-8").replace("3.4.3", "3.4.4"), encoding="utf-8")
print("docs synced")
