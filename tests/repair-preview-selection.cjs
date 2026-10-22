"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { PreviewSelection, mapSelectionOffset } = require("../web/js/core/preview-selection.js");
const { diffChars } = require("diff");

function page(t) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8"));
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const preview = document.querySelector("#preview");
  preview.innerHTML = '<div class="md-block"><p>第一段<strong>加粗内容</strong>结尾</p></div><div class="md-block"><p>第二段内容</p></div><div class="md-block"><p>第三段内容</p></div>';
  // 直接重建 DOM 节点，验证节点被替换后的选区恢复；此测试不模拟原生存储接口。
  const controller = new PreviewSelection(preview, () => {
    const children = [...preview.cloneNode(true).children];
    for (const child of children) {
      child.classList.remove("editing");
      for (const host of child.querySelectorAll("[contenteditable]")) host.removeAttribute("contenteditable");
    }
    preview.replaceChildren(...children);
  });
  controller.bind();
  const selection = dom.window.getSelection();
  const key = (target, options = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };
  const mouse = (target, type, options = {}) => target.dispatchEvent(new dom.window.MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0, ...options,
  }));
  return { document, preview, selection, controller, key, mouse };
}

test("Ctrl+A 根据实际选区依次选择本段、全文，并保留全文选择", t => {
  const p = page(t), paragraph = p.preview.querySelectorAll("p")[1];
  paragraph.setAttribute("contenteditable", "true"); paragraph.focus();
  p.selection.collapse(paragraph.firstChild, 2);
  p.key(paragraph);
  assert.equal(p.selection.toString(), "第二段内容");
  p.key(paragraph);
  assert.equal(p.selection.toString(), p.preview.textContent);
  p.key(p.document.body);
  assert.equal(p.selection.toString(), p.preview.textContent);
});

test("手动全选本段后 Ctrl+A 直接选择全文，反向选择同样有效", t => {
  const p = page(t), paragraph = p.preview.querySelectorAll("p")[1];
  p.selection.setBaseAndExtent(paragraph.firstChild, paragraph.textContent.length, paragraph.firstChild, 0);
  p.key(p.document.body);
  assert.equal(p.selection.toString(), p.preview.textContent);
});

test("富文本内部的部分选区第一次 Ctrl+A 包含整个段落", t => {
  const p = page(t), strong = p.preview.querySelector("strong");
  p.selection.setBaseAndExtent(strong.firstChild, 0, strong.firstChild, strong.textContent.length);
  p.key(p.document.body);
  assert.equal(p.selection.toString(), p.preview.querySelector("p").textContent);
});

for (const backward of [false, true]) test(`${backward ? "向前" : "向后"}跨段选择解除编辑边界，重建节点后保留选区方向和内容`, t => {
  const p = page(t), paragraphs = p.preview.querySelectorAll("p");
  const current = paragraphs[1], block = current.parentElement;
  block.classList.add("editing"); current.setAttribute("contenteditable", "true"); current.focus();
  p.mouse(current, "mousedown");
  assert.equal(current.hasAttribute("contenteditable"), false);
  assert.equal(block._stuartSelecting, true);
  const other = backward ? paragraphs[0].firstChild : paragraphs[2].firstChild;
  p.selection.setBaseAndExtent(current.firstChild, 2, other, 2);
  const text = p.selection.toString();
  p.mouse(other.parentElement, "mouseup");
  assert.equal(p.selection.toString(), text);
  assert.equal(p.selection.anchorNode.textContent, "第二段内容");
  assert.equal(p.selection.anchorOffset, 2);
  assert.equal(p.selection.focusOffset, 2);
  assert.equal(p.preview.querySelector("[contenteditable]"), null);
  assert.equal(block._stuartSelecting, undefined);
});

