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
