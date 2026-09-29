# -*- coding: utf-8 -*-
from pathlib import Path
root = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.4.1"', 'version = "3.4.2"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.4.1"', '"version": "3.4.2"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.4.1"', 'VERSION: &str = "3.4.2"'),
    ("scripts/bump_lock.py", "3.4.1", "3.4.2"),
]:
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace(a, b), encoding="utf-8")
    print(rel)

p = root / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.4.2] - 2026-09-29

### 架构
- **欢迎/示例不再写死在 app.js**：删除内嵌 `SAMPLE` 大字符串
- 统一从 **samples/** 经后端 `open_welcome` / `open_sample` 加载（与安装包共用一份文案）
- 版本号只维护在示例 Markdown，避免前端模板过期

"""
if "## [3.4.2]" not in t:
    p.write_text(t.replace("## [3.4.1]", block + "## [3.4.1]", 1), encoding="utf-8")
for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = root / rel
    p.write_text(p.read_text(encoding="utf-8").replace("3.4.1", "3.4.2"), encoding="utf-8")
    print(rel)

# selftest: no embedded SAMPLE
p = root / "scripts/selftest_3_0_0.py"
t = p.read_text(encoding="utf-8").replace("3.4.1", "3.4.2")
if "const SAMPLE" not in t:
    t += '\ncheck("const SAMPLE" not in app, "no embedded welcome SAMPLE in app.js")\ncheck("open_welcome" in app or "open_sample" in app, "welcome from backend samples")\n'
p.write_text(t, encoding="utf-8")
print("done")
