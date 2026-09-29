# -*- coding: utf-8 -*-
"""Remove hardcoded SAMPLE welcome from app.js — load from samples via backend."""
from pathlib import Path
import re

p = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\web\js\app.js")
t = p.read_text(encoding="utf-8")

# Drop const SAMPLE = ` ... `;
start = t.find("  const SAMPLE = `")
if start < 0:
    raise SystemExit("SAMPLE block not found")
end = t.find("`;", start)
if end < 0:
    raise SystemExit("SAMPLE end not found")
end = end + 2
# also remove following blank line
while end < len(t) and t[end] == "\n":
    end += 1
    if end < len(t) and t[end] == "\n":
        end += 1
        break
t = t[:start] + t[end:]

# openSampleDirect: remove SAMPLE fallback
t = t.replace(
    """    if (typeof SAMPLE === "string") {
      state.isSampleDoc = true;
      setDocument({ path: null, name: "欢迎使用 StuartMD.md", content: SAMPLE, welcome: true });
      hideBootSplash();
      return true;
    }
    return false;
  }""",
    """    // Welcome content comes from samples/欢迎使用 StuartMD.md (backend open_welcome)
    toast("无法读取示例文档，请检查安装目录 samples");
    hideBootSplash();
    return false;
  }""",
    1,
)

# openSample without api: do not embed SAMPLE
t = t.replace(
    """    if (!state.apiReady) {
      state.isSampleDoc = true;
      state.sampleDismissed = false;
      setDocument({ path: null, name: "示例文档.md", content: SAMPLE });
      setMode("preview");
      return;
    }""",
    """    if (!state.apiReady) {
      toast("应用尚未就绪，请稍候再试");
      return;
    }""",
    1,
)

# any remaining setDocument(... SAMPLE ...)
t = t.replace(
    'setDocument({ path: null, name: "欢迎使用 StuartMD.md", content: SAMPLE, welcome: true });',
    "/* welcome loaded via open_welcome() */",
)
t = t.replace(
    'setDocument({ path: null, name: "示例文档.md", content: SAMPLE });',
    "/* sample loaded via open_sample() */",
)

if "const SAMPLE" in t or "content: SAMPLE" in t:
    print("WARN leftover SAMPLE refs")
    for m in re.finditer(r".{0,50}SAMPLE.{0,50}", t):
        print(" ", m.group(0).replace("\n", " ")[:100])
else:
    print("SAMPLE fully removed from app.js")

p.write_text(t, encoding="utf-8")
print("app.js bytes", len(t))