test("本段内部选择保留原节点、选区和可编辑状态", t => {
  const p = page(t), paragraph = p.preview.querySelectorAll("p")[1];
  paragraph.parentElement.classList.add("editing"); paragraph.setAttribute("contenteditable", "true");
  p.mouse(paragraph, "mousedown");
  p.selection.setBaseAndExtent(paragraph.firstChild, 1, paragraph.firstChild, 4);
  p.mouse(paragraph, "mouseup");
  assert.equal(paragraph.isConnected, true);
  assert.equal(paragraph.getAttribute("contenteditable"), "true");
  assert.equal(p.selection.toString(), "二段内");
  // jsdom 未实现 contenteditable 的浏览器焦点行为，此处仅验证节点与选区状态。
});

test("跨单元格选择保留完整选区", t => {
  const p = page(t);
  p.preview.innerHTML = '<div class="md-block editing table-edit"><table><tbody><tr><td contenteditable="true">甲单元格</td><td contenteditable="true">乙单元格</td></tr></tbody></table></div>';
  const [first, second] = p.preview.querySelectorAll("td");
  p.mouse(first, "mousedown");
  p.selection.setBaseAndExtent(first.firstChild, 1, second.firstChild, 2);
  const text = p.selection.toString();
  p.mouse(second, "mouseup");
  assert.equal(p.selection.toString(), text);
  assert.equal(p.preview.querySelector("[contenteditable]"), null);
});

test("段落边界恢复不包含前后未选择的段落", t => {
  const p = page(t), paragraph = p.preview.querySelectorAll("p")[1];
  for (const backward of [false, true]) {
    const current = p.preview.querySelectorAll("p")[1];
    p.selection.setBaseAndExtent(current.firstChild, backward ? current.textContent.length : 0,
      current.firstChild, backward ? 0 : current.textContent.length);
    p.controller.commitSelection();
    assert.equal(p.selection.toString(), paragraph.textContent);
    const blocks = [...p.preview.children];
    assert.deepEqual(blocks.map(block => p.selection.getRangeAt(0).intersectsNode(block)), [false, true, false]);
  }
});

test("切换窗口时结束拖选并保留选区", t => {
  const p = page(t), paragraph = p.preview.querySelectorAll("p")[1], block = paragraph.parentElement;
  block.classList.add("editing"); paragraph.setAttribute("contenteditable", "true");
  p.mouse(paragraph, "mousedown");
  p.selection.setBaseAndExtent(paragraph.firstChild, 1, paragraph.firstChild, 4);
  p.document.defaultView.dispatchEvent(new p.document.defaultView.Event("blur"));
  assert.equal(p.selection.toString(), "二段内");
  assert.equal(p.controller.gesture, null);
  assert.equal(block._stuartSelecting, undefined);
  assert.equal(p.preview.querySelector("[contenteditable]"), null);
});

test("排版替换省略号时，选区继续包含替换后的完整文字", () => {
  for (const [before, after, start, end, expectedStart, expectedEnd] of [
    ["前文...", "前文…", 0, 5, 0, 3],
    ["...", "…", 0, 3, 0, 1],
    ["前文...后文", "前文…后文", 3, 4, 2, 3],
    ["甲😀乙...", "甲😀乙…", 1, 7, 1, 5],
  ]) {
    const changes = diffChars(before, after);
    assert.equal(mapSelectionOffset(changes, start, true), expectedStart);
    assert.equal(mapSelectionOffset(changes, end, false), expectedEnd);
  }
});

test("源码编辑、搜索和设置输入保留自身 Ctrl+A 行为", t => {
  const p = page(t);
  for (const field of p.document.querySelectorAll("input, textarea, select")) {
    assert.equal(p.key(field).defaultPrevented, false);
  }
  assert.equal(p.key(p.document.body).defaultPrevented, false);
});

test("局部源码第一次选择编辑内容，第二次选择全文", t => {
  const p = page(t), editor = p.document.createElement("textarea");
  editor.className = "md-block-source"; editor.value = "flowchart LR\n A --> B";
  p.preview.firstElementChild.append(editor); editor.focus(); editor.setSelectionRange(1, 3);
  p.key(editor);
  assert.equal(editor.selectionStart, 0); assert.equal(editor.selectionEnd, editor.value.length);
  p.key(editor);
  assert.equal(p.selection.toString(), p.preview.textContent);
});
