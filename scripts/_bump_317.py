# -*- coding: utf-8 -*-
from pathlib import Path
ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.1.6"', 'version = "3.1.7"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.1.6"', '"version": "3.1.7"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.1.6"', 'VERSION: &str = "3.1.7"'),
    ("scripts/bump_lock.py", "3.1.6", "3.1.7"),
]:
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    p.write_text(t.replace(a, b, 1) if a in t else t, encoding="utf-8")
    print(rel, "ok")
p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.1.7] - 2026-09-21

### 交互
- AI 入口改为**纯图标**（MD / PDF 同一星形图标，无文字）；悬停提示「AI 问答」

"""
if "## [3.1.7]" not in t:
    p.write_text(t.replace("## [3.1.6]", block + "## [3.1.6]", 1), encoding="utf-8")
p = ROOT / "README.md"
t = p.read_text(encoding="utf-8").replace("3.1.6", "3.1.7")
p.write_text(t, encoding="utf-8")
p = ROOT / "samples/欢迎使用 StuartMD.md"
t = p.read_text(encoding="utf-8").replace("3.1.6", "3.1.7")
p.write_text(t, encoding="utf-8")
print("docs ok")
