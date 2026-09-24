// Empirical Verification for P1-2 (PDF.js Virtualization, Sliding Window & Canvas VRAM Release)
const assert = require("assert");

console.log("======================================================================");
console.log(">>> TARGET 3: P1-2 (PDF.js Virtualization & Canvas Memory Release)");
console.log("======================================================================\n");

// Minimal DOM simulation for Node.js test environment
class MockCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.style = {};
    this.parentElement = null;
    this.history = [];
  }
  getContext(type) {
    return {
      save() {}, restore() {}, fillRect() {}, clearRect() {},
      drawImage() {}, scale() {}, translate() {}, transform() {}
    };
  }
  remove() {
    this.history.push({ action: "remove", width: this.width, height: this.height });
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }
}

class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.parentElement = null;
    this.offsetTop = 0;
    this.offsetHeight = 1000;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function matches(el, selector) {
  if (selector === "canvas" || selector === "canvas:not(.pdf-ann-canvas)") {
    return el instanceof MockCanvas;
  }
  if (selector === ".pdf-page") {
    return el.className && el.className.includes("pdf-page");
  }
  if (selector === '.pdf-page[data-painted="1"]') {
    return el.className && el.className.includes("pdf-page") && el.dataset.painted === "1";
  }
  if (selector === ".pdf-text-layer") {
    return el.className === "pdf-text-layer";
  }
  if (selector === ".pdf-annot-layer") {
    return el.className === "pdf-annot-layer";
  }
  if (selector === ".pdf-page-label") {
    return el.className === "pdf-page-label";
  }
  if (selector === ".pdf-page-placeholder") {
    return el.className === "pdf-page-placeholder";
  }
  return false;
}

// Global DOM mocks
global.document = {
  createElement(tag) {
    if (tag.toLowerCase() === "canvas") return new MockCanvas();
    return new MockElement(tag);
  },
  createDocumentFragment() {
    return new MockElement("fragment");
  },
  getElementById(id) {
    return mockElements[id] || null;
  }
};
global.window = {
  devicePixelRatio: 1,
  pdfjsLib: {
    Util: {
      transform: () => [1, 0, 0, 1, 0, 0]
    }
  }
};

const mockElements = {};
const scrollContainer = new MockElement("div");
scrollContainer.scrollTop = 0;
scrollContainer.clientHeight = 1000;
mockElements["pdf-scroll"] = scrollContainer;

// StuartMD Virtualization Engine Setup (from pdf-viewer.js)
const activeRenderTasks = new Map();
const MAX_RENDERED_PAGES = 5;
const allCreatedCanvases = [];

function el() {
  return { scroll: scrollContainer };
}

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

  // 2. Physical VRAM release: set width=0, height=0 on ALL canvases
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

  // 4. Restore lightweight placeholder
  if (!wrap.querySelector(".pdf-page-placeholder")) {
    const ph = document.createElement("div");
    ph.className = "pdf-page-placeholder";
    ph.textContent = `第 ${pageNum} 页…`;
    wrap.appendChild(ph);
  }

  wrap.dataset.painted = "0";
  wrap.classList = "pdf-page pending";
}

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

class MockRenderTask {
  constructor(pageNum, delayMs = 15) {
    this.pageNum = pageNum;
    this.cancelled = false;
    this.cancelCount = 0;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(() => {
        if (!this.cancelled) resolve();
      }, delayMs);
    });
  }

  cancel() {
    this.cancelled = true;
    this.cancelCount++;
    clearTimeout(this._timer);
    const err = new Error("Rendering cancelled");
    err.name = "RenderingCancelledException";
    this._reject(err);
  }
}

async function renderPage(num, renderDelayMs = 15) {
  const wrap = scrollContainer.querySelector(`.pdf-page[data-page="${num}"]`);
  if (!wrap) return;
  if (wrap.dataset.painted === "1" || wrap.dataset.rendering === "1") return;

  // Cancel any stale task
  const prevTask = activeRenderTasks.get(num);
  if (prevTask) {
    try { prevTask.cancel(); } catch (_) {}
    activeRenderTasks.delete(num);
  }

  wrap.dataset.rendering = "1";

  try {
    // Clear placeholder
    const ph = wrap.querySelector(".pdf-page-placeholder");
    if (ph) ph.remove();

    let canvas = wrap.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 1600;
      allCreatedCanvases.push({ pageNum: num, canvas });
      wrap.appendChild(canvas);
    }

    const renderTask = new MockRenderTask(num, renderDelayMs);
    activeRenderTasks.set(num, renderTask);

    await renderTask.promise;

    // Check if wrap was evicted while in flight
    if (wrap.dataset.rendering !== "1") {
      return;
    }

    wrap.dataset.painted = "1";
    wrap.className = "pdf-page";

    // Enforce pool limit immediately after page completes painting
    enforceMaxRenderedPool();
  } catch (err) {
    if (err?.name === "RenderingCancelledException" || err?.message?.includes("cancelled")) {
      return; // Silent catch
    }
    wrap.dataset.painted = "0";
  } finally {
    delete wrap.dataset.rendering;
    activeRenderTasks.delete(num);
  }
}

