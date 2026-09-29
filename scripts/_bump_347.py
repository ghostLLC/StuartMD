# -*- coding: utf-8 -*-
from pathlib import Path
root = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.6"', 'version = "3.4.7"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.6"', '"version": "3.4.7"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.6"', 'VERSION: &str = "3.4.7"'),
    ("scripts/bump_lock.py", "3.4.6", "3.4.7"),
]:
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace(a, b), encoding="utf-8")
p = root / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.4.7] - 2026-09-29

### 伴读 · 记忆
- **可手动编辑**：详情页改为文本编辑 + **保存**（`memory_set`）
- 「返回列表」改为「**返回**」
- **偏好 / 备忘筛选互斥**：避免同一条记忆在两个 Tab 重复出现
  - 偏好：`user_profile` / `*profile*` / `*prefs*`
  - 备忘：其余（活动、笔记等）

"""
if "## [3.4.7]" not in t:
    p.write_text(t.replace("## [3.4.6]", block + "## [3.4.6]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace("3.4.6", "3.4.7"), encoding="utf-8")
print("3.4.7")
