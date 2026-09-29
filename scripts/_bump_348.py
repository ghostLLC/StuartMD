# -*- coding: utf-8 -*-
"""Bump StuartMD to 3.4.8: selection-safe click edit + in-place table/code edit."""
from pathlib import Path

ROOT = Path(r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\StuartMD")
OLD, NEW = "3.4.7", "3.4.8"


def rep(path, pairs):
    p = ROOT / path
    t = p.read_text(encoding="utf-8")
    for a, b in pairs:
        if a not in t:
            raise SystemExit(f"missing in {path}: {a[:60]!r}")
        t = t.replace(a, b)
    p.write_text(t, encoding="utf-8")
    print("updated", path)


rep("tauri/src-tauri/Cargo.toml", [("version = \"3.4.7\"", "version = \"3.4.8\"")])
rep("tauri/src-tauri/tauri.conf.json", [("\"version\": \"3.4.7\"", "\"version\": \"3.4.8\"")])
rep("tauri/src-tauri/src/fs_api.rs", [("VERSION: &str = \"3.4.7\"", "VERSION: &str = \"3.4.8\"")])
rep("scripts/bump_lock.py", [("3.4.7", "3.4.8")])

# samples welcome
rep(
    "samples/欢迎使用 StuartMD.md",
    [
        ("**当前版本：** 3.4.7", "**当前版本：** 3.4.8"),
        (
            "- **双击复杂块**（表格 / 公式 / 代码 / Mermaid）：进入源码编辑，失焦立即回到渲染态  \n- 单击普通段落：就地轻量编辑；单击代码块：进入源码编辑  \n",
            "- **双击**：只选中词，不进入编辑（避免误删）  \n"
            "- **单击表格**：单元格直接编辑，Tab 切换，Enter / 失焦提交  \n"
            "- **单击代码块**：就地编辑代码正文（保留语言标记），不整块变 Markdown  \n"
            "- **单击公式 / Mermaid**：进入源码编辑，保护结构；失焦回到渲染态  \n"
            "- **单击普通段落**：就地轻量编辑  \n",
        ),
    ],
)

# sample doc (secondary)
rep(
    "samples/示例文档.md",
    [
        (
            "- **双击复杂块**（表格 / 公式 / 代码 / Mermaid）：进入源码编辑",
            "- **单击表格 / 代码**：阅读态就地编辑；**双击**只选中词；公式 / Mermaid 单击进源码编辑",
        ),
    ],
)

# README
rep(
    "README.md",
    [
        ("version-3.4.7-blue", "version-3.4.8-blue"),
        ("StuartMD-Setup-3.4.7.exe", "StuartMD-Setup-3.4.8.exe"),
        (
            "点击段落轻量编辑，双击复杂块进源码",
            "单击段落/表格/代码就地编辑，双击只选中不进编辑",
        ),
    ],
)

# fs_api fallback welcome (keep version + interaction in sync)
rep(
    "tauri/src-tauri/src/fs_api.rs",
    [
        ("**当前版本：** 2.9.10", "**当前版本：** 3.4.8"),
        (
            "双击代码/公式/图表进源码编辑",
            "单击表格/代码就地编辑；双击只选中；公式/图表进源码编辑",
        ),
    ],
)

# CHANGELOG
cl = ROOT / "CHANGELOG.md"
t = cl.read_text(encoding="utf-8")
block = """## [3.4.8] - 2026-09-29

### 修复：选区误删
- **双击选中后再单击，内容消失**：根因是双击被劫持进块源码编辑（`node.innerHTML` 清空 + 转换回写），选区被毁且偶发写回空块
  - **双击 = 只选中词**，不再进入任何编辑
  - 单击进编辑增加 **1.5s 选区宽限**，拖选/双击后的误 click 不再改文档
- **提交安全**：`commitBlockSource` 写回前压撤销栈；空转换不覆盖非空原文；WYSIWYG 转换大幅丢字时回退原文
- **撤销**：块编辑 / 批量删除均先 `pushHistory` 再改，Ctrl+Z 可回到编辑前

### 阅读态直接编辑
- **表格**：单击单元格即可改字（Tab 切格，Enter/失焦提交），不再先变 Markdown
- **代码块**：单击就地编辑代码正文（保留语言标记与边框），不再整块变源码
- **公式 / Mermaid**：单击进源码编辑（保护 KaTeX / 图结构）
- 普通段落：单击就地轻量编辑（原行为）

"""
if "## [3.4.8]" not in t:
    t = t.replace("## [3.4.7]", block + "## [3.4.7]", 1)
    cl.write_text(t, encoding="utf-8")
    print("changelog ok")
else:
    print("changelog already has 3.4.8")

print("DONE", NEW)
