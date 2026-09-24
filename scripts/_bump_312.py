# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def rep(rel, old, new):
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    if old not in t:
        print("MISS", rel, repr(old[:40]))
    else:
        p.write_text(t.replace(old, new, 1), encoding="utf-8")
        print("OK", rel)

rep("tauri/src-tauri/Cargo.toml", 'version = "3.1.1"', 'version = "3.1.2"')
rep("tauri/src-tauri/tauri.conf.json", '"version": "3.1.1"', '"version": "3.1.2"')
rep("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.1.1"', 'VERSION: &str = "3.1.2"')

p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.1.2] - 2026-09-21

### 修复：PDF 文件图标
- **根因**：资源管理器绘制 `.pdf` 跟随默认程序（常见 MSEdgePDF）图标，而非 StuartMD.PDF 的 DefaultIcon
- 写入 `Software\\Classes\\.pdf\\DefaultIcon` → `file-pdf.ico,0`
- ICO 改为经典多尺寸 BMP 帧，避免 shell 加载失败回退为 stuartmd.exe 图标
- DefaultIcon 统一带 `,0`；注册后刷新关联（SHChangeNotify）

"""
if "## [3.1.2]" not in t:
    t = t.replace("## [3.1.1]", block + "## [3.1.1]", 1)
    p.write_text(t, encoding="utf-8")
    print("OK CHANGELOG")

for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    t = t.replace("3.1.1", "3.1.2").replace("3.1.0", "3.1.2")
    p.write_text(t, encoding="utf-8")
    print("OK", rel)

# SHChangeNotify in win_api if missing
p = ROOT / "tauri/src-tauri/src/win_api.rs"
t = p.read_text(encoding="utf-8")
if "SHChangeNotify" not in t:
    needle = '        json!({"ok": true, "registered": true, "md": true, "pdf": true, "command": cmd})'
    insert = """        // Refresh Explorer association icons without reboot
        {
            use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
            unsafe {
                SHChangeNotify(
                    SHCNE_ASSOCCHANGED,
                    SHCNF_IDLIST,
                    std::ptr::null(),
                    std::ptr::null(),
                );
            }
        }

"""
    if needle not in t:
        print("MISS json return line")
    else:
        t = t.replace(needle, insert + needle, 1)
        p.write_text(t, encoding="utf-8")
        print("OK SHChangeNotify")
else:
    print("SHChangeNotify already present")

# ensure windows-sys has UI_Shell
p = ROOT / "tauri/src-tauri/Cargo.toml"
t = p.read_text(encoding="utf-8")
if "Win32_UI_Shell" not in t:
    t = t.replace('"Win32_System_LibraryLoader",', '"Win32_System_LibraryLoader",\n  "Win32_UI_Shell",')
    p.write_text(t, encoding="utf-8")
    print("OK Cargo shell feature")

print("done")
