(function (global) {
  "use strict";
  const diff = typeof module === "object" ? require("diff") : global.StuartDiff;

  function boundary(text, position) {
    if (!Number.isInteger(position) || position < 0 || position > text.length) throw new Error("UTF-16偏移超出正文");
    if (position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position])) throw new Error("UTF-16偏移拆分了字符");
  }

  function editsBetween(before, after) {
    let offset = 0;
    const edits = [];
    for (const part of diff.diffChars(before, after)) {
      if (part.added) {
        const previous = edits[edits.length - 1];
        if (previous && previous.to === offset) previous.insertedText += part.value;
        else edits.push({ from: offset, to: offset, insertedText: part.value });
      } else if (part.removed) {
        edits.push({ from: offset, to: offset + part.value.length, insertedText: "" });
        offset += part.value.length;
      } else offset += part.value.length;
    }
    return edits;
  }

  class TextBuffer {
    constructor(source = "", defaultSeparator) {
      this.source = String(source);
      this.defaultSeparator = defaultSeparator ?? this.source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
      if (!["\n", "\r\n", "\r"].includes(this.defaultSeparator)) throw new Error("文档默认换行分隔符无效");
    }
    get editorText() { return this.source.replace(/\r\n|\r/g, "\n"); }
    apply(edit) {
      boundary(this.source, edit.from);
      boundary(this.source, edit.to);
      if (edit.to < edit.from) throw new Error("UTF-16编辑范围顺序错误");
      this.source = this.source.slice(0, edit.from) + edit.insertedText + this.source.slice(edit.to);
    }
    updateEditor(next) {
      const normalized = this.editorText;
      const nextText = String(next).replace(/\r\n|\r/g, "\n");
      if (normalized === nextText) return [];
      const positions = [0];
      for (let raw = 0; raw < this.source.length;) {
        raw += this.source[raw] === "\r" && this.source[raw + 1] === "\n" ? 2 : 1;
        positions.push(raw);
      }
      const edits = editsBetween(normalized, nextText).map(edit => ({
        from: positions[edit.from], to: positions[edit.to], insertedText: edit.insertedText.replace(/\n/g, this.defaultSeparator),
      }));
      for (let index = edits.length - 1; index >= 0; index--) this.apply(edits[index]);
      return edits;
    }
    editsFrom(source) { return editsBetween(String(source), this.source); }
  }

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.TextBuffer = TextBuffer;
  global.StuartCore.editsBetween = editsBetween;
  if (typeof module === "object") module.exports = { TextBuffer, editsBetween };
})(typeof window !== "undefined" ? window : globalThis);
