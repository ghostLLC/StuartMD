from pathlib import Path

p = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、\web\js\app.js"
)
t = p.read_text(encoding="utf-8")

# 1) applyBlockEditing uses cached split
old = "    const blocks = splitMarkdownBlocks(raw);\n    if (!blocks.length) {\n      el.preview.innerHTML = \"\";\n      lastPreviewBlocks = [];\n      return;\n    }\n\n    const prev = lastPreviewBlocks;"
new = "    const blocks = splitBlocksCached(raw);\n    if (!blocks.length) {\n      el.preview.innerHTML = \"\";\n      lastPreviewBlocks = [];\n      return;\n    }\n\n    const prev = lastPreviewBlocks;"
if old not in t:
    print("split cache replace failed")
else:
    t = t.replace(old, new, 1)
    print("split cache ok")

# 2) insert postProcessBlocks after postProcessBlock function
needle = """      } catch (_) {}
    }
  }

  function applyBlockEditing() {"""
insert = """      } catch (_) {}
    }
  }

  function postProcessBlocks(nodes) {
    if (!nodes || !nodes.length) return;
    const SYNC = 6;
    for (let i = 0; i < nodes.length && i < SYNC; i++) postProcessBlock(nodes[i]);
    if (nodes.length > SYNC) {
      scheduleIdle(() => {
        for (let i = SYNC; i < nodes.length; i++) {
          if (nodes[i].isConnected) postProcessBlock(nodes[i]);
        }
      });
    }
  }

  function applyBlockEditing() {"""
if needle not in t:
    print("insert postProcessBlocks failed")
    i = t.find("function applyBlockEditing")
    print(repr(t[i-80:i+40]))
else:
    t = t.replace(needle, insert, 1)
    print("postProcessBlocks ok")

# 3) tighten blockNeedsPostProcess $ check
old_pp = '''    if (!block) return false;
    if (block.indexOf("$") >= 0) return true;
    if (block.indexOf("\\\\(") >= 0 || block.indexOf("\\\\[") >= 0) return true;
    if (/!\\[[^\\]]*\\]\\(/.test(block)) return true;
    return false;
  }'''
new_pp = '''    if (!block) return false;
    if (block.indexOf("\\\\(") >= 0 || block.indexOf("\\\\[") >= 0) return true;
    if (/!\\[[^\\]]*\\]\\(/.test(block)) return true;
    if (/(^|[^\\\\A-Za-z0-9])\\$\\$/.test(block) || /(^|[^\\\\A-Za-z0-9])\\$[^$\\n]+\\$/.test(block)) {
      return true;
    }
    return false;
  }'''
if old_pp not in t:
    print("pp replace failed")
    i = t.find("function blockNeedsPostProcess")
    print(repr(t[i:i+280]))
else:
    t = t.replace(old_pp, new_pp, 1)
    print("pp ok")

p.write_text(t, encoding="utf-8")
print("done")
