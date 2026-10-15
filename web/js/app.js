/* StuartMD application logic */
(function () {
  "use strict";

  // Global unhandled rejection & error monitoring (P0-6)
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[StuartMD UnhandledRejection]", event.reason);
    const msg = event.reason?.message || String(event.reason || "未知异步错误");
    if (typeof toast === "function") {
      toast("操作异常: " + msg);
    }
  });

  window.addEventListener("error", (event) => {
    console.error("[StuartMD GlobalError]", event.error || event.message);
  });

  let activeDocument = null;
  const pendingJournals = new Map();
  const queuedJournalSnapshots = new Map();
  function queueDraftSnapshot(document, snapshot) {
    if (snapshot.documentId !== document.documentId) throw new Error("草稿快照与文档身份不一致");
    if (document.journalRevision >= snapshot.revision) return Promise.resolve();
    const previous = pendingJournals.get(document.documentId) || Promise.resolve();
    if (queuedJournalSnapshots.get(document.documentId)?.revision >= snapshot.revision) return previous;
    const persist = () => window.pywebview.api.journal_write(snapshot);
    const next = previous.then(persist, persist).then(result => {
      if (result.documentId !== snapshot.documentId || result.journalRevision < snapshot.revision) throw new Error("草稿确认与提交版本不一致");
      document.journalRevision = Math.max(document.journalRevision, result.journalRevision);
      if (activeDocument === document) updateAutosaveStatus();
    });
    pendingJournals.set(document.documentId, next);
    queuedJournalSnapshots.set(document.documentId, snapshot);
    next.then(() => {
      if (pendingJournals.get(document.documentId) === next) pendingJournals.delete(document.documentId);
    }, () => {
      if (pendingJournals.get(document.documentId) === next) {
        pendingJournals.delete(document.documentId);
        queuedJournalSnapshots.delete(document.documentId);
      }
    });
    return next;
  }

  function scheduleDraftJournal() {
    if (!activeDocument || activeDocument.kind === "pdf" || !state.apiReady) return;
    queueDraftSnapshot(activeDocument, activeDocument.snapshot()).catch(error => toast("草稿保存失败：" + error.message));
  }

  async function flushDraftJournal() {
    if (!state.apiReady) return;
    for (const tab of state.tabs) {
      const document = tab.document;
      if (document?.kind === "markdown" && document.accessState === "Editable" && document.journalRevision < document.revision) await queueDraftSnapshot(document, document.snapshot());
    }
    await Promise.all(pendingJournals.values());
    await window.pywebview.api.journal_flush();
    await window.StuartCore.writeCoord.flush();
  }

  async function flushCurrentDocument() {
    let captured;
    do {
      commitActiveBlockEdits();
      saveActiveTabFromEditor();
      captured = activeDocument?.revision;
      await flushDraftJournal();
    } while (activeDocument?.revision !== captured);
  }

  // ---------- State ----------
  const state = {
    path: null,
    name: "未命名",
    content: "",
    dirty: false,
    mode: "preview", // preview | split | source
    theme: "light", // light | gray | dark | sepia | minion | wallpaper
    folder: "",
    sidebarOpen: true,
    findHits: [],
    findIndex: -1,
    apiReady: false,
    autosaveEnabled: true,
    lastAutosaveAt: 0,
    wallpaper: null,
    openMode: "smart", // smart | new_window | current_window
    newDocMode: "tab", // tab | new_window
    tabs: [],
    activeTabId: null,
    tabSeq: 1,
    isSampleDoc: false,
    sampleDismissed: false,
    workspaceRoot: "",
    aiShortcut: "Alt+E",
    aiConfig: null,
    // Last non-empty text selection (survives accidental collapse / block-edit steal)
    _selCache: null,
    // Timestamp of the last drag-select gesture end (short enter-edit grace only)
    _dragSelAt: 0,
  };

  // AI panel local state (3.0.0)
  const aiUI = {
    lastQuote: "",
    lastMeta: null,
    lastMessages: [],
    lastAnswer: "",
    recordingShortcut: false,
  };

  // ---------- DOM ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const el = {
    body: document.body,
    sidebar: $("#sidebar"),
    sidebarResizer: $("#sidebar-resizer"),
    fileTitle: $("#file-title"),
    dirtyDot: $("#dirty-dot"),
    welcome: $("#welcome"),
    editorArea: $("#editor-area"),
    source: $("#source"),
    preview: $("#preview"),
    sourcePane: $("#source-pane"),
    previewPane: $("#preview-pane"),
    splitResizer: $("#split-resizer"),
    fileTree: $("#file-tree"),
    folderName: $("#folder-name"),
    outlineList: $("#outline-list"),
    statusPath: $("#status-path"),
    statusWords: $("#status-words"),
    statusLines: $("#status-lines"),
    statusMode: $("#status-mode"),
    toast: $("#toast"),
    findBar: $("#find-bar"),
    findInput: $("#find-input"),
    replaceInput: $("#replace-input"),
    recentList: $("#recent-list"),
    hlLight: $("#hl-light"),
    hlDark: $("#hl-dark"),
  };

  // ---------- Markdown ----------
  const md = window.markdownit({
    html: true,
    linkify: true,
    typographer: true,
    breaks: false,
    highlight(str, lang) {
      const language = (lang || "").toLowerCase();
      // Mermaid: leave content for post-process renderer
      if (language === "mermaid") {
        return `<pre class="mermaid-src" data-mermaid="1">${escapeHtml(str)}</pre>`;
      }
      if (lang && window.hljs && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch (_) {}
      }
      if (window.hljs) {
        try {
          return hljs.highlightAuto(str).value;
        } catch (_) {}
      }
      return "";
    },
  });
  if (window.markdownitTaskLists) {
    md.use(window.markdownitTaskLists, { enabled: true, label: true });
  }

  let renderTimer = null;
  let previewScrollRatio = 0;
  /** P0: skip full preview rebuild when content is unchanged */
  let lastPreviewSource = null;
  let lastOutlineSig = "";
  let lastTreePath = null;
  /** P3: last rendered markdown blocks for dirty update */
  let lastPreviewBlocks = [];

  function scheduleIdle(fn) {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(fn, { timeout: 400 });
      return () => cancelIdleCallback(id);
    }
    return setTimeout(fn, 50);
  }

  function splitMarkdownBlocks(text) {
    const core = CoreDoc();
    if (!core) throw new Error("Markdown 文档解析依赖尚未加载");
    return core.splitMarkdownBlocks(activeDocument && text === el.source.value ? activeDocument.source : text);
  }

  function joinBlocks(blocks) {
    const core = CoreDoc();
    if (!core) throw new Error("Markdown 文档解析依赖尚未加载");
    return core.joinBlocks(blocks, activeDocument?.source);
  }

  function blockNeedsPostProcess(block) {
    // Skip KaTeX / image resolve on plain paragraphs for speed
    if (!block) return false;
    if (block.indexOf("\\(") >= 0 || block.indexOf("\\[") >= 0) return true;
    if (/!\[[^\]]*\]\(/.test(block)) return true;
    if (/(^|[^\\A-Za-z0-9])\$\$/.test(block) || /(^|[^\\A-Za-z0-9])\$[^$\n]+\$/.test(block)) {
      return true;
    }
    return false;
  }

  // ---------- Perf helpers ----------
  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  /** LRU-ish cache: markdown block source → rendered HTML (tab switch / undo / re-render). */
  const _blockHtmlCache = new Map();
  const BLOCK_HTML_CACHE_MAX = 800;

  function renderBlockHtml(block) {
    const hit = _blockHtmlCache.get(block);
    if (hit != null) return hit;
    let html = "";
    try {
      html = md.render(block);
    } catch (e) {
      html = `<pre>${escapeHtml(String(e))}</pre>`;
    }
    if (_blockHtmlCache.size >= BLOCK_HTML_CACHE_MAX) {
      // Drop oldest ~1/4
      let n = BLOCK_HTML_CACHE_MAX >> 2;
      for (const k of _blockHtmlCache.keys()) {
        _blockHtmlCache.delete(k);
        if (--n <= 0) break;
      }
    }
    _blockHtmlCache.set(block, html);
    return html;
  }

  /** splitMarkdownBlocks result cache — same text must not re-parse. */
  let _splitCache = { text: null, blocks: null };
  function splitBlocksCached(text) {
    const t = text || "";
    if (_splitCache.text === t && _splitCache.blocks) return _splitCache.blocks;
    const blocks = splitMarkdownBlocks(t);
    _splitCache = { text: t, blocks };
    return blocks;
  }

  // 严格白名单 HTML 清洗器 (原生 DOM 树递归白名单处理器 - 方案 B)
  function sanitizeHtmlStrict(rawHtml) {
    if (!rawHtml) return "";

    if (typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(rawHtml, {
        // svg/mathMl required for Mermaid diagrams and KaTeX visual twins
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link", "style", "applet", "animate", "set", "foreignObject"],
        FORBID_ATTR: ["style"],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        ADD_ATTR: ["target"],
      });
    }

    const template = document.createElement("template");
    template.innerHTML = rawHtml;
    const content = template.content;

    const ALLOWED_TAGS = new Set([
      "P", "BR", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
      "BLOCKQUOTE", "PRE", "CODE", "UL", "OL", "LI", "DL", "DT", "DD",
      "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD",
      "STRONG", "B", "EM", "I", "U", "DEL", "S", "A", "IMG",
      "SPAN", "DIV", "SUB", "SUP", "MARK", "SMALL", "ABBR", "SUMMARY", "DETAILS", "INPUT",
      "SVG", "G", "PATH", "RECT", "CIRCLE", "LINE", "POLYLINE", "POLYGON", "ELLIPSE",
      "TEXT", "TSPAN", "DEFS", "MARKER", "CLIPPATH", "FILTER", "FOREIGNOBJECT", "TITLE", "DESC",
      "STYLE", "LINEARGRADIENT", "RADIALGRADIENT", "STOP", "USE", "SYMBOL",
      "MATH", "MI", "MN", "MO", "MSUP", "MSUB", "MFRAC", "MSQRT", "MROW", "MTEXT", "MSPACE", "MSTYLE", "MERROR", "MPADDED", "MPHANTOM"
    ]);

    const SVG_ATTRS = new Set([
      "class", "id", "title", "style", "viewBox", "xmlns", "width", "height", "x", "y",
      "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "d", "fill", "stroke",
      "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
      "stroke-dashoffset", "opacity", "transform", "points", "offset", "stop-color",
      "stop-opacity", "marker-end", "marker-start", "marker-mid", "markerWidth",
      "markerHeight", "refX", "refY", "orient", "clip-path", "fill-rule", "fill-opacity",
      "stroke-opacity", "font-size", "font-family", "font-weight", "text-anchor",
      "dominant-baseline", "alignment-baseline", "href", "xlink:href", "data-icon",
      "aria-hidden", "focusable", "role", "vector-effect", "xmlns:xlink"
    ]);
    const ALLOWED_ATTRS = {
      "A": new Set(["href", "target", "rel", "title", "class", "id"]),
      "IMG": new Set(["src", "alt", "title", "width", "height", "class", "id", "loading"]),
      "CODE": new Set(["class", "id", "data-language"]),
      "PRE": new Set(["class", "id", "data-mermaid"]),
      "TH": new Set(["align", "colspan", "rowspan", "class", "id"]),
      "TD": new Set(["align", "colspan", "rowspan", "class", "id"]),
      "OL": new Set(["start", "type", "class", "id"]),
      "INPUT": new Set(["type", "disabled", "checked", "class", "id"]),
      "DEFAULT": new Set(["class", "id", "title", "dir", "lang", "data-index", "data-mermaid", "style", "viewBox", "xmlns"])
    };
    // SVG / MathML nodes get presentation attributes (Mermaid + KaTeX)
    const SVG_TAGS = new Set([
      "SVG", "G", "PATH", "RECT", "CIRCLE", "LINE", "POLYLINE", "POLYGON", "ELLIPSE",
      "TEXT", "TSPAN", "DEFS", "MARKER", "CLIPPATH", "FILTER", "FOREIGNOBJECT",
      "LINEARGRADIENT", "RADIALGRADIENT", "STOP", "USE", "SYMBOL", "TITLE", "DESC", "STYLE"
    ]);

    function isSafeUrl(rawUrl) {
      if (!rawUrl) return false;
      const normalized = rawUrl.replace(/[\u0000-\u001F\u007F\s]/g, "").toLowerCase();
      if (
        normalized.includes("javascript:") ||
        normalized.includes("data:") ||
        normalized.includes("vbscript:") ||
        normalized.includes("file:") ||
        normalized.includes("about:")
      ) {
        return false;
      }
      return (
        normalized.startsWith("http://") ||
        normalized.startsWith("https://") ||
        normalized.startsWith("mailto:") ||
        normalized.startsWith("#") ||
        normalized.startsWith("/") ||
        normalized.startsWith("./") ||
        normalized.startsWith("../")
      );
    }

    const allElements = Array.from(content.querySelectorAll("*"));
    for (const el of allElements) {
      const tagName = el.tagName.toUpperCase();

      if (!ALLOWED_TAGS.has(tagName)) {
        el.remove();
        continue;
      }

      if (tagName === "INPUT" && el.getAttribute("type") !== "checkbox") {
        el.remove();
        continue;
      }

      // Drop <style> from untrusted markdown HTML (CSS exfil / UI redress).
      // Mermaid diagrams never pass through this whitelist (see sanitizeMermaidSvg).
      if (tagName === "STYLE") {
        el.remove();
        continue;
      }

      const isSvg = SVG_TAGS.has(tagName);
      const allowedForTag = isSvg ? SVG_ATTRS : ALLOWED_ATTRS[tagName] || ALLOWED_ATTRS["DEFAULT"];
      const allowedLower = new Set([...allowedForTag].map((s) => s.toLowerCase()));
      const attrs = Array.from(el.attributes);

      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();

        if (attrName.startsWith("on") || !allowedLower.has(attrName)) {
          el.removeAttribute(attr.name);
          continue;
        }

        if (attrName === "href" || attrName === "src" || attrName === "xlink:href") {
          if (!isSafeUrl(attr.value)) {
            el.removeAttribute(attr.name);
          }
        }

        if (attrName === "class" && !/^[a-zA-Z0-9_\-\s]+$/.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
        if (attrName === "id" && !/^[a-zA-Z0-9_\-]+$/.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }

      if (tagName === "A") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }

    const container = document.createElement("div");
    container.appendChild(content);
    return container.innerHTML;
  }

  /**
   * S2.2: stamp reading-mode code blocks with data-lang for the chrome badge.
   * Lang = code.language-* (fence info) or the fence info string on the block
   * source (```js / ```language-js). Empty → no attribute → no badge.
   * CSS draws the pill via ::before; no extra DOM, clicks still reach the pre.
   */
  function attachCodeLangBadges(root) {
    if (!root || !root.querySelectorAll) return;
    const src = root._stuartSrc != null ? String(root._stuartSrc) : "";
    let fenceLang = "";
    const fence = src.match(/^[ \t]{0,3}```([^\n`]*)/);
    if (fence) {
      const info = String(fence[1] || "").trim().split(/\s+/)[0] || "";
      fenceLang = info;
    }
    const pres = root.querySelectorAll("pre");
    for (let i = 0; i < pres.length; i++) {
      const pre = pres[i];
      if (pre.classList.contains("mermaid-src") || pre.classList.contains("mermaid-fallback")) continue;
      if (pre.closest(".code-edit-wrap") || pre.closest(".md-block-source")) continue;
      if (pre.hasAttribute("data-lang")) continue;
      const code = pre.querySelector("code");
      const classLang = ((code && code.className) || "").match(/(?:^|\s)language-([\w#+.-]+)/i);
      const codeAttr = code && code.getAttribute("data-language");
      let lang = (classLang && classLang[1]) || codeAttr || fenceLang || "";
      lang = String(lang)
        .replace(/^language[-_]/i, "")
        .toLowerCase()
        .split(/[^a-z0-9#+._-]/)[0];
      if (!lang) continue;
      pre.setAttribute("data-lang", lang);
    }
  }

  function createBlockNode(block, index) {
    const wrap = document.createElement("div");
    wrap.className = "md-block";
    wrap.dataset.index = String(index);
    stampBlockVersion(wrap);
    const src = block == null ? "" : String(block);
    wrap._stuartSrc = src;
    if (!src.trim()) {
      wrap.classList.add("md-empty");
      wrap.innerHTML = '<p class="md-empty-line"><br></p>';
      return wrap;
    }
    const html = renderBlockHtml(src);
    wrap.innerHTML = sanitizeHtmlStrict(html);
    attachCodeLangBadges(wrap);
    return wrap;
  }

  /** Strip executable HTML while keeping layout tags (tables, lists, images). */
  function sanitizeRenderedHtml(root) {
    if (!root || root.nodeType !== 1) return;
    try {
      root.innerHTML = sanitizeHtmlStrict(root.innerHTML);
    } catch (_) {}
  }

  /**
   * Mermaid SVG is generated by mermaid itself (securityLevel: strict).
   * Never run the HTML whitelist on it — that strips <style>/fill/stroke and
   * makes every diagram invisible. Only drop true script vectors.
   *
   * Keep <foreignObject>: mermaid v10+ (htmlLabels) puts node/edge labels
   * inside foreignObject <div><span class="nodeLabel">…</span></div>.
   * Removing foreignObject wipes every label and leaves empty boxes.
   */
  function sanitizeMermaidSvg(root) {
    if (!root || root.nodeType !== 1) return;
    // Script-capable / embed elements only — foreignObject MUST survive (labels).
    root
      .querySelectorAll("script, iframe, object, embed, link, meta, base, form, frame, frameset")
      .forEach((n) => n.remove());

    // Defense in depth inside foreignObject: keep basic label HTML
    // (div/span/br/inline), drop anything that can execute or load remote content.
    root.querySelectorAll("foreignObject").forEach((fo) => {
      fo
        .querySelectorAll(
          "script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, img, video, audio, canvas, svg, math, applet, portal"
        )
        .forEach((n) => n.remove());
    });

    root.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((a) => {
        const name = String(a.name || "").toLowerCase();
        const val = String(a.value || "");
        if (name.startsWith("on")) {
          el.removeAttribute(a.name);
          return;
        }
        const isUrlAttr =
          name === "href" || name === "xlink:href" || name === "src" || name === "formaction";
        if (isUrlAttr) {
          const normalized = val.replace(/[\u0000-\u001F\u007F\s]/g, "").toLowerCase();
          const isJsLike = /^(?:javascript|vbscript):/.test(normalized);
          const isData = normalized.startsWith("data:");
          const isSafeDataImage = name === "src" && /^data:image\//.test(normalized);
          if (isJsLike || (isData && !isSafeDataImage)) {
            el.removeAttribute(a.name);
          }
        }
      });
    });
  }

  /**
   * Resolve block source for edit: prefer live source model by index,
   * fall back to the snapshot captured at render time (defeats index drift).
   * Never return empty original when the node still carries a non-empty snapshot.
   */
  function resolveBlockSource(node) {
    if (!activeDocument || activeDocument.accessState !== "Editable" || node.dataset.documentId !== activeDocument.documentId || Number(node.dataset.revision) !== activeDocument.revision) {
      throw new Error("段落控件与当前文档版本不一致，请重新打开该段落");
    }
    const blocks = splitMarkdownBlocks(el.source.value || "");
    const idx = Number(node.dataset.index);
    let index = Number.isFinite(idx) ? idx : -1;
    let original = index >= 0 && index < blocks.length ? String(blocks[index] == null ? "" : blocks[index]) : "";
    const snap = node && node._stuartSrc != null ? String(node._stuartSrc) : "";
    if (snap.trim()) {
      const live = index >= 0 && index < blocks.length ? String(blocks[index] == null ? "" : blocks[index]) : "";
      if (live === snap) {
        original = live;
      } else {
        // Index drifted — try locate by snapshot
        const hit = blocks.findIndex((b) => b === snap);
        if (hit >= 0) {
          index = hit;
          original = snap;
        } else if (!String(original).trim()) {
          // Live slot empty/missing but DOM snapshot still has the source.
          original = snap;
        }
        // else: live slot has newer different content — keep live (source model wins)
      }
    } else if ((!original || !String(original).trim()) && snap.trim()) {
      original = snap;
    }
    return { index, original, blocks, snap };
  }

  function stampBlockVersion(node) {
    if (!activeDocument) throw new Error("段落控件缺少文档身份");
    node.dataset.documentId = activeDocument.documentId;
    node.dataset.revision = String(activeDocument.revision);
    node.dataset.renderEpoch = String(activeDocument.renderEpoch);
  }

  function postProcessBlock(node) {
    if (!node) return;
    if (window.renderMathInElement) {
      try {
        renderMathInElement(node, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
          ],
          throwOnError: false,
          ignoredClasses: ["source-pane", "md-block-editor"],
        });
      } catch (_) {}
    }
    const imgs = node.getElementsByTagName("img");
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("http") || src.startsWith("data:") || src.startsWith("file:")) continue;
      if (state.apiReady && state.path && window.pywebview?.api?.resolve_asset) {
        window.pywebview.api
          .resolve_asset(state.path, src)
          .then((uri) => {
            if (uri) img.src = uri;
          })
          .catch(() => {});
      }
    }
  }

  /** First few KaTeX/image passes sync; rest deferred off the critical path. */
  function postProcessBlocks(nodes) {
    if (!nodes || !nodes.length) return;
    const SYNC = 6;
    for (let i = 0; i < nodes.length && i < SYNC; i++) postProcessBlock(nodes[i]);
    if (nodes.length > SYNC) {
      scheduleIdle(() => {
        for (let i = SYNC; i < nodes.length; i++) {
          if (nodes[i].isConnected) postProcessBlock(nodes[i]);
        }
      });
    }
  }

  function applyBlockEditing() {
    if (state.mode === "source") return;
    const raw = el.source.value || "";
    const blocks = splitBlocksCached(raw);
    if (!blocks.length) {
      el.preview.innerHTML = "";
      lastPreviewBlocks = [];
      return;
    }

    const prev = lastPreviewBlocks;
    const childNodes = () => [...el.preview.children].filter((n) => n.classList?.contains("md-block"));

    let prefix = 0;
    const minLen = Math.min(prev.length, blocks.length);
    while (prefix < minLen && prev[prefix] === blocks[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      prev[prev.length - 1 - suffix] === blocks[blocks.length - 1 - suffix]
    ) {
      suffix++;
    }
    const changedMid = blocks.length - prefix - suffix + (prev.length - prefix - suffix);
    const heavy = !prev.length || changedMid > Math.max(12, blocks.length * 0.7);

    const needPP = [];
    if (heavy) {
      el.preview.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (let index = 0; index < blocks.length; index++) {
        const wrap = createBlockNode(blocks[index], index);
        if (blockNeedsPostProcess(blocks[index])) needPP.push(wrap);
        frag.appendChild(wrap);
      }
      el.preview.appendChild(frag);
    } else {
      const total = blocks.length;
      const keepTailCount = suffix;
      const existing = childNodes();
      // Detach suffix nodes for reuse (avoid re-layout of unchanged tail)
      const suffixNodes = existing.slice(existing.length - keepTailCount);
      while (el.preview.children.length > prefix) {
        el.preview.removeChild(el.preview.lastElementChild);
      }
      const frag = document.createDocumentFragment();
      for (let i = prefix; i < total - keepTailCount; i++) {
        const wrap = createBlockNode(blocks[i], i);
        if (blockNeedsPostProcess(blocks[i])) needPP.push(wrap);
        frag.appendChild(wrap);
      }
      for (let i = 0; i < suffixNodes.length; i++) {
        const node = suffixNodes[i];
        node.dataset.index = String(total - keepTailCount + i);
        frag.appendChild(node);
      }
      el.preview.appendChild(frag);
      const all = childNodes();
      for (let i = 0; i < all.length; i++) {
        all[i].dataset.index = String(i);
      }
    }
    if (needPP.length) postProcessBlocks(needPP);
    let sourceCursor = 0;
    const editorSource = activeDocument ? activeDocument.buffer.editorText : src.replace(/\r\n|\r/g, "\n");
    for (const [index, node] of childNodes().entries()) {
      stampBlockVersion(node);
      const blockSource = blocks[index].replace(/\r\n|\r/g, "\n");
      const start = editorSource.indexOf(blockSource, sourceCursor);
      if (start < 0) throw new Error("正文位置与当前编辑内容不一致");
      node.dataset.sourceOffset = String(start);
      node.dataset.sourceEnd = String(start + blockSource.length);
      sourceCursor = start + blockSource.length;
    }

    const midStart = prefix;
    const midEnd = blocks.length - suffix;
    const needMermaid =
      heavy || blocks.slice(midStart, midEnd).some((b) => /```\s*mermaid/i.test(b));
    if (needMermaid) renderMermaid();

    lastPreviewBlocks = blocks;
    // Preview DOM was rebuilt — previous find marks are detached
    if (state.findHits && state.findHits.length) {
      state.findHits = [];
      state.findIndex = -1;
      state._findQuery = "";
    }
    updateOutline();
    updateStats();
  }

  function captureSelectionCache() {
    try {
      // PDF selection snapshot
      try {
        if (window.StuartMDPdf && window.StuartMDPdf.isActive && window.StuartMDPdf.isActive()) {
          const ps = window.StuartMDPdf.getSelection && window.StuartMDPdf.getSelection();
          if (ps && ps.text && String(ps.text).trim()) {
            state._selCache = {
              text: String(ps.text),
              inPreview: false,
              inPdf: true,
              page: ps.page,
              pdfRects: ps.pdfRects || [],
              segments: ps.segments || [],
              fileFingerprint: ps.fileFingerprint,
              documentId: activeDocument.documentId,
              revision: activeDocument.revision,
              blockIndex: null,
              at: Date.now(),
            };
            return state._selCache;
          }
        }
      } catch (_) {}
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return state._selCache || null;
      const text = String(sel.toString() || "");
      if (!text.trim()) return state._selCache || null;
      const inPreview = !!(
        el.preview &&
        (el.preview.contains(sel.anchorNode) ||
          el.preview.contains(sel.focusNode) ||
          (sel.anchorNode &&
            sel.anchorNode.parentElement &&
            el.preview.contains(sel.anchorNode.parentElement)))
      );
      const inSource = el.source === document.activeElement || (el.source && el.source.contains(sel.anchorNode));
      if (!inPreview && !inSource) return getSelectionCache();
      let blockIndex = typeof state._activeBlockIndex === "number" ? state._activeBlockIndex : null;
      try {
        const b =
          sel.anchorNode &&
          (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.(".md-block");
        if (b && b.dataset.index != null) blockIndex = Number(b.dataset.index);
      } catch (_) {}
      const range = sel.getRangeAt(0);
      const blockFor = node => (node.nodeType === 1 ? node : node.parentElement)?.closest(".md-block");
      const first = blockFor(range.startContainer), last = blockFor(range.endContainer);
      state._selCache = {
        text,
        inPreview,
        blockIndex,
        from: inPreview && first ? Number(first.dataset.sourceOffset) : null,
        to: inPreview && last ? Number(last.dataset.sourceEnd) : null,
        start: inSource ? el.source.selectionStart : null,
        end: inSource ? el.source.selectionEnd : null,
        documentId: activeDocument.documentId,
        revision: activeDocument.revision,
        at: Date.now(),
      };
      return state._selCache;
    } catch (_) {
      return state._selCache || null;
    }
  }

  function getSelectionCache(maxAgeMs) {
    const c = state._selCache;
    if (!c || !c.text || !String(c.text).trim()) return null;
    if (c.documentId !== activeDocument?.documentId || c.revision !== activeDocument?.revision) return null;
    const max = maxAgeMs == null ? 15000 : maxAgeMs;
    if (Date.now() - (c.at || 0) > max) return null;
    return c;
  }

  function isSelToolbarVisible() {
    const bar = document.getElementById("sel-toolbar");
    return !!(bar && !bar.hidden);
  }

  /** True when preview still has a non-empty text selection. */
  function hasLivePreviewSelection() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
      const text = String(sel.toString() || "").trim();
      if (!text) return false;
      if (!el.preview) return false;
      return (
        el.preview.contains(sel.anchorNode) ||
        el.preview.contains(sel.focusNode) ||
        !!(sel.anchorNode && sel.anchorNode.parentElement && el.preview.contains(sel.anchorNode.parentElement))
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * True only for a short grace after a drag-select gesture ends.
   * NOT a blanket "any cached selection means never edit" — that over-suppressed
   * caret placement and re-enter after the P0 content-loss fix.
   * Window ≤ 300ms (S2.1): long enough to swallow the gesture's own click,
   * short enough that the next intentional click still edits.
   */
  function recentlyHadSelection(maxAgeMs) {
    const at = state._dragSelAt || 0;
    if (!at) return false;
    return Date.now() - at < (maxAgeMs == null ? 300 : maxAgeMs);
  }

  function markDragSelectGrace(maxAgeMs) {
    state._dragSelAt = Date.now();
    return maxAgeMs == null ? 300 : maxAgeMs;
  }

  /** Drop every enter-edit lock after commit/cancel so the next click can edit. */
  function clearEditEnterGates() {
    state._dragSelAt = 0;
    try {
      bindPreviewDelegates._suppressEditUntil = 0;
      clearTimeout(bindPreviewDelegates._clickTimer);
      bindPreviewDelegates._clickSeq = (bindPreviewDelegates._clickSeq || 0) + 1;
    } catch (_) {}
  }

  /**
   * Fully commit every in-flight block editor (never a half-edit visual exit).
   * Returns true when at least one editor was torn down — callers must re-hit-test
   * because commit can remount the whole preview.
   */
  function commitActiveEditingBlocks(exceptNode) {
    const eds = $$(".md-block.editing", el.preview);
    if (!eds.length) return false;
    let committed = false;
    eds.forEach((n) => {
      // Same surface as the enter target — leave it to the .editing guard.
      if (exceptNode && (n === exceptNode || n.contains(exceptNode))) return;
      if (typeof n._stuartCommit === "function") {
        try {
          n._stuartCommit();
          committed = true;
          return;
        } catch (_) {}
      }
      const ta = n.querySelector?.("textarea.md-block-source");
      if (ta && typeof ta._stuartCommit === "function") {
        try {
          ta._stuartCommit();
          committed = true;
          return;
        } catch (_) {}
      }
      exitBlockEditVisual(n);
      committed = true;
    });
    return committed;
  }

  function pointerNearSelToolbar(x, y, pad) {
    const bar = document.getElementById("sel-toolbar");
    if (!bar || bar.hidden) return false;
    const r = bar.getBoundingClientRect();
    const p = pad == null ? 28 : pad;
    return x >= r.left - p && x <= r.right + p && y >= r.top - p && y <= r.bottom + p;
  }

  function hideSelToolbar() {
    const bar = document.getElementById("sel-toolbar");
    if (bar) bar.hidden = true;
    hideSelDropdown();
  }

  function hideSelDropdown() {
    const dd = document.getElementById("sel-dropdown");
    if (dd) dd.hidden = true;
  }

  function selectionFormattingContext() {
    return { preview: el.preview, source: el.source, selection: window.getSelection(), activeElement: document.activeElement };
  }

  function isMermaidFormattingSelection() {
    return window.StuartCore.selectionFormatting.isRestricted(selectionFormattingContext());
  }

  function updateSelToolbarFormatting() {
    const bar = document.getElementById("sel-toolbar");
    if (bar && window.StuartCore.selectionFormatting.updateToolbar(bar, selectionFormattingContext())) hideSelDropdown();
  }

  function showSelToolbarNear(rect) {
    const bar = document.getElementById("sel-toolbar");
    if (!bar || !rect) return;
    hideBlockHandle();
    hideBlockMenu();
    captureSelectionCache();
    updateSelToolbarFormatting();
    bar.hidden = false;
    const w = bar.offsetWidth || 320;
    const h = bar.offsetHeight || 40;
    // Below the selection (Feishu-style); flip up if clipped
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, rect.top - h - 8);
    }
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, rect.left + rect.width / 2 - w / 2));
    bar.style.top = top + "px";
    bar.style.left = left + "px";
    hideSelDropdown();
  }

  function openSelDropdown(kind, anchorBtn) {
    if (isMermaidFormattingSelection()) { hideSelDropdown(); return; }
    const dd = document.getElementById("sel-dropdown");
    if (!dd) return;
    const items = [];
    if (kind === "style") {
      items.push(
        { label: "正文", action: "p", hint: "" },
        { label: "标题 1", action: "h1", hint: "" },
        { label: "标题 2", action: "h2", hint: "" },
        { label: "标题 3", action: "h3", hint: "" },
        { label: "无序列表", action: "ul", hint: "" },
        { label: "有序列表", action: "ol", hint: "" },
        { label: "任务列表", action: "task", hint: "" },
        { label: "引用", action: "quote", hint: "" }
      );
    } else if (kind === "align") {
      items.push(
        { label: "左对齐", action: "align-left" },
        { label: "居中", action: "align-center" },
        { label: "右对齐", action: "align-right" },
        { label: "增加缩进", action: "indent+" },
        { label: "减少缩进", action: "indent-" }
      );
    } else if (kind === "color") {
      const colors = [
        "#f5c542",
        "#f28b82",
        "#f6aea9",
        "#aecbfa",
        "#a8dab5",
        "#d7aefb",
        "#202124",
        "#5f6368",
        "#1a73e8",
        "#188038",
        "#c5221f",
        "#ea8600",
      ];
      dd.innerHTML = `<div class="swatches">${colors
        .map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`)
        .join("")}</div>`;
      positionDropdown(dd, anchorBtn);
      return;
    }
    dd.innerHTML = items
      .map((it) => `<button type="button" data-action="${it.action}">${it.label}</button>`)
      .join("");
    positionDropdown(dd, anchorBtn);
  }

  function positionDropdown(dd, anchorBtn) {
    dd.hidden = false;
    const r = anchorBtn.getBoundingClientRect();
    const w = dd.offsetWidth || 160;
    dd.style.top = r.bottom + 6 + "px";
    dd.style.left = Math.min(window.innerWidth - w - 12, Math.max(8, r.left)) + "px";
  }

  function wrapInlineMarkdown(pre, post, placeholder) {
    if (isMermaidFormattingSelection()) return;
    const text = placeholder || "文本";
    // Preview / contenteditable path
    if (state.mode !== "source") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString()) {
        const chosen = sel.toString();
        const block = sel.anchorNode?.parentElement?.closest?.(".md-block");
        if (block) {
          // Operate via source model for reliability
          const idx = Number(block.dataset.index || 0);
          const all = splitMarkdownBlocks(el.source.value || "");
          const src = all[idx] || "";
          // Simple first-occurrence wrap of selected plain text in this block
          if (src.includes(chosen)) {
            all[idx] = src.replace(chosen, pre + chosen + post);
          } else {
            all[idx] = src + pre + chosen + post;
          }
          setContent(joinBlocks(all), true);
          return;
        }
      }
      // fallback source caret
      el.source.focus();
      wrapSelection(pre, post);
      return;
    }
    wrapSelection(pre, post);
  }

  function applyBlockLineAction(action) {
    // Convert current line/block in source model
    const focusSource = () => {
      if (state.mode === "source") el.source.focus();
    };
    if (action === "p") {
      sourceLineTransform((block) =>
        block
          .split("\n")
          .map((line) =>
            line
              .replace(/^\s{0,3}#{1,6}\s+/, "")
              .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
              .replace(/^\s*>\s?/, "")
              .replace(/^\s*- \[[ xX]\]\s+/, "")
          )
          .join("\n")
      );
    } else if (action === "h1" || action === "h2" || action === "h3") {
      setLineHeading(Number(action[1]));
    } else if (action === "ul") {
      toggleLineList(false);
    } else if (action === "ol") {
      toggleLineList(true);
    } else if (action === "task") {
      sourceLineTransform((block) =>
        block
          .split("\n")
          .map((line) => {
            if (/^\s*- \[[ xX]\]\s+/.test(line)) {
              return line.replace(/^\s*- \[[ xX]\]\s+/, "");
            }
            const text = stripHeadingPrefix(line).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
            return "- [ ] " + text;
          })
          .join("\n")
      );
    } else if (action === "quote") {
      sourceLineTransform((block) =>
        block
          .split("\n")
          .map((line) => {
            if (/^\s*>\s?/.test(line)) return line.replace(/^\s*>\s?/, "");
            return "> " + line;
          })
          .join("\n")
      );
    } else if (action === "hr") {
      sourceLineTransform((block) => block + "\n\n---\n");
    } else if (action === "code") {
      sourceLineTransform((block) => {
        if (/^```/.test(block.trim())) return block.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
        return "```\n" + block + "\n```";
      });
    } else if (action === "divider") {
      sourceLineTransform((block) => block + "\n\n---\n");
    } else if (action === "align-left" || action === "align-center" || action === "align-right") {
      const align = action.split("-")[1];
      sourceLineTransform((block) => {
        const cleaned = block.replace(/\n?<div align="(left|center|right)">\n?/g, "\n").replace(/\n?<\/div>/g, "");
        if (align === "left") return cleaned.trim();
        return `<div align="${align}">\n\n${cleaned.trim()}\n\n</div>`;
      });
    } else if (action === "indent+" || action === "indent-") {
      sourceLineTransform((block) =>
        block
          .split("\n")
          .map((line) => {
            if (action === "indent+") return "  " + line;
            return line.replace(/^ {1,2}/, "");
          })
          .join("\n")
      );
    } else if (action === "copy-block" || action === "cut-block") {
      const idx = activeBlockIndex();
      const all = splitMarkdownBlocks(el.source.value || "");
      const text = all[idx] || "";
      try {
        navigator.clipboard?.writeText(text);
      } catch (_) {}
      if (action === "cut-block" || action === "delete-block") {
        all.splice(idx, 1);
        setContent(joinBlocks(all), true);
      }
    } else if (action === "delete-block") {
      const idx = activeBlockIndex();
      const all = splitMarkdownBlocks(el.source.value || "");
      all.splice(idx, 1);
      setContent(joinBlocks(all), true);
    } else if (action === "duplicate-block") {
      const idx = activeBlockIndex();
      const all = splitMarkdownBlocks(el.source.value || "");
      if (all[idx] != null) all.splice(idx + 1, 0, all[idx]);
      setContent(joinBlocks(all), true);
    }
    focusSource();
  }

  function activeBlockIndex() {
    if (typeof state._activeBlockIndex === "number") return state._activeBlockIndex;
    const sel = window.getSelection();
    const block = sel?.anchorNode?.parentElement?.closest?.(".md-block");
    if (block && block.dataset.index != null) return Number(block.dataset.index);
    return 0;
  }

  function applySelFormat(kind) {
    if (kind !== "ai-explain" && isMermaidFormattingSelection()) { hideSelDropdown(); return; }
    if (kind === "bold") wrapInlineMarkdown("**", "**");
    else if (kind === "italic") wrapInlineMarkdown("*", "*");
    else if (kind === "strike") wrapInlineMarkdown("~~", "~~");
    else if (kind === "underline") wrapInlineMarkdown("<u>", "</u>");
    else if (kind === "code") wrapInlineMarkdown("`", "`");
    else if (kind === "link") {
      const sel = window.getSelection();
      const text = sel?.toString()?.trim() || "链接文字";
      const url = prompt("链接地址", "https://");
      if (url) wrapInlineMarkdown("[", `](${url})`.replace(text, ""), text);
      // simpler: rebuild
      if (url) {
        const chosen = sel?.toString() || "链接文字";
        // redo cleanly
        const block = sel?.anchorNode?.parentElement?.closest?.(".md-block");
        if (block && state.mode !== "source") {
          const idx = Number(block.dataset.index || 0);
          const all = splitMarkdownBlocks(el.source.value || "");
          const src = all[idx] || "";
          const mdLink = `[${chosen}](${url})`;
          all[idx] = src.includes(chosen) ? src.replace(chosen, mdLink) : src + mdLink;
          setContent(joinBlocks(all), true);
        }
      }
    } else if (kind === "h1" || kind === "h2" || kind === "h3" || kind === "p" || kind === "ul" || kind === "ol" || kind === "task" || kind === "quote") {
      applyBlockLineAction(kind);
    } else if (kind.startsWith("align-") || kind === "indent+" || kind === "indent-") {
      applyBlockLineAction(kind);
    } else if (kind.startsWith("color:")) {
      const c = kind.slice(6);
      wrapInlineMarkdown(`<span style="color:${c}">`, "</span>");
    } else if (kind.startsWith("bg:")) {
      const c = kind.slice(3);
      wrapInlineMarkdown(`<mark style="background:${c}">`, "</mark>");
    } else if (kind === "ai-explain") {
      try {
        if (window.StuartAIUI && typeof window.StuartAIUI.triggerExplain === "function") {
          window.StuartAIUI.triggerExplain();
        } else {
          toast("AI 模块未加载，请重启应用");
          console.error("StuartAIUI.triggerExplain missing");
        }
      } catch (err) {
        console.error(err);
        toast("问答启动失败：" + (err && err.message ? err.message : err));
      }
    }
  }

  function bindSelToolbar() {
    const bar = document.getElementById("sel-toolbar");
    const dd = document.getElementById("sel-dropdown");
    if (!bar || bar.dataset.bound === "1") return;
    bar.dataset.bound = "1";
    bar.addEventListener("mousedown", (e) => e.preventDefault());
    bar.addEventListener("click", (e) => {
      const menuBtn = e.target.closest("[data-sel-menu]");
      if (menuBtn) {
        e.stopPropagation();
        openSelDropdown(menuBtn.dataset.selMenu, menuBtn);
        return;
      }
      const btn = e.target.closest("[data-sel]");
      if (!btn) return;
      applySelFormat(btn.dataset.sel);
      hideSelDropdown();
    });
    if (dd) {
      dd.addEventListener("mousedown", (e) => e.preventDefault());
      dd.addEventListener("click", (e) => {
        const sw = e.target.closest("[data-color]");
        if (sw) {
          const c = sw.dataset.color;
          // Feishu-like: first row is text color, hold alt for highlight — use as text color by default
          applySelFormat("color:" + c);
          hideSelDropdown();
          return;
        }
        const act = e.target.closest("[data-action]");
        if (act) {
          applySelFormat(act.dataset.action);
          hideSelDropdown();
        }
      });
    }
    document.addEventListener("mouseup", (e) => {
      if (e.target.closest("#sel-toolbar") || e.target.closest("#sel-dropdown") || e.target.closest("#ai-panel")) {
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        // Keep toolbar + cache if user only drifted; hide bar when truly collapsed
        if (!getSelectionCache(8000)) hideSelToolbar();
        else if (!isSelToolbarVisible()) {
          // leave hidden; cache still usable for AI
        } else {
          hideSelToolbar();
        }
        return;
      }
      const inPreview = el.preview.contains(e.target) || el.preview.contains(sel.anchorNode) || el.preview.contains(sel.focusNode);
      const inSource = el.source === document.activeElement;
      if (!inPreview && !inSource) {
        captureSelectionCache();
        // Do not clear cache; only hide chrome if far outside editor
        hideSelToolbar();
        return;
      }
      showSelToolbarNear(sel.getRangeAt(0).getBoundingClientRect());
    });
    document.addEventListener("mousedown", (e) => {
      const inChrome =
        e.target.closest("#sel-toolbar") ||
        e.target.closest("#sel-dropdown") ||
        e.target.closest("#ai-panel") ||
        e.target.closest("#ai-model-menu") ||
        e.target.closest("#settings-modal") ||
        e.target.closest("#stuart-confirm") ||
        e.target.closest("#block-handle") ||
        e.target.closest("#block-menu");
      if (inChrome) {
        // keep selection + toolbar
      } else {
        const sel = window.getSelection();
        const hasLiveSel = !!(sel && !sel.isCollapsed && String(sel.toString() || "").trim());
        // Accidental click near the toolbar: keep selection instead of killing it.
        // Never preventDefault globally — that blocks focus/caret in source editors.
        if (pointerNearSelToolbar(e.clientX, e.clientY, 36) && (hasLiveSel || getSelectionCache(15000))) {
          e.preventDefault();
        } else if (!e.target.closest("#sel-toolbar") && !e.target.closest("#sel-dropdown")) {
          hideSelToolbar();
        }
      }
      if (!e.target.closest("#block-handle") && !e.target.closest("#block-menu")) {
        hideBlockMenu();
      }
    });
    // Keep cache fresh while user is selecting in the editor
    document.addEventListener("selectionchange", () => {
      try {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && String(sel.toString() || "").trim()) {
          const inEd =
            (el.preview && (el.preview.contains(sel.anchorNode) || el.preview.contains(sel.focusNode))) ||
            (el.source && (el.source === document.activeElement || el.source.contains(sel.anchorNode)));
          if (inEd) {
            captureSelectionCache();
            if (isSelToolbarVisible()) updateSelToolbarFormatting();
          }
        }
      } catch (_) {}
    });
  }

  function hideBlockMenu() {
    const m = document.getElementById("block-menu");
    if (m) m.hidden = true;
    const h = document.getElementById("block-handle");
    if (!h || h.hidden || h.dataset.hover !== "1") clearHandleSelectedBlock();
  }

  /** 16px thin-stroke block-menu icons — faces stay Latin/symbol/SVG; Chinese lives in title. */
  const bmIco = (inner) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">${inner}</svg>`;
  const bmS = 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  const bmIcon = {
    quote: bmIco(
      `<path d="M5.9 4.4C4.4 5.1 3.4 6.4 3.4 8.4V12h3.5V8.3H5.2c0-1.2.3-2 1.3-2.6zM12.4 4.4c-1.5.7-2.5 2-2.5 4V12h3.5V8.3h-1.7c0-1.2.3-2 1.3-2.6z" ${bmS}/>`
    ),
    copy: bmIco(
      `<rect x="5.5" y="5.5" width="8" height="8" rx="1.3" ${bmS}/><path d="M3 10.3V3.8c0-.7.6-1.3 1.3-1.3h6.5" ${bmS}/>`
    ),
    duplicate: bmIco(
      `<rect x="5.5" y="5.5" width="8" height="8" rx="1.3" ${bmS}/><path d="M3 10.3V3.8c0-.7.6-1.3 1.3-1.3h6.5" ${bmS}/><path d="M9.5 8.2v4M7.5 10.2h4" ${bmS}/>`
    ),
    cut: bmIco(
      `<circle cx="3.8" cy="4" r="1.6" ${bmS}/><circle cx="3.8" cy="12" r="1.6" ${bmS}/><path d="M5.1 5.1 13 12.8M5.1 10.9 13 3.2" ${bmS}/>`
    ),
    trash: bmIco(
      `<path d="M2.8 4.5h10.4M6.2 4.5V3.3c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.2M4.3 4.5l.55 8.1c.05.7.6 1.2 1.3 1.2h3.9c.7 0 1.25-.5 1.3-1.2L11.7 4.5" ${bmS}/>`
    ),
    indentIn: bmIco(`<path d="M2 3.5h12M7.5 7h6.5M7.5 10h6.5M2 13.5h12" ${bmS}/>`),
    indentOut: bmIco(`<path d="M2 3.5h12M2 7h6.5M2 10h6.5M2 13.5h12" ${bmS}/>`),
    alignLeft: bmIco(`<path d="M2 3.5h12M2 7h8M2 10h12M2 13.5h8" ${bmS}/>`),
    alignCenter: bmIco(`<path d="M2 3.5h12M4 7h8M2 10h12M4 13.5h8" ${bmS}/>`),
    alignRight: bmIco(`<path d="M2 3.5h12M6 7h8M2 10h12M6 13.5h8" ${bmS}/>`),
    indentAlign: bmIco(`<path d="M2 3.5h12M6 7h8M6 10h8M2 13.5h12" ${bmS}/>`),
    task: bmIco(
      `<rect x="2.5" y="2.5" width="11" height="11" rx="2.2" ${bmS}/><path d="M5.2 8.1 7.2 10.2l3.8-4" ${bmS}/>`
    ),
  };

  function showBlockMenuAt(x, y, blockIndex, anchorRect) {
    state._activeBlockIndex = blockIndex;
    const menu = document.getElementById("block-menu");
    if (!menu) return;
    const selBlock =
      el.preview?.querySelector(`.md-block[data-index="${blockIndex}"]`) || state._handleBlock || null;
    if (selBlock) setHandleSelectedBlock(selBlock);
    // Compact 4-col / 3-row icon grid — narrower panel, less occlusion
    menu.innerHTML = `
      <div class="menu-grid" title="块类型">
        <button type="button" data-bm="p" title="正文">T</button>
        <button type="button" data-bm="h1" title="标题 1">H1</button>
        <button type="button" data-bm="h2" title="标题 2">H2</button>
        <button type="button" data-bm="h3" title="标题 3">H3</button>
        <button type="button" data-bm="ol" title="有序列表">1.</button>
        <button type="button" data-bm="ul" title="无序列表">•</button>
        <button type="button" data-bm="task" title="任务列表">${bmIcon.task}</button>
        <button type="button" data-bm="code" title="代码块">{ }</button>
        <button type="button" data-bm="quote" title="引用">${bmIcon.quote}</button>
        <button type="button" data-bm="indent-" title="减少缩进">${bmIcon.indentOut}</button>
        <button type="button" data-bm="indent+" title="增加缩进">${bmIcon.indentIn}</button>
        <button type="button" data-bm="copy-block" title="复制">${bmIcon.copy}</button>
      </div>
      <div class="menu-sep"></div>
      <button type="button" class="menu-row" data-bm-sub="indent" title="缩进和对齐">
        <span class="mr-ico">${bmIcon.indentAlign}</span><span class="mr-label"></span><span class="mr-caret">›</span>
      </button>
      <div class="menu-sub" data-sub="indent" hidden>
        <button type="button" data-bm="indent+" title="增加缩进">${bmIcon.indentIn}</button>
        <button type="button" data-bm="indent-" title="减少缩进">${bmIcon.indentOut}</button>
        <button type="button" data-bm="align-left" title="左对齐">${bmIcon.alignLeft}</button>
        <button type="button" data-bm="align-center" title="居中">${bmIcon.alignCenter}</button>
        <button type="button" data-bm="align-right" title="右对齐">${bmIcon.alignRight}</button>
      </div>
      <div class="menu-sep"></div>
      <div class="menu-grid">
        <button type="button" data-bm="cut-block" title="剪切">${bmIcon.cut}</button>
        <button type="button" data-bm="copy-block" title="复制">${bmIcon.copy}</button>
        <button type="button" data-bm="duplicate-block" title="创建副本">${bmIcon.duplicate}</button>
        <button type="button" class="danger" data-bm="delete-block" title="删除">${bmIcon.trash}</button>
      </div>
    `;
    menu.hidden = false;
    const w = menu.offsetWidth || 168;
    const h = menu.offsetHeight || 360;
    const sidebar = document.getElementById("sidebar");
    const sidebarRight =
      sidebar && sidebar.classList.contains("open") ? sidebar.getBoundingClientRect().right : 0;
    const widthMode = document.body.dataset.width || "default";
    const handle = document.getElementById("block-handle");
    const hr = handle && !handle.hidden ? handle.getBoundingClientRect() : null;

    // Anchor = selected content (line / paragraph / live selection), not the handle chrome
    let anchor = anchorRect;
    if (!anchor) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) anchor = r;
      }
    }
    if (!anchor && state._handleAnchor && document.contains(state._handleAnchor)) {
      anchor = state._handleAnchor.getBoundingClientRect();
    }

    let left;
    let top;
    // Wide / full: Feishu — always drop the menu under the selected content.
    // Default: try left of handle when the gutter is wide enough; otherwise below.
    const preferBelow = widthMode !== "default" || !hr;
    if (preferBelow && anchor) {
      left = hr ? hr.left : anchor.left;
      top = anchor.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6);
    } else if (hr) {
      left = hr.right - w - 8;
      top = hr.top;
      if (left < sidebarRight + 12) {
        left = hr.left;
        top = (anchor ? anchor.bottom : hr.bottom) + 6;
        if (top + h > window.innerHeight - 8) {
          top = Math.max(8, (anchor ? anchor.top : hr.top) - h - 6);
        }
      }
    } else {
      left = x;
      top = y;
    }

    left = Math.min(window.innerWidth - w - 8, Math.max(sidebarRight + 8, left));
    top = Math.min(window.innerHeight - h - 8, Math.max(8, top));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.onclick = (e) => {
      const sub = e.target.closest("[data-bm-sub]");
      if (sub) {
        const name = sub.dataset.bmSub;
        const panel = menu.querySelector(`[data-sub="${name}"]`);
        if (panel) panel.hidden = !panel.hidden;
        return;
      }
      const btn = e.target.closest("[data-bm]");
      if (!btn) return;
      applyBlockLineAction(btn.dataset.bm);
      hideBlockMenu();
      hideBlockHandle();
    };
  }

  /** Highlight the .md-block the handle/menu is acting on (class toggle only). */
  function setHandleSelectedBlock(block) {
    if (!el.preview) return;
    el.preview.querySelectorAll(".md-block.is-selected").forEach((n) => {
      if (n !== block) n.classList.remove("is-selected");
    });
    if (block) block.classList.add("is-selected");
  }
  function clearHandleSelectedBlock() {
    if (!el.preview) return;
    el.preview.querySelectorAll(".md-block.is-selected").forEach((n) => {
      n.classList.remove("is-selected");
    });
  }

  function hideBlockHandle() {
    const h = document.getElementById("block-handle");
    if (h) {
      h.hidden = true;
      h.classList.remove("visible");
      h.dataset.hover = "";
    }
    const menu = document.getElementById("block-menu");
    if (!menu || menu.hidden) clearHandleSelectedBlock();
  }

  let _handleHideTimer = 0;
  function keepBlockHandle() {
    clearTimeout(_handleHideTimer);
  }
  function scheduleHideBlockHandle(ms) {
    clearTimeout(_handleHideTimer);
    _handleHideTimer = setTimeout(() => {
      const handle = document.getElementById("block-handle");
      if (!handle || handle.hidden) return;
      if (handle.dataset.hover === "1") return;
      const menu = document.getElementById("block-menu");
      if (menu && !menu.hidden) return;
      if (isSelToolbarVisible()) return;
      hideBlockHandle();
    }, ms == null ? 220 : ms);
  }

  function pointerNearHandle(x, y) {
    const handle = document.getElementById("block-handle");
    if (!handle || handle.hidden) return false;
    const r = handle.getBoundingClientRect();
    const pad = 36;
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  /** Resolve the .md-block under (or nearest to) the pointer — high hit rate. */
  function closestMdBlock(node) {
    let n = node;
    while (n && n !== document.body) {
      if (n.classList?.contains("md-block")) return n;
      n = n.parentElement || n.parentNode;
      if (n && n.nodeType !== 1) n = n.parentElement;
    }
    return null;
  }

  // 手柄只使用所在内容块或块级元素作为定位对象。
  function lineUnitFromNode(node) {
    if (!node) return null;
    const block = closestMdBlock(node);
    if (!block) return null;
    const line = node.closest?.(
      "li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, p, .mermaid-diagram, .katex-display"
    );
    return line && block.contains(line) ? line : block;
  }

  function blockFromPoint(x, y) {
    const pane = $("#preview-pane");
    if (!pane || !el.preview) return null;
    const pr = pane.getBoundingClientRect();
    if (x < pr.left - 8 || x > pr.right + 8 || y < pr.top - 4 || y > pr.bottom + 4) return null;

    const hit = document.elementFromPoint(x, y);
    if (hit) {
      if (hit.closest?.("#block-handle") || hit.closest?.("#block-menu") || hit.closest?.("#sel-toolbar")) {
        const kind = hit.closest("#block-handle")
          ? "handle"
          : hit.closest("#block-menu")
            ? "menu"
            : "toolbar";
        return { special: kind };
      }
      const b = closestMdBlock(hit);
      if (b && el.preview.contains(b)) {
        return { block: b, line: lineUnitFromNode(hit) || b };
      }
    }

    // Band fallback — only when elementFromPoint missed; cap scan cost
    const children = el.preview.children;
    let best = null;
    let bestDist = Infinity;
    const maxScan = Math.min(children.length, 400);
    for (let i = 0; i < maxScan; i++) {
      const b = children[i];
      if (!b || !b.classList || !b.classList.contains("md-block")) continue;
      const r = b.getBoundingClientRect();
      if (r.height < 2 || r.width < 2) continue;
      const inY = y >= r.top - 1 && y <= r.bottom + 1;
      const nearX = x >= r.left - 160 && x <= r.right + 48;
      if (inY && nearX) {
        const dist = Math.abs(y - (r.top + r.bottom) / 2);
        if (dist < bestDist) {
          bestDist = dist;
          best = b;
        }
      }
    }
    if (!best) return null;
    // Refine to li/tr row under Y
    let line = best;
    const rows = $$("li, tr", best);
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (y >= r.top - 1 && y <= r.bottom + 1) {
        line = row;
        break;
      }
    }
    return { block: best, line };
  }

  /** Mermaid / display math — no block handle (Feishu-like). */
  function suppressHandleFor(node) {
    if (!node) return false;
    if (node.closest?.(".mermaid-diagram")) return true;
    if (node.closest?.(".katex-display")) return true;
    return false;
  }

  function positionBlockHandle(block, lineEl) {
    const handle = document.getElementById("block-handle");
    if (!handle || !block || !block.isConnected) return;
    if (isSelToolbarVisible()) {
      hideBlockHandle();
      return;
    }
    // No handle on charts / display LaTeX
    if (suppressHandleFor(lineEl)) {
      hideBlockHandle();
      return;
    }
    const media = block.querySelector(".mermaid-diagram, .katex-display");
    if (media && !block.querySelector("p, li, h1, h2, h3, h4, h5, h6, td, th")) {
      hideBlockHandle();
      return;
    }
    keepBlockHandle();
    const target = lineEl && lineEl.isConnected && block.contains(lineEl) ? lineEl : block;
    const br = target.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const paneRect = el.previewPane.getBoundingClientRect();
    handle.hidden = false;
    handle.classList.add("visible");
    const hw = handle.offsetWidth || 52;
    const hh = handle.offsetHeight;
    const left = blockRect.left - hw - 8;
    if (left < paneRect.left + 4 || br.bottom <= paneRect.top || br.top >= paneRect.bottom) {
      hideBlockHandle();
      return;
    }
    const top = Math.max(paneRect.top + 4, Math.min(br.top, paneRect.bottom - hh - 4));
    handle.style.position = "fixed";
    handle.style.top = top + "px";
    handle.style.left = left + "px";
    state._activeBlockIndex = Number(block.dataset.index || 0);
    state._handleAnchor = target;
    state._handleBlock = block;
  }

  function bindBlockHandle() {
    const handle = document.getElementById("block-handle");
    const menu = document.getElementById("block-menu");
    if (!handle || handle.dataset.bound === "1") return;
    handle.dataset.bound = "1";
    handle.addEventListener("mousedown", (e) => e.preventDefault());
    handle.addEventListener("mouseenter", () => {
      handle.dataset.hover = "1";
      keepBlockHandle();
      clearTimeout(bindBlockHandle._menuLeave);
      const b =
        state._handleBlock && document.contains(state._handleBlock)
          ? state._handleBlock
          : el.preview?.querySelector(`.md-block[data-index="${activeBlockIndex()}"]`);
      if (b) setHandleSelectedBlock(b);
    });
    handle.addEventListener("mouseleave", () => {
      handle.dataset.hover = "";
      if (menu && !menu.hidden) scheduleHideBlockMenu();
      else {
        scheduleHideBlockHandle(240);
        clearHandleSelectedBlock();
      }
    });
    $("#bh-type")?.addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const idx = activeBlockIndex();
      let anchorEl = state._handleAnchor;
      if (!anchorEl || !document.contains(anchorEl) || (el.preview && !el.preview.contains(anchorEl))) {
        anchorEl = el.preview?.querySelector(`.md-block[data-index="${idx}"]`) || null;
      }
      let anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount && el.preview?.contains(sel.anchorNode)) {
        const sr = sel.getRangeAt(0).getBoundingClientRect();
        if (sr && (sr.width || sr.height)) anchorRect = sr;
      }
      showBlockMenuAt(r.right + 4, r.top, idx, anchorRect);
    });

    if (menu && menu.dataset.bound !== "1") {
      menu.dataset.bound = "1";
      menu.addEventListener("mouseenter", () => {
        menu.dataset.hover = "1";
        clearTimeout(bindBlockHandle._menuLeave);
        keepBlockHandle();
      });
      menu.addEventListener("mouseleave", () => {
        menu.dataset.hover = "";
        scheduleHideBlockMenu();
      });
    }

    // One document-level tracker — skip while user is selecting (perf)
    let rafId = 0;
    let px = 0;
    let py = 0;
    let pointerButtons = 0;
    const tick = () => {
      rafId = 0;
      // Cap hover hit-test frequency (~30fps) — selection path already exits earlier
      const t = nowMs();
      if (t - (tick._last || 0) < 32) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      tick._last = t;
      if (state.mode === "source") {
        hideBlockHandle();
        return;
      }
      if (isSelToolbarVisible()) {
        hideBlockHandle();
        return;
      }
      // Drag-select / non-collapsed selection: never hit-test blocks (was O(n) per frame)
      if (pointerButtons & 1) {
        hideBlockHandle();
        return;
      }
      try {
        const selNow = window.getSelection();
        if (selNow && !selNow.isCollapsed) {
          hideBlockHandle();
          return;
        }
      } catch (_) {}
      const hasEditing = el.preview && el.preview.querySelector(".md-block.editing");
      const editingEl = hasEditing ? getActiveEditingBlock() : null;
      const found = blockFromPoint(px, py);
      if (found && found.special) {
        keepBlockHandle();
        return;
      }
      if (found && found.block) {
        // Keep handle while editing — only skip mermaid / display math
        if (suppressHandleFor(found.line)) {
          hideBlockHandle();
          return;
        }
        positionBlockHandle(found.block, found.line);
        return;
      }
      if (handle.dataset.hover === "1" || pointerNearHandle(px, py)) {
        keepBlockHandle();
        return;
      }
      if (menu && !menu.hidden) {
        keepBlockHandle();
        return;
      }
      if (!handle.hidden) scheduleHideBlockHandle(180);
    };
    document.addEventListener(
      "mousemove",
      (e) => {
        px = e.clientX;
        py = e.clientY;
        pointerButtons = e.buttons || 0;
        // Primary button down (text drag-select): skip expensive hit-testing entirely
        if (pointerButtons & 1) {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
          hideBlockHandle();
          return;
        }
        if (rafId) return;
        rafId = requestAnimationFrame(tick);
      },
      { passive: true }
    );
    $("#preview-pane")?.addEventListener(
      "mouseleave",
      () => {
        if (handle.dataset.hover === "1") return;
        if (menu && !menu.hidden && menu.dataset.hover === "1") return;
        scheduleHideBlockHandle(100);
      },
      { passive: true }
    );
  }

  /** Close block menu only after pointer leaves BOTH handle and menu. */
  function scheduleHideBlockMenu() {
    clearTimeout(bindBlockHandle._menuLeave);
    bindBlockHandle._menuLeave = setTimeout(() => {
      const handle = document.getElementById("block-handle");
      const menu = document.getElementById("block-menu");
      if (!menu || menu.hidden) return;
      if (handle?.dataset.hover === "1") return;
      if (menu.dataset.hover === "1") return;
      hideBlockMenu();
      scheduleHideBlockHandle(160);
    }, 220);
  }

  function bindPreviewDelegates() {
    if (el.preview.dataset.delegated === "1") return;
    el.preview.dataset.delegated = "1";

    // Paste must never inject raw HTML (XSS via contenteditable)
    el.preview.addEventListener(
      "paste",
      (e) => {
        const target = e.target;
        if (!target || !(target.isContentEditable || target.closest?.(".md-block.editing"))) return;
        e.preventDefault();
        e.stopPropagation();
        const cd = e.clipboardData;
        const html = cd ? cd.getData("text/html") : "";
        const text = cd ? cd.getData("text/plain") : "";
        const sanitize = globalThis.StuartCore?.htmlSanitize?.sanitizeHtml;
        if (html && typeof sanitize === "function") {
          try {
            document.execCommand("insertHTML", false, sanitize(html));
            return;
          } catch (_) {}
        }
        // Safe fallback: plain text only
        try {
          document.execCommand("insertText", false, text || html.replace(/<[^>]+>/g, ""));
        } catch (_) {
          if (text) document.execCommand("insertText", false, text);
        }
      },
      true
    );

    // Outline: one delegated listener (avoids per-heading closures on every rebuild)
    if (el.outlineList && el.outlineList.dataset.delegated !== "1") {
      el.outlineList.dataset.delegated = "1";
      el.outlineList.addEventListener("click", (e) => {
        const btn = e.target.closest(".outline-item");
        if (!btn || !el.outlineList.contains(btn)) return;
        const idx = Number(btn.dataset.hindex);
        if (Number.isFinite(idx)) jumpToHeadingIndex(idx);
      });
    }

    el.preview.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (a && el.preview.contains(a)) {
        e.preventDefault();
        e.stopPropagation();
        const href = (a.getAttribute("href") || "").trim();
        if (!href) return;
        if (href.startsWith("#")) {
          const id = decodeURIComponent(href.slice(1));
          const target =
            el.preview.querySelector(`[id="${CSS.escape(id)}"]`) ||
            findHeadingByText(id);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
          if (state.apiReady && window.pywebview?.api?.open_url) {
            window.pywebview.api.open_url(href);
          }
        } else {
          console.warn("[Security] Blocked untrusted external link navigation:", href);
          toast("已拦截不安全的链接跳转");
        }
        return;
      }

      if (e.target.closest("button, input, textarea, .md-block-source")) {
        return;
      }
      if (state.mode === "source") return;

      // Commit-on-mousedown rebuilds the preview DOM; e.target may already be
      // detached or stale. After a same-gesture switch (A editing → click B)
      // ALWAYS re-hit-test — not only when the captured node is detached.
      let clickTarget = e.target;
      if (bindPreviewDelegates._gestureForcePoint || !el.preview.contains(clickTarget)) {
        try {
          clickTarget = document.elementFromPoint(e.clientX, e.clientY) || clickTarget;
        } catch (_) {}
      }
      const node = (clickTarget && clickTarget.closest && clickTarget.closest(".md-block")) || e.target.closest(".md-block");
      if (!node || node.classList.contains("editing")) return;
      if (!el.preview.contains(node)) return;

      // Multi-click (double/triple) never schedules delayed enter-edit —
      // dblclick owns that gesture (word-select or structured edit).
      clearTimeout(bindPreviewDelegates._clickTimer);
      bindPreviewDelegates._clickSeq = (bindPreviewDelegates._clickSeq || 0) + 1;
      if (e.detail > 1) return;

      const clickX = e.clientX;
      const clickY = e.clientY;
      const hadLiveSel = hasLivePreviewSelection();
      const hadSelAtDown = !!bindPreviewDelegates._gestureSelAtStart;
      const selBar = isSelToolbarVisible();

      // Keep the AI selection bar when the click is on/near it (same policy as mousedown).
      if (selBar && pointerNearSelToolbar(clickX, clickY, 36) && (hadLiveSel || getSelectionCache(15000))) {
        return;
      }

      // Drag-select / selection-adjust gestures must NOT be converted into edit.
      // Selection created during this gesture (drag end) or a move-gesture on an
      // existing selection → leave the selection alone.
      if (hadLiveSel || hadSelAtDown) {
        const createdDuringGesture = hadLiveSel && !hadSelAtDown;
        const moved = !!bindPreviewDelegates._gestureMoved;
        if (createdDuringGesture || moved) {
          markDragSelectGrace();
          return;
        }
      }
      // Same-gesture switch + drag (>4px): mouseup already consumed the gesture —
      // never convert that drag into enter-edit on the trailing click.
      if (bindPreviewDelegates._gestureSwitchHandled && bindPreviewDelegates._gestureMoved) {
        markDragSelectGrace();
        return;
      }
      // Same-gesture switch already entered B on mouseup — the trailing click
      // (possibly retargeted after remount) must not steal focus to another block.
      if (bindPreviewDelegates._gestureSwitchHandled && !bindPreviewDelegates._gestureMoved) {
        return;
      }

      // Intentional click on text (optionally into an existing selection):
      // never a dead click — clear the selection, place the caret, enter edit.
      if (hadLiveSel || selBar || hadSelAtDown) {
        hideSelToolbar();
        try {
          window.getSelection()?.removeAllRanges();
        } catch (_) {}
        // Immediate caret + light edit so heading clicks never feel dead.
        bindPreviewDelegates._suppressEditUntil = 0;
        enterEditSurfaceFor(node, clickX, clickY);
        return;
      }

      // No live selection: enter edit IMMEDIATELY (S2.1 Typora feel).
      // No 320–460ms timer as the primary path — caret must appear within 1 frame.
      // Drag-select is already filtered above (moved > 4px OR selection created
      // during this gesture). Residual grace only blocks a follow-up click while
      // a fresh drag-select selection is still live.
      if (hasLivePreviewSelection() && recentlyHadSelection(300)) return;
      bindPreviewDelegates._suppressEditUntil = 0;
      enterEditSurfaceFor(node, clickX, clickY);
    });

    /**
     * Enter the right edit surface for a block. Shared by immediate single-click,
     * selection-click caret placement, dblclick on structured blocks, and the
     * same-gesture switch path (mouseup after commit of a different block).
     * Always re-resolves via elementFromPoint after a switch/commit remount.
     */
    function enterEditSurfaceFor(node, clickX, clickY) {
      const switching =
        !!bindPreviewDelegates._gestureSwitchPending || !!bindPreviewDelegates._gestureForcePoint;
      // Commit any other in-flight editor FIRST (never leave A half-edit).
      // Commit may remount the preview, so the captured node must be dropped.
      if (commitActiveEditingBlocks(node)) {
        node = null;
        clearEditEnterGates();
      }
      // After commit-on-mousedown / leftover commit, prefer the live node under
      // the pointer — not a captured (possibly detached or stale) reference.
      if ((switching || !node || !document.contains(node)) && clickX != null && clickY != null) {
        try {
          const hit = document.elementFromPoint(clickX, clickY);
          node = (hit && hit.closest && hit.closest(".md-block")) || null;
        } catch (_) {
          node = null;
        }
      }
      if (!node || !el.preview.contains(node)) return false;
      if (node.classList.contains("editing")) return false;
      hideSelToolbar();
      try {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
      } catch (_) {}
      bindPreviewDelegates._suppressEditUntil = 0;
      if (switching) clearEditEnterGates();
      // Typora-like: pick the right in-place editor for the block kind
      if (node.querySelector(".mermaid-diagram") || /```\s*mermaid/i.test(node._stuartSrc || "")) {
        enterBlockSourceEdit(node, clickX, clickY);
        return true;
      }
      if (node.querySelector(".katex, .katex-display")) {
        enterBlockSourceEdit(node, clickX, clickY);
        return true;
      }
      if (node.querySelector("table")) {
        enterTableEdit(node, clickX, clickY);
        return true;
      }
      if (node.querySelector("pre")) {
        enterCodeEdit(node);
        return true;
      }
      enterBlockEdit(node, clickX, clickY);
      return true;
    }

    // Any new pointer gesture cancels pending delayed enter-edit AND records
    // whether this gesture started with a selection / moved (drag vs click).
    const onPreviewPointerDown = (e) => {
      clearTimeout(bindPreviewDelegates._clickTimer);
      bindPreviewDelegates._clickSeq = (bindPreviewDelegates._clickSeq || 0) + 1;
      bindPreviewDelegates._suppressEditUntil = 0;
      bindPreviewDelegates._downX = e.clientX;
      bindPreviewDelegates._downY = e.clientY;
      bindPreviewDelegates._gestureMoved = false;
      bindPreviewDelegates._gestureKnown = true;
      bindPreviewDelegates._gestureSelAtStart = hasLivePreviewSelection();
    };
    el.preview.addEventListener("mousedown", onPreviewPointerDown, true);
    el.preview.addEventListener("pointerdown", onPreviewPointerDown, true);

    // Same-gesture switch detector. MUST be document-capture and registered at
    // bind time so it runs BEFORE editor commit-on-mousedown (those register
    // later at enter-edit). Records "A editing, pointerdown on B" so mouseup
    // can enter B even after commit remounts and kills the click event.
    const onDocDownSwitch = (e) => {
      bindPreviewDelegates._gestureSwitchPending = false;
      bindPreviewDelegates._gestureSwitchHandled = false;
      bindPreviewDelegates._gestureForcePoint = false;
      if (state.mode === "source") return;
      if (!e.target || !e.target.closest) return;
      const eds = $$(".md-block.editing", el.preview);
      if (!eds.length) return;
      // Chrome / handle / toolbar clicks are not content switches.
      if (
        e.target.closest(
          "button, input, textarea, a, .md-block-source, #sel-toolbar, #sel-dropdown, #block-handle, #block-menu, #ai-panel"
        )
      ) {
        return;
      }
      const downBlock = e.target.closest(".md-block");
      if (!downBlock || !el.preview.contains(downBlock)) return;
      // Pointerdown inside the currently editing surface is not a switch.
      for (const ed of eds) {
        if (ed === downBlock || ed.contains(downBlock) || ed.contains(e.target)) return;
      }
      bindPreviewDelegates._gestureSwitchPending = true;
      bindPreviewDelegates._gestureForcePoint = true;
      bindPreviewDelegates._gestureSwitchX = e.clientX;
      bindPreviewDelegates._gestureSwitchY = e.clientY;
    };
    document.addEventListener("mousedown", onDocDownSwitch, true);

    // Enter B on the SAME gesture (mouseup), because commit-on-mousedown may
    // remount the preview and the subsequent click never reaches the preview
    // delegate (mousedown target was detached → no common ancestor click).
    const onDocUpSwitch = (e) => {
      if (!bindPreviewDelegates._gestureSwitchPending) return;
      if (bindPreviewDelegates._gestureSwitchHandled) return;
      if (e.button != null && e.button !== 0) return;
      const consume = () => {
        bindPreviewDelegates._gestureSwitchPending = false;
        bindPreviewDelegates._gestureForcePoint = false;
        bindPreviewDelegates._gestureSwitchHandled = true;
      };
      if (state.mode === "source") {
        consume();
        return;
      }
      // Drag-select protection (delta > 4px) — never convert a drag into edit.
      const swX = bindPreviewDelegates._gestureSwitchX;
      const swY = bindPreviewDelegates._gestureSwitchY;
      const dx = e.clientX - (swX != null ? swX : e.clientX);
      const dy = e.clientY - (swY != null ? swY : e.clientY);
      if (bindPreviewDelegates._gestureMoved || dx * dx + dy * dy > 16) {
        markDragSelectGrace();
        consume();
        return;
      }
      // Never steal a click that landed on chrome.
      if (
        e.target &&
        e.target.closest &&
        e.target.closest(
          "button, input, textarea, a, .md-block-source, #sel-toolbar, #sel-dropdown, #block-handle, #block-menu, #ai-panel"
        )
      ) {
        consume();
        return;
      }
      clearEditEnterGates();
      bindPreviewDelegates._suppressEditUntil = 0;
      // Always elementFromPoint — commit may have replaced every block node.
      const ok = enterEditSurfaceFor(null, e.clientX, e.clientY);
      if (ok) {
        consume();
        return ok;
      }
      // Leave pending/force-point so the trailing click can retry.
      return false;
    };
    // mouseup only (not pointerup): enter AFTER the browser finishes its own
    // mouseup caret/selection handling so our placed caret is not overwritten.
    document.addEventListener("mouseup", onDocUpSwitch, true);

    // Track drag distance so a selection gesture never becomes enter-edit.
    el.preview.addEventListener(
      "mousemove",
      (e) => {
        if (!e.buttons) return;
        const dx = e.clientX - (bindPreviewDelegates._downX || e.clientX);
        const dy = e.clientY - (bindPreviewDelegates._downY || e.clientY);
        if (dx * dx + dy * dy > 16) bindPreviewDelegates._gestureMoved = true;
      },
      true
    );

    el.preview.addEventListener("dblclick", (e) => {
      // dblclick is a VALID way to start table/code/math/mermaid edit — not a
      // suppress signal. Plain text keeps native word-selection.
      clearTimeout(bindPreviewDelegates._clickTimer);
      bindPreviewDelegates._clickSeq = (bindPreviewDelegates._clickSeq || 0) + 1;
      bindPreviewDelegates._suppressEditUntil = 0;
      if (e.target.closest("a, button, input, textarea, .md-block-source")) {
        return;
      }
      // If already editing, leave native selection alone.
      const editingNode = e.target.closest(".md-block.editing");
      if (editingNode) return;
      const node = e.target.closest(".md-block");
      if (!node) return;
      if (state.mode === "source") return;

      const isMermaid =
        !!(node.querySelector && node.querySelector(".mermaid-diagram")) ||
        /```\s*mermaid/i.test(node._stuartSrc || "");
      const isMath = !isMermaid && !!(node.querySelector && node.querySelector(".katex, .katex-display"));
      const isTable = !!(node.querySelector && node.querySelector("table"));
      const isCode = !!(node.querySelector && node.querySelector("pre"));
      // Structured blocks: double-click enters in-place edit immediately.
      // Plain text / heading: keep native word-selection only.
      if (isMermaid || isMath || isTable || isCode) {
        enterEditSurfaceFor(node, e.clientX, e.clientY);
      }
    });
  }

  /** Pull TeX source from a KaTeX-rendered node (never walk visual DOM). */
  function extractKatexTex(node) {
    if (!node) return "";
    try {
      const anns = node.querySelectorAll?.("annotation[encoding='application/x-tex']");
      if (anns && anns.length) {
        for (let i = 0; i < anns.length; i++) {
          const t = anns[i].textContent;
          if (t && String(t).trim()) return String(t).trim();
        }
      }
    } catch (_) {}
    let n = node;
    for (let i = 0; i < 8 && n && n !== document.documentElement; i++) {
      try {
        const t = n.getAttribute?.("data-tex");
        if (t && String(t).trim()) return String(t).trim();
      } catch (_) {}
      n = n.parentElement;
    }
    return "";
  }

  function katexMarkdownFromNode(node) {
    const tex = extractKatexTex(node);
    if (!tex) return "";
    const display =
      !!(node.classList && node.classList.contains("katex-display")) ||
      !!node.closest?.(".katex-display");
    return display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
  }

  /**
   * Wrap inline mark content without eating boundary whitespace.
   * `hello<strong> world </strong>bye` must stay `hello **world** bye`,
   * not `hello**world**bye` — dropped spaces made commits look "blocked"
   * for em/strong/s/del mixed lines.
   */
  function wrapInlineMark(token, inner) {
    const t = inner == null ? "" : String(inner);
    if (!t) return "";
    if (!t.trim()) return t;
    const lead = t.match(/^\s*/)[0];
    const tail = t.match(/\s*$/)[0];
    return lead + token + t.trim() + token + tail;
  }

  function htmlToMarkdown(root) {
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      // KaTeX: emit original TeX once at the root — never recurse into MathML/HTML twins
      if (node.classList && (node.classList.contains("katex") || node.classList.contains("katex-display"))) {
        return katexMarkdownFromNode(node.classList.contains("katex-display") ? node : node);
      }
      const tag = (node.tagName || "").toLowerCase();
      const kids = () => [...node.childNodes].map(walk).join("");
      switch (tag) {
        case "br":
          return "\n";
        case "strong":
        case "b":
          return wrapInlineMark("**", kids());
        case "em":
        case "i":
          return wrapInlineMark("*", kids());
        case "del":
        case "s":
        case "strike":
          return wrapInlineMark("~~", kids());
        case "u":
        case "ins":
          return kids();
        case "code":
          return node.closest("pre") ? node.textContent : `\`${node.textContent}\``;
        case "pre": {
          const code = node.querySelector("code");
          const lang = (code?.className || "").match(/language-([\w+-]+)/)?.[1] || "";
          const body = (code || node).textContent || "";
          return "```" + lang + "\n" + body.replace(/\n$/, "") + "\n```";
        }
        case "a":
          return `[${kids().trim()}](${node.getAttribute("href") || "#"})`;
        case "img":
          return `![${node.getAttribute("alt") || ""}](${node.getAttribute("src") || ""})`;
        case "hr":
          return "\n---\n";
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return "\n" + "#".repeat(Number(tag[1])) + " " + kids().trim() + "\n";
        case "blockquote":
          return (
            "\n" +
            kids()
              .trim()
              .split("\n")
              .map((l) => "> " + l)
              .join("\n") +
            "\n"
          );
        case "ul":
        case "ol": {
          const items = [...node.children]
            .filter((c) => c.tagName.toLowerCase() === "li")
            .map((li, i) => {
              const prefix = tag === "ol" ? `${i + 1}. ` : "- ";
              return prefix + walk(li).trim().replace(/\n+/g, " ");
            });
          return "\n" + items.join("\n") + "\n";
        }
        case "li":
          return kids();
        case "p":
          return "\n" + kids().trim() + "\n";
        case "div":
        case "section":
        case "article":
          return kids();
        case "span":
          if (node.classList?.contains("katex") || node.classList?.contains("katex-display")) {
            return katexMarkdownFromNode(node);
          }
          return kids();
        case "table": {
          const rows = [...node.querySelectorAll("tr")].map((tr) =>
            [...tr.children].map((td) => walk(td).trim().replace(/\|/g, "\\|"))
          );
          if (!rows.length) return "";
          const head = rows[0];
          const sep = head.map(() => "---");
          const body = rows.slice(1);
          const lines = [
            "| " + head.join(" | ") + " |",
            "| " + sep.join(" | ") + " |",
            ...body.map((r) => "| " + r.join(" | ") + " |"),
          ];
          return "\n" + lines.join("\n") + "\n";
        }
        case "input":
          if (node.type === "checkbox") return node.checked ? "[x]" : "[ ]";
          return "";
        default:
          if (node.classList?.contains("katex") || node.classList?.contains("katex-display")) {
            return katexMarkdownFromNode(node);
          }
          // Inside a KaTeX subtree without reaching root — do not dump visual text
          if (node.closest?.(".katex")) {
            const host = node.closest(".katex") || node.closest(".katex-display");
            return host && host === node ? katexMarkdownFromNode(host) : "";
          }
          return kids();
      }
    };
    let out = walk(root)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return out;
  }

  /** Range at (x, y) — Chrome/WebView caretRangeFromPoint, or the standard API. */
  function caretRangeFromXY(x, y) {
    try {
      if (typeof document.caretRangeFromPoint === "function") {
        return document.caretRangeFromPoint(x, y);
      }
      if (typeof document.caretPositionFromPoint === "function") {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) {
          const r = document.createRange();
          const max = pos.offsetNode.nodeType === 3 ? (pos.offsetNode.nodeValue || "").length : pos.offsetNode.childNodes.length;
          r.setStart(pos.offsetNode, Math.min(pos.offset || 0, max));
          r.collapse(true);
          return r;
        }
      }
    } catch (_) {}
    return null;
  }

  /** True when the caret range lives inside target (inline em/strong/code/span included). */
  function rangeInsideTarget(r, target) {
    if (!r || !target) return false;
    const n = r.startContainer;
    if (!n) return false;
    if (target === n) return true;
    if (target.contains && target.contains(n)) return true;
    // Element startContainer whose parent chain reaches target
    if (n.parentElement && target.contains(n.parentElement)) return true;
    return false;
  }

  function placeCaretOnClick(target, x, y) {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      // Prefer the real click point so heading/list/rich-text edits feel immediate
      // and land BETWEEN letters even inside em/strong/s/del/code/span.
      if (x != null && y != null) {
        const r = caretRangeFromXY(x, y);
        if (r && rangeInsideTarget(r, target)) {
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
        // Click is inside the target but caret resolved outside it
        // (padding / nested chrome / inline background). Snap to the nearest
        // text position in target at the click point.
        const rect = target.getBoundingClientRect();
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) {
          const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
          let bestNode = null;
          let bestDist = Infinity;
          let bestOffset = 0;
          while (walker.nextNode()) {
            const tn = walker.currentNode;
            if (!tn.nodeValue) continue;
            const rg = document.createRange();
            rg.selectNodeContents(tn);
            const rects = rg.getClientRects();
            for (let i = 0; i < rects.length; i++) {
              const cr = rects[i];
              const dx = x < cr.left ? cr.left - x : x > cr.right ? x - cr.right : 0;
              const dy = y < cr.top ? cr.top - y : y > cr.bottom ? y - cr.bottom : 0;
              const d = dx * dx + dy * dy;
              if (d < bestDist) {
                bestDist = d;
                bestNode = tn;
                // Estimate character offset at click X within this text node.
                bestOffset = estimateTextOffset(tn, x);
              }
            }
          }
          if (bestNode) {
            const rr = document.createRange();
            const max = (bestNode.nodeValue || "").length;
            rr.setStart(bestNode, Math.min(bestOffset, max));
            rr.collapse(true);
            sel.removeAllRanges();
            sel.addRange(rr);
            return;
          }
        }
      }
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  }

  /** Binary-search the character offset in a text node nearest to client X. */
  function estimateTextOffset(tn, x) {
    const text = tn.nodeValue || "";
    if (!text.length) return 0;
    try {
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const rg = document.createRange();
        rg.setStart(tn, mid);
        rg.setEnd(tn, Math.min(mid + 1, text.length));
        const rects = rg.getClientRects();
        if (!rects.length) {
          lo = mid + 1;
          continue;
        }
        const cr = rects[0];
        if (x < cr.left) hi = mid;
        else if (x > cr.right) lo = mid + 1;
        else return mid;
      }
      return lo;
    } catch (_) {
      return text.length;
    }
  }

  function exitBlockEditVisual(node) {
    if (!node) return;
    node.classList.remove("editing", "source-edit");
    try {
      const ae = document.activeElement;
      if (ae && (ae === node || node.contains(ae))) ae.blur?.();
    } catch (_) {}
    [...node.querySelectorAll("[contenteditable]")].forEach((el) => {
      el.removeAttribute("contenteditable");
      el.removeAttribute("spellcheck");
    });
    if (node.getAttribute("contenteditable")) node.removeAttribute("contenteditable");
  }

  /** Block currently receiving typing focus, if any. Stale .editing is cleaned up. */
  function getActiveEditingBlock() {
    const eds = $$(".md-block.editing", el.preview);
    if (!eds.length) return null;
    const ae = document.activeElement;
    for (const ed of eds) {
      if (ae && (ae === ed || ed.contains(ae))) return ed;
      const ta = ed.querySelector("textarea.md-block-source");
      if (ta && ae === ta) return ed;
    }
    // .editing without focus → leftover caret; force commit so handle can return
    cleanupStaleBlockEditing();
    return null;
  }

  function isActiveBlockEditing() {
    return !!getActiveEditingBlock();
  }

  function cleanupStaleBlockEditing() {
    $$(".md-block.editing", el.preview).forEach((n) => {
      if (typeof n._stuartCommit === "function") {
        try {
          n._stuartCommit();
          return;
        } catch (_) {}
      }
      const ta = n.querySelector("textarea.md-block-source");
      if (ta && typeof ta._stuartCommit === "function") {
        try {
          ta._stuartCommit();
          return;
        } catch (_) {}
      }
      exitBlockEditVisual(n);
      // Force a full re-render so contenteditable DOM is replaced
      invalidatePreviewBlocks();
      try {
        renderMarkdown(el.source.value);
        lastPreviewSource = el.source.value;
        lastPreviewBlocks = splitMarkdownBlocks(el.source.value || "");
      } catch (_) {}
    });
  }

  function blockNeedsSourceEdit(node) {
    return !!(node.querySelector(".katex, .mermaid-diagram"));
  }

  /**
   * Write one block back into the source model with undo + accidental-wipe guards.
   * Never silently replace non-empty source with empty conversion output.
   * Returns true when the source is unchanged or written; false when refused
   * (caller must restore snapshot HTML and leave source alone).
   */
  function commitBlockSource(idx, nextText, originalText, opts) {
    const o = opts || {};
    if (o.documentId !== activeDocument?.documentId || o.expectedRevision !== activeDocument?.revision) throw new Error("段落编辑已经失效，当前文档保持现有正文");
    const all = splitMarkdownBlocks(el.source.value || "");
    const snap = originalText != null ? String(originalText) : "";
    if (!Number.isFinite(idx) || idx < 0 || idx >= all.length) {
      // Index drift — try recover by original snapshot before giving up
      const hit = snap.trim() ? all.findIndex((b) => b === snap) : -1;
      if (hit >= 0) {
        idx = hit;
      } else {
        toast("编辑未能定位原块，已保留原文（请撤销后重试）");
        return { ok: false, index: -1 };
      }
    }
    // Slot must still hold what we opened; otherwise the index drifted onto
    // different content — refuse to overwrite unknown source.
    const current = all[idx] == null ? "" : String(all[idx]);
    if (snap.trim() && current !== snap) {
      const hit = all.findIndex((b) => b === snap);
      if (hit >= 0) {
        idx = hit;
      } else if (current.trim()) {
        toast("编辑未能定位原块，已保留原文（请撤销后重试）");
        return { ok: false, index: -1 };
      }
    }
    let next = nextText == null ? "" : String(nextText);
    const original = originalText == null ? all[idx] || "" : String(originalText);
    // Unedited sessions must write back the exact opened source — never a
    // whitespace-stripped or otherwise mutated reconstruction.
    if (o.userEdited === false) {
      next = original;
    }
    // Accidental wipe: empty conversion of a non-empty block (contenteditable +
    // selection collapse / structure loss). Allow empty only when user was in
    // source-edit and explicitly cleared.
    if (o.allowEmpty !== true && !String(next).trim() && String(original).trim()) {
      next = original;
    }
    // Never let a gutted non-empty replacement stand in for a non-empty original
    // unless the user actually edited (e.g. reconstructed empty fence over code).
    if (o.userEdited !== true && String(original).trim() && next !== original) {
      const origLines = original.split("\n").length;
      const nextLines = next.split("\n").length;
      if (!String(next).trim() || nextLines < Math.max(1, Math.floor(origLines * 0.4))) {
        next = original;
      }
    }
    // Heuristic loss guard for WYSIWYG → markdown: if visual text is substantial
    // but markdown came back gutted, keep the original source.
    if (o.domText && o.domText.length > 24) {
      const plain = String(next)
        .replace(/[*_`~\[\]()#|\\>-]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const domPlain = String(o.domText)
        .replace(/\s+/g, " ")
        .trim();
      if (plain.length < Math.min(24, domPlain.length * 0.45)) {
        next = original;
      }
    }
    if (o.preserveTrailingSeparators) next += original.match(/(?:\r\n|\r|\n)+$/)?.[0] || "";
    const buffer = new window.StuartCore.TextBuffer(original, activeDocument.buffer.defaultSeparator);
    buffer.updateEditor(next);
    next = buffer.source;
    if (next === all[idx]) {
      return { ok: true, index: idx };
    }
    const prev = activeDocument.source;
    if (prev) pushHistory(prev);
    all[idx] = next;
    const joined = joinBlocks(all);
    el.source.value = joined;
    state.content = joined;
    markDirty();
    scheduleAutoSave();
    pushHistory(activeDocument.source);
    return { ok: true, index: idx };
  }

  /** Force the next applyBlockEditing pass to rebuild every node (no incremental skip). */
  function invalidatePreviewBlocks() {
    lastPreviewBlocks = [];
    lastPreviewSource = "";
  }

  /** Restore pre-edit DOM snapshot after a refused/failed commit. */
  function restoreBlockSnapshot(node) {
    if (!node) return;
    node.classList.remove("editing", "source-edit", "code-edit", "table-edit");
    try {
      const snapHtml = node._stuartSnapshotHtml;
      if (snapHtml) {
        node.innerHTML = snapHtml;
      }
    } catch (_) {}
    try {
      document.getSelection()?.removeAllRanges();
    } catch (_) {}
  }

  /** Drop table-edit chrome without touching the surrounding preview tree. */
  function exitTableEditChrome(node, cells) {
    if (!node) return;
    node.classList.remove("editing", "source-edit", "code-edit", "table-edit");
    const list = cells && cells.length ? cells : [...node.querySelectorAll("td, th")];
    list.forEach((c) => {
      try {
        c.removeAttribute("contenteditable");
        c.removeAttribute("spellcheck");
        c.style.outline = "";
      } catch (_) {}
    });
    if (node.getAttribute && node.getAttribute("contenteditable")) {
      node.removeAttribute("contenteditable");
    }
  }

  /**
   * Re-render one preview block in place. Table commit used to call
   * invalidatePreviewBlocks + renderMarkdown, which takes the heavy path and
   * remounts the whole preview — that remount is the exit jitter.
   */
  function rebuildBlockNodeInPlace(node, sourceValue, index) {
    if (!node) return;
    const scrollTop = el.previewPane ? el.previewPane.scrollTop : 0;
    const all = splitMarkdownBlocks(sourceValue || "");
    const src =
      index >= 0 && index < all.length
        ? String(all[index] == null ? "" : all[index])
        : String(node._stuartSrc || "");
    exitTableEditChrome(node);
    node._stuartSrc = src;
    stampBlockVersion(node);
    if (!src.trim()) {
      node.classList.add("md-empty");
      node.innerHTML = '<p class="md-empty-line"><br></p>';
    } else {
      node.classList.remove("md-empty");
      node.innerHTML = sanitizeHtmlStrict(renderBlockHtml(src));
      try {
        attachCodeLangBadges(node);
      } catch (_) {}
      if (blockNeedsPostProcess(src)) {
        try {
          postProcessBlock(node);
        } catch (_) {}
      }
    }
    if (index >= 0) node.dataset.index = String(index);
    lastPreviewSource = sourceValue || "";
    lastPreviewBlocks = all;
    if (el.previewPane) el.previewPane.scrollTop = scrollTop;
    try {
      updateOutline();
      updateStats();
    } catch (_) {}
  }

  /** Restore the exact pre-edit DOM of a block (unedited session / cancel). */
  function restoreBlockDomQuiet(node, cells) {
    if (!node) return;
    exitTableEditChrome(node, cells);
    try {
      if (node._stuartSnapshotHtml != null) {
        node.innerHTML = node._stuartSnapshotHtml;
        return true;
      }
    } catch (_) {}
    return false;
  }

  function enterBlockSourceEdit(node) {
    if (node.classList.contains("editing")) return;
    $$(".md-block.editing", el.preview).forEach((n) => exitBlockEditVisual(n));
    const { index: idx, original: resolved } = resolveBlockSource(node);
    const editVersion = { documentId: activeDocument.documentId, expectedRevision: activeDocument.revision };
    let original = resolved;
    // KaTeX: recover TeX from the rendered node if the source slot came back empty.
    if (!String(original).trim() && node.querySelector && node.querySelector(".katex, .katex-display")) {
      const tex = extractKatexTex(node);
      if (tex) {
        const display =
          !!(node.classList && node.classList.contains("katex-display")) ||
          !!node.querySelector(".katex-display");
        original = display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
      }
    }
    // Never open a destructive editor over live content without a resolvable source.
    if (!String(original).trim()) {
      toast("无法解析该块源文，已保留原文");
      return;
    }
    const snapshotHtml = node.innerHTML;
    node._stuartSnapshotHtml = snapshotHtml;
    node._stuartSrc = original;
    node.classList.add("editing", "source-edit");
    const prevScroll = el.previewPane.scrollTop;
    node.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "md-block-source";
    // Keep the opened source byte-exact — trailing whitespace strip mutated
    // last-block newlines and made unchanged commits look like edits.
    ta.value = String(original || "");
    ta.spellcheck = false;
    const lineCount = Math.max(1, ta.value.split("\n").length);
    ta.rows = lineCount;
    node.appendChild(ta);
    // auto-grow without forcing a huge empty area
    const fit = () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    };
    fit();
    ta.addEventListener("input", fit);
    ta.focus();
    ta.setSelectionRange(0, 0);
    el.previewPane.scrollTop = prevScroll;

    let done = false;
    let userEdited = false;
    ta.addEventListener("input", () => {
      userEdited = true;
    });
    const cleanupDocDown = () => {
      document.removeEventListener("mousedown", onDocDown, true);
    };
    const commit = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      let next = ta.value;
      // Unchanged session must write back the exact opened source — never a
      // whitespace-stripped mutation of it.
      if (!userEdited) {
        next = original;
      }
      const written = commitBlockSource(idx, next, original, {
        ...editVersion,
        allowEmpty: !!userEdited,
        userEdited: !!userEdited,
      });
      if (!written.ok) {
        restoreBlockSnapshot(node);
        clearEditEnterGates();
        return;
      }
      const joined = el.source.value || "";
      invalidatePreviewBlocks();
      node.classList.remove("editing", "source-edit");
      node.innerHTML = "";
      renderMarkdown(joined);
      lastPreviewSource = joined;
      emitAgentEvent("document-changed", { source: "block-edit" });
      try {
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
      clearEditEnterGates();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      invalidatePreviewBlocks();
      node.classList.remove("editing", "source-edit");
      // Restore pre-edit DOM if source re-render is unavailable
      if (node._stuartSnapshotHtml) {
        node.innerHTML = node._stuartSnapshotHtml;
      }
      renderMarkdown(el.source.value);
      lastPreviewSource = el.source.value;
      pushHistory(el.source.value || "");
      clearEditEnterGates();
    };
    ta._stuartCommit = commit;
    node._stuartCommit = commit;
    ta.addEventListener("blur", commit);
    const onDocDown = (e) => {
      if (done) return;
      if (node.contains(e.target)) return;
      commit();
    };
    document.addEventListener("mousedown", onDocDown, true);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
        document.removeEventListener("mousedown", onDocDown, true);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
        document.removeEventListener("mousedown", onDocDown, true);
      }
      e.stopPropagation();
    });
  }

  function enterBlockEdit(node, clickX, clickY) {
    if (node.classList.contains("editing")) return;
    // Math / diagram: WYSIWYG edit corrupts KaTeX / mermaid DOM — source editor
    if (node.querySelector(".katex, .katex-display, .mermaid-diagram")) {
      enterBlockSourceEdit(node);
      return;
    }
    // Table / code: dedicated in-place editors (never contenteditable the shell)
    if (node.querySelector("table")) {
      enterTableEdit(node, clickX, clickY);
      return;
    }
    if (node.querySelector("pre")) {
      enterCodeEdit(node);
      return;
    }
    // exit any other editing block first
    $$(".md-block.editing", el.preview).forEach((n) => {
      exitBlockEditVisual(n);
    });
    const { index: idx, original: originalBlock } = resolveBlockSource(node);
    const editVersion = { documentId: activeDocument.documentId, expectedRevision: activeDocument.revision };
    // Never open an editor over live structured content we cannot resolve.
    if (!String(originalBlock).trim()) {
      const structured = node.querySelector && node.querySelector("pre, table, .katex, .katex-display, .mermaid-diagram");
      if (structured || String(node.textContent || "").trim()) {
        toast("无法解析该块源文，已保留原文");
        return;
      }
    }
    node._stuartSnapshotHtml = node.innerHTML;
    node._stuartSrc = originalBlock;
    node.classList.add("editing");
    // Never make table/pre shells contenteditable — browsers restructure them
    // and htmlToMarkdown then drops cells/code.
    // Inline-only children (rich text: em/strong/s/del/code/span mix) must edit
    // the whole block — a per-inline host freezes every text node outside those tags.
    const INLINE_HOST_RE = /^(em|strong|s|del|code|span|a|b|i|u|ins|strike|abbr|mark|small|sub|sup|kbd|samp|var|cite|q)$/i;
    const editableRoots = [...node.children].filter(
      (c) => c && !c.matches?.("table, pre, .katex-display, .mermaid-diagram")
    );
    const onlyInline = editableRoots.length > 0 && editableRoots.every((c) => INLINE_HOST_RE.test(c.tagName || ""));
    const hosts = !editableRoots.length || onlyInline ? [node] : editableRoots;
    hosts.forEach((h) => {
      h.setAttribute("contenteditable", "true");
      h.spellcheck = false;
      h.style.outline = "none";
    });
    // Place caret in the host under the pointer (heading letters / list rows /
    // rich-text inline runs). Focus first so the caret is visible this frame.
    let caretHost = hosts[0];
    if (clickX != null && clickY != null) {
      for (const h of hosts) {
        const hr = h.getBoundingClientRect();
        if (clickX >= hr.left - 1 && clickX <= hr.right + 1 && clickY >= hr.top - 1 && clickY <= hr.bottom + 1) {
          caretHost = h;
          break;
        }
      }
    }
    const prevScroll = el.previewPane ? el.previewPane.scrollTop : 0;
    try {
      caretHost.focus({ preventScroll: true });
    } catch (_) {
      try {
        caretHost.focus();
      } catch (_) {}
    }
    placeCaretOnClick(caretHost, clickX, clickY);
    if (el.previewPane) el.previewPane.scrollTop = prevScroll;

    let done = false;
    let userEdited = false;
    node.addEventListener(
      "input",
      () => {
        userEdited = true;
      },
      true
    );
    const clearDoc = () => document.removeEventListener("mousedown", onDocDown, true);
    const finishRestore = (text) => {
      invalidatePreviewBlocks();
      exitBlockEditVisual(node);
      renderMarkdown(text);
      lastPreviewSource = text;
      lastPreviewBlocks = splitMarkdownBlocks(text || "");
    };
    const commit = () => {
      if (done) return;
      done = true;
      clearDoc();
      let mdText = htmlToMarkdown(node).trim();
      const original = originalBlock;
      const hadMath = /\$\$[\s\S]+\$|\$[^$\n]+\$/.test(original);
      const hasMath = /\$\$[\s\S]+\$|\$[^$\n]+\$/.test(mdText);
      if (hadMath && !hasMath) mdText = original;
      const domText = node.textContent || "";
      // Unedited session must write the exact opened source — never a lossy
      // htmlToMarkdown reconstruction (footnotes / ref-links / raw HTML).
      const written = commitBlockSource(idx, userEdited ? mdText : original, original, {
        ...editVersion,
        domText,
        preserveTrailingSeparators: !!userEdited,
        userEdited: !!userEdited,
        allowEmpty: !!userEdited,
      });
      if (!written.ok) {
        restoreBlockSnapshot(node);
        finishRestore(el.source.value);
        clearEditEnterGates();
        return;
      }
      const joined = el.source.value || "";
      finishRestore(joined);
      try {
        if (document.activeElement && node.contains(document.activeElement)) {
          document.activeElement.blur?.();
        }
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
      clearEditEnterGates();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      clearDoc();
      finishRestore(el.source.value);
      try {
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
      clearEditEnterGates();
    };

    node._stuartCommit = commit;
    node.addEventListener(
      "blur",
      (e) => {
        if (!node.contains(e.relatedTarget)) commit();
      },
      true
    );
    const onDocDown = (e) => {
      if (done) return;
      if (node.contains(e.target)) return;
      // Clicking handle / toolbar / elsewhere ends the edit so the handle can return
      commit();
    };
    document.addEventListener("mousedown", onDocDown, true);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const tag = (node.firstElementChild?.tagName || "").toLowerCase();
        if (tag && tag[0] === "h" && tag.length === 2) {
          e.preventDefault();
          commit();
          return;
        }
      }
      handleBlockEditKeydown(e, node);
    });
  }

  /** In-place table cell editing — click a cell and type; no markdown shell. */
  function enterTableEdit(node, clickX, clickY) {
    if (node.classList.contains("editing")) return;
    // Intentional enter (dblclick / delayed click) may replace a live selection —
    // clear selection chrome instead of refusing to edit (P0 over-suppression).
    hideSelToolbar();
    try {
      window.getSelection()?.removeAllRanges();
    } catch (_) {}
    $$(".md-block.editing", el.preview).forEach((n) => {
      if (typeof n._stuartCommit === "function") {
        try {
          n._stuartCommit();
        } catch (_) {}
      } else {
        exitBlockEditVisual(n);
      }
    });
    const { index: idx, original } = resolveBlockSource(node);
    const editVersion = { documentId: activeDocument.documentId, expectedRevision: activeDocument.revision };
    if (!String(original).trim() && node.querySelector("table")) {
      toast("无法解析该块源文，已保留原文");
      return;
    }
    node._stuartSrc = original;
    node._stuartSnapshotHtml = node.innerHTML;
    node.classList.add("editing", "table-edit");
    const cells = [...node.querySelectorAll("td, th")];
    if (!cells.length) {
      node.classList.remove("editing", "table-edit");
      enterBlockSourceEdit(node);
      return;
    }
    cells.forEach((c) => {
      c.setAttribute("contenteditable", "true");
      c.spellcheck = false;
      c.style.outline = "none";
    });
    // Prefer the cell under the pointer so double-click lands where the user aimed.
    let focusCell = cells[0];
    if (clickX != null && clickY != null && typeof document.elementFromPoint === "function") {
      try {
        const hit = document.elementFromPoint(clickX, clickY);
        const cell = hit && hit.closest ? hit.closest("td, th") : null;
        if (cell && node.contains(cell)) focusCell = cell;
      } catch (_) {}
    }
    try {
      focusCell.focus();
      placeCaretOnClick(focusCell, clickX, clickY);
    } catch (_) {}

    let done = false;
    let userEdited = false;
    node.addEventListener(
      "input",
      () => {
        userEdited = true;
      },
      true
    );
    const onDocDown = (e) => {
      if (done) return;
      if (node.contains(e.target)) return;
      commit();
    };
    const cleanupDocDown = () => document.removeEventListener("mousedown", onDocDown, true);
    const commit = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      const mdText = htmlToMarkdown(node).trim();
      const domText = node.textContent || "";
      // Unedited session must write the exact opened source — htmlToMarkdown
      // drops alignment / cell newlines / raw HTML and must not be sole truth.
      const written = commitBlockSource(idx, userEdited ? mdText : original, original, {
        ...editVersion,
        domText,
        preserveTrailingSeparators: !!userEdited,
        userEdited: !!userEdited,
        allowEmpty: !!userEdited,
      });
      if (!written.ok) {
        restoreBlockSnapshot(node);
        clearEditEnterGates();
        return;
      }
      // Unedited exit: put back the exact pre-edit DOM. Zero remount, zero jump.
      if (!userEdited) {
        if (!restoreBlockDomQuiet(node, cells)) {
          rebuildBlockNodeInPlace(node, el.source.value || "", written.index);
        }
        try {
          document.getSelection()?.removeAllRanges();
        } catch (_) {}
        clearEditEnterGates();
        return;
      }
      // Edited exit: swap THIS block only. Never invalidatePreviewBlocks +
      // renderMarkdown (heavy path remounts the whole preview → exit jitter).
      rebuildBlockNodeInPlace(node, el.source.value || "", written.index);
      emitAgentEvent("document-changed", { source: "table-edit" });
      try {
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
      clearEditEnterGates();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      if (restoreBlockDomQuiet(node, cells)) {
        clearEditEnterGates();
        return;
      }
      // Fallback only when no snapshot exists — keep scroll, avoid full flash.
      const prevScroll = el.previewPane ? el.previewPane.scrollTop : 0;
      invalidatePreviewBlocks();
      node.classList.remove("editing", "table-edit");
      renderMarkdown(el.source.value);
      lastPreviewSource = el.source.value;
      if (el.previewPane) el.previewPane.scrollTop = prevScroll;
      clearEditEnterGates();
    };
    node._stuartCommit = commit;
    document.addEventListener("mousedown", onDocDown, true);
    node.addEventListener(
      "blur",
      (e) => {
        if (!node.contains(e.relatedTarget)) commit();
      },
      true
    );
    node.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === "Tab") {
        // Move across cells so table edit feels native
        e.preventDefault();
        const all = [...node.querySelectorAll("td, th")];
        const cur = all.indexOf(document.activeElement);
        const next = e.shiftKey ? all[cur - 1] : all[cur + 1];
        if (next) {
          next.focus();
          placeCaretOnClick(next);
        }
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Enter commits (tables have no soft line breaks in GFM cells)
        e.preventDefault();
        commit();
      }
      e.stopPropagation();
    });
  }

  /** Edit code body in place (keep the fenced chrome / language). */
  /**
   * Rebuild a fenced code block from language + body, byte-safe.
   * Body is preserved exactly; a single newline is inserted before the closing
   * fence only when the body does not already end with one.
   */
  function rebuildCodeFence(lang, body) {
    const b = body == null ? "" : String(body);
    const needsNl = b.length > 0 && !/\r?\n$/.test(b);
    return "```" + String(lang || "") + "\n" + b + (needsNl ? "\n" : "") + "```";
  }

  /**
   * Split a fence source into open/body/close/suffix so a body-only edit keeps
   * language, EOL style, closing fence and any trailing document bytes intact.
   */
  function extractFenceParts(original) {
    const src = String(original == null ? "" : original);
    const token = md.parse(src, {}).find(token => token.type === "fence" && token.level === 0 && token.map);
    if (!token) return null;
    const lines = src.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
    const opening = token.map[0];
    const closing = token.map[1] - 1;
    if (closing <= opening || !lines[closing]?.trimStart().startsWith(token.markup)) return null;
    return {
      lang: token.info.trim().split(/\s+/)[0],
      openToken: lines.slice(0, opening + 1).join(""),
      body: lines.slice(opening + 1, closing).join(""),
      closeToken: lines[closing],
      suffix: lines.slice(closing + 1).join(""),
    };
  }

  /** Reassemble a fence with a new body; open/close/suffix stay byte-identical. */
  function rebuildFenceFromParts(parts, newBody) {
    if (!parts) throw new Error("代码围栏缺少 Markdown 解析范围");
    const body = new window.StuartCore.TextBuffer(parts.body, activeDocument.buffer.defaultSeparator);
    body.updateEditor(newBody);
    if (body.source && !/[\r\n]$/.test(body.source)) body.apply({ from: body.source.length, to: body.source.length, insertedText: body.defaultSeparator });
    return parts.openToken + body.source + parts.closeToken + parts.suffix;
  }

  function enterCodeEdit(node) {
    if (node.classList.contains("editing")) return;
    // Intentional enter (dblclick / delayed click) may replace a live selection —
    // clear selection chrome instead of refusing to edit (P0 over-suppression).
    hideSelToolbar();
    try {
      window.getSelection()?.removeAllRanges();
    } catch (_) {}
    $$(".md-block.editing", el.preview).forEach((n) => {
      if (typeof n._stuartCommit === "function") {
        try {
          n._stuartCommit();
        } catch (_) {}
      } else {
        exitBlockEditVisual(n);
      }
    });
    const { index: idx, original } = resolveBlockSource(node);
    const editVersion = { documentId: activeDocument.documentId, expectedRevision: activeDocument.revision };
    // Mermaid: source edit preserves the diagram contract
    if (node.querySelector(".mermaid-diagram") || /```\s*mermaid/i.test(original) || /```\s*mermaid/i.test(node._stuartSrc || "")) {
      enterBlockSourceEdit(node);
      return;
    }
    // Never open a destructive editor without a non-empty resolvable source.
    if (!String(original).trim()) {
      toast("无法解析该块源文，已保留原文");
      return;
    }
    const snapshotHtml = node.innerHTML;
    node._stuartSnapshotHtml = snapshotHtml;
    node._stuartSrc = original;
    node.classList.add("editing", "code-edit");
    const pre = node.querySelector("pre");
    const codeEl = node.querySelector("pre code") || pre;
    if (!codeEl) {
      node.classList.remove("editing", "code-edit");
      enterBlockSourceEdit(node);
      return;
    }
    const fenceParts = extractFenceParts(original);
    if (!fenceParts) {
      node.classList.remove("editing", "code-edit");
      enterBlockSourceEdit(node);
      return;
    }
    const lang = fenceParts.lang;
    const body = fenceParts.body;

    const prevScroll = el.previewPane.scrollTop;
    // Keep the reading-mode pre chrome; only swap the body for a matching textarea
    node.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "code-edit-wrap";
    wrap.dataset.lang = lang || "";
    const ta = document.createElement("textarea");
    ta.className = "md-block-source code-edit-area";
    ta.value = body;
    ta.spellcheck = false;
    // Baseline rows = content lines (min 1). Never the HTML default of 2.
    ta.rows = Math.max(1, String(body).split("\n").length);
    ta.setAttribute("aria-label", lang ? `代码 · ${lang}` : "代码");
    wrap.appendChild(ta);
    node.appendChild(wrap);
    const fit = () => {
      // Collapse first so scrollHeight is content-driven. Using "auto" alone
      // leaves the rows/min-height floor in place and scrollHeight reports that
      // floor instead of the text, which is why 1-line blocks looked ~80px tall.
      ta.style.height = "0px";
      ta.style.height = ta.scrollHeight + "px";
    };
    fit();
    ta.addEventListener("input", fit);
    let userEdited = false;
    ta.addEventListener("input", () => {
      userEdited = true;
    });
    ta.focus();
    ta.setSelectionRange(0, 0);
    el.previewPane.scrollTop = prevScroll;

    let done = false;
    const onDocDown = (e) => {
      if (done) return;
      if (node.contains(e.target)) return;
      commit();
    };
    const cleanupDocDown = () => document.removeEventListener("mousedown", onDocDown, true);
    const commit = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      let next;
      if (!userEdited) {
        // Unedited: always restore the exact opened fence (including trailing blanks).
        next = original;
      } else {
        next = rebuildFenceFromParts(fenceParts, ta.value);
      }
      // allowEmpty only when the user explicitly edited — empty body then means
      // intentional clear, never an extraction/blur artifact.
      const written = commitBlockSource(idx, next, original, {
        ...editVersion,
        allowEmpty: !!userEdited,
        userEdited: !!userEdited,
      });
      if (!written.ok) {
        restoreBlockSnapshot(node);
        clearEditEnterGates();
        return;
      }
      const joined = el.source.value || "";
      invalidatePreviewBlocks();
      node.classList.remove("editing", "code-edit");
      node.innerHTML = "";
      renderMarkdown(joined);
      lastPreviewSource = joined;
      emitAgentEvent("document-changed", { source: "code-edit" });
      try {
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
      clearEditEnterGates();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      invalidatePreviewBlocks();
      node.classList.remove("editing", "code-edit");
      node.innerHTML = "";
      renderMarkdown(el.source.value);
      lastPreviewSource = el.source.value;
      clearEditEnterGates();
    };
    node._stuartCommit = commit;
    ta._stuartCommit = commit;
    document.addEventListener("mousedown", onDocDown, true);
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      }
      e.stopPropagation();
    });
  }

  function renderMarkdown(text) {
    if (state.mode === "source") return;
    const document = activeDocument;
    const render = document?.beginRender(state.mode, state.theme, 0);
    // 每个文档版本使用独立的渲染编号。
    applyBlockEditing();
    if (document && activeDocument === document && document.confirmRender(render)) lastPreviewSource = document.source;
  }

  function findHeadingByText(text) {
    const t = text.trim().toLowerCase();
    return $$("h1,h2,h3,h4,h5,h6", el.preview).find(
      (h) => h.textContent.trim().toLowerCase() === t
    );
  }

  let pendingMermaid = [];
  function renderMermaid() {
    const nodes = $$("pre.mermaid-src[data-mermaid]", el.preview);
    if (!nodes.length) { pendingMermaid = []; return; }
    const document = activeDocument;
    const epoch = document?.renderEpoch;
    const theme = state.theme;
    pendingMermaid = nodes.map(node => {
      const valid = () => node.isConnected && activeDocument === document && document?.renderEpoch === epoch && state.theme === theme;
      return window.StuartMermaidRenderer.render(node.textContent, theme, valid).then(wrapper => {
        if (wrapper && valid()) node.replaceWith(wrapper);
      }).catch(error => {
        if (valid()) { node.classList.add("mermaid-error"); node.title = error.message; const message = window.document.createElement("div"); message.className = "mermaid-error-message"; message.textContent = "Mermaid 渲染失败：" + error.message; node.before(message); }
        return error;
      });
    });
  }

  function scheduleRender() {
    // Source-only typing should not rebuild the hidden preview
    if (state.mode === "source") return;
    if (renderTimer) cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => {
      clearTimeout(scheduleRender._t);
      const len = (el.source.value || "").length;
      const delay = len > 40000 ? 280 : len > 20000 ? 220 : len > 6000 ? 140 : 80;
      scheduleRender._t = setTimeout(() => {
        const next = activeDocument?.source ?? el.source.value;
        // P0: identical content → skip expensive DOM rebuild
        if (next === lastPreviewSource && activeDocument?.renderRevision === activeDocument?.revision) {
          updateStats();
          return;
        }
        const pane = el.previewPane;
        const max = pane.scrollHeight - pane.clientHeight;
        previewScrollRatio = max > 0 ? pane.scrollTop / max : 0;
        renderMarkdown(next);
        lastPreviewSource = next;
        const newMax = pane.scrollHeight - pane.clientHeight;
        pane.scrollTop = previewScrollRatio * newMax;
      }, delay);
    });
  }

  function updateWindowTitle() {
    const prefix = state.dirty ? "• " : "";
    document.title = `${prefix}${state.name || "StuartMD"} — StuartMD`;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Outline ----------
  function liveHeadings() {
    return $$("h1,h2,h3,h4,h5,h6", el.preview);
  }

  function scrollToHeading(h) {
    if (!h || !h.isConnected) return;
    const scroller = $("#preview-pane") || el.preview.closest(".preview-pane") || el.preview.parentElement;
    try {
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (_) {
      h.scrollIntoView(true);
    }
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 4) {
      const top =
        h.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
      try {
        scroller.scrollTo({ top, behavior: "smooth" });
      } catch (_) {
        scroller.scrollTop = top;
      }
    }
    h.classList.add("outline-flash");
    setTimeout(() => h.classList.remove("outline-flash"), 900);
  }

  function jumpToHeadingIndex(index) {
    const go = () => {
      const heads = liveHeadings();
      const h = heads[index];
      if (h) scrollToHeading(h);
    };
    if (state.mode === "source") {
      setMode("split");
      requestAnimationFrame(() => requestAnimationFrame(go));
    } else {
      requestAnimationFrame(go);
    }
  }

  function updateOutline() {
    if (updateOutline._t) {
      updateOutline._again = true;
      return;
    }
    updateOutline._t = setTimeout(() => {
      updateOutline._t = 0;
      if (updateOutline._again) {
        updateOutline._again = false;
        updateOutline();
        return;
      }
      updateOutlineNow();
    }, 80);
  }

  function updateOutlineNow() {
    const heads = liveHeadings();
    let sig = state.mode + "\n";
    for (let i = 0; i < heads.length; i++) {
      sig += heads[i].tagName + "|" + (heads[i].textContent || "") + "\n";
    }
    // Skip rebuild when signature unchanged (nodes may be new; delegation handles clicks)
    if (sig === lastOutlineSig && el.outlineList.childElementCount === heads.length) return;
    lastOutlineSig = sig;
    if (!heads.length) {
      el.outlineList.innerHTML = `<div class="empty-hint">暂无大纲</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (!h.id) h.id = `h-${i}`;
      const level = Number(h.tagName.substring(1));
      const btn = document.createElement("button");
      btn.className = `outline-item l${level}`;
      btn.dataset.hindex = String(i);
      btn.textContent = h.textContent || "(空标题)";
      btn.title = h.textContent || "";
      frag.appendChild(btn);
    }
    el.outlineList.innerHTML = "";
    el.outlineList.appendChild(frag);
  }

  // ---------- Stats ----------
  function updateStats() {
    if (updateStats._t) {
      updateStats._pending = true;
      return;
    }
    updateStats._t = setTimeout(() => {
      updateStats._t = 0;
      updateStats._pending = false;
      updateStatsNow();
    }, 120);
  }

  function updateStatsNow() {
    const core = CoreDoc();
    const text = el.source.value || "";
    const chars = core ? core.countChars(text) : text.replace(/\s/g, "").length;
    const lines = core ? core.countLines(text) : text ? text.split("\n").length : 0;
    el.statusWords.textContent = `${chars} 字`;
    el.statusLines.textContent = `${lines} 行`;
  }

  // ---------- Theme ----------
  const THEMES = ["light", "gray", "dark", "sepia", "minion", "wallpaper"];
  function setTheme(theme) {
    const changed = state.theme !== theme;
    state.theme = theme;
    el.body.dataset.theme = theme;
    const darkish = theme === "dark" || theme === "gray";
    if (el.hlLight) el.hlLight.disabled = darkish;
    if (el.hlDark) el.hlDark.disabled = !darkish;
    if (changed && activeDocument && state.mode !== "source") {
      invalidatePreviewBlocks();
      renderMarkdown(activeDocument.source);
    }
    if (theme === "wallpaper") applyWallpaperVars(state.wallpaper);
    if (state.apiReady && window.pywebview?.api?.save_settings) {
      window.pywebview.api.save_settings({ theme, glass: false }).catch(() => {});
    }
    try {
      localStorage.setItem("StuartMD-theme", theme);
    } catch (_) {}
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  /** Sample image → CSS color tokens (bg, surface, accent, text, text2) */
  function extractWallpaperColors(img) {
    try {
      const w = 64;
      const h = 64;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      const vivid = [];
      for (let i = 0; i < data.length; i += 4) {
        const R = data[i], G = data[i + 1], B = data[i + 2];
        r += R; g += G; b += B; n++;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if (mx - mn > 40) vivid.push([R, G, B]);
      }
      if (!n) return null;
      const ar = Math.round(r / n), ag = Math.round(g / n), ab = Math.round(b / n);
      let vr = ar, vg = ag, vb = ab;
      if (vivid.length) {
        vr = vg = vb = 0;
        vivid.forEach((p) => { vr += p[0]; vg += p[1]; vb += p[2]; });
        vr = Math.round(vr / vivid.length);
        vg = Math.round(vg / vivid.length);
        vb = Math.round(vb / vivid.length);
      }
      const lum = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
      const dark = lum < 128;
      const hex = (R, G, B) =>
        "#" + [R, G, B].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
      const bg = hex(ar, ag, ab);
      const surface = dark
        ? hex(ar * 0.82, ag * 0.82, ab * 0.82)
        : hex(Math.min(255, ar * 1.04 + 6), Math.min(255, ag * 1.04 + 6), Math.min(255, ab * 1.04 + 6));
      const accent = hex(vr, vg, vb);
      const text = dark ? "#f2f2f2" : "#1a1a1a";
      const text2 = dark ? "#c8c8c8" : "#555555";
      return [bg, surface, accent, text, text2];
    } catch (_) {
      return null;
    }
  }

  function applyWallpaperVars(wp) {
    if (!wp || !wp.uri) return;
    state.wallpaper = wp;
    const root = document.documentElement;
    root.style.setProperty("--wp-image", `url("${wp.uri}")`);
    const colors = wp.colors || [];
    if (colors[0]) root.style.setProperty("--wp-bg", colors[0]);
    if (colors[1]) root.style.setProperty("--wp-surface", colors[1]);
    if (colors[2]) root.style.setProperty("--wp-accent", colors[2]);
    if (colors[3]) root.style.setProperty("--wp-text", colors[3]);
    if (colors[4]) root.style.setProperty("--wp-text2", colors[4]);
    const prev = $("#wallpaper-preview");
    if (prev) {
      prev.hidden = false;
      prev.style.backgroundImage = `url("${wp.uri}")`;
    }
  }

  function cycleTheme() {
    const i = THEMES.indexOf(state.theme);
    const next = THEMES[(i + 1) % THEMES.length];
    setTheme(next);
    toast(`主题：${themeLabel(next)}`);
  }

  function themeLabel(t) {
    return {
      light: "浅色",
      gray: "灰色",
      dark: "深色",
      sepia: "羊皮纸",
      minion: "小黄人",
      wallpaper: "壁纸",
    }[t] || t;
  }

  // ---------- Mode ----------
  function setMode(mode, persist = true) {
    state.mode = mode;
    el.editorArea.classList.remove("mode-preview", "mode-split", "mode-source");
    el.editorArea.classList.add(`mode-${mode}`);
    $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    el.splitResizer.hidden = mode !== "split";
    el.statusMode.textContent = { preview: "阅读", split: "分栏", source: "源码" }[mode];
    if (mode !== "source") {
      window.__stuartMd = md;
      scheduleRender();
    }
    if (persist && state.apiReady && window.pywebview?.api?.save_settings) {
      window.pywebview.api.save_settings({ mode }).catch(() => {});
    }
  }

  // ---------- Document ----------
  function setDocument(payload) {
    // Last line of defense: never swap documents under an open block editor.
    commitActiveEditsForHistory();
    if (renderTimer) cancelAnimationFrame(renderTimer);
    clearTimeout(scheduleRender._t);
    activeDocument = payload?.document || new window.StuartCore.DocumentSession(payload);
    state._selCache = null;
    aiUI.lastQuote = "";
    aiUI.lastMessages = [];
    window.dispatchEvent(new CustomEvent("stuart-document-changed", { detail: { documentId: activeDocument.documentId } }));
    lastPreviewSource = null;
    lastPreviewBlocks = [];
    _splitCache = { text: null, blocks: null };
    el.preview.replaceChildren();
    if (window.StuartMDPdf) window.StuartMDPdf.hidePdf();
    const { path, name, content, kind, b64, annotations } = payload || {};
    if (path && !isWelcomeOrSamplePath(path, name)) {
      state.isSampleDoc = false;
      setWorkspaceFromPath(path);
    } else if (payload?.welcome || isWelcomeOrSamplePath(path, name)) {
      state.isSampleDoc = true;
    }
    // Hide welcome whenever a real document is applied
    el.welcome.hidden = true;
    if (kind === "pdf" || b64 || (path && String(path).toLowerCase().endsWith(".pdf"))) {
      state.path = path || null;
      state.name = name || "文档.pdf";
      state.content = "";
      window.StuartAIService?.setDocument(activeDocument);
      state.dirty = false;
      el.fileTitle.textContent = state.name;
      el.dirtyDot.hidden = true;
      el.welcome.hidden = true;
      el.editorArea.hidden = true;
      el.statusPath.textContent = path || "";
      updateWindowTitle();
      if (window.StuartMDPdf?.openPdf) {
        window.StuartMDPdf.openPdf({
          path,
          documentId: activeDocument.documentId,
          name: state.name,
          b64,
          annotations: annotations || [],
        });
      }
      markActiveTreeItem();
      updateStats();
      return;
    }
    state.path = path || null;
    state.name = name || activeDocument.title;
    state.content = activeDocument.source;
    window.StuartAIService?.setDocument(activeDocument);
    state.dirty = activeDocument.dirty;
    el.source.value = state.content;
    el.source.readOnly = activeDocument.accessState !== "Editable";
    if (activeDocument.accessState === "EncodingConfirmationRequired") window.StuartRecovery.confirmEncoding(payload);
    resetHistory(state.content);
    el.fileTitle.textContent = state.name;
    el.dirtyDot.hidden = !state.dirty;
    el.welcome.hidden = true;
    el.editorArea.hidden = false;
    const pdfArea = $("#pdf-area");
    if (pdfArea) pdfArea.hidden = true;
    el.statusPath.textContent = path || "未保存文档";
    updateWindowTitle();
    // applyBlockEditing already fills lastPreviewBlocks / lastPreviewSource
    renderMarkdown(state.content);
    if (state.mode !== "source") lastPreviewSource = state.content;
    markActiveTreeItem();
    updatePinUi();
  }

  function markDirty() {
    activeDocument?.updateEditor(el.source.value);
    if (activeDocument) window.StuartAIService?.setDocument(activeDocument);
    if (activeDocument) state.content = activeDocument.source;
    state.dirty = !!activeDocument?.dirty;
    el.dirtyDot.hidden = !state.dirty;
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) {
      tab.dirty = state.dirty;
      tab.rev = activeDocument.revision;
      tab.content = activeDocument.source;
    }
    // Patch tab strip only — full renderTabs on every keystroke was costly
    patchTabDirtyUi();
    updateWindowTitle();
    persistSessionSoon();
    scheduleDraftJournal();
    updateAutosaveStatus();
  }

  function syncDocumentState(document) {
    const tab = state.tabs.find(tab => tab.document === document);
    if (tab) {
      tab.path = document.path;
      tab.name = document.title;
      tab.content = document.source;
      tab.dirty = document.dirty;
      tab.rev = document.revision;
    }
    if (activeDocument === document) {
      window.StuartAIService?.setDocument(document);
      state.path = document.path;
      state.name = document.title;
      state.content = document.source;
      state.dirty = document.dirty;
      if (el.source.value !== document.buffer.editorText) el.source.value = document.source;
      el.dirtyDot.hidden = !document.dirty;
      el.fileTitle.textContent = document.title;
      el.statusPath.textContent = document.path || "未保存文档";
      updateWindowTitle();
      updateAutosaveStatus();
    }
    renderTabs();
  }

  function patchTabDirtyUi() {
    const list = $("#tab-list");
    if (!list) return;
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id = item.dataset.tabId;
      const tab = state.tabs.find((t) => String(t.id) === id);
      const dirty = !!(tab && tab.dirty);
      const dirtyEl = item.querySelector(".tab-dirty");
      if (dirty && !dirtyEl) {
        const d = document.createElement("span");
        d.className = "tab-dirty";
        d.title = "未保存";
        const closeBtn = item.querySelector(".tab-close");
        if (closeBtn) item.insertBefore(d, closeBtn);
        else item.appendChild(d);
      } else if (!dirty && dirtyEl) {
        dirtyEl.remove();
      }
      item.classList.toggle("active", String(state.activeTabId) === id);
    }
  }

  function setContent(text, fromUser) {
    const prevVal = activeDocument?.source ?? el.source.value;
    const changed = prevVal !== text;
    if (changed) el.source.value = text;
    if (activeDocument && fromUser) activeDocument.updateEditor(String(text).replace(/\r\n|\r/g, "\n"));
    state.content = activeDocument?.source ?? text;
    if (fromUser) {
      // Snapshot the pre-change state immediately so undo can restore inserts
      if (changed && _hist.stack.length && _hist.stack[_hist.i] !== prevVal) {
        clearTimeout(_histDebounce);
        pushHistory(prevVal);
      }
      if (!_hist.stack.length) resetHistory(prevVal || "");
      schedulePushHistory(activeDocument?.source ?? text);
      markDirty();
      scheduleAutoSave();
    }
    updateStats();
    if (changed || fromUser) scheduleRender();
    if (changed) emitAgentEvent("document-changed", { fromUser: !!fromUser });
  }

  // Ctrl+Z 撤销，Ctrl+Shift+Z 和 Ctrl+Y 重做。
  const _hist = { stack: [], i: -1, max: 100, maxBytes: 4 * 1024 * 1024 };
  let _histDebounce = 0;

  function histTotalBytes(stack) {
    let n = 0;
    for (let i = 0; i < stack.length; i++) n += (stack[i] && stack[i].length) || 0;
    return n;
  }

  function pushHistory(text) {
    if (_hist.i >= 0 && _hist.stack[_hist.i] === text) return;
    _hist.stack = _hist.stack.slice(0, _hist.i + 1);
    _hist.stack.push(text);
    while (_hist.stack.length > 2) {
      if (_hist.stack.length <= _hist.max && histTotalBytes(_hist.stack) <= _hist.maxBytes) break;
      _hist.stack.shift();
    }
    _hist.i = _hist.stack.length - 1;
  }

  function schedulePushHistory(text) {
    clearTimeout(_histDebounce);
    _histDebounce = setTimeout(() => pushHistory(text), 280);
  }

  function flushHistory() {
    clearTimeout(_histDebounce);
    pushHistory(activeDocument?.source ?? el.source.value ?? "");
  }

  function resetHistory(text) {
    clearTimeout(_histDebounce);
    _hist.stack = [text || ""];
    _hist.i = 0;
  }

  /** Commit any in-flight block/source edit so new content enters the undo stack. */
  function commitActiveEditsForHistory() {
    $$(".md-block.editing", el.preview).forEach((n) => {
      if (typeof n._stuartCommit === "function") n._stuartCommit();
      const ta = n.querySelector("textarea.md-block-source");
      if (ta && typeof ta._stuartCommit === "function") ta._stuartCommit();
    });
  }

  /** Explicitly commit active block edits and sync content to source before saving/actions. */
  function commitActiveBlockEdits() {
    if (typeof commitActiveEditsForHistory === "function") {
      commitActiveEditsForHistory();
    }
    const activeBlock = el.preview?.querySelector(".md-block.editing, [contenteditable='true']");
    if (activeBlock) {
      if (typeof activeBlock._stuartCommit === "function") {
        activeBlock._stuartCommit();
      }
      const ta = activeBlock.querySelector("textarea.md-block-source");
      if (ta && typeof ta._stuartCommit === "function") {
        ta._stuartCommit();
      }
    }
  }

  function applyHistoryText(text) {
    clearTimeout(_histDebounce);
    el.source.value = text;
    state.content = text;
    activeDocument?.updateSource(text);
    // Force a clean preview rebuild (avoid incremental skip on insert undo)
    lastPreviewSource = "";
    lastPreviewBlocks = [];
    if (state.mode !== "source") {
      try {
        el.preview.innerHTML = "";
      } catch (_) {}
      renderMarkdown(text);
      lastPreviewSource = text;
    }
    updateStatsNow();
    markDirty();
    scheduleAutoSave();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) {
      tab.content = text;
      tab.dirty = true;
    }
  }

  function undoEdit() {
    commitActiveEditsForHistory();
    flushHistory();
    if (_hist.i <= 0) return false;
    _hist.i--;
    applyHistoryText(_hist.stack[_hist.i]);
    return true;
  }

  function redoEdit() {
    commitActiveEditsForHistory();
    flushHistory();
    if (_hist.i >= _hist.stack.length - 1) return false;
    _hist.i++;
    applyHistoryText(_hist.stack[_hist.i]);
    return true;
  }

  // ---------- Auto-save ----------
  async function saveCapturedDocument(document, snapshot, targetPath, targetRevision) {
    if (snapshot.documentId !== document.documentId || snapshot.revision > document.revision) throw new Error("保存快照与实际文档身份或编辑版本不一致");
    if (document.kind !== "markdown") throw new Error("当前保存入口仅接受 Markdown 文档");
    if (document.journalRevision < snapshot.revision) await queueDraftSnapshot(document, snapshot);
    await pendingJournals.get(document.documentId);
    return enqueueWrite(`document:${document.documentId}`, () => enqueueWrite(targetPath, async () => {
      const sourceEdits = window.StuartCore.editsBetween(document.persistedSource, snapshot.source);
      const result = await window.pywebview.api.save_document({
        operationId: crypto.randomUUID(), documentId: snapshot.documentId,
        editorRevision: snapshot.revision, targetPath,
        expectedDiskRevision: targetRevision || document.diskRevision,
        payload: { type: "TextEdits", encoding: snapshot.encoding, bom: snapshot.bom, sourceEdits },
      });
      document.confirmSave(result, snapshot.source);
      if (result.result === "Conflict") {
        clearTimeout(autosaveTimers.get(document.documentId));
        autosaveTimers.delete(document.documentId);
        await window.StuartRecovery.showConflict(document, result, snapshot);
      } else {
        document.path = targetPath;
        document.title = targetPath.split(/[\\/]/).pop();
        syncDocumentState(document);
        if (result.maintenanceError) throw new Error(result.maintenanceError);
      }
      return result;
    }));
  }

  const AUTOSAVE_MS = 1500;
  const autosaveTimers = new Map();

  /** Per-path write queue — prevents autosave vs manual save reordering. */
  function enqueueWrite(path, fn) {
    const coord = globalThis.StuartCore?.writeCoord;
    if (!coord || typeof coord.enqueue !== "function") throw new Error("文档写入协调服务尚未加载");
    return coord.enqueue(path, fn);
  }

  function scheduleAutoSave() {
    if (!state.autosaveEnabled || !activeDocument?.path || activeDocument.conflict || activeDocument.kind !== "markdown") return;
    const document = activeDocument;
    const snapshot = document.snapshot();
    clearTimeout(autosaveTimers.get(document.documentId));
    autosaveTimers.set(document.documentId, setTimeout(() => {
      autosaveTimers.delete(document.documentId);
      doAutoSave(document, snapshot);
    }, AUTOSAVE_MS));
  }

  async function doAutoSave(document, snapshot) {
    if (!document || document.conflict || !document.path || !document.dirty) return;
    if (!state.autosaveEnabled || !state.apiReady) return;
    if (snapshot.revision < document.persistedRevision || snapshot.path !== document.path) return;
    try {
      const res = await saveCapturedDocument(document, snapshot, snapshot.path);
      if (res.result === "Conflict") return;
      state.lastAutosaveAt = Date.now();
      emitAgentEvent("document-saved", { documentId: document.documentId, path: document.path, savedEditorRevision: res.savedEditorRevision });
    } catch (e) {
      toast("自动保存失败：" + (e.message || String(e)));
      throw e;
    }
  }

  function updateAutosaveStatus() {
    const el2 = $("#status-autosave");
    if (!el2) return;
    if (!state.autosaveEnabled) {
      el2.textContent = "自动保存：关闭";
      el2.title = "可在设置中开启自动保存";
      return;
    }
    if (!state.path) {
      el2.textContent = activeDocument?.journalRevision >= activeDocument?.revision ? "草稿已保存 · 原文件待另存为" : "草稿等待保存 · 原文件待另存为";
      el2.title = "使用 Ctrl+Shift+S 选择原文件保存位置";
      return;
    }
    if (activeDocument?.conflict) {
      el2.textContent = "保存冲突 · 自动保存已暂停";
      el2.title = "请检查基础正文、本地正文和实际磁盘正文";
      return;
    }
    if (state.dirty) {
      el2.textContent = activeDocument?.journalRevision >= activeDocument?.revision ? "草稿已保存 · 原文件待保存" : "草稿等待保存 · 原文件待保存";
      el2.title = "草稿确认版本 " + activeDocument.journalRevision + "，当前编辑版本 " + activeDocument.revision;
    } else {
      el2.textContent = "原文件已保存";
      el2.title = `已保存到 ${state.path}`;
    }
  }

  // ---------- Tabs ----------
  function folderOf(path) {
    if (!path) return "";
    const parts = String(path).split(/[\\/]/);
    if (parts.length < 2) return "";
    return parts[parts.length - 2] || "";
  }

  let _folderSetCache = { n: -1, set: new Set() };
  function tabFolderSet() {
    const n = state.tabs.length;
    if (_folderSetCache.n === n) return _folderSetCache.set;
    const set = new Set();
    for (let i = 0; i < n; i++) {
      const f = folderOf(state.tabs[i].path);
      if (f) set.add(f);
    }
    _folderSetCache = { n, set };
    return set;
  }

  function tabTitleFor(tab) {
    if (!tab) return "未命名";
    const folders = tabFolderSet();
    const name = tab.name || "未命名";
    if (folders.size > 1 && tab.path) {
      const f = folderOf(tab.path);
      if (f) return `${f} — ${name}`;
    }
    return name;
  }

  function saveActiveTabFromEditor() {
    // Flush in-flight block edits first — otherwise a contenteditable session
    // is silently dropped when this is called without a prior mousedown commit.
    commitActiveEditsForHistory();
    if (!state.activeTabId) return;
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab || tab.kind === "pdf") return;
    flushHistory();
    tab.content = activeDocument?.source ?? el.source.value;
    tab.document = activeDocument;
    tab.dirty = state.dirty;
    tab.path = state.path;
    tab.name = state.name;
    if (_hist && _hist.stack) {
      tab.history = { stack: [..._hist.stack], i: _hist.i };
    }
  }

  function renderTabs() {
    _folderSetCache = { n: -1, set: new Set() };
    persistSessionSoon();
    const bar = $("#tabbar");
    const list = $("#tab-list");
    if (!bar || !list) return;
    // Always show bar when any tab exists (avoid stuck empty UI)
    const show = state.tabs.length > 0;
    bar.hidden = !show;
    bar.style.display = show ? "flex" : "none";
    if (bar.hidden) return;
    list.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.tabs.forEach((tab) => {
      const item = document.createElement("div");
      item.className = "tab-item" + (tab.id === state.activeTabId ? " active" : "");
      item.dataset.tabId = String(tab.id);
      item.draggable = true;
      item.title = tab.path || tabTitleFor(tab);
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tabTitleFor(tab);
      item.appendChild(label);
      if (tab.dirty) {
        const d = document.createElement("span");
        d.className = "tab-dirty";
        d.title = "未保存";
        item.appendChild(d);
      }
      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.title = "关闭标签";
      close.textContent = "×";
      item.appendChild(close);
      frag.appendChild(item);
    });
    list.appendChild(frag);
  }

  function setTabBarVisible() {
    renderTabs();
  }

  async function detachTabToNewWindow(tabId) {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    saveActiveTabFromEditor();
    if (tab.path) {
      await openInNewWindow(tab.path);
      closeTab(tabId, { skipConfirm: !tab.dirty });
    } else {
      toast("未保存文档请先另存为再拖出");
    }
  }

  let pendingDocumentTransition = Promise.resolve();
  function transitionDocument(operation) {
    const transition = async () => {
      await flushCurrentDocument();
      await window.StuartAIService.flushDraft();
      return operation();
    };
    const next = pendingDocumentTransition.then(transition, transition);
    pendingDocumentTransition = next;
    return next;
  }

  function activateTab(id) {
    return transitionDocument(() => activateTabNow(id));
  }

  function activateTabNow(id) {
    if (state.activeTabId === id) {
      renderTabs();
      updatePinUi();
      return;
    }
    commitActiveBlockEdits();
    saveActiveTabFromEditor();
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    state.activeTabId = id;
    setDocument({
      path: tab.path,
      name: tab.name,
      content: tab.content,
      kind: tab.kind,
      b64: tab.b64,
      annotations: tab.annotations,
      document: tab.document,
    });
    if (tab.history && tab.history.stack && tab.history.stack.length > 0) {
      clearTimeout(_histDebounce);
      _hist.stack = [...tab.history.stack];
      _hist.i = tab.history.i;
    } else {
      resetHistory(tab.content || "");
    }
    state.dirty = !!tab.dirty;
    el.dirtyDot.hidden = !tab.dirty;
    renderTabs();
    updatePinUi();
  }

  function addOrFocusTab(payload) {
    return transitionDocument(() => addOrFocusTabNow(payload));
  }

  async function addOrFocusTabNow(payload) {
    saveActiveTabFromEditor();
    if (!payload.documentId && !payload.document && state.apiReady) {
      const registered = payload.path ? await window.pywebview.api.document_read(payload.path) : await window.pywebview.api.document_new();
      payload = { ...registered, ...payload, documentId: registered.documentId, diskRevision: registered.diskRevision, encoding: registered.encoding, bom: registered.bom };
    }
    const path = payload.path || null;
    const sameDocument = state.tabs.find(tab => tab.document.documentId === (payload.document?.documentId || payload.documentId));
    if (sameDocument) {
      activateTabNow(sameDocument.id);
      return sameDocument.id;
    }
    if (path && !payload.restored) {
      const exist = state.tabs.find((t) => t.path === path);
      if (exist) {
        if (payload.documentId && payload.documentId !== exist.document.documentId) await window.pywebview.api.document_release(payload.documentId);
        activateTabNow(exist.id);
        return exist.id;
      }
    }
    const id = state.tabSeq++;
    const document = payload.document || new window.StuartCore.DocumentSession(payload);
    if (!path && payload.source === "" && payload.content) {
      document.updateSource(payload.content);
      await queueDraftSnapshot(document, document.snapshot());
    }
    const tab = {
      id,
      path,
      name: document.title,
      content: document.source,
      dirty: document.dirty,
      kind: payload.kind || "markdown",
      b64: payload.b64,
      annotations: payload.annotations || [],
      pinned: !!payload.pinned,
      rev: document.revision,
      history: { stack: [document.source], i: 0 },
      document,
    };
    state.tabs.push(tab);
    state.activeTabId = id;
    setDocument({ ...payload, document: tab.document });
    renderTabs();
    updatePinUi();
    return id;
  }

  function closeTab(id, opts = {}) {
    return transitionDocument(() => closeTabNow(id, opts));
  }

  async function closeTabNow(id, opts = {}) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    if (!opts.skipConfirm && tab.dirty) {
      const ok = confirm(`「${tabTitleFor(tab)}」有未保存修改，确定关闭？`);
      if (!ok) return;
    }
    await window.StuartAIService.releaseDocument(tab.document.documentId);
    await window.StuartMDPdf.releaseDocument(tab.document.documentId);
    await window.pywebview.api.document_release(tab.document.documentId);
    // Closing the welcome/sample marks it dismissed → next cold start shows home
    if (tab.welcome || isWelcomeOrSamplePath(tab.path, tab.name) || tab.name === "欢迎使用 StuartMD.md") {
      state.sampleDismissed = true;
    }
    state.tabs.splice(idx, 1);
    if (state.activeTabId === id) {
      const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
      if (next) {
        state.activeTabId = next.id;
        setDocument({
          path: next.path,
          name: next.name,
          content: next.content,
          kind: next.kind,
          b64: next.b64,
          annotations: next.annotations,
          document: next.document,
        });
        if (next.history && next.history.stack && next.history.stack.length > 0) {
          clearTimeout(_histDebounce);
          _hist.stack = [...next.history.stack];
          _hist.i = next.history.i;
        } else {
          resetHistory(next.content || "");
        }
        state.dirty = !!next.dirty;
        el.dirtyDot.hidden = !next.dirty;
      } else {
        state.activeTabId = null;
        activeDocument = null;
        state._selCache = null;
        state.path = null;
        state.name = "未命名.md";
        state.content = "";
        state.dirty = false;
        el.dirtyDot.hidden = true;
        el.editorArea.hidden = true;
        const pdf = $("#pdf-area");
        if (pdf) pdf.hidden = true;
        el.welcome.hidden = false;
      }
    }
    renderTabs();
    persistSession();
  }

  let _sessionPersistTimer = 0;
  function persistSessionSoon() {
    clearTimeout(_sessionPersistTimer);
    _sessionPersistTimer = setTimeout(() => persistSession(), 900);
  }

  /** Persist open tabs + folder + sample-dismiss flag for next cold start. */
  function persistSession() {
    if (!state.apiReady || !window.pywebview?.api?.save_settings) return;
    const tabs = [];
    const seen = new Set();
    state.tabs.forEach((t) => {
      const p = t.path || null;
      if (!p || seen.has(p)) return;
      seen.add(p);
      tabs.push({ path: p, documentId: t.document.documentId, pinned: !!t.pinned });
    });
    window.pywebview.api
      .save_settings({
        session: {
          tabs,
          active_path: state.path || "",
        },
        last_open_files: tabs.map(tab => tab.path),
        last_folder: state.folder || "",
        sample_dismissed: !!state.sampleDismissed,
      })
      .catch(() => {});
    // Remember windowed / fullscreen + geometry
    try {
      window.pywebview.api.capture_window?.()?.catch?.(() => {});
    } catch (_) {}
  }

  function hideBootSplash() {
    const b = $("#boot-splash");
    if (b) b.hidden = true;
  }

  function showHomePage() {
    el.welcome.hidden = false;
    el.editorArea.hidden = true;
    const pdf = $("#pdf-area");
    if (pdf) pdf.hidden = true;
    hideBootSplash();
  }

  async function openSampleDirect() {
    // First-run path: open sample immediately — never flash the home card first
    if (window.pywebview?.api?.open_welcome) {
      const welcome = await window.pywebview.api.open_welcome();
      if (welcome && !welcome.error) {
        state.isSampleDoc = true;
        state.sampleDismissed = false;
        await addOrFocusTab(welcome);
        hideBootSplash();
        persistSession();
        return true;
      }
    }
    // Welcome content comes from samples/欢迎使用 StuartMD.md (backend open_welcome)
    toast("无法读取示例文档，请检查安装目录 samples");
    hideBootSplash();
    return false;
  }

  async function restoreSessionTabs(session) {
    const entries = (session && Array.isArray(session.tabs) ? session.tabs : []).map(entry => typeof entry === "string" ? { path: entry } : entry).filter(entry => typeof entry?.path === "string" && entry.path);
    if (!entries.length) return false;
    let restored = 0;
    for (const entry of entries) {
      const p = entry.path;
      try {
        if (window.pywebview.api.file_exists) {
          const ex = await window.pywebview.api.file_exists(p);
          if (ex === false) continue;
        }
        const res = await window.pywebview.api.open_path(p);
        if (!res || res.error || res.kind === "folder") continue;
        if (res.b64 || res.content != null) {
          await addOrFocusTab({ ...res, pinned: !!entry.pinned });
          restored++;
        }
      } catch (error) { toast("恢复已打开文档失败：" + (error.message || String(error))); throw error; }
    }
    if (!restored) return false;
    const activePath = (session && session.active_path) || "";
    if (activePath) {
      const tab = state.tabs.find((t) => t.path === activePath);
      if (tab) await activateTab(tab.id);
    }
    hideBootSplash();
    persistSession();
    return true;
  }

  function bindTabBar() {
    const bar = $("#tabbar");
    const list = $("#tab-list");
    if (!bar || !list || bar.dataset.bound === "1") return;
    bar.dataset.bound = "1";
    // Delegated click / close / drag — avoid per-tab listeners on every rebuild
    if (list.dataset.delegated !== "1") {
      list.dataset.delegated = "1";
      list.addEventListener("click", (e) => {
        const close = e.target.closest(".tab-close");
        const item = e.target.closest(".tab-item");
        if (!item) return;
        const id = Number(item.dataset.tabId);
        if (!Number.isFinite(id)) return;
        if (close) {
          e.stopPropagation();
          closeTab(id);
          return;
        }
        activateTab(id);
      });
      list.addEventListener("dragstart", (e) => {
        const item = e.target.closest(".tab-item");
        if (!item) return;
        item.classList.add("dragging");
        const id = item.dataset.tabId;
        const tab = state.tabs.find((t) => String(t.id) === id);
        e.dataTransfer.setData("text/stuart-tab", String(id));
        e.dataTransfer.setData("text/plain", (tab && (tab.path || tab.name)) || "");
        e.dataTransfer.effectAllowed = "move";
      });
      list.addEventListener("dragend", (e) => {
        const item = e.target.closest(".tab-item");
        if (item) item.classList.remove("dragging");
      });
    }
    bar.addEventListener("dragover", (e) => {
      if (e.dataTransfer.types.includes("text/stuart-tab") || e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        bar.classList.add("drag-over");
      }
    });
    bar.addEventListener("dragleave", () => bar.classList.remove("drag-over"));
    bar.addEventListener("drop", async (e) => {
      bar.classList.remove("drag-over");
      e.preventDefault();
      // Detach from another window: path text/plain
      const tabId = e.dataTransfer.getData("text/stuart-tab");
      if (tabId) {
        // same-window reorder could go here
        return;
      }
      const path = e.dataTransfer.getData("text/plain");
      if (path && path.match(/\.(md|markdown|txt|pdf)$/i)) {
        await openDocumentSmart(path, { forceTab: true });
      }
    });
    // drag tab out of window → new window
    bar.addEventListener("dragend", async (e) => {
      const el = e.target.closest?.(".tab-item");
      if (!el) return;
      // if dropped outside browser, dragend still fires; approximate detach via alt or path
    });
    // Use window-level: when drag leaves tabbar with tab data, detach
    let pendingDetach = null;
    bar.addEventListener("dragstart", (e) => {
      const id = e.dataTransfer.getData("text/stuart-tab");
      if (id) pendingDetach = Number(id);
    });
    document.addEventListener("dragover", (e) => {
      if (pendingDetach && !e.target.closest("#tabbar")) {
        e.dataTransfer.dropEffect = "move";
        e.preventDefault();
      }
    });
    document.addEventListener("drop", async (e) => {
      if (pendingDetach && !e.target.closest("#tabbar")) {
        e.preventDefault();
        const id = pendingDetach;
        pendingDetach = null;
        await detachTabToNewWindow(id);
      }
    });
    const btnNew = $("#btn-tab-new");
    if (btnNew) {
      btnNew.addEventListener("click", async () => {
        const id = await addOrFocusTab({
          path: null,
          name: "未命名.md",
          content: "# 未命名文档\n\n开始书写…\n",
        });
        state.activeTabId = id;
        renderTabs();
      });
    }
  }

  const CorePaths = () => (window.StuartCore && window.StuartCore.paths) || null;
  const CoreDoc = () => (window.StuartCore && window.StuartCore.docStats) || null;
  const CoreSettings = () => (window.StuartCore && window.StuartCore.settings) || null;

  function isWelcomeOrSamplePath(path, name) {
    const core = CorePaths();
    if (core) return core.isWelcomeOrSamplePath(path, name);
    // Fallback (kept for browser without core script)
    const p = String(path || "").toLowerCase().replace(/\//g, "\\");
    const n = String(name || "");
    if (n === "欢迎使用 StuartMD.md" || n === "示例文档.md") return true;
    if (!path && n && n.includes("欢迎")) return true;
    if (p.includes("\\samples\\") || p.endsWith("\\samples")) {
      if (n.includes("示例") || n.includes("欢迎") || n.includes("sample")) {
        return true;
      }
    }
    return false;
  }

  function hasRealDocument() {
    const core = CorePaths();
    if (core) return core.hasRealDocument(state.tabs, state.path, state.name);
    return state.tabs.some(
      (t) => t.path && !isWelcomeOrSamplePath(t.path, t.name)
    ) || (!!state.path && !isWelcomeOrSamplePath(state.path, state.name));
  }

  function parentDir(p) {
    const core = CorePaths();
    if (core) return core.parentDir(p);
    if (!p) return "";
    const parts = String(p).split(/[\\/]/);
    parts.pop();
    return parts.join("\\");
  }

  function pathEqualsOrUnder(child, root) {
    const core = CorePaths();
    if (core) return core.pathEqualsOrUnder(child, root);
    if (!child || !root) return false;
    const c = String(child).replace(/\//g, "\\").toLowerCase();
    const r = String(root).replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
    return c === r || c.startsWith(r + "\\");
  }

  function workspaceRoot() {
    const core = CorePaths();
    if (core) return core.workspaceRootFrom(state);
    if (state.workspaceRoot) return state.workspaceRoot;
    if (state.folder) return state.folder;
    const real = state.tabs.find((t) => t.path && !isWelcomeOrSamplePath(t.path, t.name));
    const src = real || (state.path && !isWelcomeOrSamplePath(state.path, state.name) ? { path: state.path } : null);
    if (src?.path) return parentDir(src.path);
    return "";
  }

  function setWorkspaceFromPath(path) {
    if (state.folder && pathEqualsOrUnder(path, state.folder)) state.workspaceRoot = state.folder;
    else if (!state.workspaceRoot || !pathEqualsOrUnder(path, state.workspaceRoot)) state.workspaceRoot = "";
  }

  /**
   * Smart open:
   * - empty window / only welcome-sample → current window
   * - path under workspace folder tree → current window tab
   * - otherwise → new window (unless forceTab / source=tree)
   */
  async function openDocumentSmart(pathOrPayload, opts = {}) {
    const fromTree = !!opts.fromTree;
    const forceTab = !!opts.forceTab;
    const beginOpen = () => {
      state._openSeq = (state._openSeq || 0) + 1;
      return state._openSeq;
    };
    const isStale = (seq) => seq !== state._openSeq;

    if (fromTree || forceTab) {
      let payload = pathOrPayload;
      if (typeof payload === "string") {
        if (!state.apiReady) return;
        const seq = beginOpen();
        payload = await window.pywebview.api.read_file(payload);
        if (isStale(seq)) { if (payload?.documentId) await window.pywebview.api.document_release(payload.documentId); return; }
        if (payload?.error) {
          toast(payload.error);
          return;
        }
      }
      await openFromSidebar(payload);
      await refreshRecents();
      return;
    }

    if (state.openMode === "new_window") {
      const path = typeof pathOrPayload === "string" ? pathOrPayload : pathOrPayload?.path;
      if (path) {
        await openInNewWindow(path);
        await refreshRecents();
        return;
      }
    }

    let payload = pathOrPayload;
    if (typeof payload === "string") {
      if (!state.apiReady) return;
      const seq = beginOpen();
      payload = await window.pywebview.api.read_file(payload);
      if (isStale(seq)) { if (payload?.documentId) await window.pywebview.api.document_release(payload.documentId); return; }
    }
    if (payload?.error) {
      toast(payload.error);
      return;
    }

    const path = payload.path || "";
    const sample = isWelcomeOrSamplePath(path, payload.name) || payload.welcome;
    const root = workspaceRoot();
    const underWorkspace = path && pathEqualsOrUnder(path, root);
    const noReal = !hasRealDocument();

    if (sample || noReal || !root || underWorkspace || state.openMode === "current_window") {
      await addOrFocusTab(payload);
      if (path && !sample) setWorkspaceFromPath(path);
      await refreshRecents();
      return;
    }

    // Outside workspace with real docs open → new window
    await openInNewWindow(path);
    if (payload.documentId) await window.pywebview.api.document_release(payload.documentId);
    await refreshRecents();
  }

  /** Sidebar open: replace unpinned current tab; add tab if current is pinned. */
  function openFromSidebar(payload) {
    return transitionDocument(() => openFromSidebarNow(payload));
  }

  async function openFromSidebarNow(payload) {
    if (!payload || payload.error) {
      if (payload?.error) toast(payload.error);
      return;
    }
    const path = payload.path || null;
    // Focus existing tab for same path
    if (path) {
      const exist = state.tabs.find((t) => t.path === path);
      if (exist) {
        if (payload.documentId && payload.documentId !== exist.document.documentId) await window.pywebview.api.document_release(payload.documentId);
        activateTabNow(exist.id);
        renderTabs();
        updatePinUi();
        return exist.id;
      }
    }
    const active = state.tabs.find((t) => t.id === state.activeTabId);

    // Unpinned current document → replace in place (no extra tab)
    const shouldReplace = state.tabs.length > 0 && active && !active.pinned;

    if (shouldReplace) {
      saveActiveTabFromEditor();
      if (active.dirty) {
        const ok = confirm(`「${tabTitleFor(active)}」有未保存修改，用新文件替换？`);
        if (!ok) { if (payload.documentId) await window.pywebview.api.document_release(payload.documentId); return; }
      }
      await window.StuartAIService.releaseDocument(active.document.documentId);
      await window.StuartMDPdf.releaseDocument(active.document.documentId);
      await window.pywebview.api.document_release(active.document.documentId);
      active.document = payload.document || new window.StuartCore.DocumentSession(payload);
      active.rev = active.document.revision;
      active.history = { stack: [active.document.source], i: 0 };
      active.path = path;
      active.name = payload.name || "未命名.md";
      active.content = payload.content || "";
      active.kind = payload.kind || "markdown";
      active.b64 = payload.b64;
      active.annotations = payload.annotations || [];
      active.dirty = false;
      active.pinned = false;
      state.activeTabId = active.id;
      setDocument({ ...payload, document: active.document });
      renderTabs();
      updatePinUi();
      return active.id;
    }

    const id = await addOrFocusTabNow(payload);
    updatePinUi();
    return id;
  }

  function togglePinActive() {
    let tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab && (state.path || state.content)) {
      tab = {
        id: state.tabSeq++,
        path: state.path,
        name: state.name,
        content: state.content,
        dirty: state.dirty,
        kind: "markdown",
        pinned: false,
      };
      state.tabs.push(tab);
      state.activeTabId = tab.id;
      renderTabs();
    }
    if (!tab) {
      toast("请先打开文档");
      return;
    }
    if (!tab.path && !tab.pinned) {
      toast("未保存文档请先另存为再固定");
      return;
    }
    tab.pinned = !tab.pinned;
    // keep state in sync if this is the active view
    if (state.activeTabId === tab.id) {
      state.pinned = tab.pinned;
    }
    renderTabs();
    updatePinUi();
    toast(tab.pinned ? "已固定到标签页" : "已取消固定");
  }

  function updatePinUi() {
    const btn = document.getElementById("btn-pin");
    if (!btn) return;
    const editorVisible = !el.editorArea.hidden || !el.welcome.hidden;
    btn.style.display = editorVisible ? "" : "none";
    let tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab && state.path) {
      tab = { path: state.path, pinned: false };
    }
    const pinned = !!(tab && tab.pinned);
    btn.classList.toggle("pinned", pinned);
    btn.setAttribute("aria-pressed", pinned ? "true" : "false");
    btn.title = pinned ? "已固定（点击取消）" : "未固定（点击固定到标签页）";
  }

  async function openFile(path, opts = {}) {
    if (!state.apiReady) {
      toast("桌面桥接尚未就绪");
      return;
    }
    try {
      await openDocumentSmart(path, opts);
    } catch (err) {
      console.error("openFile failed", path, err);
      toast("打开失败：" + (err && err.message ? err.message : err));
    }
  }

  async function openInNewWindow(path) {
    if (!state.apiReady || !window.pywebview?.api?.open_in_new_window) {
      toast("多窗口需要桌面版");
      return;
    }
    const res = await window.pywebview.api.open_in_new_window(path || state.path);
    if (res?.error) toast(res.error);
    else toast(res.kind === "folder" ? "已在新窗口打开文件夹" : "已在新窗口打开");
  }

  async function openFileDialog() {
    if (!state.apiReady) return;
    const res = await window.pywebview.api.open_file_dialog();
    if (!res) return;
    await openDocumentSmart(res, { fromTree: false });
  }

  async function saveFile() {
    if (!state.apiReady) return;
    commitActiveBlockEdits();
    if (!activeDocument || activeDocument.kind !== "markdown") throw new Error("请在 Markdown 文档中执行保存");
    const document = activeDocument;
    const snapshot = document.snapshot();
    if (snapshot.path) {
      const res = await saveCapturedDocument(document, snapshot, snapshot.path);
      if (res.result === "Conflict") return;
      toast(document.dirty ? "捕获版本已保存，当前正文继续保持待保存状态" : "原文件已保存");
    } else {
      await saveFileAs();
    }
  }

  async function saveFileAs() {
    if (!state.apiReady) return;
    commitActiveBlockEdits();
    if (!activeDocument || activeDocument.kind !== "markdown") throw new Error("请在 Markdown 文档中执行另存为");
    const document = activeDocument;
    const snapshot = document.snapshot();
    const targetPath = await window.pywebview.api.choose_save_path(document.title);
    if (!targetPath) return;
    const targetRevision = await window.pywebview.api.document_target_revision(targetPath);
    if (targetRevision.exists && targetPath !== document.path && !confirm("目标文件已经存在，确认保存当前正文覆盖该文件？")) return;
    const res = await saveCapturedDocument(document, snapshot, targetPath, targetRevision);
    if (res.result === "Conflict") return;
    toast(document.dirty ? "捕获版本已另存为，当前正文继续保持待保存状态" : "已保存为：" + document.title);
    await refreshRecents();
    if (state.folder) await loadFolder(state.folder);
  }

  async function newDocument() {
    // Always a new tab (or setting: new window)
    if (state.newDocMode === "new_window" && state.apiReady && window.pywebview?.api?.open_new_window) {
      const res = await window.pywebview.api.open_new_window();
      if (res?.error) toast(res.error);
      return;
    }
    const id = await addOrFocusTab({
      path: null,
      name: "未命名.md",
      content: "# 未命名文档\n\n开始书写…\n",
    });
    setMode("preview");
    renderTabs();
    updatePinUi();
    return id;
  }

  async function openSample() {
    // Always open sample in current window; keep folder tree
    if (state.dirty) {
      const ok = confirm("当前文档有未保存修改，确定丢弃并打开示例？");
      if (!ok) return;
    }
    if (!state.apiReady) {
      toast("应用尚未就绪，请稍候再试");
      return;
    }
    const res = await window.pywebview.api.open_sample();
    if (res?.error) {
      toast(res.error);
      return;
    }
    state.isSampleDoc = true;
    state.sampleDismissed = false;
    if (state.openMode === "current_window" || state.tabs.length) {
      await addOrFocusTab(res);
    } else {
      setDocument(res);
    }
    setMode("preview");
    await refreshRecents();
    persistSession();
  }

  // ---------- Folder tree ----------
  async function openFolder() {
    if (!state.apiReady) return;
    const path = await window.pywebview.api.open_folder_dialog();
    if (!path) return;
    await loadFolder(path);
    toast("已打开文件夹");
  }

  async function loadFolder(path) {
    if (!state.apiReady || !path) return;
    const res = await window.pywebview.api.read_dir_tree(path);
    if (res?.error) {
      toast(res.error);
      // Stale last_folder from an older install/machine
      try {
        await window.pywebview.api.save_settings({ last_folder: "" });
      } catch (_) {}
      el.folderName.textContent = "最近 / 欢迎";
      el.fileTree.innerHTML = `<div class="empty-hint">目录不可用，请重新打开文件夹</div>`;
      return;
    }
    state.folder = res.path;
    state.workspaceRoot = res.path;
    await window.pywebview.api.rag_set_workspace(res.path);
    await window.StuartAIService.setWorkspace(res.path);
    window.dispatchEvent(new CustomEvent("stuart-workspace-changed", { detail: { workspaceRoot: res.path } }));
    el.folderName.textContent = res.name || res.path;
    el.folderName.title = res.path;
    renderTree(res.items || [], el.fileTree, 0);
    toggleSidebar(true);
    showSidebarPanel("files");
    persistSession();
  }

  function bindTreeDelegates() {
    if (el.fileTree.dataset.delegated === "1") return;
    el.fileTree.dataset.delegated = "1";

    el.fileTree.addEventListener("click", (e) => {
      const dir = e.target.closest(".tree-item.dir");
      if (dir) {
        const kids = dir.nextElementSibling;
        if (kids && kids.classList.contains("tree-children")) {
          const open = kids.classList.toggle("open");
          dir.classList.toggle("expanded", open);
        }
        return;
      }
      const file = e.target.closest(".tree-item.file");
      if (!file) return;
      const path = file.dataset.path || "";
      if (!path) {
        toast("无效的文件路径");
        return;
      }
      if (e.ctrlKey || e.metaKey || e.button === 1) {
        e.preventDefault();
        openInNewWindow(path);
        return;
      }
      openFile(path, { fromTree: true }).catch((err) => {
        toast("打开失败：" + (err && err.message ? err.message : err));
      });
    });

    el.fileTree.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      const file = e.target.closest(".tree-item.file");
      if (!file) return;
      e.preventDefault();
      openInNewWindow(file.dataset.path || "");
    });

    el.fileTree.addEventListener("contextmenu", (e) => {
      const file = e.target.closest(".tree-item.file");
      if (!file) return;
      e.preventDefault();
      openInNewWindow(file.dataset.path || "");
    });
  }

  function renderTree(items, container, depth) {
    container.innerHTML = "";
    if (!items.length) {
      container.innerHTML = `<div class="empty-hint">目录中没有 Markdown 文件</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    const walk = (list, d, parent) => {
      const local = document.createDocumentFragment();
      list.forEach((item) => {
        if (item.type === "dir") {
          const row = document.createElement("div");
          row.className = "tree-item dir";
          row.style.paddingLeft = `${8 + d * 14}px`;
          row.innerHTML = `<span class="chev">›</span><span class="name"></span>`;
          row.querySelector(".name").textContent = item.name;
          const kids = document.createElement("div");
          kids.className = "tree-children";
          if (item.children?.length) walk(item.children, d + 1, kids);
          local.appendChild(row);
          local.appendChild(kids);
        } else {
          const row = document.createElement("div");
          row.className = "tree-item file";
          row.dataset.path = item.path || "";
          row.style.paddingLeft = `${8 + d * 14 + 14}px`;
          row.textContent = item.name;
          row.title = `${item.path}（中键或右键：新窗口打开）`;
          local.appendChild(row);
        }
      });
      parent.appendChild(local);
    };
    walk(items, depth, frag);
    container.appendChild(frag);
  }

  function markActiveTreeItem() {
    // P0: skip full tree walk when active path is unchanged
    if (state.path === lastTreePath) return;
    const prev = lastTreePath;
    lastTreePath = state.path;
    const tree = el.fileTree;
    if (!tree) return;
    // Only touch previous + current nodes
    if (prev) {
      try {
        const old = tree.querySelector(`.tree-item.file[data-path="${CSS.escape(prev)}"]`);
        if (old) old.classList.remove("active");
      } catch (_) {}
    }
    if (state.path) {
      try {
        const cur = tree.querySelector(`.tree-item.file[data-path="${CSS.escape(state.path)}"]`);
        if (cur) cur.classList.add("active");
      } catch (_) {}
    }
  }

  // ---------- Recents ----------
  async function refreshRecents() {
    if (!state.apiReady) return;
    try {
      const recents = await window.pywebview.api.get_recents();
      renderRecents(recents || []);
    } catch (_) {}
  }

  function renderRecents(recents) {
    el.recentList.innerHTML = "";
    if (!recents.length) return;
    const title = document.createElement("div");
    title.className = "recent-title";
    title.textContent = "最近打开";
    el.recentList.appendChild(title);
    const frag = document.createDocumentFragment();
    recents.slice(0, 8).forEach((r) => {
      const btn = document.createElement("button");
      btn.className = "recent-item";
      btn.dataset.path = r.path || "";
      btn.dataset.kind = r.kind || "file";
      btn.innerHTML = `<span></span><span class="path"></span>`;
      const [nameEl, pathEl] = btn.children;
      nameEl.textContent = r.name || r.path;
      pathEl.textContent = r.path;
      frag.appendChild(btn);
    });
    el.recentList.appendChild(frag);
    if (el.recentList.dataset.delegated !== "1") {
      el.recentList.dataset.delegated = "1";
      el.recentList.addEventListener("click", async (e) => {
        const btn = e.target.closest(".recent-item");
        if (!btn || !el.recentList.contains(btn)) return;
        const path = btn.dataset.path || "";
        if (!path) return;
        if (btn.dataset.kind === "folder") {
          await loadFolder(path);
          showSidebarPanel("files");
          toggleSidebar(true);
        } else {
          await openFile(path);
        }
      });
    }
  }

  // ---------- Export ----------
  function buildExportHtml() {
    const title = state.name.replace(/\.(md|markdown|txt)$/i, "");
    const previewHtml = el.preview.innerHTML;
    // Portable export via CDN so math/code styles resolve outside the app
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css" />
<style>
:root { --text:#1f2328; --border:#e6e6e8; --bg:#fff; --bg-soft:#f6f8fa; --accent:#2f6fed; --blockquote:#6a737d; }
body { margin:0; font-family: Georgia, "Songti SC", "Noto Serif SC", serif; color:var(--text); background:#fff; line-height:1.75; }
.wrap { max-width: 860px; margin: 0 auto; padding: 48px 24px 80px; font-size:16px; }
h1,h2,h3,h4,h5,h6 { font-family: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; font-weight:650; line-height:1.3; margin:1.6em 0 .7em; }
h1 { font-size:2em; border-bottom:1px solid var(--border); padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid var(--border); padding-bottom:.25em; }
a { color:var(--accent); text-decoration:none; }
blockquote { margin:1em 0; padding:.2em 1em; border-left:4px solid #d0d0d4; background:var(--bg-soft); color:var(--blockquote); }
code { font-family: Consolas, monospace; font-size:.88em; background:var(--bg-soft); padding:.15em .4em; border-radius:4px; }
pre { background:var(--bg-soft); padding:14px 16px; border-radius:8px; overflow:auto; border:1px solid var(--border); }
pre code { background:transparent; padding:0; }
table { border-collapse:collapse; width:100%; margin:1.2em 0; font-family:"Segoe UI",sans-serif; font-size:14px; }
th,td { border:1px solid var(--border); padding:8px 12px; text-align:left; }
th { background:var(--bg-soft); }
img { max-width:100%; }
hr { border:none; border-top:1px solid var(--border); margin:2em 0; }
</style>
</head>
<body>
<div class="wrap markdown-body">
${previewHtml}
</div>
</body>
</html>`;
  }

  async function exportHtml() {
    if (!state.apiReady) return;
    commitActiveBlockEdits();
    const captured = activeDocument;
    const snapshot = captured.snapshot();
    if (state.mode === "source") setMode("preview");
    renderMarkdown(snapshot.source);
    const rendered = await Promise.all(pendingMermaid);
    const failed = rendered.find(result => result instanceof Error);
    if (failed) throw failed;
    if (activeDocument !== captured || captured.revision !== snapshot.revision) throw new Error("导出准备期间文档已经变化");
    const html = buildExportHtml();
    const base = (state.name || "export").replace(/\.(md|markdown|txt)$/i, "") + ".html";
    const targetPath = await window.pywebview.api.choose_save_path(base);
    if (!targetPath) return;
    const expectedDiskRevision = await window.pywebview.api.document_target_revision(targetPath, snapshot.documentId);
    const res = await window.pywebview.api.export_html({ operationId: crypto.randomUUID(), documentId: snapshot.documentId, editorRevision: snapshot.revision, targetPath, expectedDiskRevision, payload: { type: "HtmlExport", html } });
    if (res.result === "Conflict") { await window.StuartRecovery.showExportConflict(res); return; }
    if (res.result !== "Saved") throw new Error("HTML 导出没有完成保存");
    toast(`已导出：${targetPath}`);
  }

  async function printPreview() {
    commitActiveBlockEdits();
    saveActiveTabFromEditor();
    const captured = activeDocument.snapshot();
    if (state.mode === "source") setMode("preview");
    renderMarkdown(captured.source);
    const rendered = await Promise.all(pendingMermaid);
    if (rendered.some(result => result?.error)) throw new Error("图表渲染失败，打印没有开始");
    if (activeDocument.documentId !== captured.documentId || activeDocument.revision !== captured.revision) throw new Error("准备打印期间文档已经变化");
    const html = buildExportHtml();
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) {
      toast("请允许弹出窗口以打印");
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  }

  // ---------- Find ----------
  function openFind() {
    el.findBar.hidden = false;
    el.findInput.focus();
    el.findInput.select();
  }

  function closeFind() {
    el.findBar.hidden = true;
    const fr = $("#find-folder-results");
    if (fr) {
      fr.hidden = true;
      fr.innerHTML = "";
    }
    clearFindHits();
  }

  function updateFindCount() {
    const elc = $("#find-count");
    if (!elc) return;
    const scope = $("#find-scope")?.value || "file";
    if (scope === "folder") {
      elc.textContent = state._folderHitCount != null ? `${state._folderHitCount} 处` : "";
      return;
    }
    if (!state.findHits || !state.findHits.length) {
      elc.textContent = el.findInput.value ? "无结果" : "";
      return;
    }
    elc.textContent = `${(state.findIndex || 0) + 1} / ${state.findHits.length}`;
  }

  /** Unwrap all find marks without a full re-render when possible. */
  function unwrapFindMarks() {
    const marks = $$(".find-hit", el.preview);
    marks.forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize?.();
    });
  }

  function clearFindHits() {
    unwrapFindMarks();
    state.findHits = [];
    state.findIndex = -1;
    state._folderHitCount = null;
    updateFindCount();
  }

  function findScope() {
    return $("#find-scope")?.value || "file";
  }

  /** Search current preview/source. Reuses existing hits when query unchanged. */
  function doFind(dir = 1) {
    const q = (el.findInput.value || "").trim();
    if (!q) return;
    if (findScope() === "folder") {
      doFolderSearch();
      return;
    }
    const fr = $("#find-folder-results");
    if (fr) {
      fr.hidden = true;
      fr.innerHTML = "";
    }

    if (state.mode === "source") {
      const ta = el.source;
      const text = ta.value;
      const needle = q.toLowerCase();
      let idx;
      if (dir > 0) {
        idx = text.toLowerCase().indexOf(needle, ta.selectionEnd);
        if (idx < 0) idx = text.toLowerCase().indexOf(needle);
      } else {
        idx = text.toLowerCase().lastIndexOf(needle, Math.max(0, ta.selectionStart - 1));
        if (idx < 0) idx = text.toLowerCase().lastIndexOf(needle);
      }
      if (idx >= 0) {
        ta.focus();
        ta.setSelectionRange(idx, idx + q.length);
        const style = getComputedStyle(ta);
        const lineHeight = parseFloat(style.lineHeight) || 22;
        const linesBefore = text.slice(0, idx).split("\n").length;
        ta.scrollTop = Math.max(0, (linesBefore - 3) * lineHeight);
        state.findHits = [];
        state.findIndex = -1;
        const elc = $("#find-count");
        if (elc) elc.textContent = "源码中";
      } else {
        toast("未找到");
      }
      return;
    }

    // Preview: if hits already exist for same query, just navigate
    if (state.findHits && state.findHits.length && state._findQuery === q) {
      findNext(dir);
      return;
    }

    // Fresh search — clear marks first (prevents highlight “growth”)
    unwrapFindMarks();
    state.findHits = [];
    state.findIndex = -1;
    state._findQuery = q;

    // Mark matches in existing DOM (no full re-render → no nested marks)
    const walker = document.createTreeWalker(el.preview, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.parentElement?.closest(".find-hit")) continue;
      nodes.push(n);
    }
    const needle = q.toLowerCase();
    // Collect ranges first, then wrap from end to start so offsets stay valid
    const ranges = [];
    const MAX_FIND_MARKS = 400;
    nodes.forEach((node) => {
      if (ranges.length >= MAX_FIND_MARKS) return;
      const text = node.nodeValue || "";
      const lower = text.toLowerCase();
      let from = 0;
      while (from < lower.length) {
        const i = lower.indexOf(needle, from);
        if (i < 0) break;
        ranges.push({ node, start: i, end: i + q.length });
        if (ranges.length >= MAX_FIND_MARKS) break;
        from = i + q.length;
      }
    });
    ranges.reverse().forEach(({ node, start, end }) => {
      try {
        if (!node.isConnected) return;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, Math.min(end, node.nodeValue.length));
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        range.surroundContents(mark);
        state.findHits.unshift(mark);
      } catch (_) {}
    });

    if (!state.findHits.length) {
      toast("未找到");
      updateFindCount();
      return;
    }
    state.findIndex = dir > 0 ? 0 : state.findHits.length - 1;
    highlightCurrentHit();
    updateFindCount();
  }

  function highlightCurrentHit() {
    (state.findHits || []).forEach((n, i) => n.classList.toggle("current", i === state.findIndex));
    const cur = state.findHits[state.findIndex];
    if (cur) cur.scrollIntoView({ behavior: "smooth", block: "center" });
    updateFindCount();
  }

  function findNext(step) {
    const q = (el.findInput.value || "").trim();
    if (!q) return;
    if (findScope() === "folder") {
      doFolderSearch();
      return;
    }
    if (!state.findHits || !state.findHits.length || state._findQuery !== q) {
      doFind(step);
      return;
    }
    state.findIndex = (state.findIndex + step + state.findHits.length) % state.findHits.length;
    highlightCurrentHit();
  }

  function collectFolderMdFiles(root) {
    const out = [];
    const walk = (items) => {
      (items || []).forEach((it) => {
        if (it.type === "file") {
          const n = (it.name || "").toLowerCase();
          if (n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".txt")) {
            out.push(it.path);
          }
        } else if (it.children) walk(it.children);
      });
    };
    return { walk, out };
  }

  async function doFolderSearch() {
    const q = (el.findInput.value || "").trim();
    const box = $("#find-folder-results");
    if (!q) return;
    if (!state.apiReady || !window.pywebview?.api?.read_dir_tree || !window.pywebview?.api?.read_file) {
      toast("桌面版才支持文件夹搜索");
      return;
    }
    let root = state.folder;
    if (!root && state.path) {
      const parts = String(state.path).split(/[\\/]/);
      parts.pop();
      root = parts.join("\\");
    }
    if (!root) {
      if (box) {
        box.hidden = false;
        box.innerHTML = `<div class="fr-empty">未打开文件夹，请先「打开文件夹」</div>`;
      }
      return;
    }
    if (box) {
      box.hidden = false;
      box.innerHTML = `<div class="fr-empty">正在搜索…</div>`;
    }
    try {
      const seq = (state._findSeq = (state._findSeq || 0) + 1);
      // Prefer backend bounded search when available
      if (window.pywebview.api.search_md) {
        const res = await window.pywebview.api.search_md(root, q, 50);
        if (seq !== state._findSeq) return;
        if (res?.error) {
          if (box) box.innerHTML = `<div class="fr-empty">${escapeHtml(res.error)}</div>`;
          return;
        }
        const hits = (res.hits || []).map((h) => ({
          path: h.path,
          name: h.name,
          line: h.line,
          snippet: String(h.preview || "").slice(0, 80),
        }));
        state._folderHitCount = hits.length;
        updateFindCount();
        if (!box) return;
        if (!hits.length) {
          box.innerHTML = `<div class="fr-empty">同级文件夹中未找到（已扫 ${res.scanned_files || 0} 个文件）</div>`;
          return;
        }
        box.innerHTML = hits
          .map(
            (h, i) =>
              `<button type="button" class="fr-item" data-fr-idx="${i}"><span class="fr-file">${escapeHtml(h.name)}:${h.line}</span>${escapeHtml(h.snippet)}</button>`
          )
          .join("");
        bindFolderHits(box, hits, q);
        return;
      }
      const tree = await window.pywebview.api.read_dir_tree(root);
      if (seq !== state._findSeq) return;
      if (tree?.error) {
        if (box) box.innerHTML = `<div class="fr-empty">${tree.error}</div>`;
        return;
      }
      const files = [];
      const walk = (items) => {
        for (const it of items || []) {
          if (files.length >= 300) return;
          if (it.type === "file") {
            const n = (it.name || "").toLowerCase();
            if (n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".txt")) files.push(it.path);
          } else if (it.children) walk(it.children);
        }
      };
      walk(tree.items);
      const hits = [];
      const lowerQ = q.toLowerCase();
      const MAX_FILES = 80;
      const MAX_HITS = 50;
      const batch = files.slice(0, MAX_FILES);
      const chunk = 8;
      for (let i = 0; i < batch.length && hits.length < MAX_HITS; i += chunk) {
        if (seq !== state._findSeq) return;
        const slice = batch.slice(i, i + chunk);
        const results = await Promise.all(
          slice.map((path) => window.pywebview.api.read_file(path).catch(() => null))
        );
        for (const res of results) {
          if (!res || res.error || res.content == null) continue;
          const content = String(res.content);
          const lines = content.split("\n");
          for (let li = 0; li < lines.length; li++) {
            if (hits.length >= MAX_HITS) break;
            if (lines[li].toLowerCase().includes(lowerQ)) {
              hits.push({
                path: res.path,
                name: res.name || String(res.path).split(/[\\/]/).pop(),
                line: li + 1,
                snippet: lines[li].trim().slice(0, 80),
              });
            }
          }
        }
      }
      if (seq !== state._findSeq) return;
      state._folderHitCount = hits.length;
      updateFindCount();
      if (!box) return;
      if (!hits.length) {
        box.innerHTML = `<div class="fr-empty">同级文件夹中未找到（已扫 ${batch.length}/${files.length} 个文件）</div>`;
        return;
      }
      box.innerHTML = hits
        .map(
          (h, i) =>
            `<button type="button" class="fr-item" data-fr-idx="${i}"><span class="fr-file">${escapeHtml(h.name)}:${h.line}</span>${escapeHtml(h.snippet)}</button>`
        )
        .join("");
      bindFolderHits(box, hits, q);
    } catch (err) {
      if (box) box.innerHTML = `<div class="fr-empty">搜索失败：${escapeHtml(String(err))}</div>`;
    }
  }

  function bindFolderHits(box, hits, q) {
    box.onclick = async (e) => {
      const btn = e.target.closest("[data-fr-idx]");
      if (!btn) return;
      const hit = hits[Number(btn.dataset.frIdx)];
      if (!hit) return;
      if (state.dirty) {
        const ok = confirm("当前文档有未保存修改，确定打开搜索结果文件？");
        if (!ok) return;
      }
      const res = await window.pywebview.api.read_file(hit.path);
      if (res && !res.error && res.content != null) {
        setDocument(res);
        await refreshRecents();
        el.findInput.value = q;
        $("#find-scope").value = "file";
        doFind(1);
      }
    };
  }

  function doReplace() {
    const q = el.findInput.value;
    const r = el.replaceInput.value;
    if (!q) return;
    const ta = el.source;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end);
    if (selected.toLowerCase() === q.toLowerCase()) {
      const next = ta.value.slice(0, start) + r + ta.value.slice(end);
      setContent(next, true);
      ta.focus();
      ta.setSelectionRange(start + r.length, start + r.length);
      clearFindHits();
    } else {
      doFind(1);
    }
  }

  function doReplaceAll() {
    const q = el.findInput.value;
    const r = el.replaceInput.value;
    if (!q) return;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const next = el.source.value.replace(re, r);
    setContent(next, true);
    clearFindHits();
    toast("已全部替换");
  }

  function startFindFromInput(shift) {
    doFind(shift ? -1 : 1);
  }

  // ---------- Insert (context menu) ----------
  function insertMarkdownAtBlock(snippet, place) {
    // place: "below" | "above" | "replace-line"
    const idx = activeBlockIndex();
    const all = splitMarkdownBlocks(el.source.value || "");
    if (place === "above") {
      all.splice(idx, 0, snippet);
    } else if (place === "replace-line") {
      all[idx] = snippet;
    } else {
      all.splice(idx + 1, 0, snippet);
    }
    const joined = joinBlocks(all);
    setContent(joined, true);
    lastPreviewSource = "";
    renderMarkdown(joined);
    lastPreviewSource = joined;
    lastPreviewBlocks = splitMarkdownBlocks(joined);
  }

  function insertInlineMarkdown(pre, post, placeholder) {
    wrapInlineMarkdown(pre, post, placeholder);
  }

  function showInsertMenu(x, y) {
    const menu = $("#insert-menu");
    if (!menu) return;
    menu.innerHTML = `
      <div class="menu-label">插入</div>
      <div class="menu-grid">
        <button type="button" data-ins="image" title="图像 (Ctrl+Shift+I)">${bmIco(`<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.5" ${bmS}/><circle cx="5.6" cy="6.4" r="1.1" ${bmS}/><path d="M3.2 11.2 6.4 8.2l2.2 2 2.1-2.4 2.1 2.6" ${bmS}/>`)}</button>
        <button type="button" data-ins="linkref" title="链接引用">${bmIco(`<path d="M6.2 9.8 9.8 6.2M5.2 7.2 3.9 8.5a2.4 2.4 0 1 0 3.4 3.4l1.3-1.3M10.8 8.8l1.3-1.3a2.4 2.4 0 1 0-3.4-3.4L7.4 5.4" ${bmS}/>`)}</button>
        <button type="button" data-ins="hr" title="水平分割线">${bmIco(`<path d="M2 8h12" ${bmS}/>`)}</button>
        <button type="button" data-ins="table" title="表格 (Ctrl+T)">${bmIco(`<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.3" ${bmS}/><path d="M2.2 6.4h11.6M2.2 9.6h11.6M6.2 3.2v9.6M9.8 3.2v9.6" ${bmS}/>`)}</button>
        <button type="button" data-ins="code" title="代码块 (Ctrl+Shift+K)">${bmIco(`<path d="M5.2 4.2 2.4 8l2.8 3.8M10.8 4.2 13.6 8l-2.8 3.8M9.1 3.4 6.9 12.6" ${bmS}/>`)}</button>
        <button type="button" data-ins="math" title="公式块 (Ctrl+Shift+M)">${bmIco(`<path d="M4 3.2h2.2c1.7 0 2.6 1.2 2.8 2.8L10.2 12c.3 1.4 1 2 2.2 2H14M4.2 6.2h6.2" ${bmS}/>`)}</button>
        <button type="button" data-ins="p-above" title="段落（上方）">${bmIco(`<path d="M8 3.2v9.6M4.8 6.4 8 3.2l3.2 3.2" ${bmS}/>`)}</button>
        <button type="button" data-ins="p-below" title="段落（下方）">${bmIco(`<path d="M8 12.8V3.2M4.8 9.6 8 12.8l3.2-3.2" ${bmS}/>`)}</button>
      </div>
    `;
    menu.hidden = false;
    const w = menu.offsetWidth || 220;
    const h = menu.offsetHeight || 280;
    menu.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x)) + "px";
    menu.style.top = Math.min(window.innerHeight - h - 8, Math.max(8, y)) + "px";
    menu.onclick = (e) => {
      const btn = e.target.closest("[data-ins]");
      if (!btn) return;
      const kind = btn.dataset.ins;
      menu.hidden = true;
      if (kind === "image") {
        const url = prompt("图片地址", "https://");
        if (url) insertInlineMarkdown("![", `](${url})`, "图片描述");
      } else if (kind === "linkref") {
        const url = prompt("链接地址", "https://");
        if (url) insertInlineMarkdown("[", `](${url})`, "链接文字");
      } else if (kind === "hr") {
        insertMarkdownAtBlock("\n---\n", "below");
      } else if (kind === "table") {
        insertMarkdownAtBlock(
          "| 列1 | 列2 | 列3 |\n|------|------|------|\n|  |  |  |\n|  |  |  |",
          "below"
        );
      } else if (kind === "code") {
        insertMarkdownAtBlock("```\n\n```", "below");
      } else if (kind === "math") {
        insertMarkdownAtBlock("$$\n\n$$", "below");
      } else if (kind === "p-above") {
        insertMarkdownAtBlock("", "above");
      } else if (kind === "p-below") {
        insertMarkdownAtBlock("", "below");
      }
    };
  }

  function hideInsertMenu() {
    const m = $("#insert-menu");
    if (m) m.hidden = true;
  }

  // ---------- Sidebar / panels ----------
  function toggleSidebar(force, persist = true) {
    const open = typeof force === "boolean" ? force : !el.sidebar.classList.contains("open");
    el.sidebar.classList.toggle("open", open);
    state.sidebarOpen = open;
    if (persist && state.apiReady && window.pywebview?.api?.save_settings) {
      window.pywebview.api.save_settings({ sidebar: open }).catch(() => {});
    }
  }

  function showSidebarPanel(name) {
    $$(".side-tab").forEach((t) => t.classList.toggle("active", t.dataset.panel === name));
    $$(".side-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2200);
  }

  // ---------- Resizers ----------
  function setupResizers() {
    let dragging = false;

    el.sidebarResizer.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    el.splitResizer.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      el.splitResizer.dataset.side = "split";
    });

    el.sidebarResizer.addEventListener("mousedown", () => {
      el.splitResizer.dataset.side = "";
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      if (el.splitResizer.dataset.side === "split") {
        // Split: preview left, source right — size source from the right edge
        const rect = el.editorArea.getBoundingClientRect();
        const fromRight = rect.right - e.clientX;
        const pct = Math.min(75, Math.max(20, (fromRight / rect.width) * 100));
        el.sourcePane.style.flex = `0 0 ${pct}%`;
      } else {
        const w = Math.min(420, Math.max(180, e.clientX - el.sidebar.getBoundingClientRect().left));
        el.sidebar.style.width = `${w}px`;
        document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
      }
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
      el.splitResizer.dataset.side = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // ---------- Events ----------
  function closeAllMenus() {
    const ids = ["#file-menu", "#more-menu", "#theme-menu", "#music-panel", "#width-menu"];
    const btns = ["#btn-file-menu", "#btn-more-menu", "#btn-theme", "#btn-width"];
    ids.forEach((id) => {
      const n = $(id);
      if (n) n.hidden = true;
    });
    btns.forEach((id) => {
      const n = $(id);
      if (n) n.setAttribute("aria-expanded", "false");
    });
  }

  function toggleMenu(triggerId, menuId) {
    const trigger = $(triggerId);
    const menu = $(menuId);
    if (!trigger || !menu) return;
    const willOpen = menu.hidden;
    closeAllMenus();
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen && menuId === "#theme-menu") {
      $$("#theme-menu [data-theme-choice]").forEach((b) => {
        b.classList.toggle("active-choice", b.dataset.themeChoice === state.theme);
      });
    }
    if (willOpen && menuId === "#width-menu") {
      $$(".width-pick").forEach((b) =>
        b.classList.toggle("active", b.dataset.width === (state.contentWidth || "default"))
      );
    }
  }

  async function runMenuAction(action) {
    closeAllMenus();
    try {
      switch (action) {
        case "new":
          await newDocument();
          break;
        case "open":
          await openFileDialog();
          break;
        case "open-folder":
          await openFolder();
          break;
        case "open-sample":
          await openSample();
          break;
        case "save":
          await saveFile();
          break;
        case "save-as":
          await saveFileAs();
          break;
        case "export-html":
          await exportHtml();
          break;
        case "print":
          printPreview();
          break;
        case "new-window":
          if (state.path) await openInNewWindow(state.path);
          else if (state.apiReady && window.pywebview?.api?.open_new_window) {
            const res = await window.pywebview.api.open_new_window();
            if (res?.error) toast(res.error);
            else toast("已打开新窗口");
          }
          break;
        case "new-empty-window":
          if (state.apiReady && window.pywebview?.api?.open_new_window) {
            const res = await window.pywebview.api.open_new_window();
            if (res?.error) toast(res.error);
            else toast("已打开新窗口");
          }
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`[MenuAction] ${action} failed:`, err);
      toast("操作失败: " + (err?.message || err));
    }
  }

  function bindEvents() {
    $("#btn-sidebar").addEventListener("click", () => toggleSidebar());
    const fileMenuBtn = $("#btn-file-menu");
    if (fileMenuBtn) {
      fileMenuBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu("#btn-file-menu", "#file-menu");
      });
    }
    const moreBtn = $("#btn-more-menu");
    if (moreBtn) {
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMenu("#btn-more-menu", "#more-menu");
      });
    }
    $$("#file-menu .menu-item, #more-menu .menu-item").forEach((item) => {
      item.addEventListener("click", () => runMenuAction(item.dataset.action));
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".menu-wrap")) closeAllMenus();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllMenus();
    });
    $("#btn-find").addEventListener("click", openFind);
    $("#btn-pin")?.addEventListener("click", togglePinActive);
    $("#btn-theme").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("#btn-theme", "#theme-menu");
    });
    $$("#theme-menu [data-theme-choice]").forEach((item) => {
      item.addEventListener("click", () => {
        const theme = item.dataset.themeChoice;
        closeAllMenus();
        if (theme === "wallpaper" && !state.wallpaper?.uri) {
          $("#wallpaper-input")?.click();
          return;
        }
        setTheme(theme);
        toast(`主题：${themeLabel(theme)}`);
      });
    });
    $("#btn-refresh-folder").addEventListener("click", () => {
      if (state.folder) loadFolder(state.folder);
    });
    $("#btn-find-close").addEventListener("click", closeFind);
    $("#btn-find-go")?.addEventListener("click", () => startFindFromInput(false));
    $("#btn-find-next").addEventListener("click", () => findNext(1));
    $("#btn-find-prev").addEventListener("click", () => findNext(-1));
    $("#btn-replace").addEventListener("click", doReplace);
    $("#btn-replace-all").addEventListener("click", doReplaceAll);
    $("#find-scope")?.addEventListener("change", () => {
      clearFindHits();
      const fr = $("#find-folder-results");
      if (fr) {
        fr.hidden = true;
        fr.innerHTML = "";
      }
    });

    el.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Enter = start search if no hits yet; otherwise next hit
        if (state.findHits && state.findHits.length && state._findQuery === el.findInput.value.trim()) {
          findNext(e.shiftKey ? -1 : 1);
        } else {
          startFindFromInput(e.shiftKey);
        }
      } else if (e.key === "Escape") {
        closeFind();
      }
    });
    el.findInput.addEventListener("input", () => {
      clearFindHits();
    });

    $("#w-open").addEventListener("click", openFileDialog);
    $("#w-folder").addEventListener("click", openFolder);
    $("#w-new").addEventListener("click", newDocument);
    $("#w-sample").addEventListener("click", openSample);
    const btnNewWin = $("#btn-new-window");
    if (btnNewWin) {
      btnNewWin.addEventListener("click", async () => {
        if (state.path) await openInNewWindow(state.path);
        else if (state.apiReady && window.pywebview?.api?.open_new_window) {
          const res = await window.pywebview.api.open_new_window();
          if (res?.error) toast(res.error);
          else toast("已打开新窗口");
        }
      });
    }

    $$(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    $$(".side-tab").forEach((tab) => {
      tab.addEventListener("click", () => showSidebarPanel(tab.dataset.panel));
    });

    el.source.addEventListener("input", () => {
      setContent(el.source.value, true);
    });

    // Tab key inserts spaces
    el.source.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = el.source;
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        const v = ta.value;
        ta.value = v.slice(0, s) + "  " + v.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        setContent(ta.value, true);
      }
      // Empty list line: Enter/Delete/Backspace strip marker (exit list).
      // Plain empty line: Enter inserts one blank line; Delete/Backspace removes one.
      if (
        (e.key === "Enter" || e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        el.source.selectionStart === el.source.selectionEnd
      ) {
        const ta = el.source;
        const v = ta.value;
        const pos = ta.selectionStart;
        const lineStart = v.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const lineEnd = (() => {
          const i = v.indexOf("\n", pos);
          return i < 0 ? v.length : i;
        })();
        const line = v.slice(lineStart, lineEnd);
        const emptyList = listMarkerOnly(line);
        const caretAtStart = pos === lineStart;
        const caretAtEnd = pos === lineEnd;
        if (e.key === "Enter" && emptyList) {
          e.preventDefault();
          const stripped = stripListMarker(line);
          ta.value = v.slice(0, lineStart) + stripped + v.slice(lineEnd);
          ta.selectionStart = ta.selectionEnd = lineStart + stripped.length;
          setContent(ta.value, true);
          return;
        }
        // Delete/Backspace on empty list marker: strip marker first (exit list).
        // A second erase on the now-empty plain line deletes that empty line.
        if ((e.key === "Backspace" || e.key === "Delete") && emptyList && (caretAtStart || caretAtEnd)) {
          e.preventDefault();
          const stripped = stripListMarker(line);
          ta.value = v.slice(0, lineStart) + stripped + v.slice(lineEnd);
          ta.selectionStart = ta.selectionEnd = lineStart + stripped.length;
          setContent(ta.value, true);
          return;
        }
        // Plain empty line erase: remove one empty line (normal logic).
        if ((e.key === "Backspace" || e.key === "Delete") && !String(line).trim()) {
          if (e.key === "Backspace" && caretAtStart && lineStart > 0) {
            e.preventDefault();
            const delFrom = lineStart - 1;
            ta.value = v.slice(0, delFrom) + v.slice(lineEnd);
            ta.selectionStart = ta.selectionEnd = delFrom;
            setContent(ta.value, true);
            return;
          }
          if (e.key === "Delete" && caretAtEnd && lineEnd < v.length) {
            e.preventDefault();
            const delTo = lineEnd + 1;
            ta.value = v.slice(0, lineStart) + v.slice(delTo);
            ta.selectionStart = ta.selectionEnd = lineStart;
            setContent(ta.value, true);
            return;
          }
        }
        // Plain empty line Enter: insert another empty line (blank line).
        if (e.key === "Enter" && !String(line).trim()) {
          // Default textarea Enter already inserts a newline (= one more empty
          // line when the current line is empty). Keep default behavior.
        }
      }
      // Ctrl+B bold
      if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        wrapSelection("**", "**");
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        wrapSelection("*", "*");
      }
      handleSourceKeydown(e);
    });

    function isTypingField(target) {
      if (!target) return false;
      const tag = target.tagName ? target.tagName.toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return target !== el.source;
      }
      if (target.isContentEditable && !target.classList.contains("editing") && !el.preview?.contains(target)) {
        return true;
      }
      return false;
    }

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      try {
        if (window.StuartAIUI?.handleShortcutKeydown?.(e)) return;
        // Alt+I — companion sidebar
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "i" || e.key === "I")) {
          e.preventDefault();
          window.StuartCompanion?.toggle?.();
          return;
        }
      } catch (_) {}

      // Don't hijack typing in form fields (AI model/key/search inputs, find-bar)
      if (isTypingField(e.target)) {
        if (e.key === "Escape" && !el.findBar.hidden && e.target.closest?.("#find-bar")) {
          closeFind();
        }
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape" && !el.findBar.hidden) closeFind();
        // Reading-mode empty list item / empty line keys (no block-edit required).
        if (
          (e.key === "Enter" || e.key === "Delete" || e.key === "Backspace") &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          state.mode !== "source"
        ) {
          const ae = document.activeElement;
          if (ae !== el.source && !(ae && (ae.isContentEditable || ae.closest?.(".md-block.editing")))) {
            if (handleReadingEmptyListKeys(e)) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
        }
        // Reading-mode bulk delete: handle selection delete in one shot
        if (
          (e.key === "Delete" || e.key === "Backspace") &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          state.mode !== "source"
        ) {
          const ae = document.activeElement;
          if (ae === el.source) return;
          if (ae && (ae.isContentEditable || ae.closest?.(".md-block.editing"))) return;
          if (deletePreviewSelection()) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
        return;
      }
      const k = e.key.toLowerCase();
      // Undo: Ctrl+Z  |  Redo: Ctrl+Shift+Z / Ctrl+Y
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          // Ctrl+Shift+Z redo
          if (!redoEdit()) toast("没有可重做的操作");
        } else {
          // Ctrl+Z undo
          if (!undoEdit()) toast("没有可撤销的操作");
        }
        return;
      }
      if (k === "y") {
        e.preventDefault();
        if (!redoEdit()) toast("没有可重做的操作");
        return;
      }
      if (k === "o") {
        e.preventDefault();
        openFileDialog();
      } else if (k === "s") {
        e.preventDefault();
        commitActiveBlockEdits();
        if (e.shiftKey) saveFileAs();
        else saveFile();
      } else if (k === "n") {
        e.preventDefault();
        newDocument();
      } else if (k === "b") {
        // Bold in editor; sidebar only when not typing
        const sel = window.getSelection();
        const ae = document.activeElement;
        const inEditor =
          ae === el.source ||
          (ae && el.preview?.contains(ae)) ||
          (sel && !sel.isCollapsed && el.preview?.contains(sel.anchorNode));
        if (inEditor) {
          e.preventDefault();
          e.stopPropagation();
          wrapSelection("**", "**");
          return;
        }
        if (!e.shiftKey) {
          e.preventDefault();
          toggleSidebar();
        }
      } else if (k === "f") {
        e.preventDefault();
        openFind();
      } else if (k === "e") {
        // Alt+E is AI explain (handled earlier); Ctrl+E remains export
        if (e.altKey) {
          // already returned via StuartAIUI
          return;
        }
        e.preventDefault();
        exportHtml();
      } else if (k === "1" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setMode("preview");
      } else if (k === "2" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setMode("split");
      } else if (k === "3" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setMode("source");
      } else if (k === "t") {
        e.preventDefault();
        cycleTheme();
      } else if (k === "p") {
        e.preventDefault();
        printPreview();
      }
    });

    // Drag & drop
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      document.getElementById("app").classList.add("dragover");
    });
    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null) {
        document.getElementById("app").classList.remove("dragover");
      }
    });
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      document.getElementById("app").classList.remove("dragover");
      // WebView2 may not expose File.path; try via API if available
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      // pywebview on Windows: sometimes webkitRelativePath / path
      const f = files[0];
      const p = f.path || f.name;
      if (state.apiReady && window.pywebview?.api?.open_path) {
        // Prefer full path if provided by WebView
        const path = f.path;
        if (path) {
          const res = await window.pywebview.api.open_path(path);
          if (res?.kind === "file" && res.content != null) {
            if (state.dirty) {
              const ok = confirm("当前文档有未保存修改，确定丢弃并打开新文件？");
              if (!ok) return;
            }
            setDocument(res);
            await refreshRecents();
          } else if (res?.kind === "folder") {
            await loadFolder(res.path);
          } else if (res?.error) toast(res.error);
        } else {
          toast("请使用「打开文件」选择文件");
        }
      }
    });

    // beforeunload-ish: warn dirty via title + persist session
    window.addEventListener("beforeunload", (e) => {
      persistSession();
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    window.addEventListener("pagehide", () => persistSession());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistSession();
    });
    bindPreviewDelegates();
    bindSelToolbar();
    bindBlockHandle();
    bindPreviewContextInsert();
    bindWidthMenu();
  }

  // ---------- Page width ----------
  const WIDTHS = ["default", "wide", "full"];

  function setContentWidth(w, persist = true) {
    const mode = WIDTHS.includes(w) ? w : "default";
    state.contentWidth = mode;
    document.body.dataset.width = mode;
    $$(".width-pick").forEach((b) => b.classList.toggle("active", b.dataset.width === mode));
    if (persist && state.apiReady && window.pywebview?.api?.save_settings) {
      window.pywebview.api.save_settings({ content_width: mode }).catch(() => {});
    }
  }

  function bindWidthMenu() {
    const btn = $("#btn-width");
    const menu = $("#width-menu");
    if (!btn || !menu || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu("#btn-width", "#width-menu");
    });
    menu.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-width]");
      if (!pick) return;
      setContentWidth(pick.dataset.width, true);
      closeAllMenus();
      toast(`页宽：${pick.dataset.width === "default" ? "默认" : pick.dataset.width === "wide" ? "较宽" : "全宽"}`);
    });
  }

  function bindPreviewContextInsert() {
    if (el.preview.dataset.ctx === "1") return;
    el.preview.dataset.ctx = "1";
    el.preview.addEventListener("contextmenu", (e) => {
      if (state.mode === "source") return;
      e.preventDefault();
      const node = e.target.closest?.(".md-block");
      if (node && node.dataset.index != null) {
        state._activeBlockIndex = Number(node.dataset.index);
      }
      showInsertMenu(e.clientX, e.clientY);
    });
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest("#insert-menu")) hideInsertMenu();
    });
  }

  function wrapSelection(pre, post) {
    if (isMermaidFormattingSelection()) return;
    const ta = el.source;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const v = ta.value;
    const selected = v.slice(s, e) || "文本";
    ta.value = v.slice(0, s) + pre + selected + post + v.slice(e);
    ta.selectionStart = s + pre.length;
    ta.selectionEnd = s + pre.length + selected.length;
    setContent(ta.value, true);
    ta.focus();
  }

  /** Prefix/suffix current line(s) in source (headings / lists). */
  function sourceLineTransform(fn) {
    if (isMermaidFormattingSelection()) return;
    const ta = el.source;
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const before = v.slice(0, s);
    const start = before.lastIndexOf("\n") + 1;
    let end = v.indexOf("\n", e);
    if (end < 0) end = v.length;
    const block = v.slice(start, end);
    const next = fn(block);
    if (next == null || next === block) return;
    ta.value = v.slice(0, start) + next + v.slice(end);
    ta.focus();
    ta.setSelectionRange(start, start + next.length);
    setContent(ta.value, true);
  }

  function stripHeadingPrefix(line) {
    return line.replace(/^\s{0,3}#{1,6}\s+/, "");
  }

  function setLineHeading(level) {
    sourceLineTransform((block) =>
      block
        .split("\n")
        .map((line) => {
          const text = stripHeadingPrefix(line).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
          return "#".repeat(level) + " " + text;
        })
        .join("\n")
    );
  }

  function toggleLineList(ordered) {
    sourceLineTransform((block) =>
      block
        .split("\n")
        .map((line, i) => {
          if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
            return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
          }
          const text = stripHeadingPrefix(line);
          return (ordered ? `${i + 1}. ` : "- ") + text;
        })
        .join("\n")
    );
  }

  /** Feishu-like shortcuts (avoid Ctrl+O/S/N/F/E/P/T/B sidebar conflicts). */
  function handleSourceKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    // Ctrl+B / Ctrl+I already handled in textarea listener as bold/italic
    if (e.shiftKey && e.key === "7") {
      e.preventDefault();
      toggleLineList(true);
      return;
    }
    if (e.shiftKey && e.key === "8") {
      e.preventDefault();
      toggleLineList(false);
      return;
    }
    if (e.shiftKey && e.key === "9") {
      e.preventDefault();
      // checklist
      sourceLineTransform((block) =>
        block
          .split("\n")
          .map((line) => {
            if (/^\s*- \[[ xX]\]\s+/.test(line)) {
              return line.replace(/^\s*- \[[ xX]\]\s+/, "");
            }
            const text = stripHeadingPrefix(line).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
            return "- [ ] " + text;
          })
          .join("\n")
      );
      return;
    }
    if (e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      setLineHeading(Number(e.key));
    }
  }

  /** Fast path: large selection delete in preview without entering per-block edit. */
  function rangeSelectsWholeNode(range, node) {
    try {
      const r = document.createRange();
      r.selectNodeContents(node);
      return (
        range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, r) >= 0
      );
    } catch (_) {
      return false;
    }
  }

  function applySourceText(text) {
    const prev = el.source.value || "";
    if (prev && prev !== text) pushHistory(prev);
    el.source.value = text;
    state.content = text;
    markDirty();
    scheduleAutoSave();
    lastPreviewSource = "";
    lastPreviewBlocks = [];
    if (state.mode !== "source") {
      try {
        el.preview.innerHTML = "";
      } catch (_) {}
      renderMarkdown(text);
      lastPreviewSource = text;
      lastPreviewBlocks = splitMarkdownBlocks(text);
    }
    updateStats();
    pushHistory(text);
    emitAgentEvent("document-changed", { source: "bulk-delete" });
  }

  /**
   * Delete a preview selection spanning one or more md-blocks in a single
   * source update + one render. Avoids contenteditable + per-keystroke rebuild.
   * @returns {boolean} true if handled
   */
  function deletePreviewSelection() {
    if (state.mode === "source") return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !el.preview) return false;
    if (!el.preview.contains(sel.anchorNode) && !el.preview.contains(sel.focusNode)) {
      return false;
    }
    const range = sel.getRangeAt(0);
    const nodes = $$(".md-block", el.preview);
    const affected = [];
    for (const b of nodes) {
      try {
        if (range.intersectsNode(b)) affected.push(b);
      } catch (_) {}
    }
    if (!affected.length) return false;

    const srcBlocks = splitMarkdownBlocks(el.source.value || "");
    const idxs = affected
      .map((b) => Number(b.dataset.index))
      .filter((n) => Number.isFinite(n) && n >= 0 && n < srcBlocks.length);
    if (!idxs.length) return false;
    idxs.sort((a, b) => a - b);
    const from = idxs[0];
    const to = idxs[idxs.length - 1];
    const multi = to > from || affected.length > 1;

    const next = srcBlocks.slice();
    if (multi) {
      // Large multi-block selection: drop whole covered blocks (fast)
      for (let i = from; i <= to; i++) next[i] = "";
    } else {
      // Single block partial selection
      const blockEl =
        el.preview.querySelector(`.md-block[data-index="${from}"]`) || affected[0];
      try {
        // Mutate live DOM once, then convert back to markdown
        range.deleteContents();
        const mdText = htmlToMarkdown(blockEl).replace(/^\n+|\n+$/g, "");
        // Conversion failure/emptiness must not wipe the unselected remainder:
        // keep the opened source when the round-trip comes back empty.
        if (String(mdText).trim() || !String(srcBlocks[from] || "").trim()) {
          next[from] = mdText;
        }
      } catch (_) {
        // Leave next[from] as the original block — never blank it on error.
      }
    }

    const kept = [];
    for (let i = 0; i < next.length; i++) {
      if (i >= from && i <= to) {
        if (next[i] && String(next[i]).trim()) kept.push(next[i]);
      } else {
        kept.push(next[i]);
      }
    }
    const text = joinBlocks(kept);
    try {
      sel.removeAllRanges();
    } catch (_) {}
    hideSelToolbar();
    hideBlockHandle();
    hideBlockMenu();
    applySourceText(text);
    return true;
  }

  /** Find source line index for the Nth list-marker line (0-based). */
  function findListLineIndex(lines, liOrdinal) {
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (isListMarkerLine(lines[i])) {
        if (n === liOrdinal) return i;
        n++;
      }
    }
    return -1;
  }

  /** Blank for edit purposes: ignore whitespace and zero-width / BOM chars. */
  function isBlankEditorText(s) {
    return !String(s == null ? "" : s).replace(/[\s\u200b\u200c\u200d\u2060\ufeff]/g, "").length;
  }

  /** True when the source line starts a list marker (with or without item text). */
  function isListMarkerLine(line) {
    return (
      /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(line) ||
      /^\s*[-*+] \[[ xX]\](?:\s|$)/.test(line)
    );
  }

  function listMarkerOnly(line) {
    return (
      /^\s*(?:[-*+]|\d+[.)])\s*$/.test(line) ||
      /^\s*[-*+] \[[ xX]\]\s*$/.test(line) ||
      /^\s*(?:[-*+]|\d+[.)])\s+$/.test(line) ||
      /^\s*[-*+] \[[ xX]\]\s+$/.test(line)
    );
  }

  function stripListMarker(line) {
    return String(line == null ? "" : line)
      .replace(/^\s*[-*+] \[[ xX]\]\s+/, "")
      .replace(/^\s*[-*+] \[[ xX]\]\s*$/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s*$/, "");
  }

  /** task | ol | ul for a marker line, else null. */
  function listItemMarkerKind(line) {
    const s = String(line == null ? "" : line);
    if (/^\s*[-*+] \[[ xX]\]/.test(s)) return "task";
    if (/^\s*\d+[.)](\s|$)/.test(s)) return "ol";
    if (/^\s*[-*+](\s|$)/.test(s)) return "ul";
    return null;
  }

  /** Next sibling item line of the SAME kind (task/ol/ul) as `refLine`. */
  function makeListItemLine(refLine) {
    const s = String(refLine == null ? "" : refLine);
    const indent = (s.match(/^\s*/) || [""])[0];
    const kind = listItemMarkerKind(s) || "ul";
    if (kind === "task") return indent + "- [ ] ";
    if (kind === "ol") {
      const m = s.match(/^\s*(\d+)([.)])/);
      const n = m ? parseInt(m[1], 10) + 1 : 1;
      const sep = m ? m[2] : ".";
      return indent + n + sep + " ";
    }
    const m = s.match(/^\s*([-*+])/);
    return indent + (m ? m[1] : "-") + " ";
  }

  /** Map a DOM `li` to its source marker-line index (text match, then ordinal). */
  function findListLineForLi(lines, li) {
    const markerIdxs = [];
    for (let i = 0; i < lines.length; i++) {
      if (isListMarkerLine(lines[i])) markerIdxs.push(i);
    }
    if (!markerIdxs.length) return -1;
    const raw = li && li.textContent != null ? li.textContent : "";
    const text = isBlankEditorText(raw)
      ? ""
      : String(raw).replace(/\s+/g, " ").trim().slice(0, 48);
    if (text) {
      for (const i of markerIdxs) {
        const t = stripListMarker(lines[i]).replace(/\s+/g, " ").trim().slice(0, 48);
        if (t && t === text) return i;
      }
    }
    const host = (li && li.closest && li.closest(".md-block")) || null;
    const lis = host ? [...host.querySelectorAll("li")] : li && li.parentNode ? [li] : [];
    let ord = li ? lis.indexOf(li) : -1;
    if (ord < 0) ord = markerIdxs.length - 1;
    if (ord < markerIdxs.length) return markerIdxs[ord];
    return -1;
  }

  /**
   * Enter in a list item (WYSIWYG / reading):
   * - empty item → strip ONLY that line's marker (become normal empty line)
   * - non-empty → insert a NEW item of the SAME kind (task/ol/ul)
   * Never deletes other rows; never pops commitBlockSource toasts.
   */
  function listEnterOnItem(node, li) {
    const blockIdx = Number(node.dataset.index || 0);
    const all = splitMarkdownBlocks(el.source.value || "");
    const src = all[blockIdx] || "";
    const lines = src.split("\n");
    const blank = isBlankEditorText((li && li.textContent) || "");
    const lineIdx = findListLineForLi(lines, li);
    if (lineIdx < 0) {
      // DOM-only empty li from a just-inserted item — strip that li only.
      rewriteListLine(node, li, blank ? "strip-marker" : "delete-line");
      return;
    }
    const ref = lines[lineIdx];
    if (blank || listMarkerOnly(ref)) {
      lines[lineIdx] = stripListMarker(ref);
    } else {
      lines.splice(lineIdx + 1, 0, makeListItemLine(ref));
    }
    const prev = el.source.value || "";
    const nextBlock = lines.join("\n");
    all[blockIdx] = nextBlock;
    const joined = joinBlocks(all);
    if (joined === prev) {
      rewriteListLine(node, li, blank ? "strip-marker" : "delete-line");
      return;
    }
    pushHistory(prev);
    el.source.value = joined;
    state.content = joined;
    markDirty();
    scheduleAutoSave();
    lastPreviewSource = "";
    node._stuartCommit = null;
    exitBlockEditVisual(node);
    node.innerHTML = "";
    renderMarkdown(joined);
    lastPreviewSource = joined;
    lastPreviewBlocks = splitMarkdownBlocks(joined);
    pushHistory(joined);
  }

  /** Rewrite one list line in the active block source and re-render. */
  function rewriteListLine(node, li, mode) {
    // mode: "strip-marker" | "delete-line"
    const idx = Number(node.dataset.index || 0);
    const all = splitMarkdownBlocks(el.source.value || "");
    const src = all[idx] || "";
    const lines = src.split("\n");
    const lis = [...node.querySelectorAll("li")];
    const ord = Math.max(0, lis.indexOf(li));
    // Map this li to its source marker line (text first, then ordinal).
    let lineIdx = findListLineForLi(lines, li);
    const markerIdxs = [];
    for (let i = 0; i < lines.length; i++) {
      if (isListMarkerLine(lines[i])) markerIdxs.push(i);
    }
    const liIsBlank = li && isBlankEditorText(li.textContent || "");
    if (lineIdx < 0 && liIsBlank && ord >= markerIdxs.length) {
      // Strip/delete only THIS empty li in the DOM. Do not touch earlier items.
      try {
        if (li && li.parentNode) {
          if (mode === "delete-line") {
            li.remove();
          } else {
            const p = document.createElement("p");
            p.className = "md-empty-line";
            p.innerHTML = "<br>";
            li.replaceWith(p);
          }
          const ul = node.querySelector("ul, ol");
          if (ul && !ul.querySelector("li")) {
            const blank = document.createElement("p");
            blank.className = "md-empty-line";
            blank.innerHTML = "<br>";
            ul.replaceWith(blank);
          }
        }
      } catch (_) {}
      node._stuartCommit = null;
      exitBlockEditVisual(node);
      return true;
    }
    const prev = el.source.value || "";
    if (lineIdx < 0) {
      // Source has no marker line (DOM-only empty bullet). Clear the marker
      // from the live DOM so the bullet is never stuck undeletable.
      try {
        if (li && li.parentNode) {
          if (mode === "delete-line") {
            li.remove();
          } else {
            const p = document.createElement("p");
            p.className = "md-empty-line";
            p.innerHTML = "<br>";
            const ul = li.closest("ul, ol");
            if (ul) {
              ul.replaceWith(p);
            } else {
              li.replaceWith(p);
            }
          }
          const stillList = node.querySelector("ul, ol, li");
          if (!stillList) {
            node.classList.add("md-empty");
          }
        }
      } catch (_) {}
      return true;
    }
    if (mode === "delete-line") {
      lines.splice(lineIdx, 1);
    } else {
      lines[lineIdx] = stripListMarker(lines[lineIdx]);
    }
    let nextBlock = lines.join("\n");
    // Enter on empty list item: only remove the marker. Keep a normal empty
    // line (do not delete the line / collapse the block away).
    all[idx] = nextBlock;
    const joined = joinBlocks(all);
    if (joined === prev) {
      // Source unchanged (already empty) but DOM may still show a bullet.
      try {
        node._stuartCommit = null;
        exitBlockEditVisual(node);
        node.innerHTML = '<p class="md-empty-line"><br></p>';
        node.classList.add("md-empty");
      } catch (_) {}
      return true;
    }
    pushHistory(prev);
    el.source.value = joined;
    state.content = joined;
    markDirty();
    scheduleAutoSave();
    lastPreviewSource = "";
    node._stuartCommit = null;
    exitBlockEditVisual(node);
    node.innerHTML = "";
    renderMarkdown(joined);
    lastPreviewSource = joined;
    lastPreviewBlocks = splitMarkdownBlocks(joined);
    pushHistory(joined);
    return true;
  }

  /** Insert one empty line after the active empty-line block (or delete it). */
  function rewriteEmptyLineBlock(node, mode) {
    // mode: "insert-empty" | "delete-empty"
    const idx = Number(node.dataset.index || 0);
    const all = splitMarkdownBlocks(el.source.value || "");
    const prev = el.source.value || "";
    if (mode === "delete-empty") {
      if (idx >= 0 && idx < all.length) all.splice(idx, 1);
    } else {
      const at = Math.min(Math.max(0, idx + 1), all.length);
      all.splice(at, 0, "");
    }
    const joined = joinBlocks(all);
    if (joined === prev) return true;
    pushHistory(prev);
    el.source.value = joined;
    state.content = joined;
    markDirty();
    scheduleAutoSave();
    lastPreviewSource = "";
    node._stuartCommit = null;
    exitBlockEditVisual(node);
    node.innerHTML = "";
    renderMarkdown(joined);
    lastPreviewSource = joined;
    lastPreviewBlocks = splitMarkdownBlocks(joined);
    pushHistory(joined);
    return true;
  }

  /** True when the block is a plain empty-line block (not a list / table / code). */
  function isEmptyLineBlock(node) {
    if (!node) return false;
    if (node.classList.contains("md-empty")) return true;
    if (node.querySelector("li, ul, ol, table, pre, .katex, .katex-display, .mermaid-diagram")) return false;
    return isBlankEditorText(node.textContent || "");
  }

  /**
   * Reading-mode (no block-edit) Enter/Delete/Backspace on a lone empty list
   * item or an empty-line block. Returns true when the key was handled.
   */
  function handleReadingEmptyListKeys(e) {
    if (state.mode === "source") return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.preview) return false;
    const anchor = sel.anchorNode;
    if (!anchor) return false;
    const inPreview = el.preview.contains(anchor) || el.preview.contains(anchor.parentElement || null);
    if (!inPreview) return false;
    const a = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const block = a?.closest?.(".md-block");
    if (!block || !el.preview.contains(block)) return false;

    // Empty plain-line block
    if (isEmptyLineBlock(block)) {
      if (e.key === "Enter") {
        rewriteEmptyLineBlock(block, "insert-empty");
        return true;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        rewriteEmptyLineBlock(block, "delete-empty");
        return true;
      }
      return false;
    }

    // Empty list item under the caret only (never another empty li).
    const li = a?.closest?.("li") || (a && a.tagName === "LI" ? a : null);
    if (!li || !block.contains(li)) return false;
    const liEmpty = (x) =>
      !!x &&
      isBlankEditorText(x.textContent || "") &&
      !x.querySelector("img, input, button, video, audio, iframe, svg");
    if (!liEmpty(li)) return false;
    if (e.key === "Enter" || e.key === "Delete" || e.key === "Backspace") {
      if (e.key === "Enter") {
        listEnterOnItem(block, li);
      } else {
        rewriteListLine(block, li, "strip-marker");
      }
      return true;
    }
    return false;
  }

  /** WYSIWYG block: execCommand + convert via htmlToMarkdown on blur. */
  function handleBlockEditKeydown(e, node) {
    const sel = window.getSelection();
    // Empty li includes <br>-only / zero-width / nbsp placeholders.
    const liEmpty = (li) => {
      if (!li) return false;
      if (!isBlankEditorText(li.textContent || "")) return false;
      return !li.querySelector("img, input, button, video, audio, iframe, svg");
    };
    const findLiAtCaret = () => {
      if (!sel || !sel.anchorNode) return null;
      const a = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      if (!a || !node.contains(a)) return null;
      // ONLY the li that actually contains the caret. Never steal another li
      // (e.g. the first empty one) — that deleted the wrong list row on Enter.
      const li = a.closest?.("li");
      return li && node.contains(li) ? li : null;
    };
    const liAtCaret = findLiAtCaret();
    const caretAtStartOfLi = (li) => {
      if (!sel || !sel.rangeCount || !li) return false;
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(li);
      pre.setEnd(range.startContainer, range.startOffset);
      return isBlankEditorText(pre.toString());
    };

    const noMod = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const isEraseKey = e.key === "Delete" || e.key === "Backspace";

    // Empty plain-line block: Enter adds one empty line; Delete/Backspace removes one.
    if (noMod && isEmptyLineBlock(node) && (e.key === "Enter" || isEraseKey)) {
      e.preventDefault();
      e.stopPropagation();
      rewriteEmptyLineBlock(node, e.key === "Enter" ? "insert-empty" : "delete-empty");
      return;
    }

    // Enter in a list item: same-kind new item, or strip empty marker.
    if (e.key === "Enter" && noMod && liAtCaret) {
      e.preventDefault();
      e.stopPropagation();
      listEnterOnItem(node, liAtCaret);
      return;
    }

    // Delete/Backspace on empty list item: strip marker first; if the source
    // line is already an empty plain line, delete that empty line.
    if (isEraseKey && noMod && liAtCaret && liEmpty(liAtCaret)) {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(node.dataset.index || 0);
      const all = splitMarkdownBlocks(el.source.value || "");
      const src = all[idx] || "";
      const lines = src.split("\n");
      const lis = [...node.querySelectorAll("li")];
      const ord = Math.max(0, lis.indexOf(liAtCaret));
      let lineIdx = findListLineIndex(lines, ord);
      // No first-line fallback: a trailing empty li missing from source must
      // never grab the first list item's marker.
      const srcLine = lineIdx >= 0 ? lines[lineIdx] : null;
      if (srcLine == null || listMarkerOnly(srcLine)) {
        // Marker-only bullet → leave the list (empty paragraph).
        rewriteListLine(node, liAtCaret, "strip-marker");
      } else if (isBlankEditorText(srcLine)) {
        // Already an empty plain line → remove one empty line.
        rewriteListLine(node, liAtCaret, "delete-line");
      } else {
        // Marker with text that rendered empty (e.g. only <br>): strip marker.
        rewriteListLine(node, liAtCaret, "strip-marker");
      }
      return;
    }

    // Backspace at start of a non-empty list item: strip marker only (keep text)
    if (e.key === "Backspace" && noMod && liAtCaret && caretAtStartOfLi(liAtCaret) && !liEmpty(liAtCaret)) {
      e.preventDefault();
      e.stopPropagation();
      rewriteListLine(node, liAtCaret, "strip-marker");
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      document.execCommand("bold");
      return;
    }
    if (e.key === "i" || e.key === "I") {
      e.preventDefault();
      document.execCommand("italic");
      return;
    }
    if (e.shiftKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      document.execCommand("strikeThrough");
      return;
    }
    if (e.shiftKey && e.key === "8") {
      e.preventDefault();
      document.execCommand("insertUnorderedList");
      return;
    }
    if (e.shiftKey && e.key === "7") {
      e.preventDefault();
      document.execCommand("insertOrderedList");
      return;
    }
    if (e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      const host = node.firstElementChild || node;
      const tag = "h" + e.key;
      try {
        document.execCommand("formatBlock", false, tag);
      } catch (_) {
        const h = document.createElement(tag);
        h.textContent = host.textContent;
        node.innerHTML = "";
        node.appendChild(h);
      }
    }
  }

  // ---------- Welcome sample ----------
  // Content is loaded from samples/ via backend open_welcome() / open_sample().

  // ---------- Settings modal ----------
  const SETTINGS_GEOM_KEY = "StuartMD-settings-ui";

  function loadSettingsUi() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_GEOM_KEY) || "null") || {};
    } catch (_) {
      return {};
    }
  }

  function saveSettingsUi(patch) {
    const cur = loadSettingsUi();
    const next = Object.assign({}, cur, patch || {});
    try {
      localStorage.setItem(SETTINGS_GEOM_KEY, JSON.stringify(next));
    } catch (_) {}
    return next;
  }

  function applySettingsZoom(z) {
    const body = $("#settings-body");
    const label = $("#settings-zoom-label");
    const zoom = Math.min(1.6, Math.max(0.85, Number(z) || 1));
    document.documentElement.style.setProperty("--settings-zoom", String(zoom));
    if (body) body.style.zoom = String(zoom);
    if (label) label.textContent = Math.round(zoom * 100) + "%";
    saveSettingsUi({ zoom });
  }

  function applySettingsSize() {
    const card = $("#settings-card");
    if (!card) return;
    const ui = loadSettingsUi();
    if (ui.w > 0) card.style.width = Math.min(ui.w, window.innerWidth - 24) + "px";
    if (ui.h > 0) card.style.height = Math.min(ui.h, window.innerHeight - 24) + "px";
  }

  function bindSettingsResize() {
    const card = $("#settings-card");
    const grip = $("#settings-resize");
    const head = $("#settings-drag");
    if (!card || card.dataset.resizeBound === "1") return;
    card.dataset.resizeBound = "1";

    let rz = null;
    const onMove = (e) => {
      if (!rz) return;
      if (rz.mode === "size") {
        const w = Math.min(window.innerWidth - 16, Math.max(480, rz.w + (e.clientX - rz.x)));
        const h = Math.min(window.innerHeight - 16, Math.max(360, rz.h + (e.clientY - rz.y)));
        card.style.width = w + "px";
        card.style.height = h + "px";
      }
    };
    const onUp = () => {
      if (rz && rz.mode === "size") {
        saveSettingsUi({ w: card.offsetWidth, h: card.offsetHeight });
      }
      rz = null;
    };
    grip?.addEventListener("mousedown", (e) => {
      rz = { mode: "size", x: e.clientX, y: e.clientY, w: card.offsetWidth, h: card.offsetHeight };
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    // Optional: drag header to move card within viewport
    let mv = null;
    head?.addEventListener("mousedown", (e) => {
      if (e.target.closest("button, input, select, textarea, .settings-zoom")) return;
      const r = card.getBoundingClientRect();
      // modal is flex-centered; convert to explicit left/top once
      if (!card.style.position || card.style.position === "relative") {
        card.style.position = "fixed";
        card.style.left = r.left + "px";
        card.style.top = r.top + "px";
        card.style.margin = "0";
        card.style.zIndex = "101";
        const modal = $("#settings-modal");
        if (modal) {
          modal.style.alignItems = "flex-start";
          modal.style.justifyContent = "flex-start";
          modal.style.padding = "0";
        }
      }
      mv = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!mv || !card) return;
      const left = Math.min(Math.max(0, window.innerWidth - 80), Math.max(0, e.clientX - mv.x));
      const top = Math.min(Math.max(0, window.innerHeight - 48), Math.max(0, e.clientY - mv.y));
      card.style.left = left + "px";
      card.style.top = top + "px";
    });
    document.addEventListener("mouseup", () => {
      mv = null;
    });

    $("#settings-zoom-in")?.addEventListener("click", () => {
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--settings-zoom")) || 1;
      applySettingsZoom(cur + 0.1);
    });
    $("#settings-zoom-out")?.addEventListener("click", () => {
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--settings-zoom")) || 1;
      applySettingsZoom(cur - 0.1);
    });
    $("#settings-zoom-reset")?.addEventListener("click", () => {
      card.style.width = "";
      card.style.height = "";
      card.style.position = "";
      card.style.left = "";
      card.style.top = "";
      const modal = $("#settings-modal");
      if (modal) {
        modal.style.alignItems = "";
        modal.style.justifyContent = "";
        modal.style.padding = "";
      }
      applySettingsZoom(1);
      saveSettingsUi({ w: 0, h: 0 });
      toast("设置窗口已重置");
    });

    // Ctrl+wheel zoom on settings body
    $("#settings-body")?.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--settings-zoom")) || 1;
        applySettingsZoom(cur + (e.deltaY < 0 ? 0.08 : -0.08));
      },
      { passive: false }
    );
  }

  function setupWindowLifecycle() {
    const tauri = window.__TAURI__;
    let closingWindow = false;
    if (tauri?.event?.listen) {
      tauri.event.listen("stuart-window-close-requested", async () => {
        if (closingWindow) return;
        closingWindow = true;
        try {
          await flushCurrentDocument();
          const dirtyTabs = state.tabs.filter(tab => tab.dirty);
          if (dirtyTabs.length) {
            const names = dirtyTabs.map(tab => `「${tabTitleFor(tab)}」`).join("、");
            const confirmed = await window.StuartUIConfirm(`以下文档包含未保存的修改：\n${names}\n\n草稿已经保存。确定关闭当前窗口吗？`);
            if (!confirmed) return;
          }
          await window.StuartAIService.cancel();
          await window.StuartAIService.flushDraft();
          await tauri.core.invoke("stuart_close_window");
        } catch (error) { toast("关闭窗口失败：" + (error.message || String(error))); }
        finally { closingWindow = false; }
      });
    }
  }

  function openSettingsModal() {
    $("#settings-modal").hidden = false;
    bindSettingsResize();
    applySettingsSize();
    const ui = loadSettingsUi();
    applySettingsZoom(ui.zoom || 1);
    refreshSettingsModal();
  }

  function closeSettingsModal() {
    const card = $("#settings-card");
    if (card) saveSettingsUi({ w: card.offsetWidth, h: card.offsetHeight });
    $("#settings-modal").hidden = true;
  }

  async function refreshSettingsModal() {
    if (!state.apiReady) return;
    try {
      const info = await window.pywebview.api.get_app_info();
      const kv = $("#app-info-kv");
      kv.innerHTML = "";
      const rows = [
        ["版本", info.version || "—"],
        ["发布者", info.publisher || "—"],
        ["程序目录", info.install_dir || "—"],
        ["安装形态", info.frozen ? "独立 EXE" : "源码运行"],
      ];
      rows.forEach(([k, v]) => {
        const a = document.createElement("div");
        a.className = "k";
        a.textContent = k;
        const b = document.createElement("div");
        b.className = "v";
        b.textContent = v;
        kv.appendChild(a);
        kv.appendChild(b);
      });
      $("#data-dir-path").textContent = info.data_dir || "—";

      const st = await window.pywebview.api.get_file_association_status();
      const mdOk = !!(st.md ?? st.registered);
      const pdfOk = !!st.pdf;
      $("#assoc-status").textContent =
        mdOk && pdfOk
          ? "已注册：Markdown 与 PDF 均可出现在系统「打开方式」中。"
          : mdOk
            ? "已注册 Markdown；PDF 尚未注册，可点击下方按钮补全。"
            : pdfOk
              ? "已注册 PDF；Markdown 尚未注册，可点击下方按钮补全。"
              : "尚未注册：点击下方按钮写入系统「打开方式」（Markdown + PDF）。";
      const us = $("#update-status");
      if (us) us.textContent = `当前版本 ${info.version || VERSION} · 升级不会丢失设置与插件`;

      $$(".theme-pick").forEach((b) => {
        b.classList.toggle("active", b.dataset.theme === state.theme);
      });
      const autosaveBtn = $("#btn-autosave");
      if (autosaveBtn) {
        autosaveBtn.textContent = state.autosaveEnabled ? "自动保存：开" : "自动保存：关";
        autosaveBtn.classList.toggle("active", !!state.autosaveEnabled);
      }
      $$(".open-mode-pick").forEach((b) => {
        b.classList.toggle("active", b.dataset.openMode === state.openMode);
      });
      $$(".new-doc-mode-pick").forEach((b) => {
        b.classList.toggle("active", b.dataset.newDocMode === state.newDocMode);
      });
    } catch (_) {}
  }

  function bindSettingsEvents() {
    $("#btn-settings").addEventListener("click", openSettingsModal);
    $("#btn-settings-close").addEventListener("click", closeSettingsModal);
    $("#settings-modal").addEventListener("click", (e) => {
      if (e.target.id === "settings-modal") closeSettingsModal();
    });
    $("#btn-register-md").addEventListener("click", async () => {
      if (!state.apiReady) return;
      const res = await window.pywebview.api.register_file_association();
      if (res?.error) toast(res.error);
      else {
        toast("已注册 Markdown / PDF 打开方式");
        refreshSettingsModal();
      }
    });
    $("#btn-default-apps").addEventListener("click", async () => {
      if (!state.apiReady) return;
      await window.pywebview.api.open_default_apps_settings();
      toast("可在系统设置中将 .md 默认应用设为 StuartMD；PDF 用右键「打开方式」即可");
    });
    $("#btn-open-data").addEventListener("click", async () => {
      if (!state.apiReady) return;
      await window.pywebview.api.open_data_dir();
    });
    $$(".theme-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.theme === "wallpaper" && !state.wallpaper?.uri) {
          $("#wallpaper-input")?.click();
          return;
        }
        setTheme(btn.dataset.theme);
        refreshSettingsModal();
      });
    });
    $$(".lang-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (window.StuartI18n) window.StuartI18n.setLang(btn.dataset.lang);
        refreshSettingsModal();
        toast(`已切换语言：${btn.dataset.lang === "zh-CN" ? "简体中文" : btn.dataset.lang === "zh-TW" ? "繁體中文" : "English"}`);
      });
    });
    const wpInput = $("#wallpaper-input");
    $("#btn-upload-wallpaper")?.addEventListener("click", () => wpInput?.click());
    wpInput?.addEventListener("change", async () => {
      const file = wpInput.files && wpInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        if (!state.apiReady) return;
        const res = await window.pywebview.api.import_wallpaper(reader.result, file.name);
        if (res?.error) {
          toast(res.error);
          return;
        }
        // Prefer frontend canvas extraction (works on both Stable & Beta)
        let colors = res.colors;
        try {
          const img = await loadImageFromUrl(res.uri || reader.result);
          if (img) colors = extractWallpaperColors(img);
        } catch (_) {}
        if (colors && colors.length) {
          try {
            await window.pywebview.api.save_settings({
              wallpaper: { path: res.path, uri: res.uri, colors },
              theme: "wallpaper",
            });
          } catch (_) {}
        }
        applyWallpaperVars({ uri: res.uri, colors: colors || res.colors, path: res.path });
        setTheme("wallpaper");
        toast("壁纸已应用，主色已提取");
        refreshSettingsModal();
      };
      reader.readAsDataURL(file);
      wpInput.value = "";
    });
    $("#btn-clear-wallpaper")?.addEventListener("click", async () => {
      if (!state.apiReady) return;
      await window.pywebview.api.clear_wallpaper();
      state.wallpaper = null;
      document.documentElement.style.removeProperty("--wp-image");
      const prev = $("#wallpaper-preview");
      if (prev) {
        prev.hidden = true;
        prev.style.backgroundImage = "";
      }
      setTheme("light");
      toast("已移除壁纸");
      refreshSettingsModal();
    });
    $$(".open-mode-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = btn.dataset.openMode;
        state.openMode = m === "current_window" || m === "new_window" ? m : "smart";
        if (state.apiReady) {
          window.pywebview.api.save_settings({ open_mode: state.openMode }).catch(() => {});
        }
        toast(state.openMode === "smart" ? "已切换为智能打开" : state.openMode === "new_window" ? "始终新窗口" : "始终当前窗口标签页");
        renderTabs();
        refreshSettingsModal();
      });
    });
    $$(".new-doc-mode-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.newDocMode = btn.dataset.newDocMode === "new_window" ? "new_window" : "tab";
        if (state.apiReady) {
          window.pywebview.api.save_settings({ new_doc_mode: state.newDocMode }).catch(() => {});
        }
        toast(state.newDocMode === "new_window" ? "新建文档将用新窗口" : "新建文档将用新标签");
        refreshSettingsModal();
      });
    });
    $("#btn-open-plugins")?.addEventListener("click", async () => {
      if (!state.apiReady) return;
      await window.pywebview.api.open_plugins_dir();
    });
    $("#btn-check-update")?.addEventListener("click", async () => {
      if (!state.apiReady) return;
      const st = $("#update-status");
      if (st) st.textContent = "正在检查更新…";
      try {
        const res = await window.pywebview.api.check_update();
        if (res?.error) {
          if (st) st.textContent = res.error;
          return;
        }
        if (res.update) {
          if (st) st.textContent = `发现新版本 v${res.latest}（当前 v${res.current}）`;
          const go = confirm(`发现新版本 v${res.latest}，是否打开下载页面？\n\n升级会保留全部设置与插件。`);
          if (go) await window.pywebview.api.open_url(res.download_url || res.url);
        } else {
          if (st) st.textContent = `已是最新版本 v${res.current}`;
          toast(`已是最新 v${res.current}`);
        }
      } catch (e) {
        if (st) st.textContent = String(e);
      }
    });
    $("#btn-open-releases")?.addEventListener("click", async () => {
      if (!state.apiReady) return;
      await window.pywebview.api.open_url("https://github.com/ghostLLC/StuartMD/releases");
    });
    const autosaveBtn = $("#btn-autosave");
    if (autosaveBtn) {
      autosaveBtn.addEventListener("click", () => {
        state.autosaveEnabled = !state.autosaveEnabled;
        if (state.apiReady) {
          window.pywebview.api
            .save_settings({ autosave: state.autosaveEnabled })
            .catch(() => {});
        }
        if (state.autosaveEnabled) scheduleAutoSave();
        else clearTimeout(autosaveTimer);
        updateAutosaveStatus();
        refreshSettingsModal();
        toast(state.autosaveEnabled ? "已开启自动保存" : "已关闭自动保存");
      });
    }
  }

  async function refreshPluginList() {
    const box = $("#plugin-list");
    if (!box || !state.apiReady) return;
    try {
      const res = await window.pywebview.api.list_plugins();
      const list = (res && res.plugins) || [];
      box.innerHTML = "";
      if (!list.length) {
        box.innerHTML = `<div class="empty-hint">暂无插件。将 .js 放入插件目录后，启用前需确认源码哈希。</div>`;
        return;
      }
      const live = window.StuartPlugins;
      const discovered = live?.list?.() || [];
      list.forEach((p) => {
        const row = document.createElement("div");
        row.className = "plugin-item";
        const name = document.createElement("span");
        const disc = discovered.find((d) => d.id === p.id);
        const pending = !!(disc && disc.pending_consent);
        name.textContent = (p.name || p.id) + (pending ? "（待确认）" : "");
        const btn = document.createElement("button");
        btn.className = "btn sm";
        btn.textContent = p.enabled && !pending ? "已启用" : pending ? "确认并启用" : "已禁用";
        btn.addEventListener("click", async () => {
          if (!p.enabled || pending) {
            const ok = confirm(`启用插件「${p.name || p.id}」？\n将执行该目录下的脚本，仅在信任来源时启用。`);
            if (!ok) return;
            await window.pywebview.api.set_plugin_enabled(p.id, true);
            if (live?.consentAndEnable) {
              try {
                await live.consentAndEnable(p.id);
              } catch (_) {}
            }
          } else {
            await window.pywebview.api.set_plugin_enabled(p.id, false);
            if (live?.disablePlugin) {
              try {
                await live.disablePlugin(p.id);
              } catch (_) {}
            }
          }
          refreshPluginList();
        });
        row.appendChild(name);
        row.appendChild(btn);
        box.appendChild(row);
      });
    } catch (_) {}
  }

  // ---------- Boot ----------
  async function boot() {
    try {
      const t = localStorage.getItem("StuartMD-theme") || "light";
      setTheme(THEMES.includes(t) ? t : "light");
    } catch (_) {
      setTheme("light");
    }

    setMode("preview", false);
    setupResizers();
    // Bind tree first — must never be skipped by later errors
    try {
      bindTreeDelegates();
    } catch (err) {
      console.error(err);
    }
    try {
      bindTabBar();
    } catch (err) {
      console.error(err);
    }
    try {
      bindEvents();
    } catch (err) {
      console.error(err);
    }
    try {
      setupWindowLifecycle();
    } catch (err) {
      console.error(err);
    }
    try {
      bindSettingsEvents();
    } catch (err) {
      console.error(err);
    }
    try {
      window.StuartAIUI?.bindAll?.();
      try {
        const sc = document.getElementById("btn-companion");
        if (sc && sc.dataset.bound !== "1") {
          sc.dataset.bound = "1";
          sc.addEventListener("click", () => window.StuartCompanion?.toggle?.());
        }
      } catch (_) {}
    } catch (err) {
      console.error(err);
    }
    updateAutosaveStatus();
    renderTabs();
    updatePinUi();
    setTimeout(updatePinUi, 100);
    setTimeout(updatePinUi, 500);

    async function applySettings(s) {
      if (s?.theme) setTheme(s.theme);
      if (s?.mode) setMode(s.mode, false);
      if (s && s.sidebar === false) toggleSidebar(false, false);
      if (s && typeof s.autosave === "boolean") state.autosaveEnabled = s.autosave;
      if (s?.language && window.StuartI18n) window.StuartI18n.setLang(s.language);
      if (s?.open_mode === "current_window" || s?.open_mode === "new_window" || s?.open_mode === "smart") {
        state.openMode = s.open_mode;
      }
      if (CoreSettings()?.isValidOpenMode && s?.open_mode) {
        if (CoreSettings().isValidOpenMode(s.open_mode)) state.openMode = s.open_mode;
      }
      if (s?.new_doc_mode === "tab" || s?.new_doc_mode === "new_window") {
        state.newDocMode = s.new_doc_mode;
      }
      if (s?.music && window.StuartMusic) window.StuartMusic.restore(s.music);
      if (s?.content_width === "default" || s?.content_width === "wide" || s?.content_width === "full") {
        setContentWidth(s.content_width, false);
      } else {
        setContentWidth("default", false);
      }
      if (s?.ai) {
        state.aiConfig = s.ai;
        state.aiShortcut = s.ai.explain_shortcut || "Alt+E";
      }
      try {
        await window.StuartAI?.ensureConfig?.(true);
        window.StuartAIUI?.refreshChrome?.();
      } catch (_) {}
      if (s?.last_folder) {
        // Restore folder tree across versions if the path still exists
        try {
          const exists = await window.pywebview.api.file_exists(s.last_folder);
          if (exists) {
            await loadFolder(s.last_folder);
          } else {
            el.folderName.textContent = "最近 / 欢迎";
            await window.pywebview.api.save_settings({ last_folder: "" });
          }
        } catch (_) {
          await loadFolder(s.last_folder);
        }
      }
      await refreshRecents();
      renderTabs();
    }

    async function onReady() {
      state.apiReady = true;
      try {
        const s = await window.pywebview.api.get_settings();
        // wallpaper first so theme can apply
        try {
          const wp = await window.pywebview.api.get_wallpaper();
          if (wp?.uri) applyWallpaperVars(wp);
        } catch (_) {}
        await applySettings(s);
        const info = await window.pywebview.api.get_app_info();
        state.appInfo = info;
        state.sampleDismissed = !!(s && s.sample_dismissed);
        await window.StuartRecovery.showRecovery();

        // Restore window geometry / fullscreen from last session
        try {
          await window.pywebview.api.apply_window_state?.();
        } catch (_) {}

        // Association + plugins: non-critical, do not block boot path
        setTimeout(() => {
          try {
            window.pywebview.api.register_file_association?.()?.catch?.(() => {});
          } catch (_) {}
        }, 2500);
        setTimeout(async () => {
          try {
            await refreshPluginList();
            if (window.StuartPlugins?.loadAll) await window.StuartPlugins.loadAll();
          } catch (_) {}
        }, 0);
        window.dispatchEvent(new CustomEvent("stuart-ready"));
        if (info?.startup_file) {
          hideBootSplash();
          const res = await window.pywebview.api.open_path(info.startup_file);
          if (res?.error) {
            toast(res.error);
            showHomePage();
          } else if (res?.kind === "folder") {
            await loadFolder(res.path);
            showHomePage();
          } else if (res?.b64 || res?.content != null) {
            if (state.openMode === "current_window" || state.tabs.length) {
              await addOrFocusTab(res);
            } else {
              setDocument(res);
            }
            if (res.path) setWorkspaceFromPath(res.path);
            hideBootSplash();
            persistSession();
          }
        } else {
          // Cold start without CLI file → last session files first
          const session = (s && s.session) || { tabs: [], active_path: "" };
          const lastFiles = Array.isArray(s && s.last_open_files) ? s.last_open_files : [];
          const tabPaths = (session.tabs && session.tabs.length ? session.tabs : lastFiles).filter(
            Boolean
          );
          let restored = false;
          if (tabPaths.length) {
            restored = await restoreSessionTabs({
              tabs: tabPaths,
              active_path: session.active_path || "",
            });
          }
          if (!restored) {
            if (!state.sampleDismissed) {
              const ok = await openSampleDirect();
              if (!ok) showHomePage();
            } else {
              showHomePage();
            }
          }
        }
      } catch (_) {
        hideBootSplash();
        showHomePage();
      }
    }

    if (window.pywebview?.api) {
      onReady();
    } else {
      window.addEventListener("pywebviewready", onReady, { once: true });
      setTimeout(() => {
        if (!state.apiReady) {
          hideBootSplash();
          /* welcome loaded via open_welcome() */
        }
      }, 800);
    }

    // Splash covers white flash; home card is shown only when boot decides so
    el.welcome.hidden = true;
    el.editorArea.hidden = true;
  }

  // ---------- Agent host bridge (plugins / mid-term AI) ----------
  const _agentBus = typeof EventTarget !== "undefined" ? new EventTarget() : null;

  function emitAgentEvent(type, detail) {
    if (!_agentBus) return;
    try {
      _agentBus.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
    } catch (_) {}
  }

  function getDocumentHost() {
    return {
      kind: state.path && String(state.path).toLowerCase().endsWith(".pdf") ? "pdf" : "markdown",
      documentId: activeDocument?.documentId,
      documentKey: activeDocument?.documentKey,
      revision: activeDocument?.revision,
      diskRevision: activeDocument?.diskRevision,
      path: state.path,
      name: state.name,
      mode: state.mode,
      theme: state.theme,
      dirty: !!state.dirty,
      content:
        state.path && String(state.path).toLowerCase().endsWith(".pdf")
          ? ""
          : activeDocument?.source ?? el.source.value ?? "",
      stats: getStatsHost(),
    };
  }

  function getStatsHost() {
    const core = CoreDoc();
    const text = el.source.value || "";
    return {
      chars: core ? core.countChars(text) : text.replace(/\s/g, "").length,
      lines: core ? core.countLines(text) : text ? text.split("\n").length : 0,
    };
  }

  function getReadingAnchorHost() {
    if (!activeDocument) throw new Error("当前没有可阅读的文档");
    if (activeDocument.kind === "pdf") return { documentId: activeDocument.documentId, revision: activeDocument.revision,
      page: window.StuartMDPdf.getCurrentPage() };
    let utf16Offset;
    if (state.mode === "source" || document.activeElement === el.source) {
      utf16Offset = el.source.selectionStart;
    } else {
      const area = el.preview.getBoundingClientRect();
      const visible = Array.from(el.preview.querySelectorAll(":scope > .md-block"))
        .find(node => node.getBoundingClientRect().bottom > area.top);
      if (visible && (visible.dataset.documentId !== activeDocument.documentId || Number(visible.dataset.revision) !== activeDocument.revision)) {
        throw new Error("阅读位置的正文版本已经变化");
      }
      utf16Offset = visible ? Number(visible.dataset.sourceOffset) : 0;
      if (!Number.isInteger(utf16Offset)) throw new Error("当前正文没有有效的阅读位置");
    }
    return { documentId: activeDocument.documentId, revision: activeDocument.revision, utf16Offset };
  }

  function sourceSelectionRange(start, end) {
    if (!activeDocument) throw new Error("选区所属文档不存在");
    activeDocument.buffer.sourceOffset(start); activeDocument.buffer.sourceOffset(end);
    return { from: start, to: end };
  }

  function setDocumentHost(text, opts) {
    const o = opts || {};
    if (state.path && String(state.path).toLowerCase().endsWith(".pdf")) {
      return { error: "PDF 文档不可直接写 Markdown" };
    }
    commitActiveEditsForHistory();
    const next = text == null ? "" : String(text);
    setContent(next, o.fromUser !== false);
    if (o.fromUser !== false) {
      // ensure preview rebuild path sees latest
      lastPreviewSource = "";
      lastPreviewBlocks = [];
      if (state.mode !== "source") renderMarkdown(next);
      lastPreviewSource = next;
      lastPreviewBlocks = splitMarkdownBlocks(next);
    }
    emitAgentEvent("document-set", { source: o.source || "agent" });
    return { ok: true, length: next.length };
  }

  function getOutlineHost() {
    const text = el.source.value || "";
    const out = [];
    const lines = text.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s{0,3}(```+|~~~+)/);
      if (fence) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        out.push({
          level: m[1].length,
          title: m[2].trim(),
          line: i + 1,
        });
      }
    }
    return out;
  }

  function getBlocksHost() {
    const blocks = splitMarkdownBlocks(el.source.value || "");
    return blocks.map((text, index) => ({
      index,
      text,
      preview: String(text).slice(0, 120),
    }));
  }

  function getSelectionInfoHost() {
    captureSelectionCache();
    // PDF viewer path first
    try {
      if (window.StuartMDPdf && window.StuartMDPdf.isActive && window.StuartMDPdf.isActive()) {
        const ps = window.StuartMDPdf.getSelection && window.StuartMDPdf.getSelection();
        if (ps && ps.text) {
          return {
            text: ps.text,
            documentId: activeDocument.documentId,
            revision: activeDocument.revision,
            inPreview: false,
            inPdf: true,
            page: ps.page,
            pdfRects: ps.pdfRects || [],
            segments: ps.segments || [],
            fileFingerprint: ps.fileFingerprint,
            start: null,
            end: null,
            blockIndex: null,
          };
        }
        const cachePdf = getSelectionCache();
        if (cachePdf && cachePdf.text) {
          return {
            text: cachePdf.text,
            documentId: activeDocument.documentId,
            revision: activeDocument.revision,
            inPreview: false,
            inPdf: true,
            page: cachePdf.page || null,
            pdfRects: cachePdf.pdfRects || [],
            segments: cachePdf.segments || [],
            fileFingerprint: cachePdf.fileFingerprint,
            start: null,
            end: null,
            blockIndex: null,
          };
        }
      }
    } catch (_) {}
    const ta = el.source;
    const sel = window.getSelection();
    let text = "";
    let inPreview = false;
    try {
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        const raw = String(sel.toString() || "");
        if (raw.trim()) {
          const anchorOk =
            !el.preview ||
            el.preview.contains(sel.anchorNode) ||
            el.preview.contains(sel.focusNode) ||
            !!(sel.anchorNode && sel.anchorNode.parentElement && el.preview.contains(sel.anchorNode.parentElement));
          const srcOk = ta && (ta === document.activeElement || ta.contains(sel.anchorNode));
          if (anchorOk || srcOk) {
            text = raw;
            inPreview = !!(el.preview && (el.preview.contains(sel.anchorNode) || el.preview.contains(sel.focusNode)));
          }
        }
      }
    } catch (_) {}
    // Live selection lost (accidental click / block edit) → use snapshot from selection bar
    const cache = getSelectionCache();
    if (!text.trim() && cache && cache.text) {
      text = cache.text;
      inPreview = !!cache.inPreview;
    }
    if (!text && ta && typeof ta.selectionStart === "number") {
      text = ta.value.slice(ta.selectionStart, ta.selectionEnd) || "";
    }
    let blockIndex = typeof state._activeBlockIndex === "number" ? state._activeBlockIndex : null;
    if (cache && typeof cache.blockIndex === "number") blockIndex = cache.blockIndex;
    try {
      if (sel && !sel.isCollapsed && sel.anchorNode) {
        const b = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.(".md-block");
        if (b && b.dataset.index != null) blockIndex = Number(b.dataset.index);
      }
    } catch (_) {}
    return {
      text,
      inPreview,
      documentId: activeDocument?.documentId,
      revision: activeDocument?.revision,
      from: inPreview ? cache?.from ?? null : null,
      to: inPreview ? cache?.to ?? null : null,
      start: inPreview ? null : cache?.text === text ? cache.start ?? ta?.selectionStart ?? null : ta?.selectionStart ?? null,
      end: inPreview ? null : cache?.text === text ? cache.end ?? ta?.selectionEnd ?? null : ta?.selectionEnd ?? null,
      blockIndex,
      fromCache: !!(cache && !String(sel && !sel.isCollapsed ? sel.toString() : "").trim() && cache.text === text),
    };
  }

  function insertTextAtSelectionHost(text) {
    const s = String(text == null ? "" : text);
    if (state.mode === "source" || document.activeElement === el.source) {
      const ta = el.source;
      const start = ta.selectionStart || 0;
      const end = ta.selectionEnd || 0;
      const v = ta.value;
      ta.value = v.slice(0, start) + s + v.slice(end);
      ta.selectionStart = ta.selectionEnd = start + s.length;
      setContent(ta.value, true);
      ta.focus();
      return { ok: true };
    }
    // Preview mode: append as paragraph via setContent
    const cur = el.source.value || "";
    const next = cur + (cur.endsWith("\n") || !cur ? "" : "\n\n") + s;
    setContent(next, true);
    return { ok: true, mode: "append" };
  }

  function applyBlockActionHost(index, action) {
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0) return { error: "invalid block index" };
    state._activeBlockIndex = idx;
    applyBlockLineAction(action);
    return { ok: true, index: idx, action };
  }

  function findInDocumentHost(query) {
    const q = String(query == null ? "" : query).trim();
    if (!q) return { hits: 0 };
    const text = el.source.value || "";
    const needle = q.toLowerCase();
    let hits = 0;
    let from = 0;
    while (from < text.length) {
      const i = text.toLowerCase().indexOf(needle, from);
      if (i < 0) break;
      hits++;
      from = i + needle.length;
    }
    return { hits, query: q };
  }

  function undoHost() {
    commitActiveEditsForHistory();
    return !!undoEdit();
  }

  function redoHost() {
    commitActiveEditsForHistory();
    return typeof redoEdit === "function" ? !!redoEdit() : false;
  }

  // StuartMD Inspiration Companion & Visual Diff Integration
  Object.defineProperty(window, "currentFilePath", {
    get() {
      return state.path;
    },
    configurable: true,
  });

  window.openFileByPath = async filePath => {
    const record = await window.pywebview.api.open_path(filePath);
    if (record.error) throw new Error(record.error);
    if (record.kind === "folder") throw new Error("打开文件需要实际文件路径");
    await addOrFocusTab(record);
    return getDocumentHost();
  };

  async function openKnowledgeSource(hit) {
    const anchor = hit?.anchor || hit;
    const path = anchor?.path || (hit?.workspaceRoot && hit.relPath ? hit.workspaceRoot.replace(/[\\/]+$/, "") + "/" + hit.relPath : null);
    const fingerprint = anchor?.fileFingerprint || anchor?.sourceHash;
    if (!path || !fingerprint) throw new Error("来源缺少实际文件路径或指纹");
    await window.StuartAIService.flushDraft();
    await window.openFileByPath(path);
    const current = getDocumentHost();
    if (current.diskRevision.rawByteSha256 !== fingerprint) throw new Error("来源文件已经变化，请重新读取来源");
    const pageNumber = anchor.page || hit.pageNumber;
    if (pageNumber) {
      const bounds = anchor.bounds || { rects: anchor.rects || anchor.blocks?.flatMap(block => block.rects) || [], sourceHash: fingerprint };
      await window.StuartMDPdf.openAnchor({ ...hit, ...anchor, pageNumber, sourceHash: fingerprint, bounds }); return;
    }
    if (anchor.sourceHash && anchor.fileFingerprint) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(current.content));
      const actual = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== anchor.sourceHash) throw new Error("来源编辑快照与当前正文不同，请在来源预览中查看归档摘录");
    }
    if (!anchor.utf16Range && !anchor.byteRange && !hit.startLine && !anchor.startLine) return;
    setMode("source");
    let from, to;
    if (anchor.utf16Range) [from, to] = anchor.utf16Range;
    else if (anchor.byteRange) {
      const bytes = new TextEncoder().encode(current.content), decoder = new TextDecoder("utf-8", { fatal: true });
      [from, to] = anchor.byteRange.map(offset => decoder.decode(bytes.slice(0, offset)).replace(/\r\n|\r/g, "\n").length);
    } else {
      const startLine = anchor.startLine || hit.startLine, endLine = anchor.endLine || hit.endLine, lines = el.source.value.split("\n");
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length) throw new Error("来源行号超出当前正文");
      from = lines.slice(0, startLine - 1).reduce((offset,line) => offset + line.length + 1, 0);
      to = lines.slice(0, endLine).reduce((offset,line) => offset + line.length + 1, 0) - 1;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > el.source.value.length) throw new Error("来源位置超出当前正文");
    el.source.focus(); el.source.setSelectionRange(from, to);
    const lineHeight = parseFloat(getComputedStyle(el.source).lineHeight);
    el.source.scrollTop = Math.max(0, (el.source.value.slice(0, from).split("\n").length - 2) * lineHeight);
    captureSelectionCache();
  }

  async function restoreCompanionDocument(restored) {
    await window.StuartMD.setWorkspaceRoot(restored.session.workspaceRoot || null);
    if (restored.kind === "workspace") return;
    if (restored.kind === "document") return addOrFocusTab(restored.document);
    if (restored.kind === "draft") return window.StuartMD.restoreDocument(restored.document);
    throw new Error("会话恢复响应的文档类型无效");
  }

  async function saveCompanionNote({ question, answer, status, sources, messageId, requestId }) {
    if (!messageId || !requestId || !answer) throw new Error("保存笔记需要实际归档答案");
    const current = getDocumentHost(), title = (current.name || "伴读").replace(/\.[^.]+$/, "") + ".伴读笔记.md";
    const target = await window.pywebview.api.choose_save_path(title);
    if (!target) return;
    const revision = await window.pywebview.api.document_target_revision(target);
    if (revision.exists && !await window.StuartUIConfirm("目标文件已经存在。确定用这份伴读笔记替换该文件吗？")) return;
    const sourceLines = sources.map(source => {
      const anchor = source.anchor || {};
      return `- ${source.title || source.kind}；${anchor.path || anchor.documentId || anchor.recordId || "归档来源"}${anchor.page ? `；第 ${anchor.page} 页` : ""}；指纹 ${anchor.sourceHash || anchor.fileFingerprint || ""}`;
    });
    const body = `# 伴读笔记\n\n保存时间：${new Date().toLocaleString()}\n\n回答状态：${status}\n\n## 问题\n\n${question}\n\n## 回答\n\n${answer}\n\n## 来源\n\n${sourceLines.join("\n")}\n\n归档消息：${messageId}\n请求编号：${requestId}\n`;
    const record = await window.pywebview.api.document_new(), note = new window.StuartCore.DocumentSession(record);
    note.updateSource(body);
    const result = await saveCapturedDocument(note, note.snapshot(), target, revision);
    if (result.result !== "Saved") throw new Error("笔记保存期间目标文件已经变化，请重新选择保存位置");
    await window.pywebview.api.document_release(note.documentId);
    toast("伴读笔记已经保存：" + target);
    return result;
  }

  function resolveCompanionDraftConflict() {
    const value = window.StuartAIService.snapshot;
    if (!value.draftConflict) return;
    const dialog = document.createElement("dialog"), title = document.createElement("h2"), error = document.createElement("div");
    title.textContent = "检查草稿冲突"; error.className = "sc-error"; error.setAttribute("role", "alert");
    dialog.className = "stuart-recovery-dialog"; dialog.append(title, error);
    for (const [label, draft] of [["当前窗口的草稿", value.draft], ["其他窗口保存的草稿", value.draftConflict.draft]]) {
      const heading = document.createElement("h3"), content = document.createElement("pre"); heading.textContent = label;
      content.textContent = draft ? JSON.stringify({ question: draft.question, scope: draft.scope, selection: draft.selection, explicitSources: draft.explicitSources }, null, 2) : "当前会话没有输入草稿";
      dialog.append(heading, content);
    }
    const actions = document.createElement("div"); actions.className = "sc-actions";
    for (const [label, choice] of [["使用其他窗口的草稿", "remote"], ["将当前草稿保存到新会话", "independent"], ["继续查看", null]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "btn"; button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { if (choice) await window.StuartAIService.resolveDraftConflict(choice); dialog.close(); }
        catch (failure) { error.textContent = failure.message || String(failure); }
        finally { button.disabled = false; }
      }); actions.append(button);
    }
    const focused = document.activeElement;
    dialog.append(actions); dialog.addEventListener("close", () => { dialog.remove(); focused?.focus(); });
    document.body.append(dialog); dialog.showModal();
  }

  // expose for debugging + AI/plugins
  window.StuartMD = {
    state,
    flushDraftJournal,
    restoreDocument: record => addOrFocusTab({ ...record, content: record.source, diskRevision: record.baseDiskRevision, document: new window.StuartCore.DocumentSession({ ...record, diskRevision: record.baseDiskRevision }) }),
    openDocumentRecord: record => addOrFocusTab(record),
    setWorkspaceRoot: async root => {
      if (root) await loadFolder(root);
      else {
        state.folder = ""; state.workspaceRoot = "";
        await window.pywebview.api.rag_set_workspace(null);
        await window.StuartAIService.setWorkspace(null);
        window.dispatchEvent(new CustomEvent("stuart-workspace-changed", { detail: { workspaceRoot: null } }));
        el.folderName.textContent = "最近 / 欢迎";
        el.fileTree.replaceChildren();
        await refreshRecents();
        persistSession();
      }
    },
    openKnowledgeSource,
    restoreCompanionDocument,
    saveCompanionNote,
    resolveCompanionDraftConflict,
    getShortcutRegistrations: () => [
      { shortcut: "Alt+I", label: "伴读面板" }, { shortcut: "Ctrl+O", label: "打开文件" },
      { shortcut: "Ctrl+N", label: "新建文档" }, { shortcut: "Ctrl+S", label: "保存文件" },
      { shortcut: "Ctrl+Shift+S", label: "另存为" }, { shortcut: "Ctrl+Z", label: "撤销" },
      { shortcut: "Ctrl+Shift+Z", label: "重做" }, { shortcut: "Ctrl+Y", label: "重做" },
      { shortcut: "Ctrl+B", label: "加粗或侧栏" }, { shortcut: "Ctrl+I", label: "斜体" },
      { shortcut: "Ctrl+F", label: "查找" }, { shortcut: "Ctrl+E", label: "导出" },
      { shortcut: "Ctrl+1", label: "阅读模式" }, { shortcut: "Ctrl+2", label: "分栏模式" },
      { shortcut: "Ctrl+3", label: "源码模式" }, { shortcut: "Ctrl+T", label: "切换主题" },
      { shortcut: "Ctrl+P", label: "打印" },
    ],
    saveDocumentSnapshot: (document, snapshot, targetPath, expectedDiskRevision) => saveCapturedDocument(document, snapshot, targetPath, expectedDiskRevision),
    saveDocumentCopy: async document => {
      const target = await window.pywebview.api.choose_save_path(document.title);
      if (!target) return;
      const revision = await window.pywebview.api.document_target_revision(target);
      if (revision.exists) throw new Error("副本必须保存到新文件");
      return saveCapturedDocument(document, document.snapshot(), target, revision);
    },
    reloadDocument: document => transitionDocument(async () => {
      const record = await window.pywebview.api.document_read(document.path);
      const tab = state.tabs.find(tab => tab.document === document);
      if (!tab) {
        await window.pywebview.api.document_release(record.documentId);
        throw new Error("重新读取的文档已经关闭");
      }
      const wasActive = activeDocument === document;
      await window.StuartAIService.releaseDocument(document.documentId);
      await window.StuartMDPdf.releaseDocument(document.documentId);
      await window.pywebview.api.document_release(document.documentId);
      tab.document = new window.StuartCore.DocumentSession(record);
      tab.content = record.content;
      tab.dirty = false;
      tab.rev = tab.document.revision;
      tab.history = { stack: [tab.document.source], i: 0 };
      tab.kind = record.kind;
      tab.b64 = record.b64;
      tab.annotations = record.annotations || [];
      if (wasActive) setDocument({ ...record, document: tab.document });
    }),
    confirmDocumentEncoding: async (documentId, encoding) => {
      const record = await window.pywebview.api.document_confirm_encoding(documentId, encoding);
      const tab = state.tabs.find(tab => tab.document?.documentId === documentId);
      if (tab) tab.document = new window.StuartCore.DocumentSession(record);
      setDocument({ ...record, document: tab?.document });
    },
    setMode,
    setTheme,
    openFile,
    toast,
    getDocument: getDocumentHost,
    getReadingAnchor: getReadingAnchorHost,
    sourceSelectionRange,
    confirmPdfSave: (documentId, result) => {
      const session = state.tabs.find(tab => tab.document?.documentId === documentId)?.document || (activeDocument?.documentId === documentId ? activeDocument : null);
      if (!session || result.documentId !== documentId || result.result !== "Saved") throw new Error("PDF保存结果与文档身份不一致");
      session.diskRevision = result.diskRevision;
      if (activeDocument === session) {
        state._selCache = null;
        window.StuartAIService?.setDocument(session);
      }
    },
    setDocumentText: setDocumentHost,
    getStats: getStatsHost,
    getOutline: getOutlineHost,
    getBlocks: getBlocksHost,
    getSelectionInfo: getSelectionInfoHost,
    getSelectionCache: getSelectionCache,
    captureSelectionCache: captureSelectionCache,
    insertTextAtSelection: insertTextAtSelectionHost,
    applyBlockActionAt: applyBlockActionHost,
    findInDocument: findInDocumentHost,
    undo: undoHost,
    redo: redoHost,
    onAgentEvent(type, fn) {
      if (!_agentBus || typeof fn !== "function") return () => {};
      _agentBus.addEventListener(type, fn);
      return () => _agentBus.removeEventListener(type, fn);
    },
    offAgentEvent(type, fn) {
      if (_agentBus && fn) _agentBus.removeEventListener(type, fn);
    },
    emitAgentEvent,
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
