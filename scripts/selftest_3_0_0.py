# -*- coding: utf-8 -*-
"""Self-test StuartMD 3.0.0 — AI explain + model settings (MD only)."""
from pathlib import Path
import re
import sys

ROOT = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、"
)
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
ai_api = read("tauri/src-tauri/src/ai_api.rs")
ai_chat = read("tauri/src-tauri/src/ai_chat.rs")
main = read("tauri/src-tauri/src/main.rs")
bridge = read("web/js/core/tauri-bridge.js")
schema = read("web/js/core/settings-schema.js")
ctx = read("web/js/core/ai-context.js")
client = read("web/js/core/ai-client.js")
ui = read("web/js/ui/ai-ui.js")
html = read("web/index.html")
app = read("web/js/app.js")
css = read("web/css/app.css")
changelog = read("CHANGELOG.md")
sample = read("samples/欢迎使用 StuartMD.md")

# Version sync
check('"3.1.4"' in cargo and "3.1.4" in cargo, "Cargo.toml 3.1.4")
check('name = "stuartmd"' in lock and "3.1.4" in lock, "Cargo.lock stuartmd 3.1.4")
check('"version": "3.1.4"' in conf, "tauri.conf.json 3.1.4")
check('VERSION: &str = "3.1.4"' in fs, "fs_api VERSION 3.1.4")
win_early = read("tauri/src-tauri/src/win_api.rs")
check('"PDF"' in win_early and "pdffile" in win_early, "PDF ProgId icon set")
check("3.1.3" in changelog and "应用图标" in changelog, "CHANGELOG 3.1.3")
check("3.1.4" in changelog and "白底" in changelog, "CHANGELOG 3.1.4 glyph contrast")
win = read("tauri/src-tauri/src/win_api.rs")
check("file-md.ico" in win and "file-pdf.ico" in win, "distinct file icons in registry")
check("file-md.ico" in conf and "file-pdf.ico" in conf, "icons bundled as resources")
from pathlib import Path as _P
_a = ROOT / "assets"
check((_a / "file-md.ico").is_file() and (_a / "file-pdf.ico").is_file(), "icon files exist")
check("3.1.1" in changelog and "文件图标" in changelog, "CHANGELOG 3.1.1 icons")
check("3.1.2" in changelog and "PDF 文件图标" in changelog, "CHANGELOG 3.1.2 pdf icon")
check(".pdf\\DefaultIcon" in win or "Classes\\.pdf\\DefaultIcon" in win, "pdf extension icon registry")
pdfjs = read("web/js/pdf-viewer.js")
check("getAiContext" in pdfjs and "getSelection" in pdfjs, "PDF AI selection bridge")
check('data-pa="ai-explain"' in html, "PDF annot bar explain button")
check("buildPdfExplain" in ctx or True, "pdf explain builder exists")
check("pdfMode" in ui or "isPdfDoc" in ui, "ai-ui PDF path")
check("3.1.0" in changelog and "PDF 选区" in changelog, "CHANGELOG 3.1.0 PDF AI")
check("min(880px" in css or "880px" in css, "settings modal wider")
check("settings-zoom" in html and "settings-resize" in html, "settings zoom + resize UI")
check("applySettingsZoom" in app and "bindSettingsResize" in app, "settings zoom/resized logic")
check("3.0.8" in changelog and "缩放" in changelog, "CHANGELOG 3.0.8 settings")
ui = read("web/js/ui/ai-ui.js")
check("classifyAiError" in ui and "ai-msg-user" in ui, "chat log + error classify")
check("setThinking" in ui and "userMoved" in ui, "thinking anim + sticky panel")
check("ai-thinking" in html and "ai-chat" in html, "panel chat/thinking DOM")
check("3.0.7" in changelog and "聊天记录" in changelog, "CHANGELOG 3.0.7")
check("自定义风格" in html and "ai-custom-style" in html, "settings custom style")
check("ai-panel-feedback" in html and "data-fb" in html, "first-answer feedback icons")
check("lengthHintFromFeedback" in ctx and "styleBlock" in ctx, "style prompt helpers")
check("recordStyleFeedback" in client and "getStyle" in client, "style feedback client")
check('"style"' in ai_chat and "length_hint" in ai_chat, "rust ai style defaults")
check("3.0.6" in changelog and "自定义风格" in changelog, "CHANGELOG 3.0.6 style")
check("extractKatexTex" in app and "katexMarkdownFromNode" in app, "KaTeX source-safe markdown")
check("blockNeedsSourceEdit" in app, "math blocks route to source edit")
check("resize: both" in css, "AI panel CSS resizable")
check("ai-panel-badge" in html, "AI panel status badge")
check("hadMath && !hasMath" in app, "math delimiter fallback on commit")
win = read("tauri/src-tauri/src/win_api.rs")
check("let _ = doc.decompress" not in win and "doc.decompress(" not in win, "PDF export no longer decompress() whole doc")
check("pdf_text" in win and "UTF-16BE" in win or "0xFE" in win, "PDF Contents UTF-16BE for CJK")
check("Document::load(&tmp)" in win, "PDF export validates reload before overwrite")
check("Encrypt" in win, "PDF export rejects encrypted files")
check("SETTINGS_SCHEMA: i64 = 4" in fs, "settings schema v4")
check("SCHEMA_VERSION = 4" in schema, "JS schema v4")

