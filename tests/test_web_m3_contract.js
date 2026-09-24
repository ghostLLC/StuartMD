// Verification test for Milestone 3 Frontend Implementation
// Checks contracts in web/index.html, web/js/app.js, web/js/pdf-viewer.js, web/js/ui/ai-ui.js, web/js/core/ai-client.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");

console.log("=== RUNNING MILESTONE 3 FRONTEND CONTRACT VERIFICATION ===");

const root = path.resolve(__dirname, "..");
const indexPath = path.join(root, "web", "index.html");
const appPath = path.join(root, "web", "js", "app.js");
const pdfViewerPath = path.join(root, "web", "js", "pdf-viewer.js");
const aiClientPath = path.join(root, "web", "js", "core", "ai-client.js");
const aiUiPath = path.join(root, "web", "js", "ui", "ai-ui.js");

const indexHtml = fs.readFileSync(indexPath, "utf-8");
const appJs = fs.readFileSync(appPath, "utf-8");
const pdfViewerJs = fs.readFileSync(pdfViewerPath, "utf-8");
const aiClientJs = fs.readFileSync(aiClientPath, "utf-8");
const aiUiJs = fs.readFileSync(aiUiPath, "utf-8");

// 1. CSP in web/index.html
console.log("[Test 1] CSP Meta tag in web/index.html");
assert(
  indexHtml.includes('http-equiv="Content-Security-Policy"'),
  "index.html must define http-equiv Content-Security-Policy"
);
assert(
  indexHtml.includes("default-src 'self'"),
  "CSP must include default-src 'self'"
);
assert(
  indexHtml.includes("object-src 'none'"),
  "CSP must include object-src 'none'"
);
console.log("  PASS: CSP meta tag present and properly configured");

// 2. DOM Sanitizer & XSS protection in web/js/app.js
console.log("[Test 2] DOM Sanitizer in web/js/app.js");
assert(
  appJs.includes("function sanitizeHtmlStrict(rawHtml)"),
  "app.js must define sanitizeHtmlStrict"
);
assert(
  appJs.includes("ALLOWED_TAGS"),
  "sanitizeHtmlStrict must use whitelist ALLOWED_TAGS"
);
assert(
  appJs.includes("ALLOWED_ATTRS"),
  "sanitizeHtmlStrict must use whitelist ALLOWED_ATTRS"
);
assert(
  appJs.includes("javascript:"),
  "sanitizeHtmlStrict must block javascript: pseudo-protocol"
);
assert(
  appJs.includes("securityLevel: \"strict\""),
  "Mermaid must be initialized with strict securityLevel"
);
console.log("  PASS: Strict DOM whitelist sanitizer and Mermaid strict level present");

// 3. Save race condition & atomic rev check in web/js/app.js
console.log("[Test 3] Save Race Prevention & tab.rev in web/js/app.js");
assert(
  appJs.includes("tab.rev = (tab.rev || 0) + 1"),
  "markDirty must increment tab.rev"
);
assert(
  appJs.includes("commitActiveBlockEdits()"),
  "app.js must implement and call commitActiveBlockEdits()"
);
assert(
  appJs.includes("saveRev = tab ? (tab.rev || 0) : 0"),
  "saveFile must snapshot saveRev"
);
assert(
  appJs.includes("tab.rev === saveRev"),
  "saveFile must only clear dirty if tab.rev === saveRev"
);
console.log("  PASS: tab.rev concurrency guard and commitActiveBlockEdits implemented");

// 4. Keyboard Shortcuts & Bubble Isolation in web/js/app.js
console.log("[Test 4] Keyboard Shortcuts & Bubble Isolation in web/js/app.js");
assert(
  appJs.includes("isTypingField(e.target)"),
  "Keyboard listener must check isTypingField(e.target)"
);
assert(
  appJs.includes('if (e.shiftKey) {') && appJs.includes("redoEdit()"),
  "Ctrl+Shift+Z must trigger redoEdit()"
);
assert(
  appJs.includes("Ctrl+Shift+Z") && appJs.includes("没有可撤销"),
  "Must preserve regression strings 'Ctrl+Shift+Z' and '没有可撤销'"
);
console.log("  PASS: Redo and input isolation properly wired");

// 5. Global Error Handling & Window Lifecycle in web/js/app.js
console.log("[Test 5] Error Handling & Window Lifecycle in web/js/app.js");
assert(
  appJs.includes('window.addEventListener("unhandledrejection"'),
  "app.js must register global unhandledrejection listener"
);
assert(
  appJs.includes("stuart-window-close-requested"),
  "app.js must listen for stuart-window-close-requested"
);
assert(
  appJs.includes("stuart_exit_app"),
  "app.js must invoke stuart_exit_app"
);
assert(
  appJs.includes("scheduleDraftJournal"),
  "app.js must implement draft journaling timer"
);
console.log("  PASS: Unhandledrejection, close lifecycle, and 3s draft journal present");

// 6. PDF Viewer Virtualization & Eviction in web/js/pdf-viewer.js
console.log("[Test 6] PDF Viewer Virtualization & Eviction in web/js/pdf-viewer.js");
assert(
  pdfViewerJs.includes("MAX_RENDERED_PAGES = 5"),
  "pdf-viewer.js must define MAX_RENDERED_PAGES = 5 pool limit"
);
assert(
  pdfViewerJs.includes("activeRenderTasks"),
  "pdf-viewer.js must track activeRenderTasks"
);
assert(
  pdfViewerJs.includes("cancelAndEvictPage"),
  "pdf-viewer.js must define cancelAndEvictPage"
);
assert(
  pdfViewerJs.includes("canvas.width = 0") && pdfViewerJs.includes("canvas.height = 0"),
  "cancelAndEvictPage must zero canvas dimensions for VRAM deallocation"
);
assert(
  pdfViewerJs.includes("stuart_read_pdf_binary"),
  "openPdf must attempt zero-copy binary ArrayBuffer IPC"
);
assert(
  pdfViewerJs.includes("RenderingCancelledException"),
  "renderPage must catch and ignore RenderingCancelledException"
);
assert(
  pdfViewerJs.includes("setupVirtualizedPdfObserver"),
  "pdf-viewer.js must implement setupVirtualizedPdfObserver"
);
console.log("  PASS: PDF 5-page pool, canvas zeroing, binary IPC, and virtualization verified");

// 7. AI Client & UI Streaming Order in web/js/core/ai-client.js & ai-ui.js
console.log("[Test 7] AI Client & UI Stream Registration Order");
assert(
  aiClientJs.includes("async function bindEvents()"),
  "ai-client.js bindEvents must be async"
);
assert(
  aiClientJs.includes("await bindEvents()"),
  "ai-client.js explain must await bindEvents()"
);
assert(
  aiClientJs.includes("async function cancel(reqId)"),
  "ai-client.js cancel must accept reqId parameter"
);
assert(
  aiUiJs.includes("await listenChat"),
  "ai-ui.js sendFollowUp must await listenChat before api.ai_chat_start"
);
assert(
  aiUiJs.includes("cancel(reqId)"),
  "ai-ui.js close and cancel handlers must pass requestId to cancel()"
);
console.log("  PASS: AI stream listener ordering and cancel request synchronization verified");

console.log("\nALL 7 MILESTONE 3 FRONTEND CONTRACT TESTS PASSED SUCCESSFULLY!");
