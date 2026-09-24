# -*- coding: utf-8 -*-
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent

for rel, a, b in [
    ("tauri/src-tauri/Cargo.toml", 'version = "3.1.9"', 'version = "3.2.0"'),
    ("tauri/src-tauri/tauri.conf.json", '"version": "3.1.9"', '"version": "3.2.0"'),
    ("tauri/src-tauri/src/fs_api.rs", 'VERSION: &str = "3.1.9"', 'VERSION: &str = "3.2.0"'),
    ("scripts/bump_lock.py", "3.1.9", "3.2.0"),
]:
    p = ROOT / rel
    t = p.read_text(encoding="utf-8")
    p.write_text(t.replace(a, b, 1) if a in t else t, encoding="utf-8")

p = ROOT / "CHANGELOG.md"
t = p.read_text(encoding="utf-8")
block = """## [3.2.0] - 2026-09-24

### 安全与稳定性 (Security & Stability)
- **封堵 RCE 命令注入**：`stuart_open_url` 改用 Win32 `ShellExecuteW` 与严格协议/字符白名单，彻底废除 `cmd.exe /C start` 间接调用
- **原子安全落盘**：`stuart_write_file` 采用同目录临时文件原子替换与 `sync_all()` 物理刷盘，彻底杜绝掉电/崩溃时 0 字节截断丢失
- **严格 DOM 白名单清洗**：彻底废除正则黑名单，基于 DOM 树深度遍历白名单清洗，消除 `<svg/onload=...>` 等 XSS 隐患；嵌入严格 CSP
- **DPAPI 凭证加固**：Windows DPAPI 引入专属应用熵隔离与 `SecureZeroMemory` 明文内存安全擦除

### 性能与显存 (Performance & Memory)
- **PDF 显存虚拟化硬释放**：视口滑动窗口池保持 <= 5 页活跃，滚出页面即刻重置宽高并释放 Canvas，彻底根除百页 PDF 累积 2.2GB 显存引发的 WebView2 OOM 崩溃；加入 `renderTask.cancel()` 保护
- **AI 流式字符对齐**：引入 UTF-8 变长字节流跨网络切片缓冲队列，根除中文字符截断乱码

### 交互与体验 (UX & Shortcuts)
- **快捷键修正**：将 `Ctrl+Shift+Z` 恢复为标准重做 (`redoEdit()`)；加入输入框焦点判定，隔离全局快捷键冒泡
- **异步保存防竞态**：引入 `tab.rev` 代际令牌，杜绝跨标签异步保存覆写；保存前自动刷写活动块编辑内容
- **自动化测试自适应**：修复所有测试脚本为基于 `Path(__file__)` 动态根路径探测

"""
if "## [3.2.0]" not in t:
    p.write_text(t.replace("## [3.1.9]", block + "## [3.1.9]", 1), encoding="utf-8")

for rel in ("README.md", "samples/欢迎使用 StuartMD.md"):
    p = ROOT / rel
    if p.exists():
        p.write_text(p.read_text(encoding="utf-8").replace("3.1.9", "3.2.0").replace("3.1.3", "3.2.0"), encoding="utf-8")

print("bump to 3.2.0 completed")
