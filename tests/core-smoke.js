// P1 core unit smoke test (node)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "web", "js", "core");
const sandbox = { window: {}, globalThis: {} };
vm.createContext(sandbox);
for (const f of ["open-policy.js", "settings-schema.js", "doc-stats.js"]) {
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
process.exit(fail ? 1 : 0);