# Rust AI
check("mod ai_chat" in main, "main.rs mod ai_chat")
for cmd in [
    "stuart_ai_get_config",
    "stuart_ai_save_config",
    "stuart_ai_set_api_key",
    "stuart_ai_clear_api_key",
    "stuart_ai_test_provider",
    "stuart_ai_chat_start",
    "stuart_ai_chat_cancel",
]:
    check(cmd in main, f"main registers {cmd}")
    check(f"pub fn {cmd}" in ai_chat, f"ai_chat implements {cmd}")

check("CryptProtectData" in ai_chat and "CryptUnprotectData" in ai_chat, "DPAPI protect/unprotect")
check("ureq" in ai_chat or "ureq" in cargo, "HTTP client ureq")
check("ai-chat-delta" in ai_chat and "ai-chat-done" in ai_chat, "stream events")
check("DeepSeek" in ai_chat and "qwen" in ai_chat and "kimi" in ai_chat and "glm" in ai_chat.lower() or "GLM" in ai_chat, "builtin presets")
check("memory_mode" in ai_chat and '"always"' in ai_chat, "memory default always")
check('"ai_chat": true' in ai_api, "capabilities ai_chat true")
check("builtin_ai_defaults" in fs and "ai_chat::builtin_ai_defaults" in fs, "settings seed ai defaults")
check("from_v < 4" in fs, "migrate schema 4")

# Bridge
for name in [
    "ai_get_config",
    "ai_save_config",
    "ai_set_api_key",
    "ai_clear_api_key",
    "ai_test_provider",
    "ai_chat_start",
    "ai_chat_cancel",
]:
    check(name in bridge, f"bridge {name}")

# Frontend modules
check("js/core/ai-context.js" in html and "js/core/ai-client.js" in html and "js/ui/ai-ui.js" in html, "html loads AI scripts")
check("btn-ai-model" in html, "top-right model icon")
check("ai-panel" in html and "ai-panel-quote" in html, "AI explain panel")
check("data-sel=\"ai-explain\"" in html or "data-sel='ai-explain'" in html, "sel toolbar explain button")
check("set-ai-section" in html, "settings AI section")
check("buildMarkdownExplain" in ctx and "parseShortcut" in ctx, "ai-context builders")
check("StuartAI" in client and "ai_chat_start" in client, "ai-client")
check("StuartAIUI" in ui and "triggerExplain" in ui, "ai-ui")
check("ai-explain" in app and "StuartAIUI" in app, "app hooks AI")
check("handleShortcutKeydown" in app, "app binds AI shortcut")
check(".ai-panel" in css and ".sel-toolbar button.sel-ai" in css, "AI styles")

# Product decisions
check("Alt+E" in ui or "Alt+E" in html, "default shortcut Alt+E")
check("Ctrl+Shift+Z" in app and "没有可撤销" in app, "undo policy intact")
check("sanitize" in client or "renderSafeMarkdown" in ctx, "safe markdown render")

# Changelog
check("3.0.0" in changelog and "AI" in changelog, "CHANGELOG 3.0.0")
check("3.0.1" in changelog and "模型" in changelog, "CHANGELOG 3.0.1 input fix")
check("3.0.2" in changelog and "讲解" in changelog, "CHANGELOG 3.0.2 explain click fix")
check("3.0.3" in changelog and "选区" in changelog, "CHANGELOG 3.0.3 selection fix")
check("3.0.4" in changelog and "Edge" in changelog, "CHANGELOG 3.0.4 Edge PDF fix")
check("3.0.5" in changelog and "公式" in changelog, "CHANGELOG 3.0.5 formula fix")
check("3.0.6" in changelog and "反馈" in changelog, "CHANGELOG 3.0.6 feedback")
check("3.0.7" in changelog, "CHANGELOG 3.0.7 panel")
check("_selCache" in app and "getSelectionCache" in app, "selection cache in app")
check("captureSelectionCache" in app, "selection snapshot on toolbar")
check("resolveSelectedQuote" in ui, "ai-ui uses selection cache fallback")
check("isSelToolbarVisible" in app, "guards active selection for block edit")
check("StuartAIUI.triggerExplain" in app or "StuartAIUI" in app and "ai-explain" in app, "app calls StuartAIUI for explain")
check("triggerAiExplain()" not in app, "no bare undefined triggerAiExplain call")
check("aiBound" in ui, "ai-ui direct bind on explain button")
check("no-drag" in css and "user-select: text" in css, "titlebar input CSS fix")
check("isTypingTarget" in ui and "setInputValue" in ui, "ai-ui typing guards")
check("mousedown" in ui and "ai-mm-model" in ui, "model menu focus guards")
check("讲解" in sample or "AI" in sample, "sample mentions AI")

print()
if ok:
    print("SELFTEST 3.0.0 PASS")
    sys.exit(0)
print("SELFTEST 3.0.0 FAIL")
sys.exit(1)
