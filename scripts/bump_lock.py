from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
p = ROOT / "tauri" / "src-tauri" / "Cargo.lock"
t = p.read_text(encoding="utf-8")
t2, n = re.subn(
    r'(name = "stuartmd"\r?\nversion = ")[^"]+(")',
    r"\g<1>3.3.0\g<2>",
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
