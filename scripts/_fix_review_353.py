# -*- coding: utf-8 -*-
from pathlib import Path

APP = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\.worktrees\ux-smooth-edit\web\js\app.js")
CSS = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD\.worktrees\ux-smooth-edit\web\css\app.css")

t = APP.read_text(encoding="utf-8")

# 1) commitBlockSource returns {ok, index}
t = t.replace(
    """        toast("编辑未能定位原块，已保留原文（请撤销后重试）");
        return false;
      }
    }
    // Slot must still hold what we opened; otherwise the index drifted onto
    // different content — refuse to overwrite unknown source.
    const current = all[idx] == null ? "" : String(all[idx]);
    if (snap.trim() && current !== snap) {
      const hit = all.findIndex((b) => b === snap);
      if (hit >= 0) {
        idx = hit;
      } else if (current.trim()) {
        toast("编辑未能定位原块，已保留原文（请撤销后重试）");
        return false;
      }
    }""",
    """        toast("编辑未能定位原块，已保留原文（请撤销后重试）");
        return { ok: false, index: -1 };
      }
    }
    // Slot must still hold what we opened; otherwise the index drifted onto
    // different content — refuse to overwrite unknown source.
    const current = all[idx] == null ? "" : String(all[idx]);
    if (snap.trim() && current !== snap) {
      const hit = all.findIndex((b) => b === snap);
      if (hit >= 0) {
        idx = hit;
      } else if (current.trim()) {
        toast("编辑未能定位原块，已保留原文（请撤销后重试）");
        return { ok: false, index: -1 };
      }
    }""",
    1,
)

t = t.replace(
    """    if (next === all[idx]) {
      return true;
    }
    const prev = el.source.value || "";
    if (prev) pushHistory(prev);
    all[idx] = next;
    const joined = joinBlocks(all);
    el.source.value = joined;
    state.content = joined;
    markDirty();
    scheduleAutoSave();
    pushHistory(joined);
    return true;
  }""",
    """    if (next === all[idx]) {
      return { ok: true, index: idx };
    }
    const prev = el.source.value || "";
    if (prev) pushHistory(prev);
    all[idx] = next;
    const joined = joinBlocks(all);
    el.source.value = joined;
    state.content = joined;
    markDirty();
    scheduleAutoSave();
    pushHistory(joined);
    return { ok: true, index: idx };
  }""",
    1,
)

# 2) call sites: written = commitBlockSource; if (!written.ok)
# There are 4 "const ok = commitBlockSource" patterns with different following uses.
t = t.replace("const ok = commitBlockSource(", "const written = commitBlockSource(")
# Fix truthiness checks that used ok
# Pattern varies: if (!ok) { ... }
# After rename, we need if (!written.ok) and use written.index for rebuild.
# Careful multi-replace for each site.

# Generic: any remaining `if (!ok)` after written rename might refer to other vars.
# Read structure: each site does `const written = commitBlockSource(...); if (!ok)`
# So replace nearby is wrong. Let's do regex on `if (!ok)` only after written assignments.
import re
t = re.sub(
    r"(const written = commitBlockSource\([^;]+;\s*\n\s*)if \(!ok\)",
    r"\1if (!written.ok)",
    t,
)

# rebuildBlockNodeInPlace(..., idx) in table commit should use written.index
# Only the table path uses rebuild after commitBlockSource.
t = t.replace(
    """        if (!restoreBlockDomQuiet(node, cells)) {
          rebuildBlockNodeInPlace(node, el.source.value || "", idx);
        }""",
    """        if (!restoreBlockDomQuiet(node, cells)) {
          rebuildBlockNodeInPlace(node, el.source.value || "", written.index);
        }""",
    1,
)
t = t.replace(
    """      rebuildBlockNodeInPlace(node, el.source.value || "", idx);
      emitAgentEvent("document-changed", { source: "table-edit" });""",
    """      rebuildBlockNodeInPlace(node, el.source.value || "", written.index);
      emitAgentEvent("document-changed", { source: "table-edit" });""",
    1,
)

# 3) rebuildBlockNodeInPlace: attachCodeLangBadges after innerHTML
t = t.replace(
    """      node.innerHTML = sanitizeHtmlStrict(renderBlockHtml(src));
      if (blockNeedsPostProcess(src)) {
        try {
          postProcessBlock(node);
        } catch (_) {}
      }""",
    """      node.innerHTML = sanitizeHtmlStrict(renderBlockHtml(src));
      try {
        attachCodeLangBadges(node);
      } catch (_) {}
      if (blockNeedsPostProcess(src)) {
        try {
          postProcessBlock(node);
        } catch (_) {}
      }""",
    1,
)

# 4) comment ::after -> ::before if present
t = t.replace("via ::after", "via ::before")

APP.write_text(t, encoding="utf-8")
print("ok returns", t.count("{ ok: true, index: idx }"), t.count("{ ok: false, index: -1 }"))
print("written.ok checks", t.count("if (!written.ok)"))
print("stale ok leftover", t.count("const ok = commitBlockSource"))
print("written.index rebuild", t.count("written.index"))

c = CSS.read_text(encoding="utf-8")
c = c.replace("box-sizing: content-box;", "box-sizing: border-box;", 1)
# mermaid: don't force width 100% on small diagrams
c = c.replace(
    "  max-width: 100% !important;\n  width: 100%;",
    "  max-width: 100% !important;\n  width: auto;",
    1,
)
CSS.write_text(c, encoding="utf-8")
print("box-sizing left content-box", c.count("box-sizing: content-box;"))
print("width auto mermaid", "width: auto;" in c)
print("DONE")
