/**
 * StuartMD AI context assembly — pure helpers for explain prompts.
 * Host: window.StuartAIContext
 */
(function (global) {
  "use strict";

  const DEFAULT_MAX = 8000;

  function clip(text, max) {
    const s = String(text == null ? "" : text);
    const m = max > 200 ? max : DEFAULT_MAX;
    if (s.length <= m) return s;
    return s.slice(0, m) + "\n…（上下文已截断）";
  }

  function findBlockIndexForSelection(blocks, selText, fallback) {
    const t = String(selText || "").trim();
    if (t && Array.isArray(blocks)) {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i] && blocks[i].text != null ? String(blocks[i].text) : "";
        if (b.includes(t)) return i;
      }
      // looser: first 40 chars
      const head = t.slice(0, 40);
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i] && blocks[i].text != null ? String(blocks[i].text) : "";
        if (head && b.includes(head)) return i;
      }
    }
    if (typeof fallback === "number" && fallback >= 0) return fallback;
    return 0;
  }

  function nearestHeading(outline, blocks, blockIndex) {
    // Map block index → approximate heading via line scan of blocks text
    let best = null;
    const list = Array.isArray(outline) ? outline : [];
    if (!list.length) {
      // fallback: search heading inside previous blocks
      for (let i = blockIndex; i >= 0; i--) {
        const b = blocks[i] && blocks[i].text != null ? String(blocks[i].text) : "";
        const lines = b.split("\n");
        for (const line of lines) {
          const m = line.match(/^(#{1,6})\s+(.*)$/);
          if (m) return { level: m[1].length, title: m[2].trim(), line: null };
        }
      }
      return null;
    }
    // outline.line is 1-based over full doc; approximate by cumulative block lines
    let lineNo = 1;
    const targetLine = (() => {
      let n = 1;
      for (let i = 0; i < blockIndex && i < blocks.length; i++) {
        const b = blocks[i] && blocks[i].text != null ? String(blocks[i].text) : "";
        n += b.split("\n").length;
      }
      return n;
    })();
    for (const h of list) {
      if (typeof h.line === "number" && h.line <= targetLine) best = h;
    }
    void lineNo;
    return best;
  }

  function neighborText(blocks, blockIndex, max) {
    const parts = [];
    const idxs = [blockIndex - 1, blockIndex, blockIndex + 1];
    for (const i of idxs) {
      if (i < 0 || !blocks || !blocks[i]) continue;
      const b = blocks[i];
      const text = b.text != null ? String(b.text) : "";
      const tag = i === blockIndex ? "当前块" : i < blockIndex ? "上一块" : "下一块";
      parts.push(`[${tag} #${i}]\n${text.trim()}`);
    }
    return clip(parts.join("\n\n"), max);
  }

  function fullDocText(doc, max) {
    return clip((doc && doc.content) || "", max);
  }

  /**
   * Build explain payload for markdown.
   * @returns {{quote:string, context:string, meta:object, promptUser:string}}
   */
  function buildMarkdownExplain(host, opts) {
    const o = opts || {};
    const max = o.maxChars || DEFAULT_MAX;
    const scope = o.scope === "full" ? "full" : "neighborhood";
    let sel = (host && host.getSelectionInfo && host.getSelectionInfo()) || {
      text: "",
      blockIndex: null,
    };
    let quote = String(sel.text || o.quote || "").trim();
    if (!quote && host && host.getSelectionCache) {
      const cache = host.getSelectionCache();
      if (cache && cache.text) {
        quote = String(cache.text).trim();
        sel = Object.assign({}, sel, { text: quote, blockIndex: cache.blockIndex });
      }
    }
    const doc = (host && host.getDocument && host.getDocument()) || {};
    const blocks = (host && host.getBlocks && host.getBlocks()) || [];
    const outline = (host && host.getOutline && host.getOutline()) || [];
    const blockIndex = findBlockIndexForSelection(blocks, quote, sel.blockIndex);
    const heading = nearestHeading(outline, blocks, blockIndex);
    const headingLine = heading
      ? `${"#".repeat(heading.level || 1)} ${heading.title}`
      : "（无标题）";

    let context = "";
    if (scope === "full") {
      context = fullDocText(doc, max);
    } else {
      context = neighborText(blocks, blockIndex, max);
    }

    const name = doc.name || o.name || "未命名";
    const path = doc.path || o.path || "";
    const meta = {
      kind: "markdown",
      name,
      path,
      heading: headingLine,
      blockIndex,
      scope,
      quoteLen: quote.length,
    };

    const memoryNote = o.memoryProfile ? `\n【用户记忆】\n${clip(o.memoryProfile, 1200)}` : "";
    const promptUser = [
      `【文件】${name}`,
      path ? `【路径】${path}` : "",
      `【章节】${headingLine}`,
      `【选区】\n${quote || "（空）"}`,
      `【上下文】\n${context || "（无）" }`,
      memoryNote,
      `【任务】请结合上述文件上下文，用简体中文讲解「选区」内容：它在全文中的含义与作用、关键概念、可能的疑点。忠于原文，不确定请标明。不要编造页码或不存在的章节。只讲解，不要改写用户文档。`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return { quote, context, meta, promptUser };
  }

  /** PDF explain — Phase 2 will feed page text; still works with selection only. */
  function buildPdfExplain(payload, opts) {
    const o = opts || {};
    const max = o.maxChars || DEFAULT_MAX;
    const quote = String((payload && payload.quote) || "").trim();
    const page = payload && payload.page != null ? payload.page : null;
    const pageText = clip((payload && payload.pageText) || "", max);
    const neighbor = clip((payload && payload.neighborText) || "", Math.floor(max / 2));
    const name = (payload && payload.name) || "PDF";
    const context = [pageText, neighbor].filter(Boolean).join("\n\n---\n\n");
    const memoryNote = o.memoryProfile ? `\n【用户记忆】\n${clip(o.memoryProfile, 1200)}` : "";
    const promptUser = [
      `【文件】${name}（PDF）`,
      page != null ? `【页码】P${page}` : "",
      `【选区】\n${quote || "（空）"}`,
      `【上下文】\n${context || "（本页暂无可用文本层）"}`,
      memoryNote,
      `【任务】请结合 PDF 上下文，用简体中文讲解选区内容。若引用页码仅使用上下文中出现过的页码。忠于原文，只讲解，不要改写文件。`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      quote,
      context,
      meta: { kind: "pdf", name, page, scope: o.scope || "neighborhood" },
      promptUser,
    };
  }

  const LENGTH_PRESETS = {
    brief: "默认简短：先一句结论，再列要点；名词/术语控制在约 3–5 句，除非用户明确要求展开。",
    normal: "长度适中：结论 + 必要展开，避免冗长铺垫与重复。",
    detailed: "较详细：可分层说明概念、例子与疑点，但仍避免无关扩写。",
  };

  const TONE_PRESETS = {
    neutral: "语气中性、清晰克制。",
    friendly: "语气亲切易懂，可适当口语化，但不轻浮。",
    professional: "偏工程/实务：准确、可执行，少空话。",
    academic: "偏学术：严谨、可引用文内依据，避免口语。",
  };

  function styleBlock(style) {
    const s = style || {};
    const length = LENGTH_PRESETS[s.length] || LENGTH_PRESETS.normal;
    const tone = TONE_PRESETS[s.tone] || TONE_PRESETS.neutral;
    const custom = String(s.custom || "").trim();
    const hint = String(s.length_hint || "").trim();
    const parts = [
      "【回答风格】",
      `- 长度偏好：${length}`,
      `- 对话语气：${tone}`,
    ];
    if (hint) {
      parts.push(`- 长度微调（来自用户反馈，轻量遵守，不必机械压缩/扩写）：${hint}`);
    }
    if (custom) {
      parts.push("- 用户自定义风格（优先参考，但不与事实冲突）：");
      parts.push(custom);
    }
    return parts.join("\n");
  }

  function systemPrompt(style) {
    return [
      "你是 StuartMD 内置的文档讲解助手。",
      "用户会提供：文件名、章节/页码、选区、以及邻近上下文。",
      "请用清晰的简体中文讲解选区：含义、在全文中的作用、关键概念、疑点。",
      "必须忠于给出的原文；材料不足时明确说明「文中未提及」。",
      "禁止编造页码、章节或数据。",
      "输出使用简洁 Markdown（可用小标题与列表），不要输出 HTML/脚本。",
      "这是讲解，不是代写：不要输出可直接替换用户全文的改写稿。",
      styleBlock(style),
      "若用户只问一个名词/短语，默认短答；确有需要再简要展开。长度微调仅作轻量指引，保留模型正常发挥。",
    ].join("\n");
  }

  /** Derive a mild length_hint from feedback counts. Never too heavy. */
  function lengthHintFromFeedback(fb, currentLength) {
    const f = fb || {};
    const short = f.short || 0;
    const ok = f.ok || 0;
    const long = f.long || 0;
    if (long > short && long >= ok) {
      return "近期反馈偏「太长」：优先短答（结论先行，默认约 3–6 句或要点列表），仅在追问时展开。";
    }
    if (short > long && short >= ok) {
      return "近期反馈偏「太短」：在完整前提下可略展开（定义后补 2–4 个关键点），仍避免无关铺垫。";
    }
    if (ok > 0 && ok >= short && ok >= long) {
      return "近期反馈多为「满意」：保持当前详细程度，无需刻意加长或压缩。";
    }
    if (currentLength === "brief") {
      return "长度偏好为简短：默认短答，细节留给追问。";
    }
    return "";
  }

  /** Parse "Alt+E" / "Ctrl+Shift+J" into matcher. */
  function parseShortcut(str) {
    const raw = String(str || "").trim();
    if (!raw) return null;
    const parts = raw.split("+").map((x) => x.trim()).filter(Boolean);
    const mods = { ctrl: false, alt: false, shift: false, meta: false };
    let key = "";
    for (const p of parts) {
      const l = p.toLowerCase();
      if (l === "ctrl" || l === "control") mods.ctrl = true;
      else if (l === "alt" || l === "option") mods.alt = true;
      else if (l === "shift") mods.shift = true;
      else if (l === "meta" || l === "cmd" || l === "win") mods.meta = true;
      else key = p;
    }
    return { label: raw, mods, key: key.toLowerCase() };
  }

  function eventMatchesShortcut(e, sc) {
    if (!sc || !sc.key) return false;
    const k = String(e.key || "").toLowerCase();
    if (k !== sc.key) return false;
    return (
      !!e.ctrlKey === !!sc.mods.ctrl &&
      !!e.altKey === !!sc.mods.alt &&
      !!e.shiftKey === !!sc.mods.shift &&
      !!e.metaKey === !!sc.mods.meta
    );
  }

  function shortcutFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    let k = e.key;
    if (!k) return "";
    if (k === " ") k = "Space";
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join("+");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Minimal markdown → safe HTML for AI panel (no raw HTML). */
  function renderSafeMarkdown(text) {
    const src = String(text == null ? "" : text);
    const lines = src.split(/\r?\n/);
    const out = [];
    let inCode = false;
    let listBuf = [];
    const flushList = () => {
      if (!listBuf.length) return;
      out.push("<ul>" + listBuf.map((x) => `<li>${inline(x)}</li>`).join("") + "</ul>");
      listBuf = [];
    };
    const inline = (t) =>
      escapeHtml(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) {
          out.push("</code></pre>");
          inCode = false;
        } else {
          flushList();
          out.push("<pre><code>");
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        out.push(escapeHtml(line));
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushList();
        const lv = Math.min(6, h[1].length + 2);
        out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        continue;
      }
      const li = line.match(/^\s*[-*+]\s+(.*)$/);
      if (li) {
        listBuf.push(li[1]);
        continue;
      }
      if (!line.trim()) {
        flushList();
        continue;
      }
      flushList();
      out.push(`<p>${inline(line)}</p>`);
    }
    if (inCode) out.push("</code></pre>");
    flushList();
    return out.join("\n");
  }

  global.StuartAIContext = {
    DEFAULT_MAX,
    clip,
    buildMarkdownExplain,
    buildPdfExplain,
    systemPrompt,
    styleBlock,
    lengthHintFromFeedback,
    LENGTH_PRESETS,
    TONE_PRESETS,
    parseShortcut,
    eventMatchesShortcut,
    shortcutFromEvent,
    renderSafeMarkdown,
    escapeHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);
