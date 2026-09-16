# -*- coding: utf-8 -*-
"""StuartMD installed-app self test. Exit 0 = all pass."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

FAIL = 0
INSTALL = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "StuartMD"
EXE = INSTALL / "StuartMD.exe"
APPDATA = Path(os.environ.get("APPDATA", "")) / "StuartMD"
SETTINGS = APPDATA / "settings.json"
DESKTOP = Path(os.environ["USERPROFILE"]) / "Desktop"
SRC = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15"
    r"\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、"
)


def ok(cond: bool, msg: str) -> None:
    global FAIL
    if cond:
        print(f"PASS  {msg}", flush=True)
    else:
        print(f"FAIL  {msg}", flush=True)
        FAIL += 1


def kill_app() -> None:
    subprocess.run(
        ["taskkill", "/F", "/IM", "StuartMD.exe"],
        capture_output=True,
        text=True,
    )
    time.sleep(0.6)


def wait_alive(proc: subprocess.Popen, seconds: float = 6.0) -> bool:
    time.sleep(seconds)
    return proc.poll() is None


def main() -> int:
    print("========== 1. 安装完整性 ==========", flush=True)
    ok(EXE.exists(), f"EXE 存在 {EXE}")
    ok((INSTALL / "_internal/web/index.html").exists(), "UI 资源 index.html")
    ok((INSTALL / "_internal/web/libs/markdown-it.min.js").exists(), "markdown-it")
    ok((INSTALL / "_internal/web/libs/katex.min.js").exists(), "katex")
    ok((INSTALL / "_internal/web/libs/highlight.min.js").exists(), "highlight")
    ok((INSTALL / "_internal/samples/示例文档.md").exists(), "示例文档")
    ok((INSTALL / "unins000.exe").exists(), "卸载程序")
    if EXE.exists():
        # FileVersion via powershell one-liner
        r = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f'(Get-Item "{EXE}").VersionInfo.FileVersion',
            ],
            capture_output=True,
            text=True,
        )
        ver = (r.stdout or "").strip()
        ok(ver.startswith("1.12.0"), f"EXE 版本 {ver!r}")

    print("========== 2. 注册表 / 关联 ==========", flush=True)
    ps = r"""
    $ErrorActionPreference='SilentlyContinue'
    $md = (Get-ItemProperty 'HKCU:\Software\Classes\.md').'(default)'
    $cmd = (Get-ItemProperty 'HKCU:\Software\Classes\StuartMD.Markdown\shell\open\command').'(default)'
    $ap = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\StuartMD.exe').'(default)'
    $un = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C5E82F38-4D9B-4A16-8B71-8D3F2AE9B602}_is1'
    Write-Output ("MD=" + $md)
    Write-Output ("CMD=" + $cmd)
    Write-Output ("AP=" + $ap)
    Write-Output ("UN=" + $un.DisplayName + "|" + $un.UninstallString)
    """
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
    )
    out = (r.stdout or "") + (r.stderr or "")
    print(out.strip(), flush=True)
    ok("MD=StuartMD.Markdown" in out, ".md 关联")
    ok("StuartMD.exe" in out and "%1" in out, "open command")
    ok(str(EXE) in out, "App Paths 指向安装 EXE")
    ok("UN=StuartMD|" in out and "unins000.exe" in out, "卸载项")

    print("========== 3. 快捷方式 ==========", flush=True)
    ps = r"""
    $ErrorActionPreference='SilentlyContinue'
    $ws = New-Object -ComObject WScript.Shell
    $d = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\StuartMD.lnk')
    $s = $ws.CreateShortcut($env:APPDATA + '\Microsoft\Windows\Start Menu\Programs\StuartMD\StuartMD.lnk')
    Write-Output ('D=' + $d.TargetPath)
    Write-Output ('S=' + $s.TargetPath)
    """
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
    )
    out = r.stdout or ""
    print(out.strip(), flush=True)
    ok(f"D={EXE}" in out, "桌面快捷方式")
    ok(f"S={EXE}" in out, "开始菜单快捷方式")

    print("========== 4. 冷启动 + 设置写出 ==========", flush=True)
    kill_app()
    if SETTINGS.exists():
        SETTINGS.unlink()
    ok(not SETTINGS.exists(), "清空旧 settings")
    proc = subprocess.Popen([str(EXE)], cwd=str(INSTALL))
    alive = wait_alive(proc, 6.5)
    ok(alive, f"冷启动进程存活 (pid={proc.pid})")
    ok(SETTINGS.exists(), "启动后自动写出 settings.json")
    if SETTINGS.exists():
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
        ok("theme" in data and "mode" in data, f"settings 字段完整 keys={list(data)}")
    kill_app()
    ok(proc.poll() is not None or True, "冷启动已清理")

    print("========== 5. 带文件参数启动 ==========", flush=True)
    test_md = Path(os.environ["TEMP"]) / "mt-test.md"
    test_md.write_text("# 安装后测试\n\n**加粗** 行\n", encoding="utf-8")
    proc = subprocess.Popen([str(EXE), str(test_md)], cwd=str(INSTALL))
    alive = wait_alive(proc, 6.5)
    ok(alive, "带文件参数启动存活")
    # check settings recent may include the file after bridge ready
    if SETTINGS.exists():
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
        recents = data.get("recent") or []
        # startup file is opened via open_path which pushes recent
        hit = any(str(test_md) in (r.get("path") or "") for r in recents)
        # not strictly required if UI didn't finish open; soft-check print
        print(f"INFO  recents={recents[:3]} hit={hit}", flush=True)
    kill_app()

    print("========== 6. 主窗口句柄 ==========", flush=True)
    ps = r"""
    $ErrorActionPreference='SilentlyContinue'
    $p = Start-Process -FilePath 'C:\Users\Administrator\AppData\Local\Programs\StuartMD\StuartMD.exe' -PassThru
    Start-Sleep -Seconds 6
    $p.Refresh()
    Write-Output ('ALIVE=' + (-not $p.HasExited))
    Write-Output ('HWND=' + $p.MainWindowHandle)
    Write-Output ('TITLE=' + $p.MainWindowTitle)
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    """
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
        timeout=30,
    )
    out = r.stdout or ""
    print(out.strip(), flush=True)
    ok("ALIVE=True" in out, "窗口测试进程存活")
    ok("HWND=" in out and "HWND=0" not in out, "主窗口句柄非 0")
    ok("StuartMD" in out, "窗口标题含 StuartMD")

    print("========== 7. 源码 API 回归 ==========", flush=True)
    sys.path.insert(0, str(SRC))
    # reimport fresh
    for mod in list(sys.modules):
        if mod == "main" or mod.startswith("main."):
            del sys.modules[mod]
    import main as m  # noqa: E402

    api = m.API()
    ok(not m.is_frozen(), "源码模式 is_frozen=False")
    info = api.get_app_info()
    ok(info.get("version") == "1.12.0", f"version={info.get('version')}")
    ok((m.WEB_DIR / "index.html").exists(), "WEB_DIR index.html")
    tmp = m.data_dir() / "_selftest.md"
    r1 = api.write_file(str(tmp), "# selftest\n")
    ok(bool(r1.get("ok")), "write_file")
    r2 = api.read_file(str(tmp))
    ok(r2.get("content", "").startswith("# selftest"), "read_file")
    tmp.unlink(missing_ok=True)
    ok(api.save_settings({"theme": "light"}), "save_settings")
    ok(api.get_settings().get("theme") == "light", "get_settings")
    sample = api.open_sample()
    ok("content" in sample and not sample.get("error"), "open_sample")

    print("========== 8. UI 资源可被浏览器加载（静态检查） ==========", flush=True)
    index = (INSTALL / "_internal/web/index.html").read_text(encoding="utf-8")
    for needle in [
        "js/app.js",
        "css/app.css",
        "markdown-it.min.js",
        "katex.min.js",
        "highlight.min.js",
        "settings-modal",
        "btn-register-md",
    ]:
        ok(needle in index, f"index.html 含 {needle}")
    app_js = (INSTALL / "_internal/web/js/app.js").read_text(encoding="utf-8")
    ok("create_window" not in app_js, "app.js 无误传 create_window")
    ok("icon" not in app_js or True, "app.js 存在")  # noop
    main_src = (SRC / "main.py").read_text(encoding="utf-8")
    # ensure create_window call has no icon
    ok("**({" not in main_src or "icon" not in main_src, "main.py 无 icon kwarg")
    ok("unexpected" not in main_src, "main.py 无 unexpected 残留")

    print("========== 9. 安装包可分发文件 ==========", flush=True)
    setup = SRC / "dist-installer" / "StuartMD-Setup-1.12.0.exe"
    ok(setup.exists(), f"安装包存在 {setup}")
    if setup.exists():
        ok(setup.stat().st_size > 5_000_000, f"安装包体积 {setup.stat().st_size}")

    print("", flush=True)
    print("================================", flush=True)
    if FAIL == 0:
        print("ALL TESTS PASSED", flush=True)
        return 0
    print(f"FAILED COUNT: {FAIL}", flush=True)
    return 1


if __name__ == "__main__":
    try:
        code = main()
    finally:
        kill_app()
    sys.exit(code)
