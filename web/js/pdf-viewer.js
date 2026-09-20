/* StuartMD PDF viewer — pdf.js + lightweight highlight annotations */
(function () {
  "use strict";

  if (!window.pdfjsLib && window.pdfjsViewer) {
    // no-op
  }
  if (window.pdfjsLib) {
    // Resolve against page URL so file-association / new-window opens still find the worker
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "libs/pdf.worker.min.js",
        window.location.href
      ).href;
    } catch (_) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";
    }
  }

  const state = {
    path: null,
    name: "",
    doc: null,
    page: 1,
    total: 1,
    scale: 1.2,
    rotation: 0, // additional user rotation: 0/90/180/270
    mode: "highlight", // highlight | erase | none
    annotations: [],
    rendering: false,
    pendingPage: null,
    landscape: false,
  };

  const el = () => ({
    area: document.getElementById("pdf-area"),
    editor: document.getElementById("editor-area"),
    welcome: document.getElementById("welcome"),
    scroll: document.getElementById("pdf-scroll"),
    pageInput: document.getElementById("pdf-page-input"),
    pageLabel: document.getElementById("pdf-page-label"),
    btnHighlight: document.getElementById("pdf-highlight"),
    btnErase: document.getElementById("pdf-erase"),
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

  function setModeUI() {
    const e = el();
    if (!e.btnHighlight) return;
    e.btnHighlight.classList.toggle("active", state.mode === "highlight");
    e.btnHighlight.textContent = state.mode === "highlight" ? "标黄中" : "标黄";
    e.btnErase.classList.toggle("active", state.mode === "erase");
    e.btnErase.textContent = state.mode === "erase" ? "擦除中" : "擦除";
    e.scroll.classList.toggle("erase-mode", state.mode === "erase");
    e.scroll.classList.toggle("highlight-mode", state.mode === "highlight");
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

      // Detect landscape (incl. rotated pages) and auto-fit width
      const p1 = await state.doc.getPage(1);
      const vp1 = p1.getViewport({ scale: 1, rotation: p1.rotate + state.rotation });
      state.landscape = vp1.width >= vp1.height;
      // Compute scale only, then ALWAYS paint pages (blank-view fix)
      await fitToWidth(false);
      await renderAll();

      document.title = `${payload.name} — StuartMD`;
    } catch (err) {
      console.error("PDF open failed", err);
      toast("PDF 打开失败：" + (err && err.message ? err.message : err));
      e.area.hidden = true;
      e.welcome.hidden = false;
    }
  }

  async function renderAll() {
    const e = el();
    if (!state.doc || !e.scroll) return;
    e.scroll.innerHTML = "";
    // Create lightweight placeholders first; paint pages as they enter view
    const pageEls = [];
    const total = state.total || 0;
    // Cache page-1 metrics once (avoid N× getPage(1) on long reports)
    let page1 = null;
    let vp0 = null;
    try {
      page1 = await state.doc.getPage(1);
      const rotation = ((page1.rotate || 0) + state.rotation) % 360;
      vp0 = page1.getViewport({ scale: state.scale, rotation });
    } catch (_) {}
    const minH = vp0 ? Math.max(200, vp0.height * 0.8) : 480;
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= total; n++) {
      const wrap = document.createElement("div");
      wrap.className = "pdf-page pending";
      wrap.dataset.page = String(n);
      wrap.style.minHeight = `${minH}px`;
      wrap.innerHTML = `<div class="pdf-page-placeholder">第 ${n} 页…</div>`;
      frag.appendChild(wrap);
      pageEls.push(wrap);
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
        console.error("PDF page render failed", num, err);
      }
    };

    // Always paint the first pages immediately so the view is never blank
    for (let i = 0; i < Math.min(2, pageEls.length); i++) {
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
      // Safety net: if IO never fires (zero-size root / headless quirk), paint page 1–3
      setTimeout(() => {
        if (!state.doc) return;
        pageEls.slice(0, 3).forEach((w) => {
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
    // Include page.Rotate (stored rotation) + user rotation → works for landscape PDFs
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

    if (!existingWrap) {
      e.scroll.appendChild(wrap);
    }

    await page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;

    // text layer — viewport.transform already handles rotation (portrait + landscape)
    const textContent = await page.getTextContent();
    textContent.items.forEach((item) => {
      if (!item.str) return;
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const style = [
        `left:${tx[4]}px`,
        `top:${tx[5] - fontHeight}px`,
        `font-size:${fontHeight}px`,
        `transform:rotate(${angle}rad)`,
        `transform-origin:0 0`,
      ].join(";");
      const span = document.createElement("span");
      span.textContent = item.str;
      span.setAttribute("style", style);
      layer.appendChild(span);
    });

    drawAnnotationsForPage(annotLayer, num, viewport);
  }

  async function fitToWidth(reRender = true) {
    const e = el();
    if (!state.doc) return;
    const page = await state.doc.getPage(1);
    const rotation = ((page.rotate || 0) + state.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation });
    const avail = Math.max(320, e.scroll.clientWidth - 40);
    state.scale = Math.max(0.4, Math.min(3, avail / vp1.width));
    if (reRender) await renderAll();
  }

  async function fitToHeight() {
    const e = el();
    if (!state.doc) return;
    const page = await state.doc.getPage(1);
    const rotation = ((page.rotate || 0) + state.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation });
    const avail = Math.max(320, e.scroll.clientHeight - 40);
    state.scale = Math.max(0.4, Math.min(3, avail / vp1.height));
    await renderAll();
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

  function drawAnnotationsForPage(layer, pageNum, viewport) {
    layer.innerHTML = "";
    state.annotations
      .filter((a) => (a.page || 1) === pageNum)
      .forEach((a) => {
        (a.rects || []).forEach((r) => {
          const box = document.createElement("div");
          box.className = "pdf-hl";
          box.dataset.id = a.id;
          box.style.left = `${r.x * viewport.width}px`;
          box.style.top = `${r.y * viewport.height}px`;
          box.style.width = `${r.w * viewport.width}px`;
          box.style.height = `${r.h * viewport.height}px`;
          box.style.background = a.color || "#fff59d";
          box.title = a.text ? a.text.slice(0, 80) : "高亮";
          box.addEventListener("click", async (ev) => {
            if (state.mode === "erase") {
              ev.preventDefault();
              ev.stopPropagation();
              await eraseAnnotation(a.id);
            }
          });
          layer.appendChild(box);
        });
      });
  }

  function bindHighlightLayer() {
    const e = el();
    e.scroll.onmouseup = async (ev) => {
      if (state.mode !== "highlight") return;
      // don't start from toolbar
      if (ev.target.closest("#pdf-toolbar")) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const text = sel.toString().trim();
      if (!text) return;
      const range = sel.getRangeAt(0);
      const wrap = ev.target.closest(".pdf-page") || range.startContainer.parentElement?.closest(".pdf-page");
      if (!wrap) return;
      const pageNum = Number(wrap.dataset.page || 1);
      const rectLayer = wrap.querySelector(".pdf-annot-layer");
      const wrapBox = wrap.getBoundingClientRect();
      const rects = [];
      const clientRects = range.getClientRects();
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
      if (!rects.length) return;
      const ann = {
        type: "highlight",
        color: "#fff59d",
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
        sel.removeAllRanges();
        const page = await state.doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: state.scale });
        drawAnnotationsForPage(rectLayer, pageNum, viewport);
        toast("已标黄");
      } catch (_) {
        toast("标黄失败");
      }
    };
  }

  async function eraseAnnotation(id) {
    try {
      const res = await api("delete_annotation", state.path, id);
      if (res?.error) {
        toast(res.error);
        return;
      }
      state.annotations = await api("load_annotations", state.path);
      await refreshAnnots();
      toast("已擦除高亮");
    } catch (_) {}
  }

  async function refreshAnnots() {
    const e = el();
    for (const wrap of e.scroll.querySelectorAll(".pdf-page")) {
      const pageNum = Number(wrap.dataset.page);
      const layer = wrap.querySelector(".pdf-annot-layer");
      const page = await state.doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: state.scale });
      drawAnnotationsForPage(layer, pageNum, viewport);
    }
  }

  async function clearAll() {
    if (!state.path) return;
    if (!confirm("清除该 PDF 的全部高亮？")) return;
    try {
      await api("clear_annotations", state.path);
      state.annotations = [];
      await refreshAnnots();
      toast("已清除全部高亮");
    } catch (_) {}
  }

  async function copySelection() {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "";
    if (!text) {
      toast("请先选中文本");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch (_) {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("已复制");
    }
  }

  async function setZoom(scale) {
    state.scale = Math.max(0.5, Math.min(3, scale));
    await renderAll();
  }

  function bindChrome() {
    const e = el();
    const on = (id, fn) => {
      const n = document.getElementById(id);
      if (n) n.addEventListener("click", fn);
    };
    on("pdf-prev", async () => {
      if (state.page > 1) {
        state.page -= 1;
        e.pageInput.value = String(state.page);
        const p = e.scroll.querySelector(`.pdf-page[data-page="${state.page}"]`);
        p?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    on("pdf-next", async () => {
      if (state.page < state.total) {
        state.page += 1;
        e.pageInput.value = String(state.page);
        const p = e.scroll.querySelector(`.pdf-page[data-page="${state.page}"]`);
        p?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    e.pageInput?.addEventListener("change", () => {
      const n = Number(e.pageInput.value || 1);
      state.page = Math.max(1, Math.min(state.total, n));
      e.pageInput.value = String(state.page);
      const p = e.scroll.querySelector(`.pdf-page[data-page="${state.page}"]`);
      p?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    on("pdf-zoom-in", () => setZoom(state.scale + 0.15));
    on("pdf-zoom-out", () => setZoom(state.scale - 0.15));
    on("pdf-fit", () => fitToWidth(true));
    on("pdf-fit-h", () => fitToHeight());
    on("pdf-rotate", () => rotateView());
    on("pdf-highlight", () => {
      state.mode = state.mode === "highlight" ? "none" : "highlight";
      setModeUI();
      toast(state.mode === "highlight" ? "选中文本即可标黄" : "已关闭标黄");
    });
    on("pdf-erase", () => {
      state.mode = state.mode === "erase" ? "none" : "erase";
      setModeUI();
      toast(state.mode === "erase" ? "点击高亮即可擦除" : "已关闭擦除");
    });
    on("pdf-copy", copySelection);
    on("pdf-clear", clearAll);
    setModeUI();
  }

  function hidePdf() {
    const e = el();
    e.area.hidden = true;
    // Fire-and-forget dispose; avoid leaking PDF.js workers/bitmaps
    disposeDoc();
    state.path = null;
  }

  document.addEventListener("DOMContentLoaded", bindChrome);

  window.StuartMDPdf = {
    openPdf,
    hidePdf,
    renderAll,
    isActive: () => !el().area.hidden && !!state.doc,
  };
})();
