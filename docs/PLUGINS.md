# StuartMD 插件开发指南

StuartMD 支持前端 JavaScript 插件。插件**不会自动执行**：放入插件目录后需在设置中启用，并在首次启用前完成授权确认。

## 安全模型（先读这一节）

1. **不自动加载**：`loadAll()` 只发现插件并计算源码指纹，绝不执行插件代码。
2. **授权确认（consent）**：首次启用前，用户必须确认一次；宿主保存该插件源码的 `sha256` 指纹。指纹缺失或与当前源码不一致时，插件保持 `pending_consent` 状态，不会执行。
3. **源码变更即失效**：插件文件被改动后指纹变化，必须重新确认授权。这是防止「先审核后偷换」的核心机制。
4. **受限 API**：插件只能拿到冻结的 `StuartPlugin` 能力对象。`window` / `document` / `__TAURI__` / `pywebview` / `eval` / `Function` / 网络接口在插件作用域内被遮蔽，不可用。
5. **残余风险**：markdown-it 钩子拿到的 `md` 实例可以扩展渲染输出，输出会经过应用侧清洗后进入预览。请只安装来源可信的插件。

## 插件目录

用户数据目录（推荐，卸载可保留）：

```
%APPDATA%\StuartMD\plugins\
```

安装目录（随程序分发）：

```
<安装路径>\plugins\
```

应用内：**设置 → 插件 → 打开插件目录**

## 最小插件

文件：`hello.js`

```js
// StuartPlugin 由加载器注入，且已冻结
StuartPlugin.log("hello loaded");
StuartPlugin.addStyle(`.my-highlight { outline: 1px solid #c00; }`);
StuartPlugin.registerMarkdownIt((md) => {
  // 可扩展 markdown-it 语法
});
```

可选元数据 `hello.json`：

```json
{
  "id": "hello",
  "name": "Hello 插件",
  "version": "1.0.0",
  "description": "示例插件"
}
```

## 可用 API（`StuartPlugin`）

插件函数只接收一个参数：冻结的 `StuartPlugin` 对象。

| 方法 | 说明 |
|------|------|
| `id` | 当前插件 id（只读字符串） |
| `addStyle(css)` | 注入一段 CSS（按插件打标，可回收；上限 256KB） |
| `log(...args)` | 带 `[plugin:id]` 前缀的控制台日志 |
| `registerMarkdownIt(fn)` | 拿到 `markdown-it` 实例后执行 `fn(md)`，可扩展语法 |
| `registerTool(def)` | 注册 AI 工具，字段白名单见下 |

**不再提供**（旧 API，已移除）：`onAppReady`、`toast`、`agent()`，以及任何 `window` / `document` / `__TAURI__` / `pywebview` 访问。请改用 `log` 与 `registerMarkdownIt`。

### `registerTool` 字段白名单

```js
StuartPlugin.registerTool({
  name: "count_words",          // 必填：^[a-z][a-z0-9_]{0,63}$
  description: "统计当前文档字数",
  run: async (args) => {
    // 工具在 AI 调用时执行，返回值会交给模型
    return { words: 0 };
  },
});
```

- 允许字段：`name`、`description`、`run`（其它字段一律拒绝）
- `name` 不得与内置工具冲突：`get_document`、`set_document`、`get_outline`、`memory_get`、`memory_set`、`search_workspace`
- 工具统一以 `plugin:<id>` 来源注册，便于在工具列表中识别

## 启用 / 停用 / 授权

| 状态 | 含义 |
|------|------|
| `disabled` | 设置中已停用，不执行 |
| `pending_consent` | 已启用但从未授权，或源码指纹变化，等待用户确认 |
| `ready` | 已授权且指纹匹配，等待 `enablePlugin()` 执行 |
| `loaded` | 已执行 |

宿主侧接口（`window.StuartPlugins`）：

| 方法 | 说明 |
|------|------|
| `loadAll()` | 只发现插件，返回状态列表（含 `pending_consent` / `hash`），不执行 |
| `list()` / `pending()` | 查询已发现插件 / 待授权插件 |
| `consentPlugin(name)` | 记录当前源码指纹为已授权（不执行） |
| `enablePlugin(name)` | 执行插件；未授权或指纹不匹配时返回 `pending_consent: true` 且不执行 |
| `consentAndEnable(name)` | 确认授权并立即执行（用户点过「确认」之后调用） |
| `revokeConsent(name)` | 撤销授权 |
| `disablePlugin(name)` | 回收该插件注入的样式并卸载 |

设置界面按插件开关写入 `%APPDATA%\StuartMD\settings.json` 的 `plugins_disabled`；授权指纹写入同文件的 `plugin_consent`。删除插件文件即卸载。

### 推荐的用户流程

1. 插件出现在设置列表中，状态为 `pending_consent`（首次）或 `ready`（已授权）。
2. UI 展示插件路径与 `hash`，用户确认来源。
3. 调用 `consentAndEnable(name)`；若用户拒绝，不调用即可。
4. 插件源码变化后，下次 `loadAll()` 重新回到 `pending_consent`。

## 扩展 Markdown 语法示例

```js
StuartPlugin.registerMarkdownIt((md) => {
  // 例子：==高亮== 语法（简单实现）
  md.inline.ruler.before("emphasis", "mark_highlight", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x3d /* = */ || src.charCodeAt(pos + 1) !== 0x3d) return false;
    const end = src.indexOf("==", pos + 2);
    if (end < 0) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = "<mark>" + md.utils.escapeHtml(src.slice(pos + 2, end)) + "</mark>";
    }
    state.pos = end + 2;
    return true;
  });
});
```

内置示例插件：`plugins/sample-highlight.js`，可直接作为模板。

## 向后兼容

- 只使用 `StuartPlugin.addStyle` 与 `registerMarkdownIt` 的简单插件**无需修改**即可在新模型下工作（仍需一次授权确认）。
- 使用 `onAppReady` / `toast` / `agent()` 的插件需要改写：启动逻辑直接写在顶层，提示改用 `log`，工具改用 `registerTool`。
- 旧版「放入目录重启即用」的行为已移除，请以本文为准。

## 与主题 / 壁纸协作

- 插件可用 `addStyle` 覆盖 `--accent` 等 CSS 变量
- 壁纸主题会写入 CSS 变量，插件可在 `registerMarkdownIt` 或 `addStyle` 中按需适配；插件作用域内无法直接读取 `document.body.dataset`

## 版本

插件宿主 API 版本：**2**（授权模型 + 受限 API；版本 1 为无沙箱的自动加载，已废弃）
