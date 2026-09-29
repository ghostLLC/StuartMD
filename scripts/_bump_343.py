# -*- coding: utf-8 -*-
from pathlib import Path
root = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.2"', 'version = "3.4.3"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.2"', '"version": "3.4.3"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.2"', 'VERSION: &str = "3.4.3"'),
    ("scripts/bump_lock.py", "3.4.2", "3.4.3"),
]:
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace(a, b), encoding="utf-8")
p = root / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.4.3] - 2026-09-29

### 修复
- **打开白屏**：删除内嵌 SAMPLE 时残留 Markdown 碎片导致 `app.js` 语法错误
  - 清理残留并恢复可启动；`node --check` 通过

"""
if "## [3.4.3]" not in t:
    p.write_text(t.replace("## [3.4.2]", block + "## [3.4.2]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace("3.4.2", "3.4.3"), encoding="utf-8")
print("bumped 3.4.3")
