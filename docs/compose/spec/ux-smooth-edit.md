---
feature: ux-smooth-edit
status: delivered
updated: 2026-09-29
branch: ux-smooth-edit
commits: 
---

# UX Smooth Edit (3.5.3)

## Report

**What was built** — 首次点击即进编辑并落 caret（含富文本混排）；代码块语言徽标；Mermaid 紧凑化；表格退出原位重建消除抖动。多智能体实现 + 独立评审后补下标返回与 border-box 等缺口。

**Verification** — `node --check web/js/app.js` PASS；`node tests/core-smoke.js` ALL PASS。

**Journey log**
1. 320/460ms 延迟进编辑是「要点两次」根因，必须同步 enter。
2. contenteditable 需先 focus 再落 caret，否则像没进编辑。
3. 表格退出抖动来自整树 remount，不是边框；单块重建 + 保 scrollTop 即可。
4. sanitize 之后才能写 `data-lang`（白名单会剥 PRE 自定义属性）。
5. `commitBlockSource` 应返回真实写入下标，供 in-place rebuild 使用。

## [S1] Problem

用户实测 3.5.2 仍有明显手感与视觉问题：

1. 代码块不显示编程语言（Typora 会显示）。
2. Mermaid 流程图过大、节点字号仍偏大，整体不像成品。
3. 富文本行（斜体/加粗/删除线/行内代码混排）单击/双击都无法进入编辑。
4. 单击标题不能立刻进入编辑：要再点一次，且延迟明显，不丝滑；期望 **第一次点击即进编辑**（接近 Typora）。
5. 从表格编辑态点击别处退出时，内容会「抖动」一下。

## [S2] Design

### S2.1 首次点击即编辑（标题 / 正文 / 富文本）

- **语义**：阅读态下，对 `.md-block` 的一次有效单击（`detail === 1`）**立即**进入对应编辑面，并在点击点落下光标。
- **延迟**：目标 ≤ 50ms（microtask / 单帧），不再使用 320–460ms 定时器作为主路径。
- **双击**：仍作为结构块（table/code/math/mermaid）的显式编辑入口；纯文本双击保留原生词选，**不得**因此阻止紧随其后的编辑。
- **拖选保护**：仅当 `mousedown → mousemove 位移 > 4px` 或手势内新建非空选区时跳过进入编辑；窗口 ≤ 300ms。
- **富文本（红框类）**：`em/strong/s/del/code/span` 混排行必须能单击进入 `enterBlockEdit`，并用 `caretRangeFromPoint` 落在字间；禁止因内部行内元素而把点击当成「非文本」。
- **光标反馈**：进入编辑后 1 帧内出现 caret；不得出现「先高亮、再点一次才有 caret」的两段式。

### S2.2 代码块语言标签

- 阅读态 `.code-edit-wrap` / `pre` 右上或左上显示 **语言徽标**（如 `js`、`python`、`ts`），无语言则不显示。
- 徽标为只读装饰，`pointer-events: none`，不抢点击进编辑。
- 样式：11–12px、次要文字色、不透明度约 0.55，圆角胶囊；与代码底 `--code-bg` 协调。
- 语言来自 fence info string（` ```js `）或 `code.language-*`；显示用小写短名。

### S2.3 图表更紧凑

- Mermaid 整体宽度更收敛：节点标签 12px 保持或略降；水平 padding/边距减少；SVG `max-width` 控制在容器 100% 内并居中。
- 节点框更矮（约 36–40px），箭头稍细；整体视觉密度接近文档插图，不是海报级大图。
- 不删除 foreignObject 标签路径；明暗主题文字仍可见。

### S2.4 表格退出不抖动

- 表格 commit 退出编辑时 **禁止布局跳动**：
  - 禁止因 `box-sizing`/border/padding 在 editing ↔ reading 切换时不一致导致 reflow 感知。
  - `table-edit` 与 reading 表格必须同尺寸 chrome（3.5.2 已对齐，需回归 border-collapse / cell padding）。
  - 退出时不要 `renderMarkdown` 整树导致滚动跳动：优先原位换回，或保持 scrollTop/几何后再重绘。
- 目标：点击别处提交后表格稳住，无 1 帧上移/缩放感。

## [S3] Out of Scope

- 字符级 span 模型 / DocumentStore 大改（除非抖动修复必须且最小）。
- 插件、PDF 标注、AI 面板逻辑。
- 主题系统重做、i18n 文案。

## Tasks

- [x] T1: 首次点击即进编辑（标题/正文/富文本）+ caret 落点 — acceptance: 单击标题/富文本行 1 次出现编辑 caret，延迟可感知为「立即」；拖选不误入 (covers: S2.1)
- [x] T2: 代码块语言徽标 — acceptance: ```js``` 显示 js 徽标；无语言不显示；点击徽标仍进代码编辑 (covers: S2.2)
- [x] T3: Mermaid 紧凑化 — acceptance: 流程图节点更矮、标签清晰、宽度贴合容器，不显臃肿 (covers: S2.3)
- [x] T4: 表格退出无抖动 — acceptance: 表格编辑 → 点击别处，表格几何稳定无跳动 (covers: S2.4)
- [x] T5: 回归自测 + 版本 3.5.3 — acceptance: core-smoke 全过；CHANGELOG/README/samples 版本同步 (covers: S2.1; S2.2; S2.3; S2.4)
