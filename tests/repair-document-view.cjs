const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DocumentSession } = require("../web/js/core/document-session.js");
const { DocumentViewport } = require("../web/js/core/document-viewport.js");
const { JSDOM } = require("jsdom");
const fs = require("node:fs");
const path = require("node:path");

function viewport() {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8"));
  const document = dom.window.document;
  const elements = {
    preview: document.querySelector("#preview"), previewPane: document.querySelector("#preview-pane"),
    source: document.querySelector("#source"), editorArea: document.querySelector("#editor-area"),
  };
  elements.editorArea.hidden = false;
  return { dom, ...elements, controller: new DocumentViewport(elements) };
}

test("不同文档独立保存预览、源码和 PDF 阅读位置", () => {
  const a = new DocumentSession({ source: "第一份文件" });
  const b = new DocumentSession({ source: "第二份文件" });
  a.viewState.preview = { top: 1200, left: 0, anchor: { offset: 3, top: -12 } };
  a.viewState.source = { top: 800, left: 20, start: 2, end: 4, direction: "forward" };
  a.viewState.pdf = { page: 7, scale: 1.4, rotation: 90, top: 9000 };
  assert.deepEqual(b.viewState, { preview: null, source: null, pdf: null });
  assert.equal(a.dirty, false);
  assert.equal(Object.hasOwn(a.snapshot(), "viewState"), false);
});

test("编辑正文前部后阅读位置随源码偏移更新并保持视口距离", () => {
  const doc = new DocumentSession({ source: "标题\r\n\r\n阅读段落\r\n" });
  doc.viewState.preview = { top: 400, left: 0, anchor: { offset: 4, top: -18 } };
  doc.viewState.source = { top: 120, left: 0, start: 4, end: 8, direction: "backward", anchor: { offset: 4, top: -3 } };
  doc.updateEditor("新增\n\n标题\n\n阅读段落\n");
  assert.equal(doc.viewState.preview.anchor.offset, 8);
  assert.equal(doc.viewState.preview.anchor.top, -18);
  assert.deepEqual([doc.viewState.source.start, doc.viewState.source.end], [8, 12]);
  assert.deepEqual(doc.viewState.source.anchor, { offset: 8, top: -3 });
  doc.updateSource("标题\r\n\r\n阅读段落\r\n");
  assert.equal(doc.viewState.preview.anchor.offset, 4);
  assert.deepEqual([doc.viewState.source.start, doc.viewState.source.end], [4, 8]);
  assert.deepEqual(doc.viewState.source.anchor, { offset: 4, top: -3 });
});

test("删除正在阅读的正文后位置保持在有效范围", () => {
  const doc = new DocumentSession({ source: "前文\n\n阅读段落\n\n后文" });
  doc.viewState.preview = { top: 300, left: 0, anchor: { offset: 6, top: -5 } };
  doc.updateSource("前文\n\n后文");
  assert.equal(doc.viewState.preview.anchor.offset, 4);
  doc.updateEditor("");
  assert.equal(doc.viewState.preview.anchor.offset, 0);
});

test("文件切换、正文修改和主动导航使旧恢复任务失效", () => {
  const page = viewport(), a = new DocumentSession({ source: "原文" }), b = new DocumentSession({ source: "另一份文件" });
  page.controller.attach(a, "preview");
  const first = page.controller.ticket();
  assert.equal(page.controller.current(first), true);
  page.controller.attach(b, "preview");
  assert.equal(page.controller.current(first), false);
  page.controller.attach(a, "preview");
  assert.equal(page.controller.current(first), false);
  const second = page.controller.ticket();
  a.updateEditor("原文修改");
  assert.equal(page.controller.current(second), false);
  const third = page.controller.ticket();
  page.controller.userIntent();
  assert.equal(page.controller.current(third), false);
  assert.equal(page.controller.restoring, null);
  page.dom.window.close();
});

test("源码区域恢复目标文档的选区与位置，新文件使用初始位置", () => {
  const page = viewport(), a = new DocumentSession({ source: "第一份文件正文" }), b = new DocumentSession({ source: "第二份文件正文" });
  a.viewState.source = { start: 2, end: 5, direction: "backward", top: 320, left: 15 };
  page.source.value = a.source;
  page.controller.attach(a, "source");
  page.controller.restoreSource();
  assert.deepEqual([page.source.selectionStart, page.source.selectionEnd, page.source.selectionDirection], [2, 5, "backward"]);
  assert.deepEqual([page.source.scrollTop, page.source.scrollLeft], [320, 15]);
  page.source.value = b.source;
  page.controller.attach(b, "source");
  page.controller.restoreSource();
  assert.deepEqual([page.source.selectionStart, page.source.selectionEnd, page.source.scrollTop, page.source.scrollLeft], [0, 0, 0, 0]);
  page.source.value = a.source;
  page.controller.attach(a, "source");
  page.controller.restoreSource();
  assert.deepEqual([page.source.selectionStart, page.source.selectionEnd, page.source.scrollTop, page.source.scrollLeft], [2, 5, 320, 15]);
  page.dom.window.close();
});

test("隐藏区域和未建立布局的区域保留已有阅读记录", () => {
  const page = viewport(), doc = new DocumentSession({ source: "正文" });
  doc.viewState.preview = { top: 900, left: 0, anchor: { offset: 0, top: -5 } };
  doc.viewState.source = { top: 600, left: 10, start: 1, end: 2, direction: "forward" };
  const before = structuredClone(doc.viewState);
  page.controller.attach(doc, "source");
  page.controller.capture();
  assert.deepEqual(doc.viewState, before);
  page.editorArea.hidden = true;
  page.controller.capture();
  assert.deepEqual(doc.viewState, before);
  page.dom.window.close();
});
