# Mermaid 选区格式操作验证

日期：2026-10-15。

对象：当前工作区源代码，代码基线为 3.5.12。

源码指纹：`945c8750278824bd5fcd42778f227c760556964003278c4ae007d5b048f0a356`。

## 行为

Mermaid 图表的选区工具栏只显示 AI 问答。格式按钮和分隔线隐藏，格式下拉及相关格式操作入口根据实际选区限制执行。普通正文选区恢复原有工具栏。

选区覆盖图表时执行相同限制。源码选区的结束位置参与检查，保护格式操作使用的插入位置。Mermaid 源码保留普通文字输入。Markdown 判断使用与正文相同的 Markdown-it 配置。

## 实际检查

| 项目 | 结果 | 范围 |
| --- | --- | --- |
| 前端模块 | Passed | npm test，共 24 项通过 |
| Mermaid 专项 | Passed | 9 项实际 DOM、Range、Selection、textarea、CSS 和 Markdown-it 检查 |
| 伴读脚本及示例 | Passed | 10 个脚本语法、CSS、两份实际示例公式与 Mermaid 源码、无效公式处理、未知来源链接 |
| 新模块与主程序语法 | Passed | selection-formatting.js、app.js |
| 应用 CSS | Passed | esbuild 解析，无警告 |
| 独立代码复核 | Passed | 当前格式限制、结束位置和 HTML 原文示例处理 |
| 窗口、浏览器、视觉与真实鼠标操作 | SkippedByUser | 用户禁止 computer use |

专项检查覆盖 SVG 标签、HTML 标签、跨越图表的选区、反向选择、相邻正文、图表源码、真实欢迎文档、局部源码编辑、嵌套围栏、结束位置和 HTML 原文示例。

本记录对应源代码修改。安装包和本机应用的运行检查按各自实际版本另行记录。

## 复核命令

```powershell
npm test
node tests/verify-companion.cjs
node --check web/js/core/selection-formatting.js
node --check web/js/app.js
git diff --check
```
