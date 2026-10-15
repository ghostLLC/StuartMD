(function (global) {
  "use strict";
  const markdownit = typeof module === "object" ? require("../../libs/markdown-it.min.js") : global.markdownit;
  const parser = markdownit({ html: true, linkify: true, typographer: true, breaks: false });
  const diagramSelector = ".mermaid-diagram, pre.mermaid-src[data-mermaid], pre.mermaid-fallback";

  function sourceIsRestricted(editor) {
    // 格式包装和整行转换都会使用结束位置，需要同时检查该位置所在行。
    const start = editor.selectionStart, end = editor.selectionEnd;
    const firstLine = editor.value.slice(0, start).split("\n").length - 1;
    const lastLine = editor.value.slice(0, end).split("\n").length - 1;
    return parser.parse(editor.value, {}).some(token => token.type === "fence" &&
      token.info.trim().split(/\s+/)[0].toLowerCase() === "mermaid" &&
      token.map[0] <= lastLine && firstLine < token.map[1]);
  }

  function isRestricted({ preview, source, selection, activeElement }) {
    if (activeElement === source) return sourceIsRestricted(source);
    if (preview.contains(activeElement) && activeElement.matches("textarea.md-block-source")) return sourceIsRestricted(activeElement);
    if (!selection || selection.isCollapsed) return false;
    const diagrams = preview.querySelectorAll(diagramSelector);
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      for (const diagram of diagrams) {
        if (range.intersectsNode(diagram)) return true;
      }
    }
    return false;
  }

  function updateToolbar(toolbar, context) {
    const restricted = isRestricted(context);
    for (const control of toolbar.querySelectorAll("button, .sel-sep")) {
      control.hidden = restricted && control.dataset.sel !== "ai-explain";
    }
    return restricted;
  }

  const selectionFormatting = { isRestricted, updateToolbar };
  global.StuartCore = global.StuartCore || {};
  global.StuartCore.selectionFormatting = selectionFormatting;
  if (typeof module === "object") module.exports = selectionFormatting;
})(typeof window !== "undefined" ? window : globalThis);