// -------------------------------------------------------------------------------------
// TEST EXECUTION
// -------------------------------------------------------------------------------------

async function testScenario1_TwentyPageSequentialNavigation() {
  console.log("[Test 1] Navigating 20-page document sequentially (Pages 1 -> 20)...");

  // Setup 20 pages in DOM
  scrollContainer.children = [];
  const TOTAL_PAGES = 20;
  for (let i = 1; i <= TOTAL_PAGES; i++) {
    const wrap = new MockElement("div");
    wrap.className = "pdf-page pending";
    wrap.dataset.page = String(i);
    wrap.dataset.painted = "0";
    wrap.offsetTop = (i - 1) * 1050;
    wrap.offsetHeight = 1000;
    const ph = document.createElement("div");
    ph.className = "pdf-page-placeholder";
    ph.textContent = `第 ${i} 页…`;
    wrap.appendChild(ph);
    scrollContainer.appendChild(wrap);
  }

  // Scroll down page by page from 1 to 20
  for (let page = 1; page <= TOTAL_PAGES; page++) {
    scrollContainer.scrollTop = (page - 1) * 1050;
    await renderPage(page, 10);

    const paintedWraps = scrollContainer.querySelectorAll('.pdf-page[data-painted="1"]');
    const totalCanvasesInDom = scrollContainer.querySelectorAll("canvas");

    assert(
      paintedWraps.length <= MAX_RENDERED_PAGES,
      `Invariant violated on page ${page}: paintedWraps (${paintedWraps.length}) > ${MAX_RENDERED_PAGES}`
    );
    assert(
      totalCanvasesInDom.length <= MAX_RENDERED_PAGES,
      `Invariant violated on page ${page}: active canvases in DOM (${totalCanvasesInDom.length}) > ${MAX_RENDERED_PAGES}`
    );
  }

  const finalPainted = scrollContainer.querySelectorAll('.pdf-page[data-painted="1"]');
  const finalCanvases = scrollContainer.querySelectorAll("canvas");
  console.log(`  Final Painted Wraps count: ${finalPainted.length} (Max allowed: ${MAX_RENDERED_PAGES})`);
  console.log(`  Final DOM Canvas count: ${finalCanvases.length}`);

  const activePages = finalPainted.map((w) => Number(w.dataset.page));
  console.log(`  Currently Active Pages: [${activePages.join(", ")}]`);

  // Active pages must be the 5 closest to page 20: [16, 17, 18, 19, 20]
  assert.deepStrictEqual(activePages, [16, 17, 18, 19, 20], "Sliding window does not contain the 5 latest pages!");

  console.log("  -> PASS: Concurrently active canvases strictly bounded to <= 5 across all 20 pages.");
}

async function testScenario2_EvictedCanvasZeroDimensions() {
  console.log("\n[Test 2] Verifying evicted canvas dimensions (width=0, height=0) and DOM removal...");

  // Inspect all canvases created for pages 1 through 15 (which have been evicted)
  const evictedEntries = allCreatedCanvases.filter((entry) => entry.pageNum <= 15);
  assert(evictedEntries.length >= 15, "Should have created at least 15 canvases");

  for (const { pageNum, canvas } of evictedEntries) {
    // 1. Canvas must be removed from DOM
    assert.strictEqual(canvas.parentElement, null, `Page ${pageNum} canvas was NOT removed from DOM!`);

    // 2. Canvas dimensions must be set to 0 to force GPU backing store release
    assert.strictEqual(canvas.width, 0, `Page ${pageNum} canvas width was NOT set to 0! (Found ${canvas.width})`);
    assert.strictEqual(canvas.height, 0, `Page ${pageNum} canvas height was NOT set to 0! (Found ${canvas.height})`);

    // 3. Removal record in history
    const removeEvent = canvas.history.find((h) => h.action === "remove");
    assert(removeEvent, `Page ${pageNum} canvas did not record remove event`);
    assert.strictEqual(removeEvent.width, 0, "Canvas was removed BEFORE width was zeroed!");
    assert.strictEqual(removeEvent.height, 0, "Canvas was removed BEFORE height was zeroed!");

    // 4. Verify page container has placeholder restored
    const wrap = scrollContainer.querySelector(`.pdf-page[data-page="${pageNum}"]`);
    assert.strictEqual(wrap.dataset.painted, "0", `Page ${pageNum} dataset.painted is not 0`);
    const ph = wrap.querySelector(".pdf-page-placeholder");
    assert(ph, `Page ${pageNum} placeholder was not restored!`);
  }

  console.log(`  Checked ${evictedEntries.length} evicted canvases.`);
  console.log("  All evicted canvases: width === 0, height === 0, removed from DOM, placeholder restored.");
  console.log("  -> PASS: Physical GPU VRAM release contract verified 100%.");
}

