// P1 core unit smoke test (node)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "web", "js", "core");
const sandbox = { window: {}, globalThis: {} };
vm.createContext(sandbox);
for (const f of ["open-policy.js", "settings-schema.js", "doc-stats.js", "write-coord.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox);
}
const core = sandbox.window.StuartCore;
let fail = 0;
function ok(c, m) {
  if (!c) {
    console.error("FAIL", m);
    fail++;
  } else console.log("PASS", m);
}
function eq(a, b, m) {
  const pass = a === b;
  if (!pass) {
    console.error("FAIL", m);
    console.error("  expected:", JSON.stringify(b));
    console.error("  actual:  ", JSON.stringify(a));
    fail++;
  } else console.log("PASS", m);
}

// ---- existing smoke ----
ok(core.paths.isWelcomeOrSamplePath("C:\\a\\samples\\欢迎使用 StuartMD.md", "欢迎使用 StuartMD.md"), "welcome sample");
ok(!core.paths.isWelcomeOrSamplePath("C:\\a\\DESIGN.md", "DESIGN.md"), "normal file");
ok(core.paths.pathEqualsOrUnder("C:\\w\\a\\b.md", "C:\\w"), "under root");
ok(!core.paths.pathEqualsOrUnder("C:\\x\\b.md", "C:\\w"), "outside root");
ok(core.paths.hasRealDocument([{ path: "C:\\a\\x.md", name: "x.md" }], null, null), "has real");
ok(!core.paths.hasRealDocument([{ path: "C:\\a\\samples\\示例文档.md", name: "示例文档.md" }], null, null), "sample only");
const s = core.settings.migrate({ theme: "glass", mode: "split" });
ok(s.theme === "light" && s.mode === "split" && s.schema_version === 4, "migrate");
ok(core.docStats.countChars("a b\nc") === 3, "chars");
ok(core.docStats.countLines("a\nb") === 2, "lines");
const blocks = core.docStats.splitMarkdownBlocks("# T\n\nbody\n");
ok(blocks.length === 2, "blocks");
ok(core.settings.isValidOpenMode("smart") && !core.settings.isValidOpenMode("x"), "open mode");

// ---- golden round-trip corpus ----
const doc = core.docStats;
const corpus = {
  empty: "",
  plain: "hello",
  trailingNewline: "hello\n",
  twoTrailingNewlines: "hello\n\n",
  hardBreak: "line one  \nline two\n",
  hardBreakThenBlank: "line one  \n\nline two\n",
  hardBreakAtEnd: "para ends hard  \n",
  leadingBlanks: "\n\nhello",
  trailingBlanks: "hello\n\n\n",
  leadingAndTrailing: "\n\nhello\n\n",
  crlfSimple: "a\r\nb\r\n",
  crlfBlank: "a\r\n\r\nb\r\n",
  crlfHardBreak: "line one  \r\nline two\r\n",
  crlfLeadingTrailing: "\r\n\r\nhello\r\n\r\n",
  fenceBlankInside: "```\ncode\n\nmore\n```\n",
  fenceCrlfBlankInside: "```\r\ncode\r\n\r\nmore\r\n```\r\n",
  fenceThenPara: "```\nx\n```\n\npara\n",
  fenceGluedPara: "```\nx\n```\npara\n",
  fenceGluedFence: "```\n```\n```\n```\n",
  fenceGluedCrlf: "```\r\nx\r\n```\r\npara\r\n",
  emptyInteriorBlocks: "a\n\n\n\nb\n",
  emptyInteriorCrlf: "a\r\n\r\n\r\nb\r\n",
  chinese: "# 标题\n\n内容，包含中文。\n\n> 引用\n",
  chineseCrlf: "标题\r\n\r\n内容，包含中文。\r\n",
  onlyNewline: "\n",
  onlyNewlines: "\n\n\n",
  whitespaceLine: "a\n   \nb\n",
  multiPara: "# T\n\npara one\n\npara two  \n\n## S\n\nend\n",
  unclosedFence: "```\ncode\n",
};

for (const name of Object.keys(corpus)) {
  const src = corpus[name];
  eq(doc.joinBlocks(doc.splitMarkdownBlocks(src)), src, "joinBlocks∘splitMarkdownBlocks " + name);
  eq(doc.joinDocument(doc.splitDocument(src)), src, "joinDocument∘splitDocument " + name);
}

// empty interior blocks must survive as slots and round-trip
{
  const src = "a\n\n\nb\n";
  const bs = doc.splitMarkdownBlocks(src);
  ok(bs.indexOf("") >= 0, "empty interior block present");
  eq(bs.length, 3, "a + empty + b\\n");
  eq(doc.joinBlocks(bs), src, "empty interior round-trip");
}

// hard break must not be stripped
{
  const bs = doc.splitMarkdownBlocks("x  \n\ny\n");
  ok(bs[0] === "x  ", "hard-break spaces kept in block");
  eq(doc.joinBlocks(bs), "x  \n\ny\n", "hard-break join");
}

// leading blanks kept as empty blocks
{
  const bs = doc.splitMarkdownBlocks("\n\nhi\n");
  ok(bs.length === 3 && bs[0] === "" && bs[1] === "", "leading blanks are empty blocks");
  eq(doc.joinBlocks(bs), "\n\nhi\n", "leading blanks join");
}

// CRLF preserved
{
  const src = "a\r\n\r\nb\r\n";
  eq(doc.joinBlocks(doc.splitMarkdownBlocks(src)), src, "crlf blocks");
  const d = doc.splitDocument(src);
  eq(d.eol, "\r\n", "crlf eol");
  eq(d.leading, "", "crlf leading");
  eq(d.trailing, "\r\n", "crlf trailing");
  eq(d.blocks.join("|"), "a|b", "crlf blocks content");
  eq(doc.joinDocument(d), src, "crlf document");
}

// splitDocument metadata sanity
{
  const d = doc.splitDocument("\n\nhello\n\n\n");
  eq(d.eol, "\n", "eol lf");
  eq(d.leading, "\n\n", "leading text");
  eq(d.trailing, "\n\n\n", "trailing text");
  eq(d.blocks.join("|"), "hello", "blocks");
  eq(doc.joinDocument(d), "\n\nhello\n\n\n", "meta join");
}

// ---- P0 block-edit integrity: code fence / LaTeX round-trip ----
// Contract mirrors enter/commit in web/js/app.js (extractFenceParts,
// rebuildFenceFromParts, commitBlockSource userEdited/allowEmpty guards).
function extractFenceParts(original) {
  const src = String(original == null ? "" : original);
  const open = src.match(/^\s*```([\w+-]*)(\r?\n)/);
  if (!open) return null;
  const lang = open[1] || "";
  const eol = open[2] === "\r\n" ? "\r\n" : "\n";
  const rest = src.slice(open[0].length);
  const closeRe = /(?:\r?\n)?```(?!\`)/g;
  let last = null;
  let m;
  while ((m = closeRe.exec(rest))) last = m;
  if (!last) return null;
  return {
    lang,
    eol,
    body: rest.slice(0, last.index),
    closeToken: last[0],
    suffix: rest.slice(last.index + last[0].length),
  };
}
function rebuildFenceFromParts(parts, newBody) {
  const p = parts || { lang: "", eol: "\n", closeToken: "\n```", suffix: "" };
  return "```" + p.lang + p.eol + String(newBody == null ? "" : newBody) + (p.closeToken || "\n```") + (p.suffix || "");
}
function rebuildCodeFence(lang, body) {
  const b = body == null ? "" : String(body);
  const needsNl = b.length > 0 && !/\r?\n$/.test(b);
  return "```" + String(lang || "") + "\n" + b + (needsNl ? "\n" : "") + "```";
}
/** commitBlockSource empty/mutation guards (userEdited=false must restore original). */
function safeCommitNext(next, original, userEdited, allowEmpty) {
  if (!userEdited) return original;
  if (allowEmpty !== true && !String(next).trim() && String(original).trim()) return original;
  return next;
}

// (a) code fence round-trip through enter (extract body) / commit (rebuild)
{
  const fences = [
    "```js\nconsole.log(1)\n```",
    "```js\nconsole.log(1)\n```\n",
    "```js\nconsole.log(1)\n\n```",
    "```js\n\n```",
    "```js\n```",
    "```python\nx = 1\ny = 2\n```",
    "```js\nconst a = `\n`;\n```",
    "```\nplain\n```",
    "```js\r\nconsole.log(1)\r\n```",
  ];
  for (const f of fences) {
    const parts = extractFenceParts(f);
    ok(!!parts, "fence parts extracted " + JSON.stringify(f));
    if (!parts) continue;
    eq(rebuildFenceFromParts(parts, parts.body), f, "fence enter/commit round-trip " + JSON.stringify(f));
  }
  // split/join must keep a fence block intact as one block
  {
    const src = "before\n\n```js\nconsole.log(1)\n```\n\nafter\n";
    const bs = doc.splitMarkdownBlocks(src);
    eq(bs.length, 3, "code fence is one middle block");
    eq(bs[1], "```js\nconsole.log(1)\n```", "code fence block exact");
    eq(doc.joinBlocks(bs), src, "code fence doc round-trip");
  }
}

// (b) LaTeX $$...$$ and $...$ survive split/join and stay one block
{
  const mathDoc = "# T\n\n$$\n\\sum_i i\n$$\n\npara $E=mc^2$ end\n";
  const bs = doc.splitMarkdownBlocks(mathDoc);
  eq(bs.length, 3, "math blocks count");
  eq(bs[1], "$$\n\\sum_i i\n$$", "display math block exact");
  ok(bs[2].indexOf("$E=mc^2$") >= 0, "inline math kept in paragraph");
  eq(doc.joinBlocks(bs), mathDoc, "math doc round-trip");

  const display = "$$\n\\sum_i i\n$$";
  eq(doc.joinBlocks(doc.splitMarkdownBlocks(display)), display, "display math alone");
  eq(doc.joinBlocks(doc.splitMarkdownBlocks(display + "\n")), display + "\n", "display math trailing nl");
  const inline = "This is $E=mc^2$ inline.";
  eq(doc.joinBlocks(doc.splitMarkdownBlocks(inline)), inline, "inline math alone");
  eq(doc.joinBlocks(doc.splitMarkdownBlocks(inline + "\n")), inline + "\n", "inline math trailing nl");
}

// (c) empty-commit must not wipe non-empty (even when allowEmpty is wrongly set
// while userEdited is false)
{
  const original = "```js\nconsole.log(1)\n```";
  eq(safeCommitNext("", original, false, false), original, "empty commit !userEdited restores");
  eq(safeCommitNext("", original, false, true), original, "empty commit !userEdited ignores allowEmpty");
  eq(safeCommitNext("   ", original, false, true), original, "ws commit !userEdited restores");
  eq(safeCommitNext(original, original, false, true), original, "unchanged commit keeps original");
  // userEdited + allowEmpty: intentional clear is allowed
  eq(safeCommitNext("", original, true, true), "", "userEdited empty allowed with allowEmpty");
  // userEdited without allowEmpty: still restore
  eq(safeCommitNext("", original, true, false), original, "userEdited empty without allowEmpty restores");
  // LaTeX original must not be wiped by empty commit
  const math = "$$\nE=mc^2\n$$";
  eq(safeCommitNext("", math, false, true), math, "empty commit cannot wipe display math");
  eq(safeCommitNext("$x$", math, false, true), math, "!userEdited writes back exact original not stripped");
}

// (d) reconstruct fence from body+lang is byte-safe (incl. trailing blank body)
{
  eq(rebuildCodeFence("js", "console.log(1)"), "```js\nconsole.log(1)\n```", "rebuild simple");
  eq(rebuildCodeFence("js", "console.log(1)\n"), "```js\nconsole.log(1)\n```", "rebuild body trailing nl");
  eq(rebuildCodeFence("js", "console.log(1)\n\n"), "```js\nconsole.log(1)\n\n```", "rebuild body blank line kept");
  eq(rebuildCodeFence("js", ""), "```js\n```", "rebuild empty body");
  eq(rebuildCodeFence("js", "\n"), "```js\n\n```", "rebuild only newline body");
  eq(rebuildCodeFence("py", "x=1"), "```py\nx=1\n```", "rebuild lang preserved");
  eq(rebuildCodeFence("", "x"), "```\nx\n```", "rebuild no lang");
  // extract body is the inverse of rebuild for canonical fences (body splice)
  const canon = [
    "```js\nconsole.log(1)\n```",
    "```js\nconsole.log(1)\n\n```",
    "```js\n\n```",
    "```js\nconsole.log(1)\n```\n",
    "```js\r\nconsole.log(1)\r\n```",
  ];
  for (const f of canon) {
    const parts = extractFenceParts(f);
    ok(!!parts, "canon parts " + JSON.stringify(f));
    if (!parts) continue;
    eq(rebuildFenceFromParts(parts, parts.body), f, "extract∘rebuild " + JSON.stringify(f));
    // enter/commit unchanged must restore exact block via safeCommitNext
    eq(safeCommitNext(rebuildFenceFromParts(parts, parts.body), f, false, true), f, "unchanged code commit " + JSON.stringify(f));
  }
}

// mixed code + math document: each block survives a no-op edit commit
{
  const src = "# T\n\n$$\nE=mc^2\n$$\n\n```js\nconsole.log(1)\n```\n\npara $a+b$ end\n";
  const bs = doc.splitMarkdownBlocks(src);
  eq(bs.length, 4, "mixed blocks");
  const edited = bs.map((b) => safeCommitNext(b, b, false, true));
  eq(doc.joinBlocks(edited), src, "all-block no-op commit preserves document");
  // Simulate a wiped code commit (empty reconstruct) — guard must restore
  const wiped = bs.map((b, i) => (i === 2 ? safeCommitNext("", b, false, true) : b));
  eq(doc.joinBlocks(wiped), src, "empty code commit cannot wipe mixed doc");
}

// ---- list empty-item marker helpers (mirrors web/js/app.js) ----
function isBlankEditorText(s) {
  return !String(s == null ? "" : s).replace(/[\s\u200b\u200c\u200d\u2060\ufeff]/g, "").length;
}
function isListMarkerLine(line) {
  return /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(line) || /^\s*[-*+] \[[ xX]\](?:\s|$)/.test(line);
}
function listMarkerOnly(line) {
  return (
    /^\s*(?:[-*+]|\d+[.)])\s*$/.test(line) ||
    /^\s*[-*+] \[[ xX]\]\s*$/.test(line) ||
    /^\s*(?:[-*+]|\d+[.)])\s+$/.test(line) ||
    /^\s*[-*+] \[[ xX]\]\s+$/.test(line)
  );
}
function stripListMarker(line) {
  return String(line == null ? "" : line)
    .replace(/^\s*[-*+] \[[ xX]\]\s+/, "")
    .replace(/^\s*[-*+] \[[ xX]\]\s*$/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*$/, "");
}
{
  // marker-only detection (the undeletable empty bullet cases)
  ok(listMarkerOnly("-"), "listMarkerOnly dash");
  ok(listMarkerOnly("*"), "listMarkerOnly star");
  ok(listMarkerOnly("+"), "listMarkerOnly plus");
  ok(listMarkerOnly("- "), "listMarkerOnly dash+space");
  ok(listMarkerOnly("1."), "listMarkerOnly ordered dot");
  ok(listMarkerOnly("2)"), "listMarkerOnly ordered paren");
  ok(listMarkerOnly("- [ ]"), "listMarkerOnly unchecked task");
  ok(listMarkerOnly("- [x]"), "listMarkerOnly checked task");
  ok(listMarkerOnly("  * "), "listMarkerOnly indented star");
  ok(!listMarkerOnly("- item"), "listMarkerOnly rejects item text");
  ok(!listMarkerOnly("- [ ] item"), "listMarkerOnly rejects task with text");
  ok(!listMarkerOnly("plain"), "listMarkerOnly rejects plain");
  ok(!listMarkerOnly(""), "listMarkerOnly rejects empty");

  // strip marker → empty plain line (exit list, no residual bullet)
  eq(stripListMarker("-"), "", "strip dash");
  eq(stripListMarker("* "), "", "strip star+space");
  eq(stripListMarker("1."), "", "strip ordered");
  eq(stripListMarker("- [ ]"), "", "strip unchecked task");
  eq(stripListMarker("- [x]"), "", "strip checked task");
  eq(stripListMarker("- item"), "item", "strip keeps item text");
  eq(stripListMarker("1. item"), "item", "strip keeps ordered text");
  eq(stripListMarker("- [ ] todo"), "todo", "strip keeps task text");
  eq(stripListMarker("plain"), "plain", "strip leaves non-list");

  // empty-item key contract: marker-only → strip → empty plain line
  {
    const line = "*";
    ok(listMarkerOnly(line), "empty bullet is marker-only");
    const stripped = stripListMarker(line);
    eq(stripped, "", "empty bullet strips to empty plain");
    ok(isBlankEditorText(stripped), "stripped bullet is blank");
    ok(!isListMarkerLine(stripped), "stripped bullet no longer a list line");
  }

  // blank detection ignores zero-width / BOM (empty li with <br> / ZWSP)
  ok(isBlankEditorText(""), "blank empty");
  ok(isBlankEditorText("   \n\t"), "blank whitespace");
  ok(isBlankEditorText("\u200b\u200c\ufeff"), "blank zero-width");
  ok(!isBlankEditorText("a"), "blank rejects text");
  ok(!isBlankEditorText("\u200b a"), "blank rejects zwsp+text");

  // isListMarkerLine covers marker + content and task forms
  ok(isListMarkerLine("-"), "isListMarkerLine dash");
  ok(isListMarkerLine("- item"), "isListMarkerLine item");
  ok(isListMarkerLine("- [ ] todo"), "isListMarkerLine task");
  ok(!isListMarkerLine("plain"), "isListMarkerLine rejects plain");
  ok(!isListMarkerLine(""), "isListMarkerLine rejects empty");
}

// ---- write-coord ----
{
  const wc = core.writeCoord;
  ok(!!wc && typeof wc.enqueue === "function", "writeCoord present");
  wc.reset();

  // generation tokens
  eq(wc.nextSeq("C:\\docs\\a.md"), 1, "nextSeq 1");
  eq(wc.nextSeq("C:\\docs\\a.md"), 2, "nextSeq 2");
  eq(wc.currentSeq("C:\\docs\\a.md"), 2, "currentSeq");
  ok(wc.isStale("C:\\docs\\a.md", 1), "old seq stale");
  ok(!wc.isStale("C:\\docs\\a.md", 2), "latest seq not stale");
  ok(wc.isStale("C:\\docs\\a.md", null), "null seq stale");
  // path separator normalization
  eq(wc.currentSeq("C:/docs/a.md"), 2, "path key normalized");
  wc.reset();

  // per-path serialization order
  const order = [];
  const p = "C:\\docs\\same.md";
  const a = wc.enqueue(p, async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
    return "A";
  });
  const b = wc.enqueue(p, async () => {
    order.push("b-start");
    await new Promise((r) => setTimeout(r, 5));
    order.push("b-end");
    return "B";
  });
  const c = wc.enqueue(p, () => {
    order.push("c");
    return "C";
  });
  // different path may interleave — only same-path order is guaranteed
  const other = [];
  const o = wc.enqueue("C:\\docs\\other.md", async () => {
    await new Promise((r) => setTimeout(r, 1));
    other.push("o");
    return "O";
  });

  Promise.all([a, b, c, o]).then((results) => {
    eq(results.slice(0, 3).join(","), "A,B,C", "enqueue results in order");
    eq(
      order.join(","),
      "a-start,a-end,b-start,b-end,c",
      "same-path writes serialize (no overlap)"
    );
    eq(other.join(","), "o", "other path ran");

    // error isolation: a failing write must not jam the queue
    const p2 = "C:\\docs\\fail.md";
    const f1 = wc.enqueue(p2, () => {
      throw new Error("boom");
    });
    const f2 = wc.enqueue(p2, () => "ok");
    Promise.all([f1, f2]).then(([e1, r2]) => {
      ok(e1 && e1.error === "boom", "failed write resolves {error}");
      eq(r2, "ok", "queue continues after error");

      // stale token after a newer write
      wc.reset();
      const path2 = "C:\\docs\\rev.md";
      const seq1 = wc.nextSeq(path2);
      wc.nextSeq(path2); // newer write bumps generation
      ok(wc.isStale(path2, seq1), "superseded write is stale");

      if (fail) {
        console.error("FAIL count:", fail);
        process.exit(1);
      }
      console.log("ALL PASS");
      process.exit(0);
    });
  });
}
