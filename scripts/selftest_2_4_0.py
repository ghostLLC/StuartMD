# -*- coding: utf-8 -*-
"""Self-test StuartMD 2.4.0 — AI prep + hardening (no UX change)."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
ok = True


def fail(msg):
    global ok
    ok = False
    print("FAIL:", msg)


def check(cond, msg):
    if cond:
        print("OK  :", msg)
    else:
        fail(msg)


app = (ROOT / "web/js/app.js").read_text(encoding="utf-8")
agent = (ROOT / "web/js/core/agent-api.js").read_text(encoding="utf-8")
bridge = (ROOT / "web/js/core/tauri-bridge.js").read_text(encoding="utf-8")
plugins = (ROOT / "web/js/plugins.js").read_text(encoding="utf-8")
html = (ROOT / "web/index.html").read_text(encoding="utf-8")
pdf = (ROOT / "web/js/pdf-viewer.js").read_text(encoding="utf-8")
fs = (ROOT / "tauri/src-tauri/src/fs_api.rs").read_text(encoding="utf-8")
ai = (ROOT / "tauri/src-tauri/src/ai_api.rs").read_text(encoding="utf-8")
main = (ROOT / "tauri/src-tauri/src/main.rs").read_text(encoding="utf-8")
win = (ROOT / "tauri/src-tauri/src/win_api.rs").read_text(encoding="utf-8")
conf = (ROOT / "tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
cargo = (ROOT / "tauri/src-tauri/Cargo.toml").read_text(encoding="utf-8")
lock = (ROOT / "tauri/src-tauri/Cargo.lock").read_text(encoding="utf-8")
changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
sample = (ROOT / "samples/欢迎使用 StuartMD.md").read_text(encoding="utf-8")

# AI facade
check("StuartAgent" in agent and "global.Stuart = agent" in agent, "StuartAgent facade exported")
check("registerTool" in agent and "memory_set" in agent, "agent has tools + memory")
check("js/core/agent-api.js" in html, "index.html loads agent-api.js")
check("window.StuartMD = {" in app and "setDocumentText" in app, "host expands StuartMD")
check("emitAgentEvent" in app and "document-changed" in app, "host emits agent events")
check("registerTool" in plugins, "plugins expose registerTool")

# Bridge + backend AI surface
for name in [
    "get_capabilities",
    "memory_list",
    "memory_set",
    "search_md",
    "workspace_files",
    "ai_home",
]:
    check(name in bridge, f"bridge has {name}")
    check(f"stuart_{name}" in main or name.replace("get_capabilities", "get_capabilities") in main, f"main registers related {name}")

check("stuart_get_capabilities" in main and "ai_api::" in main, "main registers ai_api commands")
check("stuart_memory_set" in ai and "sanitize_memory_key" in ai, "ai_api memory implemented")
check("stuart_search_md" in ai and "SEARCH_MAX_FILES" in ai, "ai_api workspace search implemented")

# Hardening
check('starts_with("http://")' in fs or 'starts_with("http://") || u.starts_with("https://")' in fs, "open_url strict scheme")
check("export_safe_name" in fs and "is_under_plugin_dir" in fs, "export + plugin path guards")
check("SETTINGS_LOCK" in fs and "load_settings_migrated_unlocked" in fs, "settings mutex + unlocked helper")
check("encoding" in fs and "from_utf8_lossy" in fs, "read_file no silent empty UTF-8")
check("MAX_NODES" in fs, "walk_md node cap")
check("WALLPAPER_MAX" in fs and "WALLPAPER_MAX" in win, "wallpaper size cap")
check("contains(\"..\")" in win or 'contains("..")' in win, "resolve_asset blocks traversal")

# Frontend safety
check("sanitizeRenderedHtml" in app, "preview sanitizes executable HTML")
check("state._openSeq" in app, "open race guard")
check("state.path !== path" in app, "autosave stale-write guard")
check("maxBytes" in app, "history byte cap")
check("cleanupDocDown" in app, "block-edit listener cleanup")
check("disposeDoc" in pdf, "pdf doc dispose")
check("search_md" in app, "folder search prefers backend")

# Product policy preserved
check("Ctrl+Shift+Z" in app or "Ctrl+Shift+Z = undo" in app or "Product policy" in app, "Shift+Z remains undo (product policy)")

# Versions
check('"version": "2.4.0"' in conf, "tauri.conf 2.4.0")
check('version = "2.4.0"' in cargo, "Cargo.toml 2.4.0")
check(re.search(r'name = "stuartmd"\nversion = "2\.4\.0"', lock), "Cargo.lock 2.4.0")
check('VERSION: &str = "2.4.0"' in fs, "fs VERSION 2.4.0")
check("2.4.0" in changelog and "StuartAgent" in changelog, "CHANGELOG 2.4.0")
check("2.4.0" in sample, "sample welcome 2.4.0")

print()
if ok:
    print("SELF-TEST PASSED")
    sys.exit(0)
print("SELF-TEST FAILED")
sys.exit(1)
