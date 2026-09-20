/* StuartMD application logic */
(function () {
  "use strict";

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
  let mermaidIdleId = null;
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
    if (core) return core.splitMarkdownBlocks(text);
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
    const core = CoreDoc();
    if (core) return core.joinBlocks(blocks);
    return blocks.join("\n\n");
  }

  function blockNeedsPostProcess(block) {
    // Skip KaTeX / image resolve on plain paragraphs for speed
    if (!block) return false;
    if (block.indexOf("$") >= 0) return true;
    if (block.indexOf("\\(") >= 0 || block.indexOf("\\[") >= 0) return true;
    if (/!\[[^\]]*\]\(/.test(block)) return true;
    return false;
  }

  function createBlockNode(block, index) {
    const wrap = document.createElement("div");
    wrap.className = "md-block";
    wrap.dataset.index = String(index);
    let html = "";
    try {
      html = md.render(block);
    } catch (e) {
      html = `<pre>${escapeHtml(String(e))}</pre>`;
    }
    wrap.innerHTML = html;
    sanitizeRenderedHtml(wrap);
    return wrap;
  }

  /** Strip executable HTML while keeping layout tags (tables, lists, images). */
  function sanitizeRenderedHtml(root) {
    if (!root || root.nodeType !== 1) return;
    try {
      root.querySelectorAll("script,iframe,object,embed,link[rel=import]").forEach((n) => n.remove());
      const all = root.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const attrs = Array.from(el.attributes || []);
        for (let j = 0; j < attrs.length; j++) {
          const a = attrs[j];
          const n = a.name || "";
          const v = a.value || "";
          if (/^on/i.test(n)) el.removeAttribute(n);
          else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(v)) {
            el.removeAttribute(n);
          }
        }
      }
    } catch (_) {}
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

  function applyBlockEditing() {
    if (state.mode === "source") return;
    const raw = el.source.value || "";
    const blocks = splitMarkdownBlocks(raw);
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

    if (heavy) {
      el.preview.innerHTML = "";
      const frag = document.createDocumentFragment();
      blocks.forEach((block, index) => {
        const wrap = createBlockNode(block, index);
        if (blockNeedsPostProcess(block)) postProcessBlock(wrap);
        frag.appendChild(wrap);
      });
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
        if (blockNeedsPostProcess(blocks[i])) postProcessBlock(wrap);
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

  function hideSelToolbar() {
    const bar = document.getElementById("sel-toolbar");
    if (bar) bar.hidden = true;
    hideSelDropdown();
  }

  function hideSelDropdown() {
    const dd = document.getElementById("sel-dropdown");
    if (dd) dd.hidden = true;
  }

  function showSelToolbarNear(rect) {
    const bar = document.getElementById("sel-toolbar");
    if (!bar || !rect) return;
    hideBlockHandle();
    hideBlockMenu();
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
      if (e.target.closest("#sel-toolbar") || e.target.closest("#sel-dropdown")) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hideSelToolbar();
        return;
      }
      const inPreview = el.preview.contains(e.target) || el.preview.contains(sel.anchorNode);
      const inSource = el.source === document.activeElement;
      if (!inPreview && !inSource) {
        hideSelToolbar();
        return;
      }
      showSelToolbarNear(sel.getRangeAt(0).getBoundingClientRect());
    });
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest("#sel-toolbar") && !e.target.closest("#sel-dropdown")) {
        hideSelToolbar();
      }
      if (!e.target.closest("#block-handle") && !e.target.closest("#block-menu")) {
        hideBlockMenu();
      }
    });
  }

  function hideBlockMenu() {
    const m = document.getElementById("block-menu");
    if (m) m.hidden = true;
  }

  function showBlockMenuAt(x, y, blockIndex, anchorRect) {
    state._activeBlockIndex = blockIndex;
    const menu = document.getElementById("block-menu");
    if (!menu) return;
    // Compact 4-col / 3-row icon grid — narrower panel, less occlusion
    menu.innerHTML = `
      <div class="menu-grid" title="块类型">
        <button type="button" data-bm="p" title="正文">T</button>
        <button type="button" data-bm="h1" title="标题 1">H1</button>
        <button type="button" data-bm="h2" title="标题 2">H2</button>
        <button type="button" data-bm="h3" title="标题 3">H3</button>
        <button type="button" data-bm="ol" title="有序列表">1.</button>
        <button type="button" data-bm="ul" title="无序列表">•</button>
        <button type="button" data-bm="task" title="任务列表">☑</button>
        <button type="button" data-bm="code" title="代码块">{ }</button>
        <button type="button" data-bm="quote" title="引用">❝</button>
        <button type="button" data-bm="indent-" title="减少缩进">⇤</button>
        <button type="button" data-bm="indent+" title="增加缩进">⇥</button>
        <button type="button" data-bm="copy-block" title="复制">⧉</button>
      </div>
      <div class="menu-sep"></div>
      <button type="button" class="menu-row" data-bm-sub="indent">
        <span class="mr-ico">☰</span><span class="mr-label">缩进和对齐</span><span class="mr-caret">›</span>
      </button>
      <div class="menu-sub" data-sub="indent" hidden>
        <button type="button" data-bm="indent+">增加缩进</button>
        <button type="button" data-bm="indent-">减少缩进</button>
        <button type="button" data-bm="align-left">左对齐</button>
        <button type="button" data-bm="align-center">居中</button>
        <button type="button" data-bm="align-right">右对齐</button>
      </div>
      <div class="menu-sep"></div>
      <button type="button" class="menu-row" data-bm="cut-block"><span class="mr-ico">✂</span><span>剪切</span></button>
      <button type="button" class="menu-row" data-bm="copy-block"><span class="mr-ico">⧉</span><span>复制</span></button>
      <button type="button" class="menu-row" data-bm="duplicate-block"><span class="mr-ico">⧉</span><span>创建副本</span></button>
      <button type="button" class="menu-row danger" data-bm="delete-block"><span class="mr-ico">🗑</span><span>删除</span></button>
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

  function hideBlockHandle() {
    const h = document.getElementById("block-handle");
    if (h) {
      h.hidden = true;
      h.classList.remove("visible");
      h.dataset.hover = "";
    }
  }

  function isSelToolbarVisible() {
    const bar = document.getElementById("sel-toolbar");
    return bar && !bar.hidden;
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

  /** Prefer list-item / table-row / heading as the "line" unit for the handle. */
  function lineUnitFromNode(node) {
    if (!node) return null;
    return (
      node.closest?.("li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote") || node
    );
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

    // Band fallback: pick closest block, then line inside it if possible
    const blocks = $$(".md-block", el.preview);
    let best = null;
    let bestDist = Infinity;
    for (const b of blocks) {
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
    const target = lineEl && lineEl.isConnected && lineEl !== block ? lineEl : block;
    const br = target.getBoundingClientRect();
    handle.hidden = false;
    handle.classList.add("visible");
    const hw = handle.offsetWidth || 52;
    const left = Math.max(6, br.left - hw - 8);
    const top = Math.max(6, br.top);
    handle.style.position = "fixed";
    handle.style.top = top + "px";
    handle.style.left = left + "px";
    state._activeBlockIndex = Number(block.dataset.index || 0);
    state._handleAnchor = target;
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
    });
    handle.addEventListener("mouseleave", () => {
      handle.dataset.hover = "";
      if (menu && !menu.hidden) scheduleHideBlockMenu();
      else scheduleHideBlockHandle(240);
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

    // One document-level tracker — elementFromPoint + band fallback
    let rafId = 0;
    let px = 0;
    let py = 0;
    const tick = () => {
      rafId = 0;
      if (state.mode === "source") {
        hideBlockHandle();
        return;
      }
      if (isSelToolbarVisible()) {
        hideBlockHandle();
        return;
      }
      const editingEl = getActiveEditingBlock();
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

    el.preview.addEventListener("click", (e) => {
      const a = e.target.closest("a");
      if (a && el.preview.contains(a)) {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#")) {
          e.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          const target =
            el.preview.querySelector(`[id="${CSS.escape(id)}"]`) ||
            findHeadingByText(id);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) {
          e.preventDefault();
          e.stopPropagation();
          if (state.apiReady && window.pywebview?.api?.open_url) {
            window.pywebview.api.open_url(href);
          }
        }
        return;
      }

      if (e.target.closest("button, input, textarea, .md-block-source")) {
        return;
      }
      if (state.mode === "source") return;
      const node = e.target.closest(".md-block");
      if (!node || node.classList.contains("editing")) return;
      if (e.detail > 1) return;
      clearTimeout(bindPreviewDelegates._clickTimer);
      bindPreviewDelegates._clickTimer = setTimeout(() => {
        if (!document.contains(node)) return;
        if (node.classList.contains("editing")) return;
        // Code blocks: single-click → source edit
        if (node.querySelector("pre")) {
          enterBlockSourceEdit(node);
          return;
        }
        // Mermaid / display math: no in-place edit on click (use double-click / menu)
        if (node.querySelector(".mermaid-diagram, .katex-display")) return;
        enterBlockEdit(node);
      }, 200);
    });

    el.preview.addEventListener("dblclick", (e) => {
      // Allow code / KaTeX / mermaid / tables — enter source edit
      if (e.target.closest("a, button, input, textarea, .md-block-source")) {
        return;
      }
      if (state.mode === "source") return;
      const node = e.target.closest(".md-block");
      if (!node) return;
      e.preventDefault();
      clearTimeout(bindPreviewDelegates._clickTimer);
      if (node.classList.contains("editing")) return;
      enterBlockSourceEdit(node);
    });
  }

  function htmlToMarkdown(root) {
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = (node.tagName || "").toLowerCase();
      const kids = () => [...node.childNodes].map(walk).join("");
      switch (tag) {
        case "br":
          return "\n";
        case "strong":
        case "b":
          return `**${kids().trim()}**`;
        case "em":
        case "i":
          return `*${kids().trim()}*`;
        case "del":
        case "s":
        case "strike":
          return `~~${kids().trim()}~~`;
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
        case "katex":
        case "math":
          return node.getAttribute("data-tex") || node.textContent || "";
        default:
          if (node.classList?.contains("katex") || node.closest?.(".katex")) {
            const tex = node.closest("[data-tex]")?.getAttribute("data-tex");
            if (tex) return tex;
            const annotation = node.querySelector("annotation[encoding='application/x-tex']");
            if (annotation) return annotation.textContent;
          }
          return kids();
      }
    };
    let out = walk(root)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return out;
  }

  function placeCaretOnClick(target) {
    try {
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
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
      // Force a re-render so contenteditable DOM is replaced
      lastPreviewSource = "";
      try {
        renderMarkdown(el.source.value);
        lastPreviewSource = el.source.value;
        lastPreviewBlocks = splitMarkdownBlocks(el.source.value || "");
      } catch (_) {}
    });
  }

  function blockNeedsSourceEdit(node) {
    return !!(node.querySelector(".katex, .mermaid-diagram, pre"));
  }

  function enterBlockSourceEdit(node) {
    if (node.classList.contains("editing")) return;
    $$(".md-block.editing", el.preview).forEach((n) => exitBlockEditVisual(n));
    const idx = Number(node.dataset.index || 0);
    const blocks = splitMarkdownBlocks(el.source.value || "");
    const original = blocks[idx] ?? "";
    node.classList.add("editing", "source-edit");
    const prevScroll = el.previewPane.scrollTop;
    node.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "md-block-source";
    ta.value = original.replace(/\s+$/, "");
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
    const cleanupDocDown = () => {
      document.removeEventListener("mousedown", onDocDown, true);
    };
    const commit = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      const next = ta.value;
      const all = splitMarkdownBlocks(el.source.value || "");
      all[idx] = next;
      const joined = joinBlocks(all);
      lastPreviewSource = "";
      node.classList.remove("editing", "source-edit");
      node.innerHTML = "";
      el.source.value = joined;
      state.content = joined;
      markDirty();
      scheduleAutoSave();
      renderMarkdown(joined);
      lastPreviewSource = joined;
      lastPreviewBlocks = splitMarkdownBlocks(joined);
      pushHistory(joined);
      emitAgentEvent("document-changed", { source: "block-edit" });
      try {
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
    };
    const cancel = () => {
      if (done) return;
      done = true;
      cleanupDocDown();
      lastPreviewSource = "";
      node.classList.remove("editing", "source-edit");
      node.innerHTML = "";
      renderMarkdown(el.source.value);
      lastPreviewSource = el.source.value;
      lastPreviewBlocks = splitMarkdownBlocks(el.source.value || "");
      pushHistory(el.source.value || "");
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

  function enterBlockEdit(node) {
    if (node.classList.contains("editing")) return;
    // exit any other editing block first
    $$(".md-block.editing", el.preview).forEach((n) => {
      exitBlockEditVisual(n);
    });
    const idx = Number(node.dataset.index || 0);
    node.classList.add("editing");
    const editableRoots = [...node.children].filter(Boolean);
    const hosts = editableRoots.length ? editableRoots : [node];
    hosts.forEach((h) => {
      h.setAttribute("contenteditable", "true");
      h.spellcheck = false;
      h.style.outline = "none";
    });
    placeCaretOnClick(hosts[0]);

    let done = false;
    const clearDoc = () => document.removeEventListener("mousedown", onDocDown, true);
    const finishRestore = (text) => {
      lastPreviewSource = "";
      exitBlockEditVisual(node);
      renderMarkdown(text);
      lastPreviewSource = text;
      lastPreviewBlocks = splitMarkdownBlocks(text || "");
    };
    const commit = () => {
      if (done) return;
      done = true;
      clearDoc();
      const mdText = htmlToMarkdown(node).trim();
      const all = splitMarkdownBlocks(el.source.value || "");
      all[idx] = mdText || all[idx] || "";
      const joined = joinBlocks(all);
      el.source.value = joined;
      state.content = joined;
      markDirty();
      scheduleAutoSave();
      finishRestore(joined);
      try {
        if (document.activeElement && node.contains(document.activeElement)) {
          document.activeElement.blur?.();
        }
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
    };
    const cancel = () => {
      if (done) return;
      done = true;
      clearDoc();
      finishRestore(el.source.value);
      try {
        document.getSelection()?.removeAllRanges();
      } catch (_) {}
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

  function renderMarkdown(text) {
    // Prefer block-wise render for Typora-like click editing
    try {
      applyBlockEditing();
      return;
    } catch (_) {
      /* fall through */
    }

    let html = "";
    try {
      html = md.render(text || "");
    } catch (e) {
      html = `<pre>${escapeHtml(String(e))}</pre>`;
    }
    el.preview.innerHTML = html;

    // KaTeX
    if (window.renderMathInElement) {
      try {
        renderMathInElement(el.preview, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
          ],
          throwOnError: false,
          ignoredClasses: ["source-pane"],
        });
      } catch (_) {}
    }

    renderMermaid();

    // images: resolve relative paths
    $$("img", el.preview).forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (!src || src.startsWith("http") || src.startsWith("data:") || src.startsWith("file:")) return;
      if (state.apiReady && state.path && window.pywebview?.api?.resolve_asset) {
        window.pywebview.api
          .resolve_asset(state.path, src)
          .then((uri) => {
            if (uri) img.src = uri;
          })
          .catch(() => {});
      }
    });

    // links: open external in system browser via default; prevent in-app nav
    $$("a", el.preview).forEach((a) => {
      a.addEventListener("click", (e) => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#")) {
          e.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          const target =
            el.preview.querySelector(`[id="${CSS.escape(id)}"]`) ||
            findHeadingByText(id);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        // leave external links to default / open
      });
    });

    updateOutline();
    updateStats();
  }

  function findHeadingByText(text) {
    const t = text.trim().toLowerCase();
    return $$("h1,h2,h3,h4,h5,h6", el.preview).find(
      (h) => h.textContent.trim().toLowerCase() === t
    );
  }

  let mermaidReady = null;
  function ensureMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = (async () => {
      if (!window.mermaid) return false;
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme:
            state.theme === "dark" || state.theme === "gray"
              ? "dark"
              : state.theme === "minion"
                ? "neutral"
                : "default",
          fontFamily: "Segoe UI, PingFang SC, Microsoft YaHei, sans-serif",
        });
        return true;
      } catch (_) {
        return false;
      }
    })();
    return mermaidReady;
  }

  function renderMermaid() {
    const nodes = $$("pre.mermaid-src[data-mermaid]", el.preview);
    if (!nodes.length) return;
    if (mermaidIdleId) {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(mermaidIdleId);
      else clearTimeout(mermaidIdleId);
    }
    // Defer expensive SVG layout off the critical paint path
    mermaidIdleId = scheduleIdle(() => {
      mermaidIdleId = null;
      runMermaidRender(nodes);
    });
  }

  function runMermaidRender(nodes) {
    if (!nodes.length || !document.contains(nodes[0])) return;
    (async () => {
      const ok = await ensureMermaid();
      if (!ok || !window.mermaid) {
        nodes.forEach((n) => {
          n.classList.add("mermaid-fallback");
        });
        return;
      }
      let idx = 0;
      for (const pre of nodes) {
        const code = pre.textContent || "";
        const id = `mermaid-${Date.now()}-${idx++}`;
        const holder = document.createElement("div");
        holder.className = "mermaid";
        holder.id = id;
        holder.textContent = code;
        try {
          const { svg } = await window.mermaid.render(id + "-svg", code);
          const wrap = document.createElement("div");
          wrap.className = "mermaid-diagram";
          wrap.innerHTML = svg;
          sanitizeRenderedHtml(wrap);
          const svgEl = wrap.querySelector("svg");
          if (svgEl) {
            svgEl.removeAttribute("style");
            svgEl.style.maxWidth = "100%";
            svgEl.style.height = "auto";
          }
          pre.replaceWith(wrap);
        } catch (e) {
          pre.classList.add("mermaid-fallback");
          pre.setAttribute("title", "Mermaid 渲染失败：" + (e && e.message ? e.message : e));
        }
      }
    })();
  }

  function scheduleRender() {
    // Source-only typing should not rebuild the hidden preview
    if (state.mode === "source") return;
    if (renderTimer) cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => {
      clearTimeout(scheduleRender._t);
      const len = (el.source.value || "").length;
      const delay = len > 20000 ? 220 : len > 6000 ? 140 : 80;
      scheduleRender._t = setTimeout(() => {
        const next = el.source.value;
        // P0: identical content → skip expensive DOM rebuild
        if (next === lastPreviewSource) {
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
    const heads = liveHeadings();
    let sig = state.mode + "\n";
    for (let i = 0; i < heads.length; i++) {
      sig += heads[i].tagName + "|" + (heads[i].textContent || "") + "\n";
    }
    // Always rebind after preview DOM rebuild (nodes are new even if text is same)
    if (sig === lastOutlineSig && el.outlineList.childElementCount === heads.length) return;
    lastOutlineSig = sig;
    if (!heads.length) {
      el.outlineList.innerHTML = `<div class="empty-hint">暂无大纲</div>`;
      return;
    }
    el.outlineList.innerHTML = "";
    heads.forEach((h, i) => {
      if (!h.id) h.id = `h-${i}`;
      const level = Number(h.tagName.substring(1));
      const btn = document.createElement("button");
      btn.className = `outline-item l${level}`;
      btn.textContent = h.textContent || "(空标题)";
      btn.title = h.textContent || "";
      btn.addEventListener("click", () => jumpToHeadingIndex(i));
      el.outlineList.appendChild(btn);
    });
  }

  // ---------- Stats ----------
  function updateStats() {
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
    state.theme = theme;
    el.body.dataset.theme = theme;
    const darkish = theme === "dark" || theme === "gray";
    el.hlLight.disabled = darkish;
    el.hlDark.disabled = !darkish;
    if (mermaidReady) {
      mermaidReady = null;
      if (state.mode !== "source") scheduleRender();
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
    state.name = name || "未命名.md";
    state.content = content || "";
    state.dirty = false;
    el.source.value = state.content;
    resetHistory(state.content);
    el.fileTitle.textContent = state.name;
    el.dirtyDot.hidden = true;
    el.welcome.hidden = true;
    el.editorArea.hidden = false;
    const pdfArea = $("#pdf-area");
    if (pdfArea) pdfArea.hidden = true;
    el.statusPath.textContent = path || "未保存文档";
    updateWindowTitle();
    renderMarkdown(state.content);
    lastPreviewSource = state.content;
    lastPreviewBlocks = splitMarkdownBlocks(state.content);
    markActiveTreeItem();
    updatePinUi();
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      el.dirtyDot.hidden = false;
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab) tab.dirty = true;
      renderTabs();
      updateWindowTitle();
    }
  }

  function setContent(text, fromUser) {
    const prevVal = el.source.value;
    const changed = prevVal !== text;
    if (changed) el.source.value = text;
    if (state.content !== text) state.content = text;
    if (fromUser) {
      // Snapshot the pre-change state immediately so undo can restore inserts
      if (changed && _hist.stack.length && _hist.stack[_hist.i] !== prevVal) {
        clearTimeout(_histDebounce);
        pushHistory(prevVal);
      }
      if (!_hist.stack.length) resetHistory(prevVal || "");
      schedulePushHistory(text);
      markDirty();
      scheduleAutoSave();
    }
    updateStats();
    if (changed || fromUser) scheduleRender();
    if (changed) emitAgentEvent("document-changed", { fromUser: !!fromUser });
  }

  // ---------- Undo / Redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Ctrl+Shift+Y) ----------
  // Product policy: Ctrl+Shift+Z = undo (same as Ctrl+Z); redo = Ctrl+Y / Ctrl+Shift+Y
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
    pushHistory(el.source.value || "");
  }

  function resetHistory(text) {
    clearTimeout(_histDebounce);
    _hist.stack = [text || ""];
    _hist.i = 0;
  }

  /** Commit any in-flight block/source edit so new content enters the undo stack. */
  function commitActiveEditsForHistory() {
    $$(".md-block.editing", el.preview).forEach((n) => {
      try {
        if (typeof n._stuartCommit === "function") n._stuartCommit();
      } catch (_) {}
      const ta = n.querySelector("textarea.md-block-source");
      try {
        if (ta && typeof ta._stuartCommit === "function") ta._stuartCommit();
      } catch (_) {}
    });
  }

  function applyHistoryText(text) {
    clearTimeout(_histDebounce);
    el.source.value = text;
    state.content = text;
    // Force a clean preview rebuild (avoid incremental skip on insert undo)
    lastPreviewSource = "";
    lastPreviewBlocks = [];
    if (state.mode !== "source") {
      try {
        el.preview.innerHTML = "";
      } catch (_) {}
      renderMarkdown(text);
      lastPreviewSource = text;
      lastPreviewBlocks = splitMarkdownBlocks(text || "");
    }
    updateStats();
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
  const AUTOSAVE_MS = 1500;
  let autosaveTimer = null;

  function scheduleAutoSave() {
    if (!state.autosaveEnabled) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(doAutoSave, AUTOSAVE_MS);
  }

  async function doAutoSave() {
    if (!state.autosaveEnabled || !state.path || !state.dirty) return;
    if (String(state.path).toLowerCase().endsWith(".pdf")) return;
    if (!state.apiReady || !window.pywebview?.api?.write_file) return;
    try {
      const path = state.path;
      const tabId = state.activeTabId;
      const content = el.source.value;
      const res = await window.pywebview.api.write_file(path, content);
      if (res?.error) {
        return;
      }
      // Stale write: user switched document/tab while IO was in flight
      if (state.path !== path) return;
      state.content = content;
      state.lastAutosaveAt = Date.now();
      if (el.source.value === content) {
        state.dirty = false;
        el.dirtyDot.hidden = true;
        const tab = state.tabs.find((t) => t.id === tabId && t.path === path);
        if (tab) tab.dirty = false;
        updateWindowTitle();
      }
      updateAutosaveStatus();
      emitAgentEvent("document-saved", { path });
    } catch (_) {}
  }

  function updateAutosaveStatus() {
    const el2 = $("#status-autosave");
    if (!el2) return;
    if (!state.autosaveEnabled) {
      el2.textContent = "自动保存：关";
      el2.title = "可在设置中开启自动保存";
      return;
    }
    if (!state.path) {
      el2.textContent = "自动保存：待另存为";
      el2.title = "尚未保存到磁盘，自动保存需要先 Ctrl+Shift+S 另存为";
      return;
    }
    if (state.dirty) {
      el2.textContent = "自动保存：待写入";
      el2.title = "有未保存修改，约 1.5 秒后自动写入";
    } else {
      el2.textContent = "自动保存：开";
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

  function tabTitleFor(tab) {
    if (!tab) return "未命名";
    const folders = new Set(
      state.tabs.map((t) => folderOf(t.path)).filter(Boolean)
    );
    const name = tab.name || "未命名";
    if (folders.size > 1 && tab.path) {
      const f = folderOf(tab.path);
      if (f) return `${f} — ${name}`;
    }
    return name;
  }

  function saveActiveTabFromEditor() {
    if (!state.activeTabId) return;
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    tab.content = el.source.value;
    tab.dirty = state.dirty;
    tab.path = state.path;
    tab.name = state.name;
  }

  function renderTabs() {
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
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      item.appendChild(close);
      item.addEventListener("click", () => activateTab(tab.id));
      item.addEventListener("dragstart", (e) => {
        item.classList.add("dragging");
        e.dataTransfer.setData("text/stuart-tab", String(tab.id));
        e.dataTransfer.setData("text/plain", tab.path || tab.name || "");
        e.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
      });
      list.appendChild(item);
    });
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

  function activateTab(id) {
    if (state.activeTabId === id) {
      renderTabs();
      updatePinUi();
      return;
    }
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
    });
    state.dirty = !!tab.dirty;
    el.dirtyDot.hidden = !tab.dirty;
    renderTabs();
    updatePinUi();
  }

  async function addOrFocusTab(payload) {
    saveActiveTabFromEditor();
    const path = payload.path || null;
    if (path) {
      const exist = state.tabs.find((t) => t.path === path);
      if (exist) {
        activateTab(exist.id);
        return exist.id;
      }
    }
    const id = state.tabSeq++;
    const tab = {
      id,
      path,
      name: payload.name || "未命名.md",
      content: payload.content || "",
      dirty: false,
      kind: payload.kind || "markdown",
      b64: payload.b64,
      annotations: payload.annotations || [],
      pinned: !!payload.pinned,
    };
    state.tabs.push(tab);
    state.activeTabId = id;
    setDocument(payload);
    renderTabs();
    updatePinUi();
    return id;
  }

  async function closeTab(id, opts = {}) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    if (!opts.skipConfirm && tab.dirty) {
      const ok = confirm(`「${tabTitleFor(tab)}」有未保存修改，确定关闭？`);
      if (!ok) return;
    }
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
        });
        state.dirty = !!next.dirty;
        el.dirtyDot.hidden = !next.dirty;
      } else {
        state.activeTabId = null;
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
    _sessionPersistTimer = setTimeout(() => persistSession(), 400);
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
      tabs.push(p);
    });
    window.pywebview.api
      .save_settings({
        session: {
          tabs,
          active_path: state.path || "",
        },
        last_folder: state.folder || "",
        sample_dismissed: !!state.sampleDismissed,
      })
      .catch(() => {});
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
        setDocument(welcome);
        hideBootSplash();
        persistSession();
        return true;
      }
    }
    if (typeof SAMPLE === "string") {
      state.isSampleDoc = true;
      setDocument({ path: null, name: "欢迎使用 StuartMD.md", content: SAMPLE, welcome: true });
      hideBootSplash();
      return true;
    }
    return false;
  }

  async function restoreSessionTabs(session) {
    const paths = (session && Array.isArray(session.tabs) ? session.tabs : []).filter(
      (p) => p && typeof p === "string"
    );
    if (!paths.length) return false;
    let restored = 0;
    for (const p of paths) {
      try {
        if (window.pywebview.api.file_exists) {
          const ex = await window.pywebview.api.file_exists(p);
          if (ex === false) continue;
        }
        const res = await window.pywebview.api.open_path(p);
        if (!res || res.error || res.kind === "folder") continue;
        if (res.b64 || res.content != null) {
          await addOrFocusTab(res);
          restored++;
        }
      } catch (_) {}
    }
    if (!restored) return false;
    const activePath = (session && session.active_path) || "";
    if (activePath) {
      const tab = state.tabs.find((t) => t.path === activePath);
      if (tab) activateTab(tab.id);
    }
    hideBootSplash();
    persistSession();
    return true;
  }

  function bindTabBar() {
    const bar = $("#tabbar");
    if (!bar) return;
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
        await openDocumentRespectingMode(path, { forceTab: true });
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
    const root = parentDir(path);
    if (root) state.workspaceRoot = root;
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
        if (isStale(seq)) return;
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
      if (isStale(seq)) return;
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
    await refreshRecents();
  }

  /** Sidebar open: replace unpinned current tab; add tab if current is pinned. */
  async function openFromSidebar(payload) {
    if (!payload || payload.error) {
      if (payload?.error) toast(payload.error);
      return;
    }
    const path = payload.path || null;
    // Focus existing tab for same path
    if (path) {
      const exist = state.tabs.find((t) => t.path === path);
      if (exist) {
        activateTab(exist.id);
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
        if (!ok) return;
      }
      active.path = path;
      active.name = payload.name || "未命名.md";
      active.content = payload.content || "";
      active.kind = payload.kind || "markdown";
      active.b64 = payload.b64;
      active.annotations = payload.annotations || [];
      active.dirty = false;
      active.pinned = false;
      state.activeTabId = active.id;
      setDocument(payload);
      renderTabs();
      updatePinUi();
      return active.id;
    }

    const id = await addOrFocusTab(payload);
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
    const content = el.source.value;
    if (state.path) {
      const res = await window.pywebview.api.write_file(state.path, content);
      if (res?.error) {
        toast(res.error);
        return;
      }
      state.content = content;
      state.dirty = false;
      el.dirtyDot.hidden = true;
      updateWindowTitle();
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab) {
        tab.content = content;
        tab.dirty = false;
      }
      updateAutosaveStatus();
      renderTabs();
      toast("已保存");
    } else {
      await saveFileAs();
    }
  }

  async function saveFileAs() {
    if (!state.apiReady) return;
    const content = el.source.value;
    const res = await window.pywebview.api.save_file_dialog(content, state.name || "untitled.md");
    if (!res) return;
    if (res.error) {
      toast(res.error);
      return;
    }
    state.path = res.path;
    state.name = res.path.split(/[\\/]/).pop();
    state.content = content;
    state.dirty = false;
    el.dirtyDot.hidden = true;
    el.fileTitle.textContent = state.name;
    el.statusPath.textContent = res.path;
    updateWindowTitle();
    toast("已保存");
    updateAutosaveStatus();
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
      state.isSampleDoc = true;
      state.sampleDismissed = false;
      setDocument({ path: null, name: "示例文档.md", content: SAMPLE });
      setMode("preview");
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
    items.forEach((item) => {
      if (item.type === "dir") {
        const row = document.createElement("div");
        row.className = "tree-item dir";
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.innerHTML = `<span class="chev">›</span><span class="name"></span>`;
        row.querySelector(".name").textContent = item.name;
        const kids = document.createElement("div");
        kids.className = "tree-children";
        if (item.children?.length) renderTree(item.children, kids, depth + 1);
        // expand/collapse via delegated click on #file-tree
        container.appendChild(row);
        container.appendChild(kids);
      } else {
        const row = document.createElement("div");
        row.className = "tree-item file";
        row.dataset.path = item.path || "";
        row.style.paddingLeft = `${8 + depth * 14 + 14}px`;
        row.textContent = item.name;
        row.title = `${item.path}（中键或右键：新窗口打开）`;
        // Delegated on #file-tree — bound once in bindTreeDelegates
        container.appendChild(row);
      }
    });
  }

  function markActiveTreeItem() {
    // P0: skip full tree walk when active path is unchanged
    if (state.path === lastTreePath) return;
    lastTreePath = state.path;
    $$(".tree-item.file").forEach((n) => {
      n.classList.toggle("active", !!state.path && n.dataset.path === state.path);
    });
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
    recents.slice(0, 8).forEach((r) => {
      const btn = document.createElement("button");
      btn.className = "recent-item";
      btn.innerHTML = `<span></span><span class="path"></span>`;
      const [nameEl, pathEl] = btn.children;
      nameEl.textContent = r.name || r.path;
      pathEl.textContent = r.path;
      btn.addEventListener("click", async () => {
        if (r.kind === "folder") {
          await loadFolder(r.path);
          showSidebarPanel("files");
          toggleSidebar(true);
        } else {
          await openFile(r.path);
        }
      });
      el.recentList.appendChild(btn);
    });
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
    const html = buildExportHtml();
    const base = (state.name || "export").replace(/\.(md|markdown|txt)$/i, "") + ".html";
    const res = await window.pywebview.api.export_html(html, base);
    if (!res) return;
    if (res.error) toast(res.error);
    else toast(`已导出：${res.path}`);
  }

  function printPreview() {
    if (state.mode === "source") setMode("preview");
    // ensure preview is fresh
    renderMarkdown(el.source.value);
    // open a print-friendly window
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
    nodes.forEach((node) => {
      const text = node.nodeValue || "";
      const lower = text.toLowerCase();
      let from = 0;
      while (from < lower.length) {
        const i = lower.indexOf(needle, from);
        if (i < 0) break;
        ranges.push({ node, start: i, end: i + q.length });
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
      <button type="button" class="menu-row" data-ins="image"><span class="mr-ico">🖼</span><span>图像</span><span class="mr-caret" style="margin-left:auto;opacity:.45;font-size:11px">Ctrl+Shift+I</span></button>
      <button type="button" class="menu-row" data-ins="linkref"><span class="mr-ico">🔗</span><span>链接引用</span></button>
      <button type="button" class="menu-row" data-ins="hr"><span class="mr-ico">—</span><span>水平分割线</span></button>
      <button type="button" class="menu-row" data-ins="table"><span class="mr-ico">▦</span><span>表格</span><span class="mr-caret" style="margin-left:auto;opacity:.45;font-size:11px">Ctrl+T</span></button>
      <button type="button" class="menu-row" data-ins="code"><span class="mr-ico">{ }</span><span>代码块</span><span class="mr-caret" style="margin-left:auto;opacity:.45;font-size:11px">Ctrl+Shift+K</span></button>
      <button type="button" class="menu-row" data-ins="math"><span class="mr-ico">∑</span><span>公式块</span><span class="mr-caret" style="margin-left:auto;opacity:.45;font-size:11px">Ctrl+Shift+M</span></button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-row" data-ins="p-above"><span class="mr-ico">↑</span><span>段落（上方）</span></button>
      <button type="button" class="menu-row" data-ins="p-below"><span class="mr-ico">↓</span><span>段落（下方）</span></button>
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
    switch (action) {
      case "new":
        newDocument();
        break;
      case "open":
        openFileDialog();
        break;
      case "open-folder":
        openFolder();
        break;
      case "open-sample":
        openSample();
        break;
      case "save":
        saveFile();
        break;
      case "save-as":
        saveFileAs();
        break;
      case "export-html":
        exportHtml();
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
    $("#btn-outline").addEventListener("click", () => {
      toggleSidebar(true);
      showSidebarPanel("outline");
    });
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

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape" && !el.findBar.hidden) closeFind();
        return;
      }
      const k = e.key.toLowerCase();
      // Undo: Ctrl+Z / Ctrl+Shift+Z  |  Redo: Ctrl+Y / Ctrl+Shift+Y
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!undoEdit()) toast("没有可撤销的操作");
        return;
      }
      if (k === "z" && e.shiftKey) {
        e.preventDefault();
        if (!undoEdit()) toast("没有可撤销的操作");
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
        if (e.shiftKey) saveFileAs();
        else saveFile();
      } else if (k === "n") {
        e.preventDefault();
        newDocument();
      } else if (k === "b") {
        // Bold in editor; sidebar only when not typing
        const ae = document.activeElement;
        const editing =
          ae === el.source ||
          (ae && (ae.isContentEditable || ae.closest?.(".md-block.editing")));
        if (editing) return;
        if (!e.shiftKey) {
          e.preventDefault();
          toggleSidebar();
        }
      } else if (k === "f") {
        e.preventDefault();
        openFind();
      } else if (k === "e") {
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

  /** WYSIWYG block: execCommand + convert via htmlToMarkdown on blur. */
  function handleBlockEditKeydown(e, node) {
    // List: first Backspace at start of item removes the bullet, not the line
    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) {
        const anchor = sel.anchorNode;
        const li = (anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement))?.closest?.("li");
        if (li && node.contains(li)) {
          try {
            const range = sel.getRangeAt(0);
            const pre = range.cloneRange();
            pre.selectNodeContents(li);
            pre.setEnd(range.startContainer, range.startOffset);
            if (pre.toString().length === 0) {
              e.preventDefault();
              const liText = li.textContent.trim().slice(0, 24);
              const idx = Number(node.dataset.index || 0);
              const all = splitMarkdownBlocks(el.source.value || "");
              const src = all[idx] || "";
              const lines = src.split("\n");
              const key = liText.slice(0, 12);
              let changed = false;
              const nextLines = lines.map((line) => {
                if (changed) return line;
                if (!/^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+/.test(line)) return line;
                if (key && !line.includes(key) && liText && !line.includes(liText)) return line;
                changed = true;
                return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\s*- \[[ xX]\]\s+/, "");
              });
              if (changed) {
                all[idx] = nextLines.join("\n");
                const joined = joinBlocks(all);
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
              return;
            }
          } catch (_) {}
        }
      }
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
  const SAMPLE = `# 欢迎使用 StuartMD

这是一款**简约美观**的 Markdown 阅读与编辑器。

## 快速上手

1. 点击顶部 **打开文件** 或按 <kbd>Ctrl</kbd>+<kbd>O</kbd>
2. 使用 **阅读 / 分栏 / 源码** 三种模式切换
3. 按 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存（已开启自动保存）

## 功能一览

| 功能 | 快捷键 | 说明 |
|------|--------|------|
| 打开文件 | Ctrl+O | 选择本地 Markdown |
| 保存 | Ctrl+S | 写入当前文件 |
| 查找 | Ctrl+F | 文档内搜索 |
| 切换主题 | Ctrl+T | 浅色 / 深色 / 羊皮纸 / 小黄人 |
| 导出 HTML | Ctrl+E | 生成可分享页面 |
| 新窗口 | 工具栏 | 同时打开多个文档 |

## 代码高亮

\`\`\`javascript
function hello(name) {
  return \`Hello, \${name}!\`;
}
console.log(hello("StuartMD"));
\`\`\`

## LaTeX 公式

行内公式 $E = mc^2$，以及块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

## Mermaid 图表

\`\`\`mermaid
flowchart LR
  A[打开文件] --> B[阅读预览]
  B --> C[编辑分栏]
  C --> D[自动保存]
\`\`\`

## 任务列表

- [x] 打开并预览 Markdown
- [x] 语法高亮与公式 / Mermaid
- [ ] 写下你的第一篇笔记

---

左侧可打开文件夹浏览 Markdown；右键文件树可「新窗口打开」。
`;

  // ---------- Settings modal ----------
  function openSettingsModal() {
    $("#settings-modal").hidden = false;
    refreshSettingsModal();
  }

  function closeSettingsModal() {
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
        toast(`Language: ${btn.dataset.lang}`);
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
        box.innerHTML = `<div class="empty-hint">暂无插件</div>`;
        return;
      }
      list.forEach((p) => {
        const row = document.createElement("div");
        row.className = "plugin-item";
        const name = document.createElement("span");
        name.textContent = p.name || p.id;
        const btn = document.createElement("button");
        btn.className = "btn sm";
        btn.textContent = p.enabled ? "已启用" : "已禁用";
        btn.addEventListener("click", async () => {
          await window.pywebview.api.set_plugin_enabled(p.id, !p.enabled);
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
      bindSettingsEvents();
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
        // Association + plugins: non-critical, do not block boot path
        state.sampleDismissed = !!(s && s.sample_dismissed);
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
          const session = (s && s.session) || { tabs: [], active_path: "" };
          const restored = await restoreSessionTabs(session);
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
          setDocument({ path: null, name: "欢迎使用 StuartMD.md", content: SAMPLE, welcome: true });
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
      path: state.path,
      name: state.name,
      mode: state.mode,
      theme: state.theme,
      dirty: !!state.dirty,
      content:
        state.path && String(state.path).toLowerCase().endsWith(".pdf")
          ? ""
          : el.source.value || "",
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
    const ta = el.source;
    const sel = window.getSelection();
    let text = "";
    let inPreview = false;
    try {
      if (sel && !sel.isCollapsed && el.preview.contains(sel.anchorNode)) {
        text = sel.toString();
        inPreview = true;
      }
    } catch (_) {}
    if (!text && ta && typeof ta.selectionStart === "number") {
      text = ta.value.slice(ta.selectionStart, ta.selectionEnd) || "";
    }
    return {
      text,
      inPreview,
      start: ta ? ta.selectionStart : null,
      end: ta ? ta.selectionEnd : null,
      blockIndex: typeof state._activeBlockIndex === "number" ? state._activeBlockIndex : null,
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

  // expose for debugging + AI/plugins
  window.StuartMD = {
    state,
    setMode,
    setTheme,
    openFile,
    toast,
    getDocument: getDocumentHost,
    setDocumentText: setDocumentHost,
    getStats: getStatsHost,
    getOutline: getOutlineHost,
    getBlocks: getBlocksHost,
    getSelectionInfo: getSelectionInfoHost,
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
