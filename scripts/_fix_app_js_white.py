# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\js\app.js")
lines = p.read_text(encoding="utf-8").splitlines(keepends=True)
# find welcome marker
start = None
for i, line in enumerate(lines):
    if "Welcome sample" in line:
        start = i
        break
if start is None:
    raise SystemExit("marker not found")
# find settings modal after it
end = None
for i in range(start + 1, min(start + 80, len(lines))):
    if "Settings modal" in lines[i]:
        end = i
        break
if end is None:
    raise SystemExit("settings marker not found")
new_block = [
    "  // ---------- Welcome sample ----------\n",
    "  // Content is loaded from samples/ via backend open_welcome() / open_sample().\n",
    "\n",
    "  // ---------- Settings modal ----------\n",
]
lines[start : end + 1] = new_block
p.write_text("".join(lines), encoding="utf-8")
print("patched lines", start, end, "newlen", p.stat().st_size)
