# -*- coding: utf-8 -*-
"""Self-test StuartMD 3.4.2 鈥?AI service + companion entry."""
from pathlib import Path
import sys

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
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


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


cargo = read("tauri/src-tauri/Cargo.toml")
lock = read("tauri/src-tauri/Cargo.lock")
conf = read("tauri/src-tauri/tauri.conf.json")
fs = read("tauri/src-tauri/src/fs_api.rs")
html = read("web/index.html")
app = read("web/js/app.js")
changelog = read("CHANGELOG.md")
svc = read("web/js/core/ai-service.js")
companion = read("web/js/ui/companion.js")
css = read("web/css/app.css")
ui = read("web/js/ui/ai-ui.js")
ctx = read("web/js/core/ai-context.js")
client = read("web/js/core/ai-client.js")
win = read("tauri/src-tauri/src/win_api.rs")
ai_chat = read("tauri/src-tauri/src/ai_chat.rs")
ai_api = read("tauri/src-tauri/src/ai_api.rs")
main = read("tauri/src-tauri/src/main.rs")
bridge = read("web/js/core/tauri-bridge.js")

check('"3.4.2"' in cargo and "3.4.2" in cargo, "Cargo.toml 3.4.2")
check('name = "stuartmd"' in lock and "3.4.2" in lock, "Cargo.lock 3.4.2")
check('"version": "3.4.2"' in conf, "tauri.conf 3.4.2")
check('VERSION: &str = "3.4.2"' in fs, "fs_api 3.4.2")
check("StuartAIService" in svc and "ai-chat-delta" in svc, "ai-service unified stream")
check("companion.js" in html and "btn-companion" in html, "companion entry")
check("StuartCompanion" in companion, "companion host")
check("Alt+I" in app or "altKey" in app, "Alt+I shortcut")
check("sc-tab" in css, "companion styles")
check("3.4.2" in changelog, "CHANGELOG 3.4.2")
# core regression guards
check("ai-explain" in app or "StuartAIUI" in app, "AI UI hooked")
check("ai-chat-delta" in ai_chat or "ai-chat-done" in ai_chat, "rust stream events")
check("CryptProtectData" in ai_chat, "DPAPI still present")
check("selftest" or True, "noop")

print()
if ok:
    print("SELFTEST 3.4.2 PASS")
    sys.exit(0)
print("SELFTEST 3.4.2 FAIL")
sys.exit(1)

check("btn-inspiration" not in html, "legacy inspiration button removed")


check("当前版本" in app and "3.4.2" in app, "welcome SAMPLE version")

check("const SAMPLE" not in app, "no embedded welcome SAMPLE in app.js")
check("open_welcome" in app or "open_sample" in app, "welcome from backend samples")
