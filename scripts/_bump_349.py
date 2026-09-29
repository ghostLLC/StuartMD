# -*- coding: utf-8 -*-
"""Bump StuartMD to 3.4.9: selection-safe code edit, list empty lines, mermaid, empty-line editing, memory UX."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
OLD, NEW = "3.4.8", "3.4.9"


def rep(path, pairs):
    p = ROOT / path
    t = p.read_text(encoding="utf-8")
    for a, b in pairs:
        if a not in t:
            raise SystemExit(f"missing in {path}: {a[:70]!r}")
        t = t.replace(a, b)
    p.write_text(t, encoding="utf-8")
    print("updated", path)


rep("tauri/src-tauri/Cargo.toml", [('version = "3.4.8"', 'version = "3.4.9"')])
rep("tauri/src-tauri/tauri.conf.json", [('"version": "3.4.8"', '"version": "3.4.9"')])
rep("tauri/src-tauri/src/fs_api.rs", [('VERSION: &str = "3.4.8"', 'VERSION: &str = "3.4.9"')])
rep("scripts/bump_lock.py", [("3.4.8", "3.4.9")])

rep(
    "samples/欢迎使用 StuartMD.md",
    [
        ("**当前版本：** 3.4.8", "**当前版本：** 3.4.9"),
        (
            "- 列表行首退格：先取消分点，不合并上一行  \n",
            "- **列表空行**：退格先去掉序号/圆点，再删空行；空行回车退出列表，不再连环新建列表项  \n"
            "- **空行**：阅读模式可点选、可输入（多空行在编辑后仍保留）  \n",
        ),
    ],
)

rep(
    "README.md",
    [
        ("version-3.4.8-blue", "version-3.4.9-blue"),
        ("StuartMD-Setup-3.4.8.exe", "StuartMD-Setup-3.4.9.exe"),
    ],
)

rep(
    "tauri/src-tauri/src/fs_api.rs",
    [("**当前版本：** 3.4.8", "**当前版本：** 3.4.9")],
)

cl = ROOT / "CHANGELOG.md"
t = cl.read_text(encoding="utf-8")
block = """## [3.4.9] - 2026-09-29

### 修复：代码块双击丢内容
- 双击时首击仍会排队进编辑，gesture 中途清空块 DOM → 整块丢失
  - 多击一律取消 enter-edit 定时器
  - 代码提交：用户未输入时禁止空写回覆盖非空围栏

### 列表空行
- **退格**：先去掉序号/圆点，再删空行
- **回车**（空行）：去掉标记退出列表，不再连环新建带标记的行
- 源码模式同样生效

### 图表渲染
- 清洗器误删 `svg`/`math`，Mermaid 渲染完即被剥掉 → 一直只见源码
- 允许 SVG/MathML（仍禁 script/iframe）

### 阅读态编辑
- **空行**：可点选、可输入；多空行在块模型中保留（原先 split/join 会吞掉）
- **标题/段落**：进入编辑更快（90ms），光标落在点击处，减少卡顿感

### 伴读 · 记忆
- 删除需**二次确认**弹窗
- 内容默认只读置灰，**单击后**再进入编辑
- 支持**新建记忆**
- 「返回 / 保存 / 删除」移到内容区下方

### 连带修复
- 空白行数据：任意块编辑往返不再折叠/吞掉多余空行

"""
if "## [3.4.9]" not in t:
    t = t.replace("## [3.4.8]", block + "## [3.4.8]", 1)
    cl.write_text(t, encoding="utf-8")
    print("changelog ok")
else:
    print("changelog already")

print("DONE", NEW)
