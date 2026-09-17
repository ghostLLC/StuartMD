# StuartMD 插件开发指南

StuartMD 支持**即插即用**的前端插件（JavaScript）。放入插件目录后重启应用即可加载。

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
// StuartPlugin 由加载器注入
StuartPlugin.addStyle(`.my-highlight { outline: 1px solid #c00; }`);
StuartPlugin.onAppReady(() => {
  StuartPlugin.toast("Hello from plugin");
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

| 方法 | 说明 |
|------|------|
| `addStyle(css)` | 注入一段 CSS |
| `onAppReady(fn)` | 应用就绪后执行 `fn(Stuart)` |
| `registerMarkdownIt(fn)` | 拿到 `markdown-it` 实例后执行 `fn(md)`，可扩展语法 |
| `toast(msg)` | 显示轻提示 |

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

## 启用 / 禁用

- 设置界面可按插件开关（写入 `%APPDATA%\StuartMD\settings.json` 的 `plugins_disabled`）
- 删除插件文件即卸载

## 安全注意

- 插件以本机 JS 权限运行，请只安装信任来源的插件
- 不要把密钥写进插件；不要在插件里读写无关文件
- 未来可能增加更严格的权限模型，建议保持 API 最小化

## 与主题 / 壁纸协作

- 插件可用 `addStyle` 覆盖 `--accent` 等 CSS 变量
- 壁纸主题会写入 CSS 变量，插件可在 `onAppReady` 后读取 `document.body.dataset.theme`

## 版本

插件宿主 API 版本：**1**（与 StuartMD 1.0 对应）
