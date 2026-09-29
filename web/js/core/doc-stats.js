/**
 * StuartMD core — document stats (pure, testable).
 * Host: window.StuartCore.docStats
 */
(function (global) {
  "use strict";

  function countChars(text) {
    return String(text || "").replace(/\s/g, "").length;
  }

  function countLines(text) {
    const t = String(text || "");
    if (!t) return 0;
    return t.split("\n").length;
  }

  function summarize(text) {
    return { chars: countChars(text), lines: countLines(text) };
  }

  /**
   * Split markdown into visual blocks.
   * Extra blank lines become empty-string blocks so reading-mode can select/edit them.
   * One blank line between content is the separator (not an empty block).
   */
  function splitMarkdownBlocks(text) {
    const src = text || "";
    if (!src.trim()) return [];
    const lines = src.split("\n");
    const blocks = [];
    let buf = [];
    let inFence = false;
    let fenceMarker = "";
    const flush = () => {
      const raw = buf.join("\n").replace(/\s+$/, "");
      if (raw.trim().length) blocks.push(raw);
      buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s{0,3}(```+|~~~+)/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence[1][0];
          buf.push(line);
          continue;
        }
        if (fence[1][0] === fenceMarker) {
          buf.push(line);
          inFence = false;
          fenceMarker = "";
          flush();
          continue;
        }
      }
      if (!inFence && line.trim() === "") {
        if (buf.length) {
          flush();
        } else {
          // Extra blank line (not the single separator) → empty block
          blocks.push("");
        }
        continue;
      }
      buf.push(line);
    }
    flush();
    // Drop leading/trailing empty blocks only (they are not meaningful content slots)
    while (blocks.length && blocks[0] === "") blocks.shift();
    while (blocks.length && blocks[blocks.length - 1] === "") blocks.pop();
    return blocks;
  }

  /**
   * Inverse of splitMarkdownBlocks.
   * Content blocks are separated by one blank line; each empty block is one extra blank line.
   */
  function joinBlocks(blocks) {
    const list = (blocks || []).map((b) => (b == null ? "" : String(b)));
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (i === 0) {
        if (b) out.push(...b.split("\n"));
        else out.push("");
      } else if (b) {
        out.push("");
        out.push(...b.split("\n"));
      } else {
        out.push("");
      }
    }
    return out.join("\n");
  }

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.docStats = {
    countChars,
    countLines,
    summarize,
    splitMarkdownBlocks,
    joinBlocks,
  };
})(typeof window !== "undefined" ? window : globalThis);
