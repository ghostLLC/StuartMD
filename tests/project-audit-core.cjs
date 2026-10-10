const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

require('../web/js/core/doc-stats.js');
const core = globalThis.StuartCore.docStats;
const directory = path.join(__dirname, '..', 'docs', 'audit', '2026-10-09');
fs.mkdirSync(directory, { recursive: true });

const cases = [
  { name: 'LF 换行', source: '# 文档\n\n正文第一段\n\n正文第二段\n' },
  { name: 'CRLF 换行', source: '# 文档\r\n\r\n正文第一段\r\n\r\n正文第二段\r\n' },
  { name: '混合 LF 和 CRLF 换行', source: '# 文档\r\n\r\n正文第一段\n\n正文第二段\r\n' },
];
const results = cases.map(item => ({
  ...item,
  actual: core.joinBlocks(core.splitMarkdownBlocks(item.source)),
})).map(item => ({ ...item, preserved: item.actual === item.source }));

fs.writeFileSync(path.join(directory, 'source-roundtrip.json'), JSON.stringify({
  module: 'web/js/core/doc-stats.js',
  operation: 'joinBlocks(splitMarkdownBlocks(source))',
  results,
}, null, 2));

for (const result of results) {
  test(result.name, () => {
    assert.equal(result.actual, result.source, '拆分和重新组合段落应当保留原文');
  });
}