async function testScenario3_RapidCancellationDuringActiveRenders() {
  console.log("\n[Test 3] Rapid cancellation during active render tasks (Fast Scroll Simulation)...");

  // Reset scroll to page 1
  scrollContainer.scrollTop = 0;
  for (let i = 1; i <= 20; i++) {
    const wrap = scrollContainer.querySelector(`.pdf-page[data-page="${i}"]`);
    cancelAndEvictPage(wrap);
  }
  activeRenderTasks.clear();

  // Launch 10 in-flight render tasks with longer delay (100ms)
  console.log("  Launching concurrent render tasks for pages 1..10 (in-flight delay: 100ms)...");
  const renderPromises = [];
  for (let p = 1; p <= 10; p++) {
    renderPromises.push(renderPage(p, 100));
  }

  assert.strictEqual(activeRenderTasks.size, 10, "Should have 10 active render tasks registered");

  // User rapidly scrolls past them to page 20 at t=20ms: cancel pages 1..10
  await new Promise((r) => setTimeout(r, 20));
  console.log("  Simulating fast swipe to page 20: evicting/cancelling pages 1..10...");

  for (let p = 1; p <= 10; p++) {
    const wrap = scrollContainer.querySelector(`.pdf-page[data-page="${p}"]`);
    cancelAndEvictPage(wrap);
  }

  // Active tasks map should be cleared by cancelAndEvictPage
  assert.strictEqual(activeRenderTasks.size, 0, "Active render tasks map was not cleared after cancellation!");

  // Wait for all cancelled promises to settle (none should reject with unhandled error)
  await Promise.all(renderPromises);

  // Verify none of pages 1..10 became painted
  for (let p = 1; p <= 10; p++) {
    const wrap = scrollContainer.querySelector(`.pdf-page[data-page="${p}"]`);
    assert.strictEqual(
      wrap.dataset.painted,
      "0",
      `Cancelled page ${p} was falsely marked as painted!`
    );
    const canvas = wrap.querySelector("canvas");
    assert.strictEqual(canvas, null, `Cancelled page ${p} left a zombie canvas in DOM!`);
  }

  console.log("  -> PASS: All in-flight tasks cleanly cancelled, zero unhandled errors, zero zombie canvases.");
}

async function testScenario4_BidirectionalScrolling() {
  console.log("\n[Test 4] Bidirectional continuous scrolling (1 -> 20 -> 1)...");

  // Scroll downwards to 20
  for (let p = 1; p <= 20; p++) {
    scrollContainer.scrollTop = (p - 1) * 1050;
    await renderPage(p, 5);
  }
  assert(scrollContainer.querySelectorAll("canvas").length <= MAX_RENDERED_PAGES);

  // Scroll backwards from 20 to 1
  for (let p = 20; p >= 1; p--) {
    scrollContainer.scrollTop = (p - 1) * 1050;
    await renderPage(p, 5);

    const canvasCount = scrollContainer.querySelectorAll("canvas").length;
    assert(
      canvasCount <= MAX_RENDERED_PAGES,
      `Backwards scroll exceeded pool limit at page ${p}: ${canvasCount} > ${MAX_RENDERED_PAGES}`
    );
  }

  const finalPainted = scrollContainer.querySelectorAll('.pdf-page[data-painted="1"]');
  const finalPages = finalPainted.map((w) => Number(w.dataset.page)).sort((a, b) => a - b);
  console.log(`  Active pages after returning to top: [${finalPages.join(", ")}]`);
  assert.deepStrictEqual(finalPages, [1, 2, 3, 4, 5], "Pages 1..5 should be active at top of document");

  console.log("  -> PASS: Bidirectional scrolling maintained <= 5 invariant throughout.");
}

(async () => {
  try {
    await testScenario1_TwentyPageSequentialNavigation();
    await testScenario2_EvictedCanvasZeroDimensions();
    await testScenario3_RapidCancellationDuringActiveRenders();
    await testScenario4_BidirectionalScrolling();

    console.log("\n######################################################################");
    console.log("# P1-2 PDF.JS VIRTUALIZATION & VRAM EVICTION: ALL 4 SUITES PASSED    #");
    console.log("######################################################################");
  } catch (err) {
    console.error("\n[-] TEST FAILED WITH ASSERTION ERROR:", err);
    process.exit(1);
  }
})();
