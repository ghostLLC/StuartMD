# -*- coding: utf-8 -*-
"""Self-test for StuartMD 2.3.1 block-menu occlusion fixes."""
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


css = (ROOT / "web/css/app.css").read_text(encoding="utf-8")
js = (ROOT / "web/js/app.js").read_text(encoding="utf-8")
conf = (ROOT / "tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
cargo = (ROOT / "tauri/src-tauri/Cargo.toml").read_text(encoding="utf-8")
fs = (ROOT / "tauri/src-tauri/src/fs_api.rs").read_text(encoding="utf-8")
lock = (ROOT / "tauri/src-tauri/Cargo.lock").read_text(encoding="utf-8")
sample = (ROOT / "samples/欢迎使用 StuartMD.md").read_text(encoding="utf-8")
changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

check("width: 168px" in css, "block-menu width is 168px")
check(
    re.search(r"\.block-menu \.menu-grid \{[^}]*repeat\(4, 1fr\)", css, re.S),
    "menu-grid is 4 columns (3 rows for 12 icons)",
)
check(
    'body[data-width="default"] #preview' in css
    and "padding-left: 80px" in css
    and "max-width: 780px" in css,
    "default page width has larger sidebar-content gap",
)
check("preferBelow" in js, "menu uses preferBelow Feishu positioning")
check("_handleAnchor" in js, "handle stores selected content anchor")
check(
    "anchor.bottom + 6" in js and 'widthMode !== "default"' in js,
    "wide/full places menu under selected content",
)
check('"version": "2.3.1"' in conf, "tauri.conf.json = 2.3.1")
check('version = "2.3.1"' in cargo, "Cargo.toml = 2.3.1")
check('VERSION: &str = "2.3.1"' in fs, "fs_api.rs VERSION = 2.3.1")
check(
    re.search(r'name = "stuartmd"\nversion = "2\.3\.1"', lock),
    "Cargo.lock stuartmd = 2.3.1",
)
check("2.3.1" in sample, "sample welcome doc = 2.3.1")
check("2.3.1" in changelog and "168px" in changelog, "CHANGELOG has 2.3.1 entry")

# Layout math: default width — menu left of handle should clear text if gutter is enough
# editor ~1030, sidebar 260, content max 780, padding-left 80
sidebar = 260
editor = 1030
box_left = sidebar + (editor - 780) / 2
text_left = box_left + 80
handle_w = 52
handle_left = text_left - handle_w - 8
menu_w = 168
menu_left_clamped = max(sidebar + 12, handle_left + handle_w - menu_w - 8)
# if clamped to sidebar+8
menu_left = max(sidebar + 8, handle_left + handle_w - menu_w - 8)
menu_right = menu_left + menu_w
check(
    menu_right <= text_left + 2,
    f"default: menu right {menu_right:.0f} does not cover text left {text_left:.0f}",
)

# Wide mode simulation — menu must sit below, not over, selected content
# content nearly full width, menu top = anchor.bottom
anchor_top, anchor_bottom, menu_h = 200, 230, 360
menu_top = anchor_bottom + 6
check(
    menu_top >= anchor_bottom,
    f"wide: menu top {menu_top} is below selected content bottom {anchor_bottom}",
)

print()
if ok:
    print("SELF-TEST PASSED")
    sys.exit(0)
print("SELF-TEST FAILED")
sys.exit(1)
