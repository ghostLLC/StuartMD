# -*- coding: utf-8 -*-
from pathlib import Path
p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\css\app.css")
t = p.read_text(encoding="utf-8")
a = t.replace("min-height: 200px;", "min-height: 4.8em;", 1)
b = a.replace("  min-height: 180px;\n}", "}", 1)
if b == a and "min-height: 180px" in a:
    b = a.replace("  min-height: 180px;\r\n}", "}", 1)
# also try without requiring closing brace on next line
if "min-height: 180px" in b:
    b = b.replace("min-height: 180px", "min-height: 4.8em", 1)
# focus-visible global
if ":focus-visible" not in b:
    b = b.rstrip() + """

/* Keyboard focus affordance (was missing globally). */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
"""
p.write_text(b, encoding="utf-8")
print("200px left", b.count("min-height: 200px"))
print("180px left", b.count("min-height: 180px"))
print("focus-visible", b.count(":focus-visible"))
print("bg-soft in md-block-source?", "background: var(--bg-soft);" in b[b.find(".md-block-source"):b.find(".md-block-source")+400])
print("OK")
