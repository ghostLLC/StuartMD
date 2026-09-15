# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for StuartMD.exe"""
import sys
from pathlib import Path

block_cipher = None
ROOT = Path(SPECPATH).resolve()
ASSETS = ROOT / "assets"
WEB = ROOT / "web"
SAMPLES = ROOT / "samples"
DOCS = ROOT / "docs"
PLUGINS = ROOT / "plugins"

datas = [
    (str(WEB), "web"),
    (str(SAMPLES), "samples"),
    (str(ASSETS / "app.ico"), "assets"),
    (str(DOCS), "docs"),
    (str(PLUGINS), "plugins"),
    (str(ROOT / "CHANGELOG.md"), "."),
]

hiddenimports = [
    "webview",
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
    "webview.platforms.win32",
    "clr",
    "clr_loader",
    "pythonnet",
    "System",
    "System.Windows.Forms",
    "System.Drawing",
    "System.Threading",
    "System.IO",
    "System.Runtime",
    "Microsoft.Web.WebView2",
    "Microsoft.Web.WebView2.Core",
    "Microsoft.Web.WebView2.WinForms",
]

a = Analysis(
    [str(ROOT / "main.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "PIL",
        "scipy",
        "test",
        "unittest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StuartMD",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ASSETS / "app.ico"),
    version=str(ASSETS / "version_info.txt"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="StuartMD",
)
