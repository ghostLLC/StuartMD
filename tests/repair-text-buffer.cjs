const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TextBuffer } = require('../web/js/core/text-buffer.js');

test('源码编辑保留未编辑的混合换行和尾部空行', () => {
  const source = '# 标题\r\n\r\n第一段😀\n\n第二段\r\n\r\n';
  const buffer = new TextBuffer(source);
  buffer.updateEditor('# 标题\n\n修改第一段😀\n\n第二段\n\n');
  assert.equal(buffer.source, '# 标题\r\n\r\n修改第一段😀\n\n第二段\r\n\r\n');
  assert.deepEqual(buffer.editsFrom(source), [{ from: 8, to: 8, insertedText: '修改' }]);
});

test('UTF-16编辑不能拆开emoji', () => {
  const buffer = new TextBuffer('甲😀乙');
  assert.throws(() => buffer.apply({ from: 2, to: 3, insertedText: '' }), /UTF-16/);
  buffer.apply({ from: 1, to: 3, insertedText: '🙂' });
  assert.equal(buffer.source, '甲🙂乙');
});

test('新增换行使用记录的默认分隔符并保留其他换行', () => {
  const source = '甲\r\n乙\n丙\r终点';
  const buffer = new TextBuffer(source);
  buffer.updateEditor('甲\n乙\n新增\n丙\n终点');
  assert.equal(buffer.source, '甲\r\n乙\n新增\r\n丙\r终点');
  assert.equal(buffer.defaultSeparator, '\r\n');
});

test('段落源码编辑只改变编辑文字并保留该段落的混合换行', () => {
  const buffer = new TextBuffer('```js\r\n甲\n乙😀\r\n```\n\n');
  buffer.updateEditor('```js\n甲\n修改乙😀\n```\n\n');
  assert.equal(buffer.source, '```js\r\n甲\n修改乙😀\r\n```\n\n');
});

test('成熟Markdown解析保留段落外的全部字符', () => {
  require('../web/js/core/doc-stats.js');
  const core = globalThis.StuartCore.docStats;
  for (const source of ['', '\r\n\n', '# 标题\r\n\n- [ ] 任务\r\n  - 嵌套\n\n```js\n\n😀\n```\r\n\r\n']) {
    assert.equal(core.joinBlocks(core.splitMarkdownBlocks(source)), source);
  }
  const source = '# 标题\r\n\r\n第一段\n\n第二段\r\n\r\n';
  const blocks = core.splitMarkdownBlocks(source);
  blocks[1] = blocks[1].replace('第一段', '修改第一段');
  assert.equal(core.joinBlocks(blocks), '# 标题\r\n\r\n修改第一段\n\n第二段\r\n\r\n');
});
