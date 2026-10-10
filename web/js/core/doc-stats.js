(function (global) {
  "use strict";
  const markdownit = typeof module === "object" ? require("../../libs/markdown-it.min.js") : global.markdownit;
  const diff = typeof module === "object" ? require("diff") : global.StuartDiff;
  const parser = markdownit({ html: true });
  const metadata = Symbol("sourceRanges");

  function splitMarkdownBlocks(text) {
    const source = String(text ?? "");
    const lines = [0];
    for (let index = 0; index < source.length; index++) {
      if (source[index] === "\n" || (source[index] === "\r" && source[index + 1] !== "\n")) lines.push(index + 1);
    }
    const ranges = parser.parse(source, {}).filter(token => token.level === 0 && token.map && token.type !== "inline").map(token => ({
      from: lines[token.map[0]] ?? source.length, to: lines[token.map[1]] ?? source.length,
    })).filter((range, index, all) => index === 0 || range.from >= all[index - 1].to);
    if (!ranges.length && source) ranges.push({ from: 0, to: source.length });
    const blocks = ranges.map(range => source.slice(range.from, range.to));
    Object.defineProperty(blocks, metadata, { value: { source, ranges, original: [...blocks] } });
    return blocks;
  }

  function joinBlocks(blocks, originalSource) {
    let record = blocks[metadata];
    if (!record && originalSource != null) record = splitMarkdownBlocks(originalSource)[metadata];
    if (!record) return blocks.join("\n\n");
    let source = record.source;
    let originalIndex = 0;
    const edits = [];
    const changes = diff.diffArrays(record.original, Array.from(blocks, value => String(value ?? "")));
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (!change.added && !change.removed) { originalIndex += change.count; continue; }
      const startIndex = originalIndex;
      let removed = 0;
      let added = [];
      if (change.removed) {
        removed = change.count;
        originalIndex += removed;
        if (changes[index + 1]?.added) added = changes[++index].value;
      } else added = change.value;
      const from = record.ranges[startIndex]?.from ?? source.length;
      const to = removed ? record.ranges[startIndex + removed - 1].to : from;
      const separator = record.ranges.length > 1 ? source.slice(record.ranges[0].to, record.ranges[1].from) : "\n";
      let insertedText = added.join(separator || "\n");
      if (!removed && insertedText && startIndex < record.ranges.length) insertedText += separator || "\n";
      if (!removed && insertedText && startIndex === record.ranges.length && source && !source.endsWith("\n")) insertedText = "\n\n" + insertedText;
      edits.push({ from, to, insertedText });
    }
    for (let index = edits.length - 1; index >= 0; index--) {
      const edit = edits[index];
      source = source.slice(0, edit.from) + edit.insertedText + source.slice(edit.to);
    }
    return source;
  }

  const countChars = text => String(text || "").replace(/\s/g, "").length;
  const countLines = text => text ? String(text).split("\n").length : 0;
  global.StuartCore = global.StuartCore || {};
  global.StuartCore.docStats = {
    countChars, countLines, summarize: text => ({ chars: countChars(text), lines: countLines(text) }),
    splitMarkdownBlocks, joinBlocks,
    splitDocument: source => ({ blocks: splitMarkdownBlocks(source) }),
    joinDocument: document => joinBlocks(document.blocks),
  };
})(typeof window !== "undefined" ? window : globalThis);
