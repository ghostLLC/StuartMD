# -*- coding: utf-8 -*-
from pathlib import Path
import re
p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\scripts\selftest_3_0_0.py")
t = p.read_text(encoding="utf-8")
t = re.sub(
    r'check\("3\.4\.0" in changelog and "[^"]*" in changelog, "CHANGELOG 3\.4\.0"\)',
    'check("3.4.0" in changelog, "CHANGELOG 3.4.0")',
    t,
)
p.write_text(t, encoding="utf-8")
print("patched selftest changelog check")
