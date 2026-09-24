# -*- coding: utf-8 -*-
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.1.8"', 'version = "3.1.9"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.1.8"', '"version": "3.1.9"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.1.8"', 'VERSION: &str = "3.1.9"'),
    ("scripts/bump_lock.py", "3.1.8", "3.1.9"),
]:
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    p.write_text(t.replace(a, b, 1) if a in t else t, encoding="utf-8")
p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.1.9] - 2026-09-21

### 交互
- **取消 AI 输出自动滚底**：面板较小，自动跟随导致看不过来；改为完全手动滚动
- 开始新一次问答时仅回到顶部，便于从引文读起

"""
if "## [3.1.9]" not in t:
    p.write_text(t.replace("## [3.1.8]", block + "## [3.1.8]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = ROOT / rel
    p.write_text(p.read_text(encoding="utf-8").replace("3.1.8", "3.1.9"), encoding="utf-8")
print("ok")
