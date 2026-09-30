# -*- coding: utf-8 -*-
"""Bump StuartMD 3.5.1 -> 3.5.2 and refresh docs/samples."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
OLD = "3.5.1"
NEW = "3.5.2"

replacements = [
    (ROOT / "tauri" / "src-tauri" / "tauri.conf.json", f'"version": "{OLD}"', f'"version": "{NEW}"'),
    (ROOT / "tauri" / "src-tauri" / "Cargo.toml", f'version = "{OLD}"', f'version = "{NEW}"'),
    (ROOT / "README.md", f"version-{OLD}-blue", f"version-{NEW}-blue"),
    (ROOT / "README.md", f"StuartMD-Setup-{OLD}.exe", f"StuartMD-Setup-{NEW}.exe"),
    (ROOT / "samples" / "示例文档.md", f"**当前版本：** {OLD}", f"**当前版本：** {NEW}"),
    (ROOT / "samples" / "欢迎使用 StuartMD.md", f"**当前版本：** {OLD}", f"**当前版本：** {NEW}"),
    (ROOT / "samples" / "欢迎使用 StuartMD.md", f"StuartMD-Setup-{OLD}.exe", f"StuartMD-Setup-{NEW}.exe"),
]

for path, old, new in replacements:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        print(f"WARN missing {old!r} in {path}")
        continue
    path.write_text(text.replace(old, new), encoding="utf-8")
    print(f"OK {path.name}: {old} -> {new}")

cl = ROOT / "CHANGELOG.md"
text = cl.read_text(encoding="utf-8")
entry = """# 更新日志 / Changelog

本文件记录 StuartMD 的版本变更，便于开发与发布对照。

## [3.5.2] - 2026-09-29

### 修复：编辑交互过抑制（标题/表格/代码共性根因）
- 3.5.1 防丢内容的门闩做过头：有选区就点不进光标、双击只词选不进编辑、退出后难以再进
- 新模型：选中后点击 = 清选区 + 点击点落光标；双击表格/代码/公式/图表 = 直接进编辑
- 单击延迟进编辑改为结构块 320ms / 文本 460ms；拖选保护仅 500ms 手势宽限
- commit/cancel 全路径 `clearEditEnterGates()`；DOM 重建后用 `elementFromPoint` 重解析节点

### 修复：代码编辑高度 / 表格编辑观感
- 一行代码编辑高度贴合内容（去掉 min-height 80px + 塌陷后测量）
- 表格编辑态与阅读态一致，仅活动单元格细焦点线

### 修复：块手柄选中反馈 + 图表字号
- 手柄 hover/菜单打开时块显示 `.md-block.is-selected`（浅底 + 左侧条）
- Mermaid 节点/边标签收到 12px，更干净

### 多智能体根因审查：同类潜藏问题
- 内容丢失：选区删除误清整块、未编辑提交走有损 htmlToMarkdown、表格缺快照、切标签丢未提交编辑
- 交互锁：AI 伴读取消后发送键锁死、renderMarkdown 降级不失效增量缓存
- 视觉同型：源码编辑灰底框、备忘 min-height 200/180px、全局 `:focus-visible`
- 其它：选区工具栏 15s 缓存误挡焦点、陈旧选区缓存、静默解析失败无反馈

### 测试
- core-smoke / M3 contract 全过；保留防抹除守卫

"""
marker = "## [3.5.1]"
idx = text.find(marker)
if idx < 0:
    raise SystemExit("CHANGELOG missing 3.5.1 section")
cl.write_text(entry + text[idx:], encoding="utf-8")
print("OK CHANGELOG.md prepended 3.5.2")
print("DONE")
