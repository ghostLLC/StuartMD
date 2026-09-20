/* StuartMD PDF viewer — pdf.js + multi-color annotations + native PDF export */
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

  /** Light highlighter colors — distinct from selection blue */
  const PALETTE = [
    { id: "yellow", label: "黄", css: "rgba(255,232,96,0.34)", hex: "#ffe566", pdf: [1.0, 0.91, 0.23] },
    { id: "green", label: "绿", css: "rgba(120,200,130,0.34)", hex: "#78c882", pdf: [0.47, 0.78, 0.51] },
    { id: "blue", label: "蓝", css: "rgba(100,170,230,0.32)", hex: "#64aae6", pdf: [0.39, 0.67, 0.9] },
    { id: "pink", label: "粉", css: "rgba(240,150,180,0.32)", hex: "#f096b4", pdf: [0.94, 0.59, 0.71] },
    { id: "orange", label: "橙", css: "rgba(250,180,90,0.34)", hex: "#fab45a", pdf: [0.98, 0.71, 0.35] },
    { id: "purple", label: "紫", css: "rgba(180,150,230,0.32)", hex: "#b496e6", pdf: [0.71, 0.59, 0.9] },
  ];

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
    rotation: 0,
    mode: "none", // highlight | none
    annotations: [],
    landscape: false,
    spread: false,
    selectedHlId: null,
    hlColor: "yellow",
  };

  /** Annotation undo/redo (PDF area only) */
  const annotHist = { stack: [], i: -1, max: 80 };

  const el = () => ({
    area: document.getElementById("pdf-area"),
    editor: document.getElementById("editor-area"),
    welcome: document.getElementById("welcome"),
    scroll: document.getElementById("pdf-scroll"),
    pageInput: document.getElementById("pdf-page-input"),
    pageLabel: document.getElementById("pdf-page-label"),
    btnHighlight: document.getElementById("pdf-highlight"),
    btnSpread: document.getElementById("pdf-spread"),
    annotMenu: document.getElementById("pdf-annot-menu"),
    palette: document.getElementById("pdf-color-palette"),
    colorDot: document.getElementById("pdf-color-dot"),
    commentModal: document.getElementById("pdf-comment-modal"),
    commentInput: document.getElementById("pdf-comment-input"),
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
        await api("save_annotations", state.path, state.annotations);
      } catch (_) {}
    }
    await refreshAnnots();
  }

  async function undoAnnot() {
    if (!pdfActive()) return false;
    if (annotHist.i <= 0) return false;
    annotHist.i--;
    await applyAnnotSnapshot(annotHist.stack[annotHist.i]);
    toast("已撤销标注");
    return true;
  }

  async function redoAnnot() {
    if (!pdfActive()) return false;
    if (annotHist.i >= annotHist.stack.length - 1) return false;
    annotHist.i++;
    await applyAnnotSnapshot(annotHist.stack[annotHist.i]);
    toast("已重做标注");
    return true;
  }

  function pdfActive() {
    const e = el();
    return !!(e.area && !e.area.hidden && state.doc);
  }

  function hideAnnotMenu() {
    const m = el().annotMenu;
    if (m) m.hidden = true;
    state.selectedHlId = null;
    document.querySelectorAll(".pdf-hl.selected").forEach((n) => n.classList.remove("selected"));
  }

  function showAnnotMenu(x, y, annId) {
    const m = el().annotMenu;
    if (!m) return;
    state.selectedHlId = annId;
    // fill recolor chips
    const box = document.getElementById("pdf-annot-colors");
    if (box) {
      box.innerHTML = "";
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
    m.hidden = false;
    const w = m.offsetWidth || 150;
    const h = m.offsetHeight || 80;
    m.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x)) + "px";
    m.style.top = Math.min(window.innerHeight - h - 8, Math.max(8, y)) + "px";
  }

  function setModeUI() {
    const e = el();
    const on = state.mode === "highlight";
    if (e.btnHighlight) {
      e.btnHighlight.classList.toggle("active", on);
      e.btnHighlight.title = on
        ? "标注中：选中文字即可标注（点击关闭）"
        : "标注（默认关闭）：开启后选中文字标注；右上可选颜色";
    }
    if (e.scroll) e.scroll.classList.toggle("highlight-mode", on);
    if (e.btnSpread) {
      e.btnSpread.classList.toggle("active", !!state.spread);
      e.btnSpread.title = state.spread ? "单页显示" : "双页显示";
    }
    if (e.colorDot) {
      const c = colorMeta(state.hlColor);
      e.colorDot.style.background = c.hex;
    }
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
        setModeUI();
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

  /** Pull native PDF Highlight/Text annotations (Edge/WPS) into our model. */
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
        } catch (_) {
          raw = [];
        }
        for (const a of raw || []) {
          const sub = a.subtype || a.Subtype || "";
          if (sub !== "Highlight" && sub !== "Text" && sub !== "Underline" && sub !== "StrikeOut") continue;
          const comment = a.contentsObj?.str || a.contents || a.titleObj?.str || "";
          const col = pdfColorToId(a.color);
          if (sub === "Highlight" || sub === "Underline" || sub === "StrikeOut") {
            const rects = quadToRects(a.quadPoints || a.quadpoints, W, H);
            if (!rects.length) continue;
            merged.push({
              id: "pdf-native-" + n + "-" + (a.id || merged.length),
              type: "highlight",
              native: true,
              page: n,
              color: col,
              text: String(comment || "").slice(0, 200),
              comment: comment ? String(comment) : "",
              rects,
            });
          }
        }
      }
      // Keep sidecar items + native (native first so they show even without sidecar)
      const sidecar = state.annotations.filter((a) => !a.native);
      const nativeOnly = merged.filter((m) => !sidecar.some((s) => s.id === m.id));
      state.annotations = [...nativeOnly, ...sidecar];
    } catch (err) {
      console.warn("native annot load", err);
    }
  }

  function pdfColorToId(color) {
    if (!color || !color.length) return "yellow";
    const [r, g, b] = color;
    // nearest palette
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
    // QuadPoints: 8 numbers per quad, PDF space y-up
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
    state.path = payload.path;
    state.name = payload.name;
    state.annotations = payload.annotations || [];
    state.page = 1;
    state.rotation = 0;
    state.scale = 1.2;
    state.mode = "none";
    e.scroll.innerHTML = "";
    setModeUI();

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

  function makePageWrap(num, minH) {
    const wrap = document.createElement("div");
    wrap.className = "pdf-page pending";
    wrap.dataset.page = String(num);
    wrap.style.minHeight = `${minH}px`;
    wrap.innerHTML = `<div class="pdf-page-placeholder">第 ${num} 页…</div>`;
    return wrap;
  }

  async function renderAll() {
    const e = el();
    if (!state.doc || !e.scroll) return;
    e.scroll.innerHTML = "";
    hideAnnotMenu();
    const total = state.total || 0;
    let vp0 = null;
    try {
      const page1 = await state.doc.getPage(1);
      const rotation = ((page1.rotate || 0) + state.rotation) % 360;
      vp0 = page1.getViewport({ scale: state.scale, rotation });
    } catch (_) {}
    const minH = vp0 ? Math.max(200, vp0.height * 0.8) : 480;

    const pageEls = [];
    const frag = document.createDocumentFragment();
    if (state.spread) {
      e.scroll.classList.add("spread-mode");
      for (let n = 1; n <= total; n += 2) {
        const row = document.createElement("div");
        row.className = "pdf-spread";
        const a = makePageWrap(n, minH);
        row.appendChild(a);
        pageEls.push(a);
        if (n + 1 <= total) {
          const b = makePageWrap(n + 1, minH);
          row.appendChild(b);
          pageEls.push(b);
        }
        frag.appendChild(row);
      }
    } else {
      e.scroll.classList.remove("spread-mode");
      for (let n = 1; n <= total; n++) {
        const wrap = makePageWrap(n, minH);
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
    wrap.dataset.rotation = String(rotation);
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

    const annotLayer = document.createElement("div");
    annotLayer.className = "pdf-annot-layer";
    annotLayer.style.width = `${viewport.width}px`;
    annotLayer.style.height = `${viewport.height}px`;
    wrap.appendChild(annotLayer);

    const layer = document.createElement("div");
    layer.className = "pdf-text-layer";
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    wrap.appendChild(layer);

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
        [
          `left:${tx[4]}px`,
          `top:${top}px`,
          `font-size:${fs}px`,
          `transform:rotate(${angle}rad)`,
          `transform-origin:0 0`,
        ].join(";")
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

  async function fitView() {
    await fitScaleToHeight(true);
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

  /** Full line-box rects (match top/bottom of selection). */
  function hlRectsFromClientRects(clientRects, wrapBox) {
    const rects = [];
    for (let i = 0; i < clientRects.length; i++) {
      const cr = clientRects[i];
      if (cr.width < 2 || cr.height < 2) continue;
      rects.push({
        x: (cr.left - wrapBox.left) / wrapBox.width,
        y: (cr.top - wrapBox.top) / wrapBox.height,
        w: cr.width / wrapBox.width,
        h: cr.height / wrapBox.height,
      });
    }
    return rects;
  }

  function drawAnnotationsForPage(layer, pageNum, viewport) {
    layer.innerHTML = "";
    const pickable = state.mode !== "highlight";
    state.annotations
      .filter((a) => (a.page || 1) === pageNum)
      .forEach((a) => {
        (a.rects || []).forEach((r) => {
          const box = document.createElement("div");
          box.className = "pdf-hl" + (a.comment ? " has-comment" : "");
          box.dataset.id = a.id;
          box.dataset.color = a.color || "yellow";
          box.style.left = `${r.x * viewport.width}px`;
          box.style.top = `${r.y * viewport.height}px`;
          box.style.width = `${r.w * viewport.width}px`;
          box.style.height = `${Math.max(r.h * viewport.height, 2)}px`;
          box.style.background = colorMeta(a.color || state.hlColor).css;
          box.style.pointerEvents = pickable ? "auto" : "none";
          box.title = a.comment || a.text || "标注";
          if (pickable) {
            box.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              document.querySelectorAll(".pdf-hl.selected").forEach((n) => n.classList.remove("selected"));
              box.classList.add("selected");
              state.selectedHlId = a.id;
            });
            box.addEventListener("contextmenu", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              document.querySelectorAll(".pdf-hl.selected").forEach((n) => n.classList.remove("selected"));
              box.classList.add("selected");
              showAnnotMenu(ev.clientX, ev.clientY, a.id);
            });
          }
          layer.appendChild(box);
        });
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
    if (a.native) {
      // native items are display-only unless exported — still recolor locally
    }
    await persistAnnots();
    await refreshAnnots();
    toast("已改标注颜色");
  }

  function bindHighlightLayer() {
    const e = el();
    e.scroll.onmouseup = async (ev) => {
      hideAnnotMenu();
      if (state.mode !== "highlight") return;
      if (ev.target.closest("#pdf-toolbar")) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const text = sel.toString().trim();
      if (!text) return;
      const range = sel.getRangeAt(0);
      const wrap =
        ev.target.closest(".pdf-page") ||
        range.startContainer.parentElement?.closest(".pdf-page");
      if (!wrap) return;
      const pageNum = Number(wrap.dataset.page || 1);
      const rectLayer = wrap.querySelector(".pdf-annot-layer");
      const wrapBox = wrap.getBoundingClientRect();
      const rects = hlRectsFromClientRects(range.getClientRects(), wrapBox);
      if (!rects.length) return;
      const colorId = state.hlColor || "yellow";
      const ann = {
        type: "highlight",
        color: colorId,
        page: pageNum,
        text,
        rects,
      };
      try {
        const res = await api("add_annotation", state.path, ann);
        if (res?.error) {
          toast(res.error);
          return;
        }
        state.annotations = await api("load_annotations", state.path);
        // re-merge natives
        await loadNativePdfAnnotations();
        pushAnnotHistory();
        sel.removeAllRanges();
        const page = await state.doc.getPage(pageNum);
        const rotation = ((page.rotate || 0) + state.rotation) % 360;
        const viewport = page.getViewport({ scale: state.scale, rotation });
        drawAnnotationsForPage(rectLayer, pageNum, viewport);
        toast("已标注");
      } catch (_) {
        toast("标注失败");
      }
    };

    e.scroll.oncontextmenu = (ev) => {
      if (ev.target.closest(".pdf-hl")) return;
      hideAnnotMenu();
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
        toast("已隐藏原生标注（导出前不会写回 PDF）");
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

  async function clearAll() {
    if (!state.path) return;
    if (!confirm("确定清除该 PDF 的全部标注？\n此操作不可撤销（除非立刻 Ctrl+Z）。")) return;
    if (!confirm("再次确认：清除全部标注？")) return;
    try {
      await api("clear_annotations", state.path);
      state.annotations = state.annotations.filter((a) => a.native);
      pushAnnotHistory();
      await refreshAnnots();
      hideAnnotMenu();
      toast("已清除侧车标注");
    } catch (_) {
      toast("清除失败");
    }
  }

  /** Export sidecar annotations into the PDF as native Highlight + Text (WPS/Edge). */
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
      toast("已写入 PDF 原生批注（可用 WPS / Edge 打开查看）");
      if (res.path && res.path !== state.path) {
        toast("另存为：" + res.path);
      }
    } catch (err) {
      toast("写入 PDF 失败：" + (err && err.message ? err.message : err));
    }
  }

  // ---- Comment modal ----
  let _commentTargetId = null;

  function openCommentModal(id) {
    const e = el();
    _commentTargetId = id;
    const a = findAnnot(id);
    if (e.commentInput) e.commentInput.value = (a && (a.comment || a.text)) || "";
    if (e.commentModal) e.commentModal.hidden = false;
    e.commentInput?.focus();
  }

  function closeCommentModal() {
    const e = el();
    if (e.commentModal) e.commentModal.hidden = true;
    _commentTargetId = null;
  }

  async function saveComment() {
    const e = el();
    const id = _commentTargetId;
    const text = (e.commentInput && e.commentInput.value ? e.commentInput.value : "").trim();
    closeCommentModal();
    if (!id) return;
    const a = findAnnot(id);
    if (!a) return;
    a.comment = text;
    a.text = text || a.text;
    await persistAnnots();
    await refreshAnnots();
    toast(text ? "评论已保存" : "评论已清空");
  }

  let zoomTimer = 0;
  async function setZoom(scale, immediate) {
    state.scale = Math.max(0.35, Math.min(4, scale));
    clearTimeout(zoomTimer);
    if (immediate) {
      await renderAll();
      return;
    }
    zoomTimer = setTimeout(() => renderAll(), 140);
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
    on("pdf-zoom-in", () => setZoom(state.scale + 0.15, true));
    on("pdf-zoom-out", () => setZoom(state.scale - 0.15, true));
    on("pdf-fit", () => fitView());
    on("pdf-rotate", () => rotateView());
    on("pdf-spread", async () => {
      state.spread = !state.spread;
      setModeUI();
      if (state.spread) await fitToWidth(true);
      else await fitScaleToHeight(true);
      toast(state.spread ? "双页显示" : "单页显示");
    });
    on("pdf-highlight", () => {
      state.mode = state.mode === "highlight" ? "none" : "highlight";
      setModeUI();
      hideAnnotMenu();
      refreshAnnots();
      toast(state.mode === "highlight" ? "标注已开启" : "标注已关闭：可点选后右键操作");
    });
    on("pdf-hl-color", (ev) => {
      ev.stopPropagation();
      if (!e.palette) return;
      e.palette.hidden = !e.palette.hidden;
      if (!e.palette.hidden) renderPalette();
    });
    on("pdf-export-annots", () => exportAnnotsToPdf());
    on("pdf-clear", () => clearAll());

    e.scroll?.addEventListener(
      "wheel",
      (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        if (!state.doc) return;
        ev.preventDefault();
        const dir = ev.deltaY > 0 ? -0.12 : 0.12;
        setZoom(state.scale + dir, false);
      },
      { passive: false }
    );

    // Annot context menu actions
    e.annotMenu?.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-annot-act]");
      if (!btn) return;
      const act = btn.dataset.annotAct;
      const id = state.selectedHlId;
      if (!id) return;
      if (act === "erase") {
        await eraseAnnotation(id);
      } else if (act === "comment") {
        openCommentModal(id);
        hideAnnotMenu();
      }
    });

    document.getElementById("pdf-comment-ok")?.addEventListener("click", () => saveComment());
    document.getElementById("pdf-comment-cancel")?.addEventListener("click", () => closeCommentModal());
    e.commentModal?.addEventListener("click", (ev) => {
      if (ev.target === e.commentModal) closeCommentModal();
    });

    document.addEventListener("mousedown", (ev) => {
      if (e.palette && !e.palette.hidden && !ev.target.closest(".pdf-color-wrap")) {
        e.palette.hidden = true;
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
        closeCommentModal();
        if (e.palette) e.palette.hidden = true;
      }
    });

    // Annotation undo/redo when PDF is the active surface
    window.addEventListener("keydown", (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod) return;
      if (!pdfActive()) return;
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

    setModeUI();
  }

  function hidePdf() {
    const e = el();
    e.area.hidden = true;
    hideAnnotMenu();
    closeCommentModal();
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
