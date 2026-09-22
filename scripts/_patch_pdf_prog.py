# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、\tauri\src-tauri\src\win_api.rs"
)
t = p.read_text(encoding="utf-8")
old = """        if let Ok(k) = hkcu.create_subkey(r"Software\\Classes\\.pdf\\DefaultIcon") {
            let _ = k.0.set_value("", &icon_pdf.as_str());
        }
"""
new = """        // Windows often binds .pdf to ProgId "PDF" (created by installer).
        // Paint type icons on every known PDF ProgId so Explorer does not
        // fall back to stuartmd.exe,0 (application icon).
        for pdf_prog in ["PDF", "pdffile", "StuartMD.PDF"] {
            if let Ok(k) = hkcu.create_subkey(format!(r"Software\\Classes\\{}\\DefaultIcon", pdf_prog)) {
                let _ = k.0.set_value("", &icon_pdf.as_str());
            }
        }
        if let Ok(k) = hkcu.create_subkey(r"Software\\Classes\\.pdf\\DefaultIcon") {
            let _ = k.0.set_value("", &icon_pdf.as_str());
        }
        if hkcu.open_subkey("Software\\\\Classes\\\\MSEdgePDF").is_ok() {
            if let Ok(k) = hkcu.create_subkey(r"Software\\Classes\\MSEdgePDF\\DefaultIcon") {
                let _ = k.0.set_value("", &icon_pdf.as_str());
            }
        }
"""
# normalize
tn = t.replace("\r\n", "\n")
if old not in tn:
    # try without exact - find .pdf\\DefaultIcon block and replace
    import re
    pat = re.compile(
        r'        if let Ok\(k\) = hkcu\.create_subkey\(r"Software\\\\Classes\\\\\.pdf\\\\DefaultIcon"\) \{\n            let _ = k\.0\.set_value\("", &icon_pdf\.as_str\(\)\);\n        \}\n'
    )
    if not pat.search(tn):
        # looser
        idx = tn.find('Software\\Classes\\.pdf\\DefaultIcon')
        print("idx", idx)
        print(repr(tn[idx-120:idx+200]) if idx>=0 else "not found")
        raise SystemExit(1)
    tn = pat.sub(new, tn, count=1)
else:
    tn = tn.replace(old, new, 1)
p.write_text(tn, encoding="utf-8")
print("patched win_api pdf icons")
