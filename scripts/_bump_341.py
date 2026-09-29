# -*- coding: utf-8 -*-
from pathlib import Path
root = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.0"', 'version = "3.4.1"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.0"', '"version": "3.4.1"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.0"', 'VERSION: &str = "3.4.1"'),
    ("scripts/bump_lock.py", "3.4.0", "3.4.1"),
]:
    p = root / rel
    t = p.read_text(encoding="utf-8")
    p.write_text(t.replace(a, b), encoding="utf-8")
    print("OK", rel)

p = root / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.4.1] - 2026-09-29

### 修复
- **欢迎页版本过期**：内嵌欢迎模板与安装包示例仍显示 3.2.0
  - 欢迎模板增加 **当前版本 3.4.1**，samples 同步打包
  - 发布纪律：README + 软件内示例每次更新必同步

"""
if "## [3.4.1]" not in t:
    p.write_text(t.replace("## [3.4.0]", block + "## [3.4.0]", 1), encoding="utf-8")
    print("OK CHANGELOG")

for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = root / rel
    t = p.read_text(encoding="utf-8").replace("3.4.0", "3.4.1")
    p.write_text(t, encoding="utf-8")
    print("OK", rel)

p = root / "scripts/selftest_3_0_0.py"
t = p.read_text(encoding="utf-8").replace("3.4.0", "3.4.1")
if "当前版本" not in t:
    t += '\ncheck("当前版本" in app and "3.4.1" in app, "welcome SAMPLE version")\n'
p.write_text(t, encoding="utf-8")
print("done")
