"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const scripts = ["web/js/ui/companion.js", "web/js/ui/memory.js", "web/js/ui/ai-ui.js", "web/js/ui/conversation-view.js", "web/js/core/message-renderer.js", "web/js/core/conversation-store.js", "web/js/core/ai-service.js", "web/js/core/ai-client.js", "web/js/core/tauri-bridge.js", "web/js/app.js"];
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, script)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${script}: ${result.stderr}`);
}
const css = esbuild.transformSync(fs.readFileSync(path.join(root, "web/css/companion.css"), "utf8"), { loader: "css" });
assert.equal(css.warnings.length, 0);
global.markdownit = require(path.join(root, "web/libs/markdown-it.min.js"));
global.katex = require(path.join(root, "web/libs/katex.min.js"));
global.texmath = require(path.join(root, "web/libs/texmath.js"));
require(path.join(root, "web/js/core/message-renderer.js"));
const parser = global.StuartMessageRenderer.getParser();
const samples = [];
for (const file of ["示例文档.md", "欢迎使用 StuartMD.md"]) {
  const source = fs.readFileSync(path.join(root, "samples", file), "utf8");
  const environment = { streaming: false, diagrams: [], sources: [] };
  const rendered = parser.render(source, environment);
  assert.ok(rendered.includes('class="katex"'));
  assert.ok(environment.diagrams.length > 0);
  assert.ok(rendered.includes('data-diagram="0"'));
  const streaming = parser.render(source, { streaming: true, diagrams: [], sources: [] });
  assert.ok(streaming.includes("language-mermaid"));
  assert.ok(!streaming.includes("data-diagram="));
  samples.push({ file, bytes: Buffer.byteLength(source), diagramBlocks: environment.diagrams.length });
}
// texmath 捕获 KaTeX 错误的实际行为要求共享渲染明确终止。
assert.throws(() => parser.render("$\\undefinedCompanionCommand$", { streaming: false, diagrams: [], sources: [] }), /Undefined control sequence/);
const unknownSource = parser.render("[来源](stuart-source:missing)", { streaming: false, diagrams: [], sources: [] });
assert.ok(unknownSource.includes('data-unverified-source="true"'));
assert.ok(!unknownSource.includes('href="stuart-source:missing"'));
console.log(JSON.stringify({ status: "Passed", scripts: scripts.length, cssWarnings: css.warnings.length, samples, mathematicalError: "Passed", unverifiedSource: "Passed", windowChecks: "SkippedByUser", browserChecks: "SkippedByUser" }, null, 2));
