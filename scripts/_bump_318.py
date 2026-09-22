# -*- coding: utf-8 -*-
from pathlib import Path
ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.1.7"', 'version = "3.1.8"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.1.7"', '"version": "3.1.8"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.1.7"', 'VERSION: &str = "3.1.8"'),
    ("scripts/bump_lock.py", "3.1.7", "3.1.8"),
]:
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    p.write_text(t.replace(a, b, 1) if a in t else t, encoding="utf-8")
p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.1.8] - 2026-09-21

### 修复：AI 窗口拉高出现底部空白
- 正文区去掉 `max-height` 限制，拉高面板时正文跟随占满
- 统一 flex 布局：头/引文/操作条固定，正文 `flex:1` 撑满剩余高度

"""
if "## [3.1.8]" not in t:
    p.write_text(t.replace("## [3.1.7]", block + "## [3.1.7]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = ROOT / rel
    p.write_text(p.read_text(encoding="utf-8").replace("3.1.7", "3.1.8"), encoding="utf-8")
print("ok")
