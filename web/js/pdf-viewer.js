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
    documentId: null,
    loadEpoch: 0,
    loadingTask: null,
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
    _pageText: {},
    _pageTextBusy: {},
  };

  let annotHist = { stack: [], i: -1, max: 21 };
  const annotationRecords = new Map();

  function annotationSnapshot() {
    return { items: cloneAnnots(state.annotations.filter(annotation => !annotation.native)), pdfVersion: state.annotationRecord.pdfVersion };
  }

  function recordPdfSave(record, result) {
    if (!record.pdfVersion) {
      const base = { operationId: result.operationId, version: "base" };
      for (const snapshot of record.history.stack) if (!snapshot.pdfVersion) snapshot.pdfVersion = base;
    }
    record.pdfVersion = { operationId: result.operationId, version: "local" };
  }

  function ensureAnnotationIdle() {
    if (state.annotationRecord?.restoring) throw new Error("PDF批注正在恢复保存版本");
  }

  // === PHASE P1-2: PDF.js Virtualization & VRAM Eviction State ===
  const activeRenderTasks = new Map(); // pageNum (Number) -> RenderTask
  const MAX_RENDERED_PAGES = 5; // Hard invariant: at most 5 concurrently painted canvas pages

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
    annotHist.stack = [annotationSnapshot()];
    annotHist.i = 0;
  }

  function pushAnnotHistory() {
    annotHist.stack = annotHist.stack.slice(0, annotHist.i + 1);
    annotHist.stack.push(annotationSnapshot());
    if (annotHist.stack.length > annotHist.max) annotHist.stack.shift();
    annotHist.i = annotHist.stack.length - 1;
  }

  function pushRecordHistory(record) {
    record.history.stack = record.history.stack.slice(0, record.history.i + 1);
    record.history.stack.push({ items: cloneAnnots(record.items), pdfVersion: record.pdfVersion });
    if (record.history.stack.length > record.history.max) record.history.stack.shift();
    record.history.i = record.history.stack.length - 1;
  }

  async function reloadSavedPdf(documentId, record) {
    const view = state.documentId === documentId ? { page: state.page, scale: state.scale, rotation: state.rotation, scrollTop: el().scroll.scrollTop } : null;
    const payload = await api("pdf_document_snapshot", documentId);
    if (state.documentId !== documentId) return;
    await openPdf({ ...payload, annotations: record.items, view });
  }

  async function applyAnnotSnapshot(snapshot) {
    const documentId = state.documentId, path = state.path, record = state.annotationRecord;
    record.restoring = true;
    try {
      await window.StuartCore.writeCoord.enqueue(`pdf-annotations:${documentId}`, async () => {
        if (JSON.stringify(snapshot.pdfVersion) !== JSON.stringify(record.pdfVersion)) {
          if (!snapshot.pdfVersion) throw new Error("PDF批注恢复版本缺失");
          const saved = await confirmAnnotationSave(await api("restore_pdf_annotations", documentId, snapshot.pdfVersion.operationId, snapshot.pdfVersion.version));
          window.StuartMD.confirmPdfSave(documentId, saved);
          record.pdfVersion = snapshot.pdfVersion;
        }
        record.items = cloneAnnots(snapshot.items);
        await confirmAnnotationSave(await api("save_annotations", path, record.items, documentId));
        if (state.documentId === documentId) await reloadSavedPdf(documentId, record);
      });
    } finally { record.restoring = false; }
  }

  async function undoAnnot() {
    if (!pdfActive() || annotHist.i <= 0) return false;
    ensureAnnotationIdle();
    const history = annotHist, index = history.i - 1;
    await applyAnnotSnapshot(history.stack[index]);
    history.i = index;
    toast("已撤销标注");
    return true;
  }

  async function redoAnnot() {
    if (!pdfActive() || annotHist.i >= annotHist.stack.length - 1) return false;
    ensureAnnotationIdle();
    const history = annotHist, index = history.i + 1;
    await applyAnnotSnapshot(history.stack[index]);
    history.i = index;
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
    const previous = state.doc, loading = state.loadingTask;
    state.doc = null; state.loadingTask = null;
    try {
      if (state._virtualIo) {
        state._virtualIo.disconnect();
        state._virtualIo = null;
      }
      if (state._io) {
        state._io.disconnect();
        state._io = null;
      }
    } catch (_) {}

    for (const [pageNum, task] of activeRenderTasks.entries()) {
      try { task.cancel(); } catch (_) {}
    }
    activeRenderTasks.clear();

    const e = el();
    if (e.scroll) {
      e.scroll.querySelectorAll("canvas").forEach((c) => {
        try {
          c.width = 0;
          c.height = 0;
        } catch (_) {}
        c.remove();
      });
    }

    try {
      if (previous) await previous.destroy();
      else if (loading) await loading.destroy();
    } catch (error) { toast("释放PDF文档失败：" + error.message); throw error; }
  }

  async function loadNativePdfAnnotations(pageNumber = state.page || 1) {
    if (!state.doc || !state.path) return;
    const captured = state.doc, epoch = state.loadEpoch, merged = [];
    for (const number of [pageNumber]) {
      const page = await captured.getPage(number), raw = await page.getAnnotations({ intent: "display" });
      if (captured !== state.doc || epoch !== state.loadEpoch) return;
      for (const annotation of raw) {
        const subtype = annotation.subtype;
        if (!["Highlight", "Text", "Underline", "StrikeOut", "Squiggly"].includes(subtype)) continue;
        const rectangles = subtype === "Text" ? [annotation.rect] : (annotation.quadPoints || []).map(points => {
          if (points.length !== 4 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error("PDF原生批注的页面坐标无效");
          return [Math.min(...points.map(point => point.x)), Math.min(...points.map(point => point.y)), Math.max(...points.map(point => point.x)), Math.max(...points.map(point => point.y))];
        });
        if (!rectangles.length) continue;
        if (rectangles.some(rectangle => !rectangle || rectangle.length !== 4 || rectangle.some(value => !Number.isFinite(value)))) throw new Error("PDF原生批注缺少实际矩形");
        const comment = String(annotation.contentsObj?.str || annotation.contents || "");
        merged.push({ id: `pdf-native-${number}-${annotation.id}`, nativeAnnotationId: annotation.id, type: subtype === "Text" ? "comment" : subtype === "Underline" ? "underline" : subtype === "StrikeOut" ? "strike" : "highlight", native: true, page: number, color: pdfColorToId(annotation.color), text: comment, comment, pdfRects: rectangles });
      }
    }
    if (captured !== state.doc || epoch !== state.loadEpoch) return;
    state.annotations = [...merged, ...state.annotations.filter(annotation => !annotation.native || annotation.page !== pageNumber)];
  }

  function pdfColorToId(color) {
    if (!color || !color.length) return "yellow";
    const [r, g, b] = Array.from(color, value => value / 255);
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

  function openPdf(payload) {
    state.openPromise = openPdfDocument(payload);
    return state.openPromise;
  }

  async function openPdfDocument(payload) {
    const epoch = ++state.loadEpoch;
    if (!window.pdfjsLib) {
      toast("PDF 引擎未加载");
      return;
    }
    const e = el();
    e.welcome.hidden = true;
    e.editor.hidden = true;
    e.area.hidden = false;
    await disposeDoc();
    if (epoch !== state.loadEpoch) return;
    hideAnnotMenu();
    hideAnnotBar();
    hideHoverTip();
    state.path = payload.path;
    state.documentId = payload.documentId;
    state._pendingSel = null; state._pageText = {}; state._pageTextBusy = {};
    state.name = payload.name;
    const record = annotationRecords.get(payload.documentId) || { items: cloneAnnots(payload.annotations || []), pdfVersion: null, history: { stack: [], i: -1, max: 21 }, restoring: false };
    annotationRecords.set(payload.documentId, record);
    state.annotationRecord = record;
    annotHist = record.history;
    state.annotations = cloneAnnots(record.items);
    state.page = payload.view?.page || 1;
    state.rotation = payload.view?.rotation || 0;
    state.scale = payload.view?.scale || 1.2;
    e.scroll.innerHTML = "";

    try {
      let docInit;
      if (payload.data) {
        docInit = { data: payload.data };
      } else if (!payload.b64 && payload.path && window.__TAURI__?.core?.invoke) {
        const ab = await window.__TAURI__.core.invoke("stuart_read_pdf_binary", { path: payload.path });
        docInit = { data: new Uint8Array(ab) };
      }
      if (!docInit && payload.b64) {
        const bin = atob(payload.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        docInit = { data: bytes };
      }
      if (!docInit) throw new Error("缺少 PDF 数据源");

      const loading = window.pdfjsLib.getDocument({
        ...docInit,
        cMapUrl: new URL("libs/pdfjs/cmaps/", window.location.href).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("libs/pdfjs/standard_fonts/", window.location.href).href,
      });
      state.loadingTask = loading;
      const pdf = await loading.promise;
      if (epoch !== state.loadEpoch) { await pdf.destroy(); return; }
      state.doc = pdf; state.loadingTask = null;
      state.total = state.doc.numPages;
      e.pageInput.value = String(state.page);
      e.pageInput.max = String(state.total);
      e.pageLabel.textContent = `/ ${state.total}`;

      const p1 = await state.doc.getPage(1);
      const vp1 = p1.getViewport({ scale: 1, rotation: p1.rotate + state.rotation });
      state.landscape = vp1.width >= vp1.height;
      await normalizeAnnotationCoordinates(state.doc, record);
      if (epoch !== state.loadEpoch) return;
      await loadNativePdfAnnotations();
      if (epoch !== state.loadEpoch) return;
      if (!annotHist.stack.length) resetAnnotHistory();
      if (!payload.view) {
        if (state.landscape) await fitToWidth(false);
        else await fitScaleToHeight(false);
      }
      await renderAll();
      if (payload.view && epoch === state.loadEpoch) el().scroll.scrollTop = payload.view.scrollTop;
      document.title = `${payload.name} — StuartMD`;
    } catch (err) {
      console.error("PDF open failed", err);
      toast("PDF 打开失败：" + (err && err.message ? err.message : err));
      e.area.hidden = true;
      e.welcome.hidden = false;
      throw err;
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
    e.scroll.style.transform = "";
    e.scroll.classList.remove("pdf-zooming");
  }

  /**
   * Hard eviction of PDF page canvases to release GPU VRAM backing store in WebView2/Chromium.
   * Explicitly sets canvas.width = 0 and canvas.height = 0 before DOM removal.
   */
  function cancelAndEvictPage(wrap) {
    if (!wrap) return;
    const pageNum = Number(wrap.dataset.page);

    // 1. Cancel active render task if in progress
    const task = activeRenderTasks.get(pageNum);
    if (task) {
      try {
        task.cancel();
      } catch (_) {}
      activeRenderTasks.delete(pageNum);
    }
    delete wrap.dataset.rendering;

    // If page is not painted, skip DOM destruction
    if (wrap.dataset.painted !== "1") return;

    // 2. Physical VRAM release: set width=0, height=0 on ALL canvases (primary + annotation)
    const canvases = wrap.querySelectorAll("canvas");
    canvases.forEach((c) => {
      try {
        c.width = 0;
        c.height = 0;
      } catch (_) {}
      c.remove();
    });

    // 3. Remove text layer and annot layer
    const textLayer = wrap.querySelector(".pdf-text-layer");
    if (textLayer) textLayer.remove();
    const annotLayer = wrap.querySelector(".pdf-annot-layer");
    if (annotLayer) annotLayer.remove();
    const label = wrap.querySelector(".pdf-page-label");
    if (label) label.remove();

    // 4. Restore lightweight placeholder so page container dimensions remain stable
    if (!wrap.querySelector(".pdf-page-placeholder")) {
      const ph = document.createElement("div");
      ph.className = "pdf-page-placeholder";
      ph.textContent = `第 ${pageNum} 页…`;
      wrap.appendChild(ph);
    }

    wrap.dataset.painted = "0";
    wrap.classList.add("pending");
  }

  /**
   * Enforces the sliding window invariant: concurrently painted pages <= MAX_RENDERED_PAGES (5).
   * Evicts pages furthest from current scroll viewport center.
   */
  function enforceMaxRenderedPool() {
    const e = el();
    if (!e.scroll) return;
    const paintedWraps = Array.from(e.scroll.querySelectorAll('.pdf-page[data-painted="1"]'));
    if (paintedWraps.length <= MAX_RENDERED_PAGES) return;

    const scrollCenter = e.scroll.scrollTop + e.scroll.clientHeight / 2;
    paintedWraps.sort((a, b) => {
      const centerA = a.offsetTop + a.offsetHeight / 2;
      const centerB = b.offsetTop + b.offsetHeight / 2;
      return Math.abs(centerB - scrollCenter) - Math.abs(centerA - scrollCenter);
    });

    while (paintedWraps.length > MAX_RENDERED_PAGES) {
      const furthest = paintedWraps.shift();
      cancelAndEvictPage(furthest);
    }
  }

  async function renderPage(target, existingWrap) {
    let num, wrap;
    if (typeof target === "number") {
      num = target;
      wrap = existingWrap || el().scroll?.querySelector(`.pdf-page[data-page="${num}"]`);
    } else {
      wrap = target;
      num = Number(wrap?.dataset?.page);
    }

    if (!wrap || !state.doc) return;
    if (num < 1 || num > (state.total || state.doc.numPages)) return;
    if (wrap.dataset.painted === "1" || wrap.dataset.rendering === "1") return;

    // Cancel any stale task for this page
    const prevTask = activeRenderTasks.get(num);
    if (prevTask) {
      try { prevTask.cancel(); } catch (_) {}
      activeRenderTasks.delete(num);
    }

    wrap.dataset.rendering = "1";
    const capturedDoc = state.doc, epoch = state.loadEpoch, renderIdentity = Symbol("pdf-page-render");
    wrap._renderIdentity = renderIdentity;
    let renderTask;
    const isCurrent = () => capturedDoc === state.doc && epoch === state.loadEpoch && wrap.isConnected && wrap._renderIdentity === renderIdentity;

    try {
      const page = await capturedDoc.getPage(num);
      if (!isCurrent()) return;
      const rotation = ((page.rotate || 0) + state.rotation) % 360;
      const viewport = page.getViewport({ scale: state.scale, rotation });
      wrap._pdfViewport = viewport;

      wrap.className = "pdf-page";
      wrap.dataset.page = String(num);
      wrap.style.width = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;
      wrap.style.minHeight = `${viewport.height}px`;

      // Clear placeholder
      const ph = wrap.querySelector(".pdf-page-placeholder");
      if (ph) ph.remove();

      // Main PDF canvas
      let canvas = wrap.querySelector("canvas:not(.pdf-ann-canvas)");
      if (!canvas) {
        canvas = document.createElement("canvas");
        wrap.appendChild(canvas);
      }
      const ctx = canvas.getContext("2d");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      let layer = wrap.querySelector(".pdf-text-layer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "pdf-text-layer";
        wrap.appendChild(layer);
      }
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;

      let annotLayer = wrap.querySelector(".pdf-annot-layer");
      if (!annotLayer) {
        annotLayer = document.createElement("div");
        annotLayer.className = "pdf-annot-layer";
        wrap.appendChild(annotLayer);
      }
      annotLayer.style.width = `${viewport.width}px`;
      annotLayer.style.height = `${viewport.height}px`;

      let label = wrap.querySelector(".pdf-page-label");
      if (!label) {
        label = document.createElement("div");
        label.className = "pdf-page-label";
        label.textContent = String(num);
        wrap.appendChild(label);
      }

      renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      });
      activeRenderTasks.set(num, renderTask);

      await renderTask.promise;
      if (!isCurrent()) return;

      // Check if wrap was evicted while renderTask was in flight
      if (wrap.dataset.rendering !== "1") {
        return;
      }

      wrap.dataset.painted = "1";
      wrap.classList.remove("pending");

      // Extract and cache plain text
      const textContent = await page.getTextContent();
      if (!isCurrent()) return;
      try {
        const plain = (textContent.items || [])
          .map((it) => (it && it.str) || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (plain) state._pageText[num] = plain;
      } catch (_) {}

      layer.innerHTML = "";
      layer.style.setProperty("--scale-factor", String(viewport.scale));
      const textDivs = [], textDivProperties = new WeakMap();
      await window.pdfjsLib.renderTextLayer({ textContentSource: textContent, container: layer, viewport, textDivs, textDivProperties }).promise;
      layer._pdfTextDivs = textDivs;
      layer._pdfTextDivProperties = textDivProperties;
      if (!isCurrent()) return;
      await loadNativePdfAnnotations(num);
      if (!isCurrent()) return;

      drawAnnotationsForPage(annotLayer, num, viewport);

      // Enforce pool limit
      enforceMaxRenderedPool();
    } catch (err) {
      if (!isCurrent()) return;
      if (err?.name === "RenderingCancelledException" || err?.message?.includes("cancelled")) {
        return; // Silent catch: fast scroll cancellation is expected behavior
      }
      console.error(`[PDF.js] Page ${num} render error:`, err);
      wrap.dataset.painted = "0";
      wrap.classList.add("pending");
      if (!wrap.querySelector(".pdf-page-placeholder")) {
        wrap.innerHTML = `<div class="pdf-page-placeholder">第 ${num} 页渲染失败</div>`;
      }
    } finally {
      if (wrap._renderIdentity === renderIdentity) delete wrap.dataset.rendering;
      if (activeRenderTasks.get(num) === renderTask) activeRenderTasks.delete(num);
    }
  }

  function setupVirtualizedPdfObserver(pageWrappers, scrollContainer) {
    if (state._virtualIo) {
      state._virtualIo.disconnect();
      state._virtualIo = null;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const wrap = entry.target;
          if (entry.isIntersecting) {
            renderPage(wrap);
          } else {
            cancelAndEvictPage(wrap);
          }
        });
        enforceMaxRenderedPool();
      },
      { root: scrollContainer, rootMargin: "800px 0px" }
    );

    pageWrappers.forEach((w) => io.observe(w));
    state._virtualIo = io;
  }

  async function renderAll() {
    const e = el();
    if (!state.doc || !e.scroll) return;
    clearLiveZoom();

    // 1. Cancel in-flight renders and clean up canvases
    for (const [pageNum, task] of activeRenderTasks.entries()) {
      try { task.cancel(); } catch (_) {}
    }
    activeRenderTasks.clear();

    e.scroll.querySelectorAll("canvas").forEach((c) => {
      try { c.width = 0; c.height = 0; } catch (_) {}
      c.remove();
    });

    if (state._virtualIo) {
      state._virtualIo.disconnect();
      state._virtualIo = null;
    }
    if (state._io) {
      state._io.disconnect();
      state._io = null;
    }

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

    state.baseScale = state.scale;

    // Attach virtual observer for bidirectional render/evict
    if ("IntersectionObserver" in window) {
      setupVirtualizedPdfObserver(pageEls, e.scroll);
      // Pre-paint initial visible pages
      const initCount = Math.min(state.spread ? 4 : 2, pageEls.length);
      for (let i = 0; i < initCount; i++) {
        renderPage(pageEls[i]);
      }
    } else {
      // Fallback for non-IO environments
      for (const w of pageEls) await renderPage(w);
    }
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

  /** Visual constants — canvas lines are always the same device-pixel width */
  const ANN = {
    highlightAlpha: 0.32,
    linePx: 2.5,
    underlineBottomPad: 3,
    underlineTopRatio: 0.93,
    strikeTopRatio: 0.54,
    // Comment = underline geometry, only color differs
    underlineLine: "#7cb518",
    commentLine: "#1e88e5",
    strikeLine: "#e53935",
  };

  function hexToRgb(hex) {
    const h = (hex || "#ffe566").replace("#", "");
    const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbaFromHex(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  }

  /**
   * Union line segments by (color, snapped-y) then paint once —
   * stacked overlapping fillRects were making some lines look thicker.
   */
  function paintLineBands(ctx, segs, linePx) {
    const groups = new Map();
    segs.forEach((s) => {
      // Snap to 0.5px so tiny y jitter does not create a second thick band
      const y = Math.round(s.y * 2) / 2;
      const key = `${s.color}|${y}`;
      if (!groups.has(key)) groups.set(key, { y, color: s.color, iv: [] });
      groups.get(key).iv.push([s.x, s.x + s.w]);
    });
    groups.forEach((g) => {
      g.iv.sort((a, b) => a[0] - b[0]);
      const merged = [];
      g.iv.forEach(([a, b]) => {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + 0.75) {
          last[1] = Math.max(last[1], b);
        } else {
          merged.push([a, b]);
        }
      });
      ctx.fillStyle = g.color;
      merged.forEach(([a, b]) => {
        ctx.fillRect(a, g.y, Math.max(b - a, 1), linePx);
      });
    });
  }

  function drawAnnotationsForPage(layer, pageNum, viewport) {
    layer.innerHTML = "";
    const W = viewport.width;
    const H = viewport.height;
    if (!W || !H) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-ann-canvas";
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const linePx = ANN.linePx;
    const items = state.annotations.filter((a) => (a.page || 1) === pageNum);
    const lineSegs = [];
    const fillRects = [];

    items.forEach((a) => {
      const type = a.type || "highlight";
      const defCol = TYPE_DEFAULT_COLOR[type] || "yellow";
      const colorId = a.color || defCol;
      const cm = colorMeta(colorId);

      const rectangles = a.pdfRects ? a.pdfRects.map(rect => {
        const bounds = viewport.convertToViewportRectangle(rect);
        return { x: Math.min(bounds[0], bounds[2]) / W, y: Math.min(bounds[1], bounds[3]) / H, w: Math.abs(bounds[2] - bounds[0]) / W, h: Math.abs(bounds[3] - bounds[1]) / H };
      }) : a.rects || [];
      rectangles.forEach((r) => {
        const x = r.x * W;
        const y = r.y * H;
        const w = Math.max(r.w * W, 1);
        const h = Math.max(r.h * H, 2);

        if (type === "highlight" && !a.native) {
          fillRects.push({
            x,
            y,
            w,
            h: Math.round(h),
            color: rgbaFromHex(cm.hex, ANN.highlightAlpha),
          });
        } else if (type === "strike" && !a.native) {
          const lineY = Math.round(y + h * ANN.strikeTopRatio);
          lineSegs.push({
            x,
            y: lineY,
            w,
            color: ANN.strikeLine,
          });
        } else if (!a.native) {
          // underline === comment geometry (pixel-snapped, same linePx)
          const lineY = Math.round(y + h * ANN.underlineTopRatio + ANN.underlineBottomPad);
          const color = type === "comment" ? ANN.commentLine : ANN.underlineLine;
          lineSegs.push({ x, y: lineY, w, color });
        }

        const hit = document.createElement("div");
        hit.className = "pdf-hl pdf-ann-hit";
        hit.dataset.id = a.id;
        hit.dataset.type = type;
        hit.dataset.color = colorId;
        hit.style.left = `${x}px`;
        hit.style.top = `${y}px`;
        hit.style.width = `${w}px`;
        hit.style.height = `${h}px`;
        hit.title = a.comment || a.text || "标注";
        bindAnnotEl(hit, a.id);
        layer.appendChild(hit);
      });
    });

    // Highlights: union by color+rect to avoid stacked alpha
    const fillGroups = new Map();
    fillRects.forEach((f) => {
      const key = `${f.color}|${Math.round(f.y)}|${Math.round(f.h)}`;
      if (!fillGroups.has(key)) fillGroups.set(key, { ...f, parts: [] });
      fillGroups.get(key).parts.push([f.x, f.x + f.w]);
    });
    fillGroups.forEach((g) => {
      g.parts.sort((a, b) => a[0] - b[0]);
      const merged = [];
      g.parts.forEach(([a, b]) => {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + 0.75) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
      });
      ctx.fillStyle = g.color;
      merged.forEach(([a, b]) => ctx.fillRect(a, g.y, Math.max(b - a, 1), g.h));
    });

    paintLineBands(ctx, lineSegs, linePx);
    layer.appendChild(canvas);
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
    ensureAnnotationIdle();
    const documentId = state.documentId, path = state.path, record = state.annotationRecord;
    record.items = cloneAnnots(state.annotations.filter(a => !a.native));
    pushAnnotHistory();
    await window.StuartCore.writeCoord.enqueue(`pdf-annotations:${documentId}`, async () => {
      await confirmAnnotationSave(await api("save_annotations", path, record.items, documentId));
    });
  }

  async function normalizeAnnotationCoordinates(document, record) {
    for (const annotation of record.items) {
      if (annotation.pdfQuads?.length) continue;
      const page = await document.getPage(annotation.page);
      const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
      let rectangles;
      if (annotation.pdfRects?.length) rectangles = annotation.pdfRects.map(rectangle => {
        const points = viewport.convertToViewportRectangle(rectangle);
        return { x: Math.min(points[0], points[2]) / viewport.width, y: Math.min(points[1], points[3]) / viewport.height, w: Math.abs(points[2] - points[0]) / viewport.width, h: Math.abs(points[3] - points[1]) / viewport.height };
      });
      else rectangles = annotation.rects;
      if (!Array.isArray(rectangles) || !rectangles.length) throw new Error("PDF批注缺少实际选区");
      annotation.pdfQuads = rectangles.map(rectangle => {
        const { x, y, w, h } = rectangle;
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new Error("PDF批注选区坐标无效");
        return [viewport.convertToPdfPoint(x * viewport.width, y * viewport.height), viewport.convertToPdfPoint((x + w) * viewport.width, y * viewport.height), viewport.convertToPdfPoint(x * viewport.width, (y + h) * viewport.height), viewport.convertToPdfPoint((x + w) * viewport.width, (y + h) * viewport.height)].flat();
      });
      annotation.pdfRects = annotation.pdfQuads.map(points => [Math.min(points[0], points[2], points[4], points[6]), Math.min(points[1], points[3], points[5], points[7]), Math.max(points[0], points[2], points[4], points[6]), Math.max(points[1], points[3], points[5], points[7])]);
    }
    if (document === state.doc) state.annotations = [...state.annotations.filter(annotation => annotation.native), ...cloneAnnots(record.items)];
  }

  async function editNativeAnnotations(edits) {
    ensureAnnotationIdle();
    const documentId = state.documentId, path = state.path, record = state.annotationRecord;
    return window.StuartCore.writeCoord.enqueue(`pdf-annotations:${documentId}`, async () => {
      const saved = await confirmAnnotationSave(await api("edit_pdf_annotations", path, edits, documentId));
      window.StuartMD.confirmPdfSave(documentId, saved);
      recordPdfSave(record, saved);
      pushRecordHistory(record);
      if (state.documentId === documentId) await reloadSavedPdf(documentId, record);
      return saved;
    });
  }

  async function confirmAnnotationSave(result) {
    if (result?.error) throw new Error(result.error);
    if (result?.saveResult?.result === "Conflict") { await window.StuartRecovery.showExportConflict(result.saveResult); throw new Error("PDF批注保存存在冲突，本地内容已经保留"); }
    if (result?.saveResult?.result !== "Saved") throw new Error("PDF批注保存没有完成");
    return result.saveResult;
  }

  async function recolorAnnotation(id, colorId) {
    const a = findAnnot(id);
    if (!a) return;
    ensureAnnotationIdle();
    if (a.native) {
      await editNativeAnnotations([{ action: "color", page: a.page, id: a.nativeAnnotationId, color: colorId }]);
      toast("已修改批注颜色");
      return;
    }
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
    const layer = wrap.querySelector(".pdf-text-layer");
    if (!layer?.contains(range.startContainer) || !layer.contains(range.endContainer)) return false;
    const wrapBox = wrap.getBoundingClientRect();
    const viewport = wrap._pdfViewport;
    if (!viewport) throw new Error("PDF页面尚未完成坐标初始化");
    const spans = (layer._pdfTextDivs || []).filter(span => range.intersectsNode(span) && span.textContent).map(span => ({ box: span.getBoundingClientRect(), angle: layer._pdfTextDivProperties.get(span).angle + viewport.rotation }));
    const rects = [], quads = [];
    for (const client of range.getClientRects()) {
      if (client.width < 1 || client.height < 1) continue;
      const overlaps = spans.map(span => ({ ...span, area: Math.max(0, Math.min(client.right, span.box.right) - Math.max(client.left, span.box.left)) * Math.max(0, Math.min(client.bottom, span.box.bottom) - Math.max(client.top, span.box.top)) })).sort((left, right) => right.area - left.area);
      if (!overlaps[0]?.area) continue;
      const angle = ((overlaps[0].angle % 360) + 360) % 360;
      if (Math.abs(angle / 90 - Math.round(angle / 90)) > 0.001) throw new Error("PDF选区包含无法核验的倾斜文字角度");
      const rect = { x: (client.left - wrapBox.left) / wrapBox.width, y: (client.top - wrapBox.top) / wrapBox.height, w: client.width / wrapBox.width, h: client.height / wrapBox.height };
      if (rects.some(previous => ["x", "y", "w", "h"].every(key => Math.abs(previous[key] - rect[key]) < 0.0001))) continue;
      const left = rect.x * viewport.width, right = (rect.x + rect.w) * viewport.width, top = rect.y * viewport.height, bottom = (rect.y + rect.h) * viewport.height;
      const corners = [[left, top], [right, top], [left, bottom], [right, bottom]];
      const order = [[0, 1, 2, 3], [1, 3, 0, 2], [3, 2, 1, 0], [2, 0, 3, 1]][Math.round(angle / 90) % 4];
      quads.push(order.map(index => viewport.convertToPdfPoint(...corners[index])));
      rects.push(rect);
    }
    if (!rects.length) return false;
    state._pendingSel = {
      documentId: state.documentId,
      loadEpoch: state.loadEpoch,
      text,
      rects,
      pdfRects: quads.map(points => [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]),
      pdfQuads: quads.map(points => points.flat()),
      page: Number(wrap.dataset.page || 1),
      clientX: ev ? ev.clientX : null,
      clientY: ev ? ev.clientY : null,
      at: Date.now(),
    };
    // Mirror into host selection cache so AI can read after chrome steals focus
    try {
      window.StuartMD?.captureSelectionCache?.();
    } catch (_) {}
    return true;
  }

  async function loadPageText(pageNum) {
    const document = state.doc, epoch = state.loadEpoch;
    if (!document || !Number.isInteger(pageNum) || pageNum < 1 || pageNum > state.total) throw new Error("PDF文字来源页码无效");
    const page = await document.getPage(pageNum);
    const content = await page.getTextContent();
    if (document !== state.doc || epoch !== state.loadEpoch) throw new Error("读取PDF文字期间已经切换文档");
    const text = content.items.map(item => item.str || "").join(" ").replace(/\s+/g, " ").trim();
    state._pageText[pageNum] = text;
    return text;
  }

  function getSelection() {
    const ctx = state._pendingSel;
    // Expire stale pending selection so AI/annotate never quote a dead highlight.
    if (ctx && (ctx.documentId !== state.documentId || ctx.loadEpoch !== state.loadEpoch || (ctx.at && Date.now() - ctx.at > 15000))) {
      state._pendingSel = null;
      return null;
    }
    if (ctx && ctx.text) {
      return {
        text: ctx.text,
        page: ctx.page,
        rects: ctx.rects || [],
        pdfRects: ctx.pdfRects || [],
        pdfQuads: ctx.pdfQuads || [],
        fromPdf: true,
      };
    }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      if (!captureSelectionCtx()) return null;
      const wrap =
        sel.anchorNode &&
        (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.(
          ".pdf-page"
        );
      return {
        text: sel.toString().trim(),
        page: wrap ? Number(wrap.dataset.page || state.page) : state.page,
        rects: state._pendingSel.rects,
        pdfRects: state._pendingSel.pdfRects,
        pdfQuads: state._pendingSel.pdfQuads,
        fromPdf: true,
      };
    }
    return null;
  }

  async function getAiContext() {
    const sel = getSelection();
    const page = (sel && sel.page) || state.page || 1;
    const capturedId = state.documentId;
    const source = await api("pdf_context", state.path, page);
    if (capturedId !== state.documentId) throw new Error("读取PDF上下文期间已经切换文档");
    const visible = source.pages.find(item => item.pageNumber === page);
    if (!visible || visible.needsReview) throw new Error("PDF页面的文字识别结果需要复核");
    return {
      kind: "pdf",
      name: state.path ? String(state.path).split(/[\\/]/).pop() : "PDF",
      path: state.path || "",
      quote: sel ? sel.text : "",
      page,
      pageText: visible.blocks.map(block => block.text).join("\n"),
      neighborText: source.pages.filter(item => item.pageNumber !== page && !item.needsReview).map(item => `【P${item.pageNumber}】\n${item.blocks.map(block => block.text).join("\n")}`).join("\n\n"),
      source,
      total: state.total,
    };
  }

  async function addAnnotFromSelection(type, colorId, commentText) {
    ensureAnnotationIdle();
    const ctx = state._pendingSel;
    if (!ctx || !state.path) {
      toast("请先选中 PDF 文字");
      return;
    }
    if (ctx.documentId !== state.documentId || ctx.loadEpoch !== state.loadEpoch || Date.now() - ctx.at > 15000) throw new Error("PDF选区已经失效，请重新选择文字");
    const defCol = TYPE_DEFAULT_COLOR[type] || state.hlColor || "yellow";
    const ann = {
      id: crypto.randomUUID(),
      type,
      color: colorId || defCol,
      page: ctx.page,
      text: ctx.text,
      comment: commentText || "",
      rects: ctx.rects,
      pdfRects: ctx.pdfRects,
      pdfQuads: ctx.pdfQuads,
    };
    try {
      const capturedId = state.documentId;
      state.annotations.push(ann);
      await persistAnnots();
      if (capturedId !== state.documentId) return;
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
    } catch (error) {
      toast("标注失败：" + error.message); throw error;
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
      ensureAnnotationIdle();
      if (a?.native) {
        await editNativeAnnotations([{ action: "delete", page: a.page, id: a.nativeAnnotationId }]);
        hideAnnotMenu(); toast("已删除批注"); return;
      }
      const capturedId = state.documentId;
      state.annotations = state.annotations.filter(annotation => annotation.id !== id);
      await persistAnnots();
      if (capturedId !== state.documentId) return;
      await refreshAnnots();
      hideAnnotMenu();
      toast("已擦除标注");
    } catch (error) {
      toast("擦除批注失败：" + error.message);
    }
  }

  async function refreshAnnots() {
    const e = el();
    if (!state.doc) return;
    const capturedDoc = state.doc, epoch = state.loadEpoch;
    for (const wrap of e.scroll.querySelectorAll(".pdf-page")) {
      const pageNum = Number(wrap.dataset.page);
      const layer = wrap.querySelector(".pdf-annot-layer");
      if (!layer) continue;
      const page = await capturedDoc.getPage(pageNum);
      if (capturedDoc !== state.doc || epoch !== state.loadEpoch || !wrap.isConnected) return;
      const rotation = ((page.rotate || 0) + state.rotation) % 360;
      const viewport = page.getViewport({ scale: state.scale, rotation });
      drawAnnotationsForPage(layer, pageNum, viewport);
    }
  }

  /**
   * Reliable confirm in Tauri WebView.
   * Native confirm() often no-ops / never shows — use in-app modal.
   */
  /**
   * @param {string} message
   * @param {{checkLabel?: string, checkDefault?: boolean}} [opts]
   * @returns {Promise<boolean|{ok:boolean, checked:boolean}>}
   */
  function uiConfirm(message, opts) {
    return new Promise((resolve) => {
      const modal = document.getElementById("stuart-confirm");
      const msg = document.getElementById("stuart-confirm-msg");
      const card = modal && modal.querySelector(".stuart-confirm-card");
      const okBtn = document.getElementById("stuart-confirm-ok");
      const cancelBtn = document.getElementById("stuart-confirm-cancel");
      const checkWrap = document.getElementById("stuart-confirm-check-wrap");
      const check = document.getElementById("stuart-confirm-check");
      const checkLabel = document.getElementById("stuart-confirm-check-label");
      const wantCheck = !!(opts && opts.checkLabel);
      if (!modal || !okBtn || !cancelBtn) {
        resolve(window.confirm(message));
        return;
      }
      modal.setAttribute(
        "style",
        "position:fixed;left:0;top:0;right:0;bottom:0;z-index:400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.38);margin:0;padding:0;"
      );
      if (card) {
        card.setAttribute(
          "style",
          "width:min(400px,92vw);background:#fff;color:#222;border-radius:12px;padding:16px 18px;box-shadow:0 16px 48px rgba(0,0,0,.25);font-family:system-ui,sans-serif;"
        );
      }
      if (msg) {
        msg.textContent = String(message || "");
        msg.setAttribute("style", "font-size:14px;line-height:1.55;white-space:pre-wrap;");
      }
      if (checkWrap && check && checkLabel) {
        if (wantCheck) {
          checkWrap.hidden = false;
          checkLabel.textContent = opts.checkLabel || "";
          check.checked = !!opts.checkDefault;
        } else {
          checkWrap.hidden = true;
          check.checked = false;
        }
      }
      modal.hidden = false;
      const finish = (val) => {
        modal.hidden = true;
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        document.removeEventListener("keydown", onKey, true);
        resolve(val);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          finish(wantCheck ? { ok: false, checked: false } : false);
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          finish(
            wantCheck ? { ok: true, checked: !!(check && check.checked) } : true
          );
        }
      };
      okBtn.onclick = () =>
        finish(wantCheck ? { ok: true, checked: !!(check && check.checked) } : true);
      cancelBtn.onclick = () =>
        finish(wantCheck ? { ok: false, checked: false } : false);
      document.addEventListener("keydown", onKey, true);
      try {
        okBtn.focus();
      } catch (_) {}
    });
  }

  async function clearAll() {
    if (!state.path) return;
    ensureAnnotationIdle();
    const capturedId = state.documentId;
    const res = await uiConfirm(
      "确定清除标注？\n默认只清除高光 / 下划线 / 删除线，保留评论。\n清除后可用 Ctrl+Z 撤销。",
      { checkLabel: "同时清除评论", checkDefault: false }
    );
    const ok = res && typeof res === "object" ? !!res.ok : !!res;
    const alsoComments = res && typeof res === "object" ? !!res.checked : false;
    if (!ok) return;
    if (capturedId !== state.documentId) throw new Error("确认清除期间已经切换 PDF 文档");
    const record = state.annotationRecord, path = state.path;
    record.restoring = true;
    try {
      for (let page = 1; page <= state.total; page++) {
        await loadNativePdfAnnotations(page);
        if (capturedId !== state.documentId) throw new Error("读取批注期间已经切换PDF文档");
      }
      const native = state.annotations.filter(annotation => annotation.native && (alsoComments || (!annotation.comment && annotation.type !== "comment")));
      await window.StuartCore.writeCoord.enqueue(`pdf-annotations:${capturedId}`, async () => {
        if (native.length) {
          const edits = native.map(annotation => ({ action: "delete", page: annotation.page, id: annotation.nativeAnnotationId }));
          const saved = await confirmAnnotationSave(await api("edit_pdf_annotations", path, edits, capturedId));
          window.StuartMD.confirmPdfSave(capturedId, saved);
          recordPdfSave(record, saved);
        }
        const retained = record.items.filter(annotation => !alsoComments && (annotation.type === "comment" || annotation.comment));
        await confirmAnnotationSave(await api("save_annotations", path, retained, capturedId));
        record.items = retained;
        pushRecordHistory(record);
        if (state.documentId === capturedId) await reloadSavedPdf(capturedId, record);
      });
      if (capturedId !== state.documentId) return;
      hideAnnotMenu();
      toast(alsoComments ? "已清除全部标注（含评论）" : "已清除标注（保留评论）");
    } catch (error) {
      toast("清除批注失败：" + error.message);
      throw error;
    } finally { record.restoring = false; }
  }

  async function exportAnnotsToPdf() {
    if (!state.path) {
      toast("请先打开 PDF");
      return;
    }
    ensureAnnotationIdle();
    const items = cloneAnnots(state.annotations.filter((a) => !a.native));
    if (!items.length) {
      toast("没有可写入的标注");
      return;
    }
    try {
      const capturedId = state.documentId, capturedPath = state.path;
      const record = state.annotationRecord;
      await window.StuartCore.writeCoord.enqueue(`pdf-annotations:${capturedId}`, async () => {
        const saved = await confirmAnnotationSave(await api("export_pdf_annotations", capturedPath, items, capturedId));
        window.StuartMD.confirmPdfSave(capturedId, saved);
        recordPdfSave(record, saved);
        record.items = record.items.filter(annotation => !items.some(exported => exported.id === annotation.id && JSON.stringify(exported) === JSON.stringify(annotation)));
        await confirmAnnotationSave(await api("save_annotations", capturedPath, record.items, capturedId));
        pushRecordHistory(record);
        if (state.documentId === capturedId) await reloadSavedPdf(capturedId, record);
      });
      toast("已写入 PDF 原生批注");
    } catch (err) {
      toast("写入 PDF 失败：" + (err && err.message ? err.message : err));
    }
  }

  // ---- Floating comment panel ----
  let _commentTargetId = null;
  let _commentDocumentId = null;
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
    _commentDocumentId = state.documentId;
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
    if (e.commentInput) { e.commentInput.value = a?.comment || ""; e.commentInput.readOnly = false; }
    if (e.commentPanel) e.commentPanel.hidden = false;
    placeCommentPanel(anchorX, anchorY);
    e.commentInput?.focus();
  }

  function closeCommentPanel() {
    const e = el();
    if (e.commentPanel) e.commentPanel.hidden = true;
    _commentTargetId = null;
    _commentDocumentId = null;
  }

  async function saveComment() {
    ensureAnnotationIdle();
    if (_commentDocumentId !== state.documentId) throw new Error("评论所属PDF文档已经变化");
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
    if (a.native) {
      await editNativeAnnotations([{ action: "comment", page: a.page, id: a.nativeAnnotationId, comment: text }]);
      closeCommentPanel(); toast("评论已经保存"); return;
    }
    a.comment = text;
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
      } else if (act === "ai-explain") {
        hideAnnotBar();
        try {
          window.StuartMD?.captureSelectionCache?.();
        } catch (_) {}
        if (window.StuartAIUI?.triggerExplain) {
          window.StuartAIUI.triggerExplain({ reposition: true }).catch((err) => {
            console.error(err);
            toast(String(err && err.message ? err.message : err));
          });
        } else {
          toast("AI 模块未加载");
        }
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

  async function openAnchor(hit) {
    await state.openPromise;
    if (!state.doc || hit.sourceHash !== window.StuartMD.getDocument().diskRevision.rawByteSha256) throw new Error("PDF来源文件指纹与知识命中不同");
    const pageNumber = Number(hit.pageNumber ?? hit.page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > state.total) throw new Error("PDF来源页码超出文档范围");
    const source = typeof hit.boundingBox === "string" ? JSON.parse(hit.boundingBox) : hit.boundingBox || hit.bounds;
    if (!source?.rects?.length || source.sourceHash !== hit.sourceHash) throw new Error("PDF来源缺少已经验证的坐标");
    const capturedId = state.documentId;
    const wrap = el().scroll.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
    if (!wrap) throw new Error("PDF来源页面尚未建立");
    wrap.scrollIntoView({ block: "center" });
    await renderPage(wrap);
    if (wrap.dataset.rendering === "1") await new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (wrap.dataset.rendering !== "1") { clearTimeout(timer); observer.disconnect(); resolve(); }
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error("PDF来源页面渲染超时")); }, 15000);
      observer.observe(wrap, { attributes: true, attributeFilter: ["data-rendering"] });
    });
    if (capturedId !== state.documentId || !wrap._pdfViewport || wrap.dataset.painted !== "1") throw new Error("PDF来源页面未完成当前文档的渲染");
    document.querySelectorAll(".pdf-source-anchor").forEach(element => element.remove());
    for (const rectangle of source.rects) {
      if (rectangle.length !== 4 || rectangle.some(value => !Number.isFinite(value))) throw new Error("PDF来源坐标无效");
      const points = wrap._pdfViewport.convertToViewportRectangle(rectangle);
      const marker = document.createElement("div"); marker.className = "pdf-source-anchor";
      Object.assign(marker.style, { position: "absolute", left: Math.min(points[0], points[2]) + "px", top: Math.min(points[1], points[3]) + "px", width: Math.abs(points[2] - points[0]) + "px", height: Math.abs(points[3] - points[1]) + "px", background: "rgba(255,210,45,.35)", outline: "2px solid #ca9e18", pointerEvents: "none", zIndex: "5" });
      wrap.append(marker);
    }
    state.page = pageNumber; el().pageInput.value = String(pageNumber);
  }

  function hidePdf() {
    state.loadEpoch++;
    const e = el();
    e.area.hidden = true;
    hideAnnotMenu();
    hideAnnotBar();
    hideHoverTip();
    closeCommentPanel();
    const disposing = disposeDoc();
    state.path = null;
    state.documentId = null;
    return disposing;
  }

  document.addEventListener("DOMContentLoaded", bindChrome);

  window.StuartMDPdf = {
    openPdf,
    hidePdf,
    renderAll,
    undoAnnot,
    redoAnnot,
    isActive: () => !el().area.hidden && !!state.doc,
    getSelection,
    getAiContext,
    getCurrentPage: () => state.page,
    openAnchor,
    loadPageText,
    uiConfirm,
    async releaseDocument(documentId) {
      if (state.documentId === documentId) await hidePdf();
      annotationRecords.delete(documentId);
    },
  };
  // Shared in-app confirm (Tauri native confirm() often no-ops)
  window.StuartUIConfirm = uiConfirm;
})();
