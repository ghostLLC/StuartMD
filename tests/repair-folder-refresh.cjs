const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { JSDOM } = require("jsdom");
const { FolderView } = require("../web/js/core/folder-view.js");
const { DocumentSession } = require("../web/js/core/document-session.js");

const workspace = path.resolve(__dirname, "..");
const artifacts = path.join(__dirname, "native-artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const root = fs.mkdtempSync(path.join(artifacts, "folder-refresh-"));
const executable = path.join(workspace, "tauri/src-tauri/target/debug/examples/folder-tree.exe");
const scan = directory => JSON.parse(execFileSync(executable, [directory], { encoding: "utf8", stdio: "pipe" }));
const dom = new JSDOM(fs.readFileSync(path.join(workspace, "web/index.html"), "utf8"));
const tree = dom.window.document.querySelector("#file-tree");
const label = dom.window.document.querySelector("#folder-name");
const button = dom.window.document.querySelector("#btn-refresh-folder");
const view = new FolderView(tree, label, button);
const first = path.join(root, "甲目录"), second = path.join(root, "乙目录");
fs.mkdirSync(path.join(first, "子目录"), { recursive: true });
fs.mkdirSync(second);
fs.writeFileSync(path.join(first, "甲.md"), "# 甲\n正文");
fs.writeFileSync(path.join(first, "子目录", "子文档.txt"), "子文档");
fs.writeFileSync(path.join(second, "乙.md"), "# 乙\n正文");
fs.copyFileSync(path.join(workspace, "samples/测试.pdf"), path.join(second, "资料.pdf"));
const a = new DocumentSession({ path: path.join(first, "甲.md"), source: "# 甲\n正文" });
const b = new DocumentSession({ path: path.join(second, "乙.md"), source: "# 乙\n正文" });

test("实际 Rust 目录扫描结果切换目录并恢复当前文档高亮", () => {
  const snapshot = a.snapshot();
  a.viewState.preview = { top: 400 };
  let ticket = view.begin(a);
  assert.equal(view.current(ticket, a), true);
  const result = view.render(scan(first), a.path);
  assert.equal(result.changedDirectory, true);
  assert.equal(result.selected.textContent, "甲.md");
  view.finish(ticket);
  ticket = view.begin(b);
  assert.equal(view.current(ticket, a), false);
  view.render(scan(second), b.path);
  assert.equal(label.title, second);
  assert.equal(tree.querySelector(".active").textContent, "乙.md");
  assert.equal(tree.textContent.includes("甲.md"), false);
  assert.deepEqual(a.snapshot(), snapshot);
  assert.equal(a.viewState.preview.top, 400);
  view.finish(ticket);
});

test("真实新增、重命名和删除后刷新列表并保持展开状态及滚动属性", () => {
  view.render(scan(first), a.path);
  tree.querySelector(".dir").classList.add("expanded");
  tree.querySelector(".tree-children").classList.add("open");
  tree.scrollTop = 30;
  fs.writeFileSync(path.join(first, "新增.md"), "新增内容");
  view.render(scan(first), a.path);
  assert.ok(tree.textContent.includes("新增.md"));
  assert.ok(tree.querySelector(".dir.expanded"));
  assert.equal(tree.scrollTop, 30);
  assert.equal(tree.querySelector(".active").textContent, "甲.md");
  fs.renameSync(path.join(first, "新增.md"), path.join(first, "改名.md"));
  view.render(scan(first), a.path);
  assert.ok(tree.textContent.includes("改名.md"));
  assert.equal(tree.textContent.includes("新增.md"), false);
  fs.unlinkSync(path.join(first, "改名.md"));
  view.render(scan(first), a.path);
  assert.equal(tree.textContent.includes("改名.md"), false);
});

test("文档切换、另存为、关闭和后续目录操作使旧请求失效", () => {
  let ticket = view.begin(a);
  assert.equal(view.current(ticket, b), false);
  const original = a.path;
  a.path = path.join(second, "另存为.md");
  assert.equal(view.current(ticket, a), false);
  a.path = original;
  view.cancel();
  assert.equal(view.current(ticket, a), false);
  ticket = view.begin(a);
  assert.equal(view.current(ticket, null), false);
  const newer = view.begin(b);
  view.finish(ticket);
  assert.equal(view.pending, newer);
  assert.equal(view.current(ticket, a), false);
  view.finish(newer);
});

test("按钮显示未保存、未打开、刷新中和可用状态", () => {
  view.update(null, true);
  assert.equal(button.disabled, true);
  view.update(new DocumentSession({ source: "未保存" }), true);
  assert.match(button.title, /保存文档/);
  const ticket = view.begin(a);
  view.update(a, true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  view.finish(ticket);
  view.update(a, true);
  assert.equal(button.disabled, false);
  assert.equal(button.title, "刷新当前文件所在目录");
});

test("真实 PDF 文件显示并支持当前文件定位", () => {
  const pdf = path.join(second, "资料.pdf");
  const result = view.render(scan(second), pdf);
  assert.equal(result.selected.textContent, "资料.pdf");
  assert.equal(result.selected.dataset.path, pdf);
  assert.equal(view.matchesPath(pdf.toUpperCase().replaceAll("\\", "/"), pdf), true);
  assert.equal(view.matchesPath(pdf, a.path), false);
});

test("目录读取失败会抛出实际错误，原有 DOM 保持完整", () => {
  const before = tree.innerHTML;
  assert.throws(() => scan(path.join(root, "不存在")), /读取实际目录失败/);
  assert.equal(tree.innerHTML, before);
});
