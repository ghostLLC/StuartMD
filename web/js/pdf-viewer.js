/* StuartMD PDF viewer — pdf.js + lightweight highlight annotations */
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

  const HL_COLOR = "#ffe566";
  const state = {
    path: null,
    name: "",
    doc: null,
    page: 1,
    total: 1,
    scale: 1.2,
    rotation: 0,
    // highlight OFF by default — erase via click/right-click on marks
    mode: "none", // highlight | none
    annotations: [],
    landscape: false,
    spread: false,
    selectedHlId: null,
  };

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
    m.hidden = false;
    const w = m.offsetWidth || 130;
    const h = m.offsetHeight || 40;
    m.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x)) + "px";
    m.style.top = Math.min(window.innerHeight - h - 8, Math.max(8, y)) + "px";
  }

  function setModeUI() {
    const e = el();
    const on = state.mode === "highlight";
    if (e.btnHighlight) {
      e.btnHighlight.classList.toggle("active", on);
      e.btnHighlight.title = on
        ? "标黄中：选中文字即可标黄（点击关闭）"
        : "标黄（默认关闭）：开启后选中文字即可标黄";
    }
    if (e.scroll) e.scroll.classList.toggle("highlight-mode", on);
    if (e.btnSpread) {
      e.btnSpread.classList.toggle("active", !!state.spread);
      e.btnSpread.title = state.spread ? "单页显示" : "双页显示";
    }
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
    hideAnnotMenu();
    state.path = payload.path;
    state.name = payload.name;
    state.annotations = payload.annotations || [];
    state.page = 1;
    state.rotation = 0;
    state.scale = 1.2;
    // Default: highlight tool off
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
      // Smart initial fit: portrait → height, landscape → width
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
        console.error("PDF page render failed", num, err);
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

    // Highlight UNDER text layer (Edge/WPS): canvas → annot → transparent text
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

    if (!existingWrap) {
      e.scroll.appendChild(wrap);
    }

    await page.render({ canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;

    const textContent = await page.getTextContent();
    const frag = document.createDocumentFragment();
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

  /** Toolbar "适应" — height fit (single control). */
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

  /**
   * Convert DOM selection client rects → highlight rects that sit under glyphs
   * (lower band of the line box), like Edge/WPS marker under text.
   */
  function hlRectsFromClientRects(clientRects, wrapBox) {
    const rects = [];
    for (let i = 0; i < clientRects.length; i++) {
      const cr = clientRects[i];
      if (cr.width < 2 || cr.height < 2) continue;
      const x = (cr.left - wrapBox.left) / wrapBox.width;
      const y = (cr.top - wrapBox.top) / wrapBox.height;
      const w = cr.width / wrapBox.width;
      const h = cr.height / wrapBox.height;
      // Bias downward: keep ~60% of line height on the lower part of the box
      const topPad = h * 0.18;
      const hlH = h * 0.58;
      rects.push({
        x,
        y: y + topPad,
        w,
        h: Math.max(hlH, 0.04),
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
          // Legacy full-line rects: re-bias under glyphs (Edge/WPS marker)
          let ry = r.y;
          let rh = r.h;
          if (rh > 0.72) {
            ry = r.y + rh * 0.18;
            rh = rh * 0.58;
          }
          const box = document.createElement("div");
          box.className = "pdf-hl";
          box.dataset.id = a.id;
          box.style.left = `${r.x * viewport.width}px`;
          box.style.top = `${ry * viewport.height}px`;
          box.style.width = `${r.w * viewport.width}px`;
          box.style.height = `${rh * viewport.height}px`;
          box.style.background = a.color || HL_COLOR;
          box.style.pointerEvents = pickable ? "auto" : "none";
          box.title = a.text ? a.text.slice(0, 80) : "高亮";
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
      const ann = {
        type: "highlight",
        color: HL_COLOR,
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
        const rotation = ((page.rotate || 0) + state.rotation) % 360;
        const viewport = page.getViewport({ scale: state.scale, rotation });
        drawAnnotationsForPage(rectLayer, pageNum, viewport);
        toast("已标黄");
      } catch (_) {
        toast("标黄失败");
      }
    };

    e.scroll.oncontextmenu = (ev) => {
      // Allow default menu outside annot; annot handler stops propagation
      if (ev.target.closest(".pdf-hl")) return;
      hideAnnotMenu();
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
      hideAnnotMenu();
      toast("已擦除高亮");
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
    const ok = confirm("确定清除该 PDF 的全部高亮？\n此操作不可撤销。");
    if (!ok) return;
    const ok2 = confirm("再次确认：清除全部高亮？");
    if (!ok2) return;
    try {
      await api("clear_annotations", state.path);
      state.annotations = [];
      await refreshAnnots();
      hideAnnotMenu();
      toast("已清除全部高亮");
    } catch (_) {
      toast("清除失败");
    }
  }

  let zoomTimer = 0;
  async function setZoom(scale, immediate) {
    state.scale = Math.max(0.35, Math.min(4, scale));
    clearTimeout(zoomTimer);
    if (immediate) {
      await renderAll();
      return;
    }
    zoomTimer = setTimeout(() => {
      renderAll();
    }, 140);
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
        const p = e.scroll.querySelector(`.pdf-page[data-page="${state.page}"]`);
        p?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    on("pdf-next", async () => {
      const step = state.spread ? 2 : 1;
      if (state.page < state.total) {
        state.page = Math.min(state.total, state.page + step);
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
    on("pdf-zoom-in", () => setZoom(state.scale + 0.15, true));
    on("pdf-zoom-out", () => setZoom(state.scale - 0.15, true));
    on("pdf-fit", () => fitView());
    on("pdf-rotate", () => rotateView());
    on("pdf-spread", async () => {
      state.spread = !state.spread;
      setModeUI();
      // Re-fit so two pages fit the pane when spreading
      if (state.spread) await fitToWidth(true);
      else await fitScaleToHeight(true);
      toast(state.spread ? "双页显示" : "单页显示");
    });
    on("pdf-highlight", () => {
      state.mode = state.mode === "highlight" ? "none" : "highlight";
      setModeUI();
      hideAnnotMenu();
      // Refresh pickability of existing marks
      refreshAnnots();
      toast(state.mode === "highlight" ? "标黄已开启：选中文字即可标黄" : "标黄已关闭：可点选高亮后右键擦除");
    });
    on("pdf-clear", () => clearAll());

    // Ctrl + wheel → zoom
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

    // Annot context menu
    const menu = document.getElementById("pdf-annot-menu");
    document.getElementById("pdf-annot-erase")?.addEventListener("click", async () => {
      const id = state.selectedHlId;
      if (!id) return;
      await eraseAnnotation(id);
    });
    document.addEventListener("mousedown", (ev) => {
      if (!menu || menu.hidden) return;
      if (ev.target.closest("#pdf-annot-menu") || ev.target.closest(".pdf-hl")) return;
      hideAnnotMenu();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") hideAnnotMenu();
    });

    setModeUI();
  }

  function hidePdf() {
    const e = el();
    e.area.hidden = true;
    hideAnnotMenu();
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
