from pathlib import Path
import re

p = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、\tauri\src-tauri\Cargo.lock"
)
t = p.read_text(encoding="utf-8")
t2, n = re.subn(
    r'(name = "stuartmd"\r?\nversion = ")[^"]+(")',
    r"\g<1>3.1.6\g<2>",
    t,
    count=1,
)
print("replacements", n)
if n:
    p.write_text(t2, encoding="utf-8")
    print("updated")
else:
    i = t.find('name = "stuartmd"')
    print("pattern not found", repr(t[i : i + 60]))
