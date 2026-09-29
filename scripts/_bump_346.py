# -*- coding: utf-8 -*-
from pathlib import Path
root = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.5"', 'version = "3.4.6"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.5"', '"version": "3.4.6"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.5"', 'VERSION: &str = "3.4.6"'),
    ("scripts/bump_lock.py", "3.4.5", "3.4.6"),
]:
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace(a, b), encoding="utf-8")
    print(rel)
p = root / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.4.6] - 2026-09-29

### 修复
- **记忆点击无反应**：`showMemoryDetail` 未注入导致点击 ReferenceError；已补全（查看 / 返回 / 删除）
- **首开窗口过大**：默认 1100×720，并按屏幕钳制恢复尺寸

"""
if "## [3.4.6]" not in t:
    p.write_text(t.replace("## [3.4.5]", block + "## [3.4.5]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace("3.4.5", "3.4.6"), encoding="utf-8")
print("done")
