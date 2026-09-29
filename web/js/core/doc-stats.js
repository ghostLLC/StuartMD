/**
 * StuartMD core — document stats (pure, testable).
 * Host: window.StuartCore.docStats
 *
 * Fidelity contract:
 *   joinBlocks(splitMarkdownBlocks(s)) === s
 *   joinDocument(splitDocument(s)) === s
 * for the golden corpus (hard breaks, trailing newline, leading/trailing
 * blanks, CRLF, fenced blanks, empty interior blocks, UTF-8).
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

  /** Blank separator line: empty, or CR-only (CRLF blank when split on LF). */
  function isBlankLine(ln) {
    return ln === "" || ln === "\r";
  }

  /**
   * CRLF if a strict majority of informative lines end with CR (split on LF).
   * Empty lines are not evidence. A lone trailing CR inside LF text must not
   * flip a whole document to CRLF blank markers.
   */
  function detectCrlf(blocks) {
    let cr = 0;
    let lf = 0;
    for (let i = 0; i < blocks.length; i++) {
      const lines = String(blocks[i]).split("\n");
      for (let j = 0; j < lines.length; j++) {
        const ln = lines[j];
        if (ln === "") continue;
        if (ln.charAt(ln.length - 1) === "\r") cr++;
        else lf++;
      }
    }
    return cr > 0 && cr > lf;
  }

  /**
   * Split markdown into visual blocks (legacy string[] API, byte-preserving).
   *
   * Semantics:
   * - Content runs (paragraphs, fenced regions) are blocks.
   * - One blank line between content is the separator (not an empty block).
   * - Extra interior blank lines become empty-string blocks.
   * - Leading blank lines become empty-string blocks.
   * - Trailing blank lines + the final newline are kept as exact text on the
   *   last content block (string[] alone cannot mark "ends with newline"
   *   separately from a blank line).
   * - A document with no content lines round-trips as a single exact block.
   * - Trailing whitespace (hard-break spaces) and CR are never stripped.
   */
  function splitMarkdownBlocks(text) {
    const src = String(text == null ? "" : text);
    if (src === "") return [];

    const rawLines = src.split("\n");
    const tnl = src.charAt(src.length - 1) === "\n";
    const lines = rawLines.slice();
    if (tnl) lines.pop();

    const blocks = [];
    let buf = [];
    let inFence = false;
    let fenceMarker = "";
    let pending = [];
    let contentCount = 0;

    const flushContent = () => {
      if (!buf.length) return;
      blocks.push(buf.join("\n"));
      buf = [];
      contentCount++;
    };
    const emitPending = () => {
      if (!pending.length) return;
      if (contentCount === 0) {
        // Leading blanks → empty blocks
        for (let i = 0; i < pending.length; i++) blocks.push("");
      } else {
        // Interior gap: one blank is the separator, the rest are empty blocks
        for (let i = 1; i < pending.length; i++) blocks.push("");
      }
      pending = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s{0,3}(```+|~~~+)/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence[1][0];
          emitPending();
          buf.push(line);
          continue;
        }
        if (fence[1][0] === fenceMarker) {
          buf.push(line);
          inFence = false;
          fenceMarker = "";
          // Glue to following content when no blank line separates them —
          // join must not invent a separator that was never in the source.
          const next = i + 1 < lines.length ? lines[i + 1] : null;
          if (next == null || isBlankLine(next)) flushContent();
          continue;
        }
      }
      if (!inFence && isBlankLine(line)) {
        if (buf.length) {
          flushContent();
          pending = [line];
        } else {
          pending.push(line);
        }
        continue;
      }
      if (!buf.length) emitPending();
      buf.push(line);
    }
    flushContent();

    // No content lines at all: keep exact bytes as one block
    if (contentCount === 0) return [src];

    // Trailing blanks + final newline → exact text on the last content block.
    // After the last content line text comes its terminator, then any blank
    // lines with their terminators (or the last blank without one when the
    // document does not end in a newline).
    if (pending.length || tnl) {
      let after = "";
      if (tnl || pending.length) {
        after = "\n";
        if (pending.length) {
          if (tnl) {
            for (let i = 0; i < pending.length; i++) after += pending[i] + "\n";
          } else {
            for (let i = 0; i < pending.length - 1; i++) after += pending[i] + "\n";
            after += pending[pending.length - 1];
          }
        }
      }
      const last = blocks.length - 1;
      blocks[last] = blocks[last] + after;
    }
    return blocks;
  }

  /**
   * Inverse of splitMarkdownBlocks (legacy string[] API).
   * Content blocks are separated by one blank line; each empty block is one
   * extra blank line. CRLF is detected from trailing CRs and preserved.
   */
  function joinBlocks(blocks) {
    const list = (blocks || []).map((b) => (b == null ? "" : String(b)));
    if (!list.length) return "";
    const blankLine = detectCrlf(list) ? "\r" : "";
    const out = [];
    let seenContent = false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b === "" || b === "\r") {
        out.push(blankLine);
      } else {
        if (seenContent) out.push(blankLine);
        const lines = b.split("\n");
        for (let j = 0; j < lines.length; j++) out.push(lines[j]);
        seenContent = true;
      }
    }
    return out.join("\n");
  }

  /**
   * Exact document split with explicit metadata (preferred for new code).
   * Returns { blocks, leading, trailing, eol } where joinDocument(doc) === text.
   * - eol: "\r\n" if the document uses CRLF, else "\n"
   * - leading: exact blank lines before the first content (including eols)
   * - trailing: exact text after the last content line (blanks + final eol)
   * - blocks: content blocks; "" marks an extra interior blank line
   */
  function splitDocument(text) {
    const src = String(text == null ? "" : text);
    const eol = /\r\n/.test(src) ? "\r\n" : "\n";
    if (src === "") return { blocks: [], leading: "", trailing: "", eol: "\n" };

    const parts = src.split(/\r\n|\n|\r/);
    const tnl = /(?:\r\n|\n|\r)$/.test(src);
    if (tnl) parts.pop();

    const blocks = [];
    let buf = [];
    let inFence = false;
    let fenceMarker = "";
    let pending = 0;
    let contentCount = 0;
    let firstContent = -1;
    let lastContent = -1;

    const flushContent = () => {
      if (!buf.length) return;
      blocks.push(buf.join("\n"));
      buf = [];
      contentCount++;
    };
    const emitPending = () => {
      if (pending <= 0) return;
      if (contentCount > 0) {
        for (let i = 1; i < pending; i++) blocks.push("");
      }
      pending = 0;
    };

    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      const fence = line.match(/^\s{0,3}(```+|~~~+)/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence[1][0];
          emitPending();
          if (firstContent < 0) firstContent = i;
          lastContent = i;
          buf.push(line);
          continue;
        }
        if (fence[1][0] === fenceMarker) {
          buf.push(line);
          lastContent = i;
          inFence = false;
          fenceMarker = "";
          const next = i + 1 < parts.length ? parts[i + 1] : null;
          if (next == null || next === "") flushContent();
          continue;
        }
      }
      if (!inFence && line === "") {
        if (buf.length) {
          flushContent();
          pending = 1;
        } else {
          pending++;
        }
        continue;
      }
      if (!buf.length) {
        emitPending();
        if (firstContent < 0) firstContent = i;
      }
      lastContent = i;
      buf.push(line);
    }
    flushContent();

    if (contentCount === 0) {
      return { blocks: [], leading: "", trailing: src, eol: eol };
    }

    let leading = "";
    for (let i = 0; i < firstContent; i++) leading += parts[i] + eol;
    let trailing = "";
    for (let i = lastContent + 1; i < parts.length; i++) trailing += parts[i] + eol;
    if (tnl) trailing += eol;
    return { blocks: blocks, leading: leading, trailing: trailing, eol: eol };
  }

  /** Exact inverse of splitDocument. */
  function joinDocument(doc) {
    const d = doc && typeof doc === "object" ? doc : {};
    const eol = d.eol === "\r\n" ? "\r\n" : "\n";
    const list = Array.isArray(d.blocks)
      ? d.blocks.map((b) => (b == null ? "" : String(b)))
      : [];
    const leading = d.leading == null ? "" : String(d.leading);
    const trailing = d.trailing == null ? "" : String(d.trailing);
    const out = [];
    let seenContent = false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b === "") {
        out.push("");
      } else {
        if (seenContent) out.push("");
        const lines = b.split("\n");
        for (let j = 0; j < lines.length; j++) out.push(lines[j]);
        seenContent = true;
      }
    }
    return leading + out.join(eol) + trailing;
  }

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.docStats = {
    countChars,
    countLines,
    summarize,
    splitMarkdownBlocks,
    joinBlocks,
    splitDocument,
    joinDocument,
  };
})(typeof window !== "undefined" ? window : globalThis);
