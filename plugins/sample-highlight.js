// StuartMD sample plugin — adds ==highlight== markdown syntax
StuartPlugin.addStyle("mark.plugin-mark { background: #fff59d; }");
StuartPlugin.onAppReady(() => {
  console.log("[sample-plugin] ready");
});
StuartPlugin.registerMarkdownIt((md) => {
  md.inline.ruler.before("emphasis", "md_eq_highlight", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 61 || src.charCodeAt(pos + 1) !== 61) return false;
    const end = src.indexOf("==", pos + 2);
    if (end < 0) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      token.content = '<mark class="plugin-mark">' + md.utils.escapeHtml(src.slice(pos + 2, end)) + "</mark>";
    }
    state.pos = end + 2;
    return true;
  });
});
