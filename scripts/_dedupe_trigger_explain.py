# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
p = ROOT / "web" / "js" / "ui" / "ai-ui.js"
t = p.read_text(encoding="utf-8")
# Keep first triggerExplain, drop the second duplicate up to handleShortcutKeydown
first = t.find("  async function triggerExplain(opts)")
second = t.find("  async function triggerExplain(opts)", first + 10)
end = t.find("  function handleShortcutKeydown")
print("first", first, "second", second, "end", end)
if second > 0 and end > second:
    t = t[:second] + t[end:]
    p.write_text(t, encoding="utf-8")
    print("removed duplicate triggerExplain")
elif second < 0:
    print("no duplicate")
else:
    raise SystemExit("unexpected layout")
# sanity
t2 = p.read_text(encoding="utf-8")
assert t2.count("async function triggerExplain") == 1
assert "isPdfDoc" in t2
print("ok count", t2.count("async function triggerExplain"))
