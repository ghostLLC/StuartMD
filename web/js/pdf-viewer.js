/* StuartMD PDF viewer — pdf.js + annotation bar / underline / comments */
(function () {
  "use strict";

  if (window.pdfjsLib) {
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "libs/pdf.worker.min.js",
        window.location.href
      ).href;
    } catch (_) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";
    }
  }

  const PALETTE = [
    { id: "yellow", label: "黄", css: "rgba(255,232,96,0.34)", hex: "#ffe566", pdf: [1.0, 0.91, 0.23], line: "#d4a800" },
    { id: "lime", label: "黄绿", css: "rgba(163,210,80,0.32)", hex: "#a3d250", pdf: [0.64, 0.82, 0.31], line: "#7cb518" },
    { id: "red", label: "红", css: "rgba(255,80,90,0.22)", hex: "#ff505a", pdf: [1.0, 0.31, 0.35], line: "#e53935" },
    { id: "blue", label: "蓝", css: "rgba(100,170,230,0.28)", hex: "#64aae6", pdf: [0.39, 0.67, 0.9], line: "#1e88e5" },
    { id: "green", label: "绿", css: "rgba(120,200,130,0.32)", hex: "#78c882", pdf: [0.47, 0.78, 0.51], line: "#3d9a4f" },
    { id: "pink", label: "粉", css: "rgba(240,150,180,0.30)", hex: "#f096b4", pdf: [0.94, 0.59, 0.71], line: "#d4568a" },
  ];

  /** Per-type default colors (user spec) */
  const TYPE_DEFAULT_COLOR = {
    highlight: "yellow", // 淡黄
    underline: "lime", // 黄绿
    strike: "red", // 鲜红
    comment: "blue", // 蓝下划线
  };

  function colorMeta(id) {
    return PALETTE.find((c) => c.id === id) || PALETTE[0];
  }

  const state = {
    path: null,
    name: "",
    doc: null,
    page: 1,
    total: 1,
    scale: 1.2,
    baseScale: 1.2,
    rotation: 0,
    annotations: [],
    landscape: false,
    spread: false,
    selectedHlId: null,
    hlColor: "yellow",
    _pendingSel: null,
  };

  const annotHist = { stack: [], i: -1, max: 80 };

  const el = () => ({
    area: document.getElementById("pdf-area"),
    editor: document.getElementById("editor-area"),
    welcome: document.getElementById("welcome"),
    scroll: document.getElementById("pdf-scroll"),
    pageInput: document.getElementById("pdf-page-input"),
    pageLabel: document.getElementById("pdf-page-label"),
    btnColor: document.getElementById("pdf-highlight"),
    btnSpread: document.getElementById("pdf-spread"),
    annotMenu: document.getElementById("pdf-annot-menu"),
    palette: document.getElementById("pdf-color-palette"),
    annotBar: document.getElementById("pdf-annot-bar"),
    hoverTip: document.getElementById("pdf-hover-tip"),
    commentPanel: document.getElementById("pdf-comment-panel"),
    commentInput: document.getElementById("pdf-comment-input"),
    commentQuote: document.getElementById("pdf-comment-quote"),
    commentTitle: document.getElementById("pdf-comment-title"),
  });

  function toast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      t.hidden = true;
    }, 2000);
  }

  async function api(name, ...args) {
    if (!window.pywebview?.api?.[name]) throw new Error("bridge missing");
    return window.pywebview.api[name](...args);
  }

  function cloneAnnots(list) {
    return JSON.parse(JSON.stringify(list || []));
  }

  function resetAnnotHistory() {
    annotHist.stack = [cloneAnnots(state.annotations)];
    annotHist.i = 0;
  }

  function pushAnnotHistory() {
    annotHist.stack = annotHist.stack.slice(0, annotHist.i + 1);
    annotHist.stack.push(cloneAnnots(state.annotations));
    if (annotHist.stack.length > annotHist.max) annotHist.stack.shift();
    annotHist.i = annotHist.stack.length - 1;
  }

  async function applyAnnotSnapshot(list) {
    state.annotations = cloneAnnots(list);
    if (state.path) {
      try {
        const sidecar = state.annotations.filter((a) => !a.native);
        await api("save_annotations", state.path, sidecar);
      } catch (_) {}
    }
    await refreshAnnots();
  }

  async function undoAnnot() {
    if (!pdfActive() || annotHist.i <= 0) return false;
    annotHist.i--;
    await applyAnnotSnapshot(annotHist.stack[annotHist.i]);
    toast("已撤销标注");
    return true;
  }

  async function redoAnnot() {
    if (!pdfActive() || annotHist.i >= annotHist.stack.length - 1) return false;
    annotHist.i++;
    await applyAnnotSnapshot(annotHist.stack[annotHist.i]);
    toast("已重做标注");
    return true;
  }

  function pdfActive() {
    const e = el();
    return !!(e.area && !e.area.hidden && state.doc);
  }

  function hideAnnotBar() {
    const b = el().annotBar;
    if (b) b.hidden = true;
  }

  function showAnnotBar(x, y) {
    const b = el().annotBar;
    if (!b) return;
    b.hidden = false;
    const w = b.offsetWidth || 140;
    const h = b.offsetHeight || 36;
    b.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x))}px`;
    b.style.top = `${Math.min(window.innerHeight - h - 8, Math.max(8, y))}px`;
  }

  function hideAnnotMenu() {
    const m = el().annotMenu;
    if (m) m.hidden = true;
    state.selectedHlId = null;
    document
      .querySelectorAll(".pdf-hl.selected, .pdf-cm.selected, .pdf-cm-bubble.selected")
      .forEach((n) => n.classList.remove("selected"));
  }

  function showAnnotMenu(x, y, annId) {
    const m = el().annotMenu;
    if (!m) return;
    state.selectedHlId = annId;
    const a = findAnnot(annId);
    const isCm = a && a.type === "comment";
    m.innerHTML = `
      <button type="button" data-annot-act="comment">${a && a.comment ? "编辑评论" : "添加评论"}</button>
      ${isCm ? "" : `<div class="pdf-annot-colors" id="pdf-annot-colors"></div>`}
      <button type="button" data-annot-act="erase">擦除此标注</button>
    `;
    if (!isCm) {
      const box = document.getElementById("pdf-annot-colors");
      if (box) {
        PALETTE.forEach((c) => {
          const b = document.createElement("button");
          b.type = "button";
          b.title = c.label;
          b.style.background = c.hex;
          b.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            await recolorAnnotation(annId, c.id);
            hideAnnotMenu();
          });
          box.appendChild(b);
        });
      }
    }
    m.hidden = false;
    const w = m.offsetWidth || 150;
    const h = m.offsetHeight || 80;
    m.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x))}px`;
    m.style.top = `${Math.min(window.innerHeight - h - 8, Math.max(8, y))}px`;
  }

  function renderPalette() {
    const e = el();
    if (!e.palette) return;
    e.palette.innerHTML = "";
    PALETTE.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = c.label;
      b.style.background = c.hex;
      b.className = c.id === state.hlColor ? "active" : "";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        state.hlColor = c.id;
        e.palette.hidden = true;
        toast(`标注颜色：${c.label}`);
      });
      e.palette.appendChild(b);
    });
  }

  async function disposeDoc() {
    try {
      if (state._io) {
        state._io.disconnect();
        state._io = null;
      }
    } catch (_) {}
    try {
      if (state.doc && typeof state.doc.destroy === "function") {
        await state.doc.destroy();
      }
    } catch (_) {}
    state.doc = null;
  }

  async function loadNativePdfAnnotations() {
    if (!state.doc || !state.path) return;
    try {
      const merged = [];
      const maxPages = Math.min(state.total, 80);
      for (let n = 1; n <= maxPages; n++) {
        const page = await state.doc.getPage(n);
        const vp = page.getViewport({ scale: 1, rotation: (page.rotate || 0) + state.rotation });
        const H = vp.height;
        const W = vp.width;
        let raw = [];
        try {
          raw = await page.getAnnotations({ intent: "display" });
        } catch (_) {}
        for (const a of raw || []) {
          const sub = a.subtype || a.Subtype || "";
          if (!["Highlight", "Text", "Underline", "StrikeOut", "Squiggly"].includes(sub)) continue;
          const comment = a.contentsObj?.str || a.contents || "";
          const col = pdfColorToId(a.color);
          if (sub === "Text") {
            const rect = a.rect || a.Rect;
            let rects = [];
            if (rect && rect.length >= 4) {
              const x0 = Math.min(rect[0], rect[2]) / W;
              const x1 = Math.max(rect[0], rect[2]) / W;
              const yTop = 1 - Math.max(rect[1], rect[3]) / H;
              const yBot = 1 - Math.min(rect[1], rect[3]) / H;
              rects = [{ x: x0, y: yTop, w: Math.max(x1 - x0, 0.02), h: Math.max(yBot - yTop, 0.015) }];
            }
            merged.push({
              id: "pdf-native-" + n + "-" + (a.id || merged.length),
              type: "comment",
              native: true,
              page: n,
              color: col,
              text: String(comment || "").slice(0, 200),
              comment: String(comment || ""),
              rects,
            });
            continue;
          }
          const rects = quadToRects(a.quadPoints || a.quadpoints, W, H);
          if (!rects.length) continue;
          const type = sub === "Underline" ? "underline" : sub === "StrikeOut" ? "strike" : "highlight";
          merged.push({
            id: "pdf-native-" + n + "-" + (a.id || merged.length),
            type,
            native: true,
            page: n,
            color: col,
            text: String(comment || "").slice(0, 200),
            comment: comment ? String(comment) : "",
            rects,
          });
        }
      }
      const sidecar = state.annotations.filter((a) => !a.native);
      const nativeOnly = merged.filter((m) => !sidecar.some((s) => s.id === m.id));
      // Dedupe native ids (re-open / re-import can double-draw lines)
      const seen = new Set();
      const natives = [];
      nativeOnly.forEach((m) => {
        if (seen.has(m.id)) return;
        seen.add(m.id);
        natives.push(m);
      });
      state.annotations = [...natives, ...sidecar];
    } catch (err) {
      console.warn("native annot load", err);
    }
  }

  function pdfColorToId(color) {
    if (!color || !color.length) return "yellow";
    const [r, g, b] = color;
    let best = PALETTE[0];
    let bestD = Infinity;
    PALETTE.forEach((c) => {
      const [pr, pg, pb] = c.pdf;
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    });
    return best.id;
  }

  function quadToRects(quads, W, H) {
    if (!quads || !quads.length) return [];
    const rects = [];
    for (let i = 0; i + 7 < quads.length; i += 8) {
      const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]];
      const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]];
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (W <= 0 || H <= 0) continue;
      rects.push({
        x: minX / W,
        y: 1 - maxY / H,
        w: (maxX - minX) / W,
        h: (maxY - minY) / H,
      });
    }
    return rects;
  }

  async function openPdf(payload) {
    if (!window.pdfjsLib) {
      toast("PDF 引擎未加载");
      return;
    }
    const e = el();
    e.welcome.hidden = true;
    e.editor.hidden = true;
    e.area.hidden = false;
    await disposeDoc();
    hideAnnotMenu();
    hideAnnotBar();
    hideHoverTip();
    state.path = payload.path;
    state.name = payload.name;
    state.annotations = payload.annotations || [];
    state.page = 1;
    state.rotation = 0;
    state.scale = 1.2;
    e.scroll.innerHTML = "";

    try {
      const bin = atob(payload.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      state.doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      state.total = state.doc.numPages;
      e.pageInput.value = "1";
      e.pageInput.max = String(state.total);
      e.pageLabel.textContent = `/ ${state.total}`;

      const p1 = await state.doc.getPage(1);
      const vp1 = p1.getViewport({ scale: 1, rotation: p1.rotate + state.rotation });
      state.landscape = vp1.width >= vp1.height;
      await loadNativePdfAnnotations();
      resetAnnotHistory();
      if (state.landscape) await fitToWidth(false);
      else await fitScaleToHeight(false);
      await renderAll();
      document.title = `${payload.name} — StuartMD`;
    } catch (err) {
      console.error("PDF open failed", err);
      toast("PDF 打开失败：" + (err && err.message ? err.message : err));
      e.area.hidden = true;
      e.welcome.hidden = false;
    }
  }

  function makePageWrap(num, vp0) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page pending";
    wrap.dataset.page = String(num);
    if (vp0 && vp0.width > 10 && vp0.height > 10) {
      wrap.style.width = `${vp0.width}px`;
      wrap.style.minHeight = `${vp0.height}px`;
    } else {
      wrap.style.minHeight = "480px";
    }
    wrap.innerHTML = `<div class="pdf-page-placeholder">第 ${num} 页…</div>`;
    return wrap;
  }

  /** Scale page+canvas+annot together via CSS zoom (Chromium/WebView2) — Edge-like. */
  function applyLiveZoom() {
    const e = el();
    if (!e.scroll || !state.baseScale || state.baseScale <= 0) return;
    const ratio = state.scale / state.baseScale;
    e.scroll.classList.add("pdf-zooming");
    // zoom affects layout box too → paper grows with content (no tear)
    e.scroll.style.zoom = String(Math.max(0.2, Math.min(5, ratio)));
  }

  function clearLiveZoom() {
    const e = el();
    if (!e.scroll) return;
    e.scroll.style.zoom = "";
    e.scroll.classList.remove("pdf-zooming");
  }

  async function renderAll() {
    const e = el();
    if (!state.doc || !e.scroll) return;
    clearLiveZoom();
    e.scroll.innerHTML = "";
    hideAnnotMenu();
    const total = state.total || 0;
    let vp0 = null;
    try {
      const page1 = await state.doc.getPage(1);
      const rotation = ((page1.rotate || 0) + state.rotation) % 360;
      vp0 = page1.getViewport({ scale: state.scale, rotation });
    } catch (_) {}

    const pageEls = [];
    const frag = document.createDocumentFragment();
    if (state.spread) {
      e.scroll.classList.add("spread-mode");
      const half = vp0 ? { width: vp0.width, height: vp0.height } : null;
      for (let n = 1; n <= total; n += 2) {
        const row = document.createElement("div");
        row.className = "pdf-spread";
        const a = makePageWrap(n, half);
        row.appendChild(a);
        pageEls.push(a);
        if (n + 1 <= total) {
          const b = makePageWrap(n + 1, half);
          row.appendChild(b);
          pageEls.push(b);
        }
        frag.appendChild(row);
      }
    } else {
      e.scroll.classList.remove("spread-mode");
      for (let n = 1; n <= total; n++) {
        const wrap = makePageWrap(n, vp0);
        frag.appendChild(wrap);
        pageEls.push(wrap);
      }
    }
    e.scroll.appendChild(frag);
    bindHighlightLayer();

    const paint = async (wrap) => {
      if (!wrap || wrap.dataset.painted === "1") return;
      if (!state.doc) return;
      wrap.dataset.painted = "1";
      const num = Number(wrap.dataset.page);
      try {
        await renderPage(num, wrap);
      } catch (err) {
        wrap.dataset.painted = "";
        wrap.classList.add("pending");
        wrap.innerHTML = `<div class="pdf-page-placeholder">第 ${num} 页渲染失败</div>`;
      }
    };

    for (let i = 0; i < Math.min(state.spread ? 4 : 2, pageEls.length); i++) {
      await paint(pageEls[i]);
    }
    state.baseScale = state.scale;

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              paint(en.target);
              io.unobserve(en.target);
            }
          });
        },
        { root: e.scroll, rootMargin: "600px 0px" }
      );
      pageEls.forEach((w) => {
        if (w.dataset.painted !== "1") io.observe(w);
      });
      state._io = io;
      setTimeout(() => {
        if (!state.doc) return;
        pageEls.slice(0, 4).forEach((w) => {
          if (w.dataset.painted !== "1") paint(w);
        });
      }, 400);
    } else {
      for (const w of pageEls) await paint(w);
    }
  }

  async function renderPage(num, existingWrap) {
    const e = el();
    if (!state.doc) return;
    const page = await state.doc.getPage(num);
    const rotation = ((page.rotate || 0) + state.rotation) % 360;
    const viewport = page.getViewport({ scale: state.scale, rotation });
    const wrap = existingWrap || document.createElement("div");
    wrap.className = "pdf-page";
    wrap.dataset.page = String(num);
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    wrap.style.minHeight = "";
    wrap.innerHTML = "";

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrap.appendChild(canvas);

    const layer = document.createElement("div");
    layer.className = "pdf-text-layer";
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    wrap.appendChild(layer);

    const annotLayer = document.createElement("div");
    annotLayer.className = "pdf-annot-layer";
    annotLayer.style.width = `${viewport.width}px`;
    annotLayer.style.height = `${viewport.height}px`;
    wrap.appendChild(annotLayer);

    const label = document.createElement("div");
    label.className = "pdf-page-label";
    label.textContent = String(num);
    wrap.appendChild(label);

    if (!existingWrap) e.scroll.appendChild(wrap);

    await page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;

    const textContent = await page.getTextContent();
    const frag = document.createDocumentFragment();
    const vscale = viewport.scale || 1;
    textContent.items.forEach((item) => {
      if (!item.str) return;
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const fs =
        typeof item.height === "number" && item.height > 0
          ? item.height * vscale
          : fontHeight * 0.82;
      const top = tx[5] - fs * 0.95;
      const span = document.createElement("span");
      span.textContent = item.str;
      span.setAttribute(
        "style",
        `left:${tx[4]}px;top:${top}px;font-size:${fs}px;transform:rotate(${angle}rad);transform-origin:0 0`
      );
      frag.appendChild(span);
    });
    layer.appendChild(frag);
    drawAnnotationsForPage(annotLayer, num, viewport);
  }

  async function fitScaleToHeight(reRender = true) {
    const e = el();
    if (!state.doc) return;
    const page = await state.doc.getPage(1);
    const rotation = ((page.rotate || 0) + state.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation });
    const avail = Math.max(320, e.scroll.clientHeight - 40);
    state.scale = Math.max(0.4, Math.min(3, avail / vp1.height));
    if (reRender) await renderAll();
  }

  async function fitToWidth(reRender = true) {
    const e = el();
    if (!state.doc) return;
    const page = await state.doc.getPage(1);
    const rotation = ((page.rotate || 0) + state.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation });
    const gap = state.spread ? 12 : 0;
    const pagesWide = state.spread ? 2 : 1;
    const avail = Math.max(320, e.scroll.clientWidth - 40 - gap);
    state.scale = Math.max(0.35, Math.min(3, avail / (vp1.width * pagesWide)));
    if (reRender) await renderAll();
  }

  async function rotateView() {
    state.rotation = ((state.rotation || 0) + 90) % 360;
    const page = state.doc ? await state.doc.getPage(1) : null;
    if (page) {
      const rotation = ((page.rotate || 0) + state.rotation) % 360;
      const vp = page.getViewport({ scale: 1, rotation });
      state.landscape = vp.width >= vp.height;
    }
    await renderAll();
    toast(`已旋转 ${state.rotation}°`);
  }

  function hlRectsFromClientRects(clientRects, wrapBox) {
    // px-space list for merging
    const raw = [];
    for (let i = 0; i < clientRects.length; i++) {
      const cr = clientRects[i];
      if (cr.width < 1 && cr.height < 1) continue;
      raw.push({
        x: cr.left - wrapBox.left,
        y: cr.top - wrapBox.top,
        w: cr.width,
        h: cr.height,
      });
    }
    if (!raw.length) return [];
    raw.sort((a, b) => {
      const dy = a.y + a.h / 2 - (b.y + b.h / 2);
      if (Math.abs(dy) > 3) return dy;
      return a.x - b.x;
    });

    // Merge ONLY on the same visual line (never combine multi-line into one box)
    const merged = [];
    raw.forEach((r) => {
      const last = merged[merged.length - 1];
      if (!last) {
        merged.push({ ...r });
        return;
      }
      const dy = Math.abs(r.y + r.h / 2 - (last.y + last.h / 2));
      const minH = Math.min(r.h, last.h) || 8;
      const sameLine = dy < minH * 0.28;
      const gap = r.x - (last.x + last.w);
      const maxGap = Math.max(14, minH * 0.85);
      if (sameLine && gap < maxGap && gap > -Math.max(last.w, r.w) * 0.5) {
        const x1 = Math.max(last.x + last.w, r.x + r.w);
        const y1 = Math.max(last.y + last.h, r.y + r.h);
        last.x = Math.min(last.x, r.x);
        last.y = Math.min(last.y, r.y);
        last.w = x1 - last.x;
        last.h = y1 - last.y;
      } else {
        merged.push({ ...r });
      }
    });

    // Slight horizontal pad so word gaps look continuous
    const pad = 2;
    return merged.map((r) => ({
      x: Math.max(0, r.x - pad) / wrapBox.width,
      y: r.y / wrapBox.height,
      w: (r.w + pad * 2) / wrapBox.width,
      h: r.h / wrapBox.height,
    }));
  }

  /** Visual constants — keep every annot type consistent across pages/zoom */
  const ANN = {
    highlightAlpha: 0.32,
    linePx: 2.5,
    // Underline sits at a stable fraction of each line box (not raw bottom)
    // so "depth" does not drift when client-rect heights vary
    underlineTopRatio: 0.86,
    strikeTopPct: 54,
  };

  function drawAnnotationsForPage(layer, pageNum, viewport) {
    layer.innerHTML = [];
    layer.innerHTML = "";
    // Quantize to device pixels → stable physical thickness
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const linePx = Math.round(ANN.linePx * dpr) / dpr;
    state.annotations
      .filter((a) => (a.page || 1) === pageNum)
      .forEach((a) => {
        const type = a.type || "highlight";
        const defCol = TYPE_DEFAULT_COLOR[type] || "yellow";
        const colorId = a.color || defCol;
        const cm = colorMeta(colorId);
        (a.rects || []).forEach((r) => {
          const left = r.x * viewport.width;
          const top = r.y * viewport.height;
          const wPx = Math.max(r.w * viewport.width, 2);
          let hPx = Math.max(r.h * viewport.height, 2);
          if (type === "highlight") {
            hPx = Math.max(8, Math.round(hPx));
          }

          const hit = document.createElement("div");
          hit.className = "pdf-hl pdf-ann-hit";
          hit.dataset.id = a.id;
          hit.dataset.type = type;
          hit.dataset.color = colorId;
          hit.style.left = `${left}px`;
          hit.style.top = `${top}px`;
          hit.style.width = `${wPx}px`;
          hit.style.height = `${hPx}px`;
          hit.title = a.comment || a.text || "标注";

          if (type === "highlight") {
            const [cr, cg, cb] = hexToRgb(cm.hex);
            hit.style.background = `rgba(${cr},${cg},${cb},${ANN.highlightAlpha})`;
          } else if (type === "strike") {
            const bar = document.createElement("div");
            bar.className = "pdf-ann-line";
            // Center on glyph band, not on arbitrary client box
            bar.style.top = `${hPx * 0.54}px`;
            bar.style.height = `${linePx}px`;
            bar.style.background = cm.line || "#e53935";
            hit.appendChild(bar);
          } else {
            // underline / comment — same depth ratio + same thickness on every line
            const bar = document.createElement("div");
            bar.className = "pdf-ann-line";
            const lineTop = hPx * ANN.underlineTopRatio;
            bar.style.top = `${lineTop}px`;
            bar.style.height = `${linePx}px`;
            bar.style.background =
              type === "comment" ? "#1e88e5" : cm.line || "#7cb518";
            hit.appendChild(bar);
          }

          bindAnnotEl(hit, a.id);
          layer.appendChild(hit);
        });
      });
  }

  function hexToRgb(hex) {
    const h = (hex || "#ffe566").replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function selectAnnotVisual(id) {
    document
      .querySelectorAll(".pdf-hl.selected, .pdf-cm.selected")
      .forEach((n) => n.classList.remove("selected"));
    // Select every fragment of the same annotation
    document.querySelectorAll(`.pdf-hl[data-id="${CSS.escape(String(id))}"]`).forEach((n) => {
      n.classList.add("selected");
    });
  }

  function bindAnnotEl(node, id) {
    node.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selectAnnotVisual(id);
      state.selectedHlId = id;
      const r = node.getBoundingClientRect();
      showAnnotMenu(ev.clientX || r.left, ev.clientY || r.bottom, id);
    });
    node.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selectAnnotVisual(id);
      showAnnotMenu(ev.clientX, ev.clientY, id);
    });
  }

  function findAnnot(id) {
    return state.annotations.find((a) => a.id === id);
  }

  async function persistAnnots() {
    if (!state.path) return;
    try {
      const sidecar = state.annotations.filter((a) => !a.native);
      await api("save_annotations", state.path, sidecar);
    } catch (_) {}
    pushAnnotHistory();
  }

  async function recolorAnnotation(id, colorId) {
    const a = findAnnot(id);
    if (!a) return;
    a.color = colorId;
    await persistAnnots();
    await refreshAnnots();
    toast("已改标注颜色");
  }

  function captureSelectionCtx(ev) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const text = sel.toString().trim();
    if (!text) return false;
    const range = sel.getRangeAt(0);
    const wrap =
      (ev && ev.target && ev.target.closest && ev.target.closest(".pdf-page")) ||
      range.startContainer?.parentElement?.closest?.(".pdf-page");
    if (!wrap || !el().scroll?.contains(wrap)) return false;
    const wrapBox = wrap.getBoundingClientRect();
    const rects = hlRectsFromClientRects(range.getClientRects(), wrapBox);
    if (!rects.length) return false;
    state._pendingSel = {
      text,
      rects,
      page: Number(wrap.dataset.page || 1),
      clientX: ev ? ev.clientX : null,
      clientY: ev ? ev.clientY : null,
    };
    return true;
  }

  async function addAnnotFromSelection(type, colorId, commentText) {
    const ctx = state._pendingSel;
    if (!ctx || !state.path) {
      toast("请先选中 PDF 文字");
      return;
    }
    const defCol = TYPE_DEFAULT_COLOR[type] || state.hlColor || "yellow";
    const ann = {
      type,
      color: colorId || defCol,
      page: ctx.page,
      text: ctx.text,
      comment: commentText || "",
      rects: ctx.rects,
    };
    try {
      const res = await api("add_annotation", state.path, ann);
      if (res?.error) {
        toast(res.error);
        return;
      }
      state.annotations = await api("load_annotations", state.path);
      await loadNativePdfAnnotations();
      pushAnnotHistory();
      await refreshAnnots();
      toast(
        type === "highlight"
          ? "已高光"
          : type === "underline"
            ? "已下划线"
            : type === "strike"
              ? "已删除线"
              : "已添加"
      );
    } catch (_) {
      toast("标注失败");
    }
  }

  function hideHoverTip() {
    const t = el().hoverTip;
    if (t) t.hidden = true;
  }

  function showHoverTip(text, x, y) {
    const t = el().hoverTip;
    if (!t) return;
    t.textContent = text;
    t.hidden = false;
    const w = t.offsetWidth || 200;
    const h = t.offsetHeight || 40;
    t.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 14))}px`;
    t.style.top = `${Math.min(window.innerHeight - h - 8, Math.max(8, y + 16))}px`;
  }

  function bindHighlightLayer() {
    const e = el();

    e.scroll.onmouseup = (ev) => {
      hideAnnotMenu();
      if (ev.target.closest("#pdf-toolbar")) {
        hideAnnotBar();
        return;
      }
      // Show mini toolbar for any selection
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
        hideAnnotBar();
        return;
      }
      if (captureSelectionCtx(ev)) {
        showAnnotBar(ev.clientX + 8, ev.clientY + 12);
      } else {
        hideAnnotBar();
      }
    };

    e.scroll.oncontextmenu = (ev) => {
      if (ev.target.closest(".pdf-hl") || ev.target.closest(".pdf-cm")) {
        ev.preventDefault();
        return;
      }
      if (captureSelectionCtx(ev)) {
        ev.preventDefault();
        showAnnotBar(ev.clientX, ev.clientY);
        return;
      }
      hideAnnotMenu();
      hideAnnotBar();
    };

    // Hover tip for comments
    e.scroll.onmousemove = (ev) => {
      const hl = ev.target.closest && ev.target.closest(".pdf-hl");
      if (!hl) {
        hideHoverTip();
        return;
      }
      const id = hl.dataset.id;
      const a = id ? findAnnot(id) : null;
      if (a && (a.comment || a.type === "comment")) {
        const txt = a.comment || a.text || "";
        if (txt) showHoverTip(txt, ev.clientX, ev.clientY);
        else hideHoverTip();
      } else {
        hideHoverTip();
      }
    };

    e.scroll.onmouseleave = () => {
      hideHoverTip();
    };
  }

  async function eraseAnnotation(id) {
    try {
      const a = findAnnot(id);
      if (a && a.native) {
        state.annotations = state.annotations.filter((x) => x.id !== id);
        pushAnnotHistory();
        await refreshAnnots();
        hideAnnotMenu();
        toast("已隐藏原生标注");
        return;
      }
      const res = await api("delete_annotation", state.path, id);
      if (res?.error) {
        toast(res.error);
        return;
      }
      state.annotations = await api("load_annotations", state.path);
      await loadNativePdfAnnotations();
      pushAnnotHistory();
      await refreshAnnots();
      hideAnnotMenu();
      toast("已擦除标注");
    } catch (_) {
      toast("擦除失败");
    }
  }

  async function refreshAnnots() {
    const e = el();
    if (!state.doc) return;
    for (const wrap of e.scroll.querySelectorAll(".pdf-page")) {
      const pageNum = Number(wrap.dataset.page);
      const layer = wrap.querySelector(".pdf-annot-layer");
      if (!layer) continue;
      const page = await state.doc.getPage(pageNum);
      const rotation = ((page.rotate || 0) + state.rotation) % 360;
      const viewport = page.getViewport({ scale: state.scale, rotation });
      drawAnnotationsForPage(layer, pageNum, viewport);
    }
  }

  /**
   * Reliable confirm in Tauri WebView.
   * Native confirm() often no-ops / never shows — use in-app modal.
   */
  function uiConfirm(message) {
    return new Promise((resolve) => {
      const modal = document.getElementById("stuart-confirm");
      const msg = document.getElementById("stuart-confirm-msg");
      const okBtn = document.getElementById("stuart-confirm-ok");
      const cancelBtn = document.getElementById("stuart-confirm-cancel");
      if (!modal || !okBtn || !cancelBtn) {
        // Extreme fallback
        resolve(window.confirm(message));
        return;
      }
      if (msg) msg.textContent = String(message || "");
      modal.hidden = false;
      const cleanup = () => {
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        document.removeEventListener("keydown", onKey, true);
      };
      const finish = (val) => {
        modal.hidden = true;
        cleanup();
        resolve(val);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          finish(false);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          finish(true);
        }
      };
      okBtn.onclick = () => finish(true);
      cancelBtn.onclick = () => finish(false);
      document.addEventListener("keydown", onKey, true);
      try {
        okBtn.focus();
      } catch (_) {}
    });
  }

  async function clearAll() {
    if (!state.path) return;
    const ok1 = await uiConfirm(
      "确定清除全部标注？\n（高光 / 下划线 / 删除线 / 评论）"
    );
    if (!ok1) return;
    const ok2 = await uiConfirm(
      "请再次确认：清除全部标注？\n清除后可用 Ctrl+Z 撤销。"
    );
    if (!ok2) return;
    try {
      await api("clear_annotations", state.path);
      state.annotations = state.annotations.filter((a) => a.native);
      pushAnnotHistory();
      await refreshAnnots();
      hideAnnotMenu();
      toast("已清除全部标注");
    } catch (_) {
      toast("清除失败");
    }
  }

  async function exportAnnotsToPdf() {
    if (!state.path) {
      toast("请先打开 PDF");
      return;
    }
    const items = state.annotations.filter((a) => !a.native);
    if (!items.length) {
      toast("没有可写入的标注");
      return;
    }
    try {
      const res = await api("export_pdf_annotations", state.path, items);
      if (res?.error) {
        toast(res.error);
        return;
      }
      toast("已写入 PDF 原生批注（WPS / Edge 可打开）");
    } catch (err) {
      toast("写入 PDF 失败：" + (err && err.message ? err.message : err));
    }
  }

  // ---- Floating comment panel ----
  let _commentTargetId = null;
  const _panelPos = { x: 0, y: 0, has: false };

  function placeCommentPanel(x, y) {
    const e = el();
    const p = e.commentPanel;
    if (!p) return;
    const w = p.offsetWidth || 340;
    const h = p.offsetHeight || 200;
    let left;
    let top;
    if (_panelPos.has && x == null) {
      left = _panelPos.x;
      top = _panelPos.y;
    } else {
      left = Math.min(window.innerWidth - w - 12, Math.max(8, (x || 120) + 8));
      top = Math.min(window.innerHeight - h - 12, Math.max(8, (y || 80) + 8));
    }
    p.style.left = `${left}px`;
    p.style.top = `${top}px`;
    _panelPos.x = left;
    _panelPos.y = top;
    _panelPos.has = true;
  }

  function openCommentPanel(id, anchorX, anchorY) {
    const e = el();
    _commentTargetId = id;
    const a = id ? findAnnot(id) : null;
    if (e.commentTitle) {
      e.commentTitle.textContent = a ? "编辑评论" : "添加评论";
    }
    if (e.commentQuote) {
      const quote =
        (a && (a.text || a.comment)) ||
        (state._pendingSel && state._pendingSel.text) ||
        "";
      if (quote) {
        e.commentQuote.hidden = false;
        e.commentQuote.textContent = String(quote).slice(0, 120);
      } else {
        e.commentQuote.hidden = true;
        e.commentQuote.textContent = "";
      }
    }
    if (e.commentInput) e.commentInput.value = (a && (a.comment || a.text)) || "";
    if (e.commentPanel) e.commentPanel.hidden = false;
    placeCommentPanel(anchorX, anchorY);
    e.commentInput?.focus();
  }

  function closeCommentPanel() {
    const e = el();
    if (e.commentPanel) e.commentPanel.hidden = true;
    _commentTargetId = null;
  }

  async function saveComment() {
    const e = el();
    const id = _commentTargetId;
    const text = (e.commentInput && e.commentInput.value ? e.commentInput.value : "").trim();
    if (!id) {
      if (!text) {
        toast("评论内容为空");
        return;
      }
      await addAnnotFromSelection("comment", TYPE_DEFAULT_COLOR.comment, text);
      closeCommentPanel();
      const sel = window.getSelection();
      try {
        sel.removeAllRanges();
      } catch (_) {}
      hideAnnotBar();
      return;
    }
    const a = findAnnot(id);
    if (!a) {
      closeCommentPanel();
      return;
    }
    a.comment = text;
    a.text = text || a.text;
    await persistAnnots();
    await refreshAnnots();
    toast(text ? "评论已保存" : "评论已清空");
  }

  function bindCommentPanelDrag() {
    const p = el().commentPanel;
    const handle = document.getElementById("pdf-comment-drag");
    if (!p || !handle || handle.dataset.bound === "1") return;
    handle.dataset.bound = "1";
    let dragging = false;
    let ox = 0;
    let oy = 0;
    handle.addEventListener("mousedown", (ev) => {
      if (ev.target.closest("button")) return;
      dragging = true;
      const r = p.getBoundingClientRect();
      ox = ev.clientX - r.left;
      oy = ev.clientY - r.top;
      ev.preventDefault();
    });
    window.addEventListener(
      "mousemove",
      (ev) => {
        if (!dragging || p.hidden) return;
        const w = p.offsetWidth;
        const h = p.offsetHeight;
        const left = Math.min(window.innerWidth - w - 4, Math.max(4, ev.clientX - ox));
        const top = Math.min(window.innerHeight - h - 4, Math.max(4, ev.clientY - oy));
        p.style.left = `${left}px`;
        p.style.top = `${top}px`;
        _panelPos.x = left;
        _panelPos.y = top;
        _panelPos.has = true;
      },
      { passive: true }
    );
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  let zoomTimer = 0;
  async function setZoom(scale, immediate) {
    state.scale = Math.max(0.35, Math.min(4, scale));
    clearTimeout(zoomTimer);
    if (immediate) {
      clearLiveZoom();
      state.baseScale = state.scale;
      await renderAll();
      return;
    }
    applyLiveZoom();
    // Longer settle after wheel burst → fewer full re-renders, smoother feel
    zoomTimer = setTimeout(async () => {
      clearLiveZoom();
      state.baseScale = state.scale;
      await renderAll();
    }, 320);
  }

  function bindChrome() {
    const e = el();
    const on = (id, fn) => {
      const n = document.getElementById(id);
      if (n) n.addEventListener("click", fn);
    };
    on("pdf-prev", async () => {
      const step = state.spread ? 2 : 1;
      if (state.page > 1) {
        state.page = Math.max(1, state.page - step);
        e.pageInput.value = String(state.page);
        e.scroll
          .querySelector(`.pdf-page[data-page="${state.page}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    on("pdf-next", async () => {
      const step = state.spread ? 2 : 1;
      if (state.page < state.total) {
        state.page = Math.min(state.total, state.page + step);
        e.pageInput.value = String(state.page);
        e.scroll
          .querySelector(`.pdf-page[data-page="${state.page}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    e.pageInput?.addEventListener("change", () => {
      const n = Number(e.pageInput.value || 1);
      state.page = Math.max(1, Math.min(state.total, n));
      e.pageInput.value = String(state.page);
      e.scroll
        .querySelector(`.pdf-page[data-page="${state.page}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    on("pdf-zoom-in", () => setZoom(state.scale + 0.15, false));
    on("pdf-zoom-out", () => setZoom(state.scale - 0.15, false));
    on("pdf-fit", () => fitScaleToHeight(true));
    on("pdf-rotate", () => rotateView());
    on("pdf-spread", async () => {
      state.spread = !state.spread;
      if (e.btnSpread) e.btnSpread.classList.toggle("active", !!state.spread);
      if (state.spread) await fitToWidth(true);
      else await fitScaleToHeight(true);
      toast(state.spread ? "双页显示" : "单页显示");
    });
    // Pen = color palette (not a mode toggle)
    on("pdf-highlight", (ev) => {
      ev.stopPropagation();
      if (!e.palette) return;
      e.palette.hidden = !e.palette.hidden;
      if (!e.palette.hidden) renderPalette();
    });
    on("pdf-export-annots", () => exportAnnotsToPdf());
    on("pdf-clear", () => clearAll());

    // Mini annot bar actions
    e.annotBar?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-pa]");
      if (!btn) return;
      const act = btn.dataset.pa;
      const bar = e.annotBar;
      const br = bar ? bar.getBoundingClientRect() : { left: 200, top: 200 };
      if (act === "highlight") {
        await addAnnotFromSelection("highlight", state.hlColor);
        hideAnnotBar();
        const sel = window.getSelection();
        try {
          sel.removeAllRanges();
        } catch (_) {}
      } else if (act === "underline") {
        await addAnnotFromSelection("underline", TYPE_DEFAULT_COLOR.underline);
        hideAnnotBar();
      } else if (act === "strike") {
        await addAnnotFromSelection("strike", TYPE_DEFAULT_COLOR.strike);
        hideAnnotBar();
      } else if (act === "comment") {
        openCommentPanel(null, br.left, br.top + 8);
        hideAnnotBar();
      }
    });

    e.scroll?.addEventListener(
      "wheel",
      (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        if (!state.doc) return;
        ev.preventDefault();
        const dir = ev.deltaY > 0 ? -0.08 : 0.08;
        setZoom(state.scale * (ev.deltaY > 0 ? 0.92 : 1.08), false);
      },
      { passive: false }
    );

    e.annotMenu?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-annot-act]");
      if (!btn) return;
      const act = btn.dataset.annotAct;
      const id = state.selectedHlId;
      if (!id) return;
      const menu = e.annotMenu;
      const mr = menu ? menu.getBoundingClientRect() : { left: 200, top: 200 };
      if (act === "erase") await eraseAnnotation(id);
      else if (act === "comment") {
        openCommentPanel(id, mr.left, mr.top);
        hideAnnotMenu();
      }
    });

    document.getElementById("pdf-comment-ok")?.addEventListener("click", () => saveComment());
    document.getElementById("pdf-comment-cancel")?.addEventListener("click", () => closeCommentPanel());
    document.getElementById("pdf-comment-close")?.addEventListener("click", () => closeCommentPanel());
    bindCommentPanelDrag();

    document.addEventListener("mousedown", (ev) => {
      if (e.palette && !e.palette.hidden && !ev.target.closest(".pdf-color-wrap")) {
        e.palette.hidden = true;
      }
      if (e.annotBar && !e.annotBar.hidden && !ev.target.closest("#pdf-annot-bar")) {
        // keep bar if selecting; hide only when clicking outside without selection
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideAnnotBar();
      }
      const menu = e.annotMenu;
      if (menu && !menu.hidden) {
        if (ev.target.closest("#pdf-annot-menu") || ev.target.closest(".pdf-hl")) return;
        hideAnnotMenu();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        hideAnnotMenu();
        hideAnnotBar();
        closeCommentPanel();
        hideHoverTip();
        if (e.palette) e.palette.hidden = true;
      }
    });

    window.addEventListener("keydown", (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod || !pdfActive()) return;
      const ae = document.activeElement;
      const typing =
        ae === document.getElementById("source") ||
        ae === e.commentInput ||
        (ae && (ae.isContentEditable || ae.closest?.(".md-block.editing")));
      if (typing) return;
      const k = ev.key.toLowerCase();
      if (k === "z" && !ev.shiftKey) {
        ev.preventDefault();
        undoAnnot();
      } else if ((k === "z" && ev.shiftKey) || k === "y") {
        ev.preventDefault();
        redoAnnot();
      }
    });

    if (e.btnSpread) e.btnSpread.title = "双页显示";
    if (e.btnColor) e.btnColor.title = "标注颜色";
  }

  function hidePdf() {
    const e = el();
    e.area.hidden = true;
    hideAnnotMenu();
    hideAnnotBar();
    hideHoverTip();
    closeCommentPanel();
    disposeDoc();
    state.path = null;
  }

  document.addEventListener("DOMContentLoaded", bindChrome);

  window.StuartMDPdf = {
    openPdf,
    hidePdf,
    renderAll,
    undoAnnot,
    redoAnnot,
    isActive: () => !el().area.hidden && !!state.doc,
  };
})();
