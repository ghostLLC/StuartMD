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
      if (!inFence && line.trim() === "" && buf.length) {
        flush();
        continue;
      }
      buf.push(line);
    }
    flush();
    return blocks;
  }

  function joinBlocks(blocks) {
    return (blocks || []).join("\n\n");
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
