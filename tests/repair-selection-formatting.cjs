"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

function fixture() {
  const document = new JSDOM(fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8")).window.document;
  const preview = document.querySelector("#preview"), source = document.querySelector("#source");
  document.querySelector("#editor-area").hidden = false;
  preview.innerHTML = '<p id="before">图表之前的正文</p><div class="md-block"><div class="mermaid-diagram"><svg xmlns="http://www.w3.org/2000/svg"><g><text id="svg-label">保存正文</text><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span id="html-label">阅读与编辑</span></div></foreignObject></g></svg></div></div><p id="after">图表之后的正文</p>';
  const selection = document.defaultView.getSelection();
  const context = () => ({ preview, source, selection, activeElement: document.activeElement });
  function select(first, last = first, start = 0, end) {
    const begin = document.querySelector(first).firstChild, finish = document.querySelector(last).firstChild;
    const range = document.createRange(); range.setStart(begin, start); range.setEnd(finish, end ?? finish.length);
    selection.removeAllRanges(); selection.addRange(range);
  }
  return { document, preview, source, context, select, toolbar: document.querySelector("#sel-toolbar") };
}

test("Mermaid 的 SVG 标签和 HTML 标签只显示问答操作", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture();
  const style = page.document.createElement("style");
  style.textContent = fs.readFileSync(path.join(__dirname, "../web/css/app.css"), "utf8");
  page.document.head.append(style); page.toolbar.hidden = false;
  for (const label of ["#svg-label", "#html-label"]) {
    page.select(label);
    assert.equal(policy.updateToolbar(page.toolbar, page.context()), true);
    assert.deepEqual([...page.toolbar.querySelectorAll("button")].filter(button => !button.hidden).map(button => button.dataset.sel), ["ai-explain"]);
    assert.ok([...page.toolbar.querySelectorAll(".sel-sep")].every(separator => separator.hidden));
    for (const button of page.toolbar.querySelectorAll("button")) {
      assert.equal(page.document.defaultView.getComputedStyle(button).display === "none", button.dataset.sel !== "ai-explain");
    }
  }
});

test("跨越 Mermaid 的选区保护图表，相邻正文恢复格式操作", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture();
  for (const [first, last] of [["#before", "#after"], ["#before", "#svg-label"], ["#html-label", "#after"]]) {
    page.select(first, last); assert.equal(policy.isRestricted(page.context()), true);
  }
  policy.updateToolbar(page.toolbar, page.context());
  for (const paragraph of ["#before", "#after"]) {
    page.select(paragraph); assert.equal(policy.updateToolbar(page.toolbar, page.context()), false);
    assert.ok([...page.toolbar.querySelectorAll("button, .sel-sep")].every(control => !control.hidden));
  }
});

test("反向选择以及范围端点位于图表旁边时正确识别选区", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture(), selection = page.document.defaultView.getSelection();
  const label = page.document.querySelector("#html-label").firstChild;
  selection.setBaseAndExtent(label, label.length, label, 0);
  assert.equal(policy.isRestricted(page.context()), true);
  page.select("#before", "#before", 0, 1);
  const range = selection.getRangeAt(0); range.setEndBefore(page.document.querySelector(".md-block"));
  assert.equal(policy.isRestricted(page.context()), false);
});

test("未渲染或渲染失败的 Mermaid 源码同样保护格式操作", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture();
  for (const className of ["mermaid-src", "mermaid-fallback"]) {
    page.preview.innerHTML = `<div class="md-block"><pre id="diagram-source" class="${className}" data-mermaid="1">flowchart LR\n A[阅读] --&gt; B[保存]</pre></div>`;
    page.select("#diagram-source"); assert.equal(policy.isRestricted(page.context()), true);
  }
});

test("真实示例文档中的 Mermaid 源码选区和光标停止格式操作", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture();
  page.source.value = fs.readFileSync(path.join(__dirname, "../samples/欢迎使用 StuartMD.md"), "utf8");
  page.source.focus();
  const from = page.source.value.indexOf("flowchart"); assert.ok(from >= 0);
  page.source.setSelectionRange(from, from + "flowchart".length);
  assert.equal(policy.isRestricted(page.context()), true);
  page.source.setSelectionRange(from, from);
  assert.equal(policy.isRestricted(page.context()), true);
  page.source.setSelectionRange(0, 1);
  assert.equal(policy.isRestricted(page.context()), false);
});

test("Mermaid 局部源码编辑保留文字输入并限制格式操作", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture(), editor = page.document.createElement("textarea");
  editor.className = "md-block-source"; editor.value = "~~~mermaid\nflowchart LR\n A[阅读] --> B[保存]\n~~~";
  page.preview.querySelector(".md-block").replaceChildren(editor); editor.focus();
  editor.setSelectionRange(editor.value.indexOf("阅读"), editor.value.indexOf("阅读") + 2);
  assert.equal(policy.isRestricted(page.context()), true);
  const before = editor.value; editor.setRangeText("编辑", editor.selectionStart, editor.selectionEnd, "select");
  assert.notEqual(editor.value, before); assert.ok(editor.value.includes("A[编辑]"));
  editor.value = "```javascript\nconst value = 1;\n```"; editor.setSelectionRange(15, 20);
  assert.equal(policy.isRestricted(page.context()), false);
});

test("外层代码围栏中的 Mermaid 示例按实际 Markdown 语法处理", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture(); page.source.focus();
  page.source.value = "````text\n```mermaid\nflowchart LR\n A --> B\n```\n````\n\n普通正文";
  const from = page.source.value.indexOf("flowchart"); page.source.setSelectionRange(from, from + 3);
  assert.equal(policy.isRestricted(page.context()), false);
  page.source.value = "正文\r\n\r\n~~~mermaid\r\nflowchart LR\r\n A --> B\r\n~~~\r\n\r\n后文";
  const after = page.source.value.indexOf("后文"); page.source.setSelectionRange(after, after + 1);
  assert.equal(policy.isRestricted(page.context()), false);
});

test("源码格式操作保护紧接选区结束位置的 Mermaid 围栏", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture(); page.source.focus();
  page.source.value = "正文\n```mermaid\nflowchart LR\n A --> B\n```\n";
  page.source.setSelectionRange(0, 3);
  assert.equal(policy.updateToolbar(page.toolbar, page.context()), true);
  page.source.setSelectionRange(0, 2);
  assert.equal(policy.updateToolbar(page.toolbar, page.context()), false);
});

test("HTML 原文中的围栏示例遵守正文 Markdown 解析配置", () => {
  const policy = require("../web/js/core/selection-formatting.js");
  const page = fixture(); page.source.focus();
  page.source.value = "<pre>\n```mermaid\nflowchart LR\n A --> B\n```\n</pre>";
  const start = page.source.value.indexOf("flowchart"); page.source.setSelectionRange(start, start + 3);
  assert.equal(policy.isRestricted(page.context()), false);
});
