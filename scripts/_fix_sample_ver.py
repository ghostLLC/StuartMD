# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\js\app.js")
t = p.read_text(encoding="utf-8")
t = t.replace("const SAMPLE = # 欢迎使用 StuartMD", "const SAMPLE = `# 欢迎使用 StuartMD", 1)
# also ensure version line present
if "**当前版本：** 3.4.1" not in t:
    t = t.replace(
        "const SAMPLE = `# 欢迎使用 StuartMD\n",
        "const SAMPLE = `# 欢迎使用 StuartMD\n\n**当前版本：** 3.4.1\n",
        1,
    )
p.write_text(t, encoding="utf-8")
i = t.find("const SAMPLE")
print(repr(t[i : i + 80]))
# sanity: template closes later
print("backtick ok", "const SAMPLE = `" in t)
