const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const markdown = require('../web/libs/markdown-it.min.js')({ html: true });
const { editPreviewSelection } = require('../web/js/core/preview-commands.js');

function page(parts) {
  const document = new JSDOM('<main></main>').window.document;
  const preview = document.querySelector('main');
  const source = parts.join('\n\n');
  let offset = 0;
  for (const text of parts) {
    const block = document.createElement('div');
    block.className = 'md-block';
    Object.assign(block.dataset, { documentId: 'document', revision: '2', sourceOffset: String(offset), sourceEnd: String(offset + text.length) });
    block.innerHTML = markdown.render(text);
    preview.append(block);
    offset += text.length + 2;
  }
  const selection = document.defaultView.getSelection();
  function select(first, start, last, end) { selection.setBaseAndExtent(first, start, last, end); }
  function edit(format) { return editPreviewSelection({ preview, selection, source, documentId: 'document', revision: 2, format }); }
  return { preview, source, selection, select, edit };
}

test('部分跨段删除保留首尾未选文字及其他段落', () => {
  const p = page(['前缀删除', '删除后缀', '其他 **正文**']);
  const nodes = p.preview.querySelectorAll('p');
  p.select(nodes[0].firstChild, 2, nodes[1].firstChild, 2);
  assert.equal(p.edit(), '前缀\n\n后缀\n\n其他 **正文**');
  assert.equal(nodes[0].textContent, '前缀删除');
});

test('重复文字仅格式化选中的第二处，反向选择保持范围', () => {
  const p = page(['重复 重复']);
  const text = p.preview.querySelector('p').firstChild;
  p.select(text, 5, text, 3);
  assert.equal(p.edit({ before: '**', after: '**' }), '重复 **重复**');
});

test('跨段加粗分别作用于实际文字，保留原有链接', () => {
  const p = page(['前缀选择', '[链接](https://example.com) 后缀']);
  const paragraphs = p.preview.querySelectorAll('p');
  p.select(paragraphs[0].firstChild, 2, paragraphs[1].querySelector('a').firstChild, 2);
  const result = p.edit({ before: '**', after: '**' });
  const rendered = new JSDOM(markdown.render(result)).window.document;
  assert.deepEqual([...rendered.querySelectorAll('strong')].map(n => n.textContent), ['选择', '链接']);
  assert.equal(rendered.querySelector('a').getAttribute('href'), 'https://example.com');
  assert.equal(rendered.body.textContent.replace(/\s/g, ''), '前缀选择链接后缀');
});

test('整段删除和全文删除允许产生空正文', () => {
  const p = page(['删除', '保留']);
  const text = p.preview.querySelector('p').firstChild;
  p.select(text, 0, text, text.length);
  assert.equal(p.edit(), '\n\n保留');
  p.select(p.preview, 0, p.preview, p.preview.childNodes.length);
  assert.equal(p.edit(), '');
});

test('相邻段落起点不属于删除范围', () => {
  const p = page(['删除', '保留']);
  const nodes = p.preview.querySelectorAll('p');
  p.select(nodes[0].firstChild, 0, nodes[1].firstChild, 0);
  assert.equal(p.edit(), '\n\n保留');
});

test('表格跨单元格删除保留表格结构与未选文字', () => {
  const p = page(['| 标题甲 | 标题乙 |\n| --- | --- |\n| 前缀删除 | 删除后缀 |']);
  const cells = p.preview.querySelectorAll('td');
  p.select(cells[0].firstChild, 2, cells[1].firstChild, 2);
  const rendered = new JSDOM(markdown.render(p.edit())).window.document;
  assert.deepEqual([...rendered.querySelectorAll('td')].map(n => n.textContent.trim()), ['前缀', '后缀']);
});

test('过期文档控件拒绝修改', () => {
  const p = page(['正文']);
  const text = p.preview.querySelector('p').firstChild;
  p.select(text, 0, text, 1);
  p.preview.firstChild.dataset.revision = '1';
  assert.throws(() => p.edit(), /版本/);
});

test('图表部分删除拒绝转换并保留源码', () => {
  const p = page(['```mermaid\nflowchart LR\nA-->B\n```']);
  p.preview.firstChild.innerHTML = '<div class="mermaid-diagram">图表标签</div>';
  const text = p.preview.querySelector('.mermaid-diagram').firstChild;
  p.select(text, 1, text, 2);
  assert.throws(() => p.edit(), /源码/);
});

test('下划线、颜色和行内代码保留对应表现', () => {
  for (const [before, after, selector] of [['<u>', '</u>', 'u'], ['<span style="color:red">', '</span>', 'span[style]'], ['`', '`', 'code']]) {
    const p = page(['前缀目标后缀']);
    const text = p.preview.querySelector('p').firstChild;
    p.select(text, 2, text, 4);
    const rendered = new JSDOM(markdown.render(p.edit({ before, after }))).window.document;
    assert.equal(rendered.querySelector(selector).textContent, '目标');
    assert.equal(rendered.body.textContent.trim(), '前缀目标后缀');
  }
});

test('空格选区只删除选中的空格', () => {
  const p = page(['甲 乙']);
  const text = p.preview.querySelector('p').firstChild;
  p.select(text, 1, text, 2);
  assert.equal(p.edit(), '甲乙');
});

test('已有强调格式中的部分文字再次应用相同格式保持原有表现', () => {
  for (const [source, selector, before, after] of [['**abcdef**', 'strong', '**', '**'], ['*abcdef*', 'em', '*', '*'], ['~~abcdef~~', 's', '~~', '~~']]) {
    const p = page([source]);
    const text = p.preview.querySelector(selector).firstChild;
    p.select(text, 2, text, 4);
    const rendered = new JSDOM(markdown.render(p.edit({ before, after }))).window.document;
    assert.equal(rendered.querySelector(selector).textContent, 'abcdef');
    assert.equal(rendered.body.textContent.trim(), 'abcdef');
  }
});

test('多级列表局部删除保留相邻列表内容', () => {
  const p = page(['- 第一项\n  - 子项删除\n- 最后一项']);
  const text = p.preview.querySelector('ul ul li').firstChild;
  p.select(text, 2, text, 4);
  const rendered = new JSDOM(markdown.render(p.edit())).window.document;
  assert.equal(rendered.querySelector('ul ul li').textContent.trim(), '子项');
  assert.equal(rendered.querySelector('body > ul > li:last-child').textContent.trim(), '最后一项');
});

test('跨越已有加粗与行内代码的格式操作保持正文及单层格式', () => {
  for (const source of ['a**b**c', 'a`b`c']) {
    const p = page([source]);
    const paragraph = p.preview.querySelector('p');
    p.select(paragraph, 0, paragraph, paragraph.childNodes.length);
    const rendered = new JSDOM(markdown.render(p.edit({ before: '**', after: '**' }))).window.document;
    assert.equal(rendered.body.textContent.trim(), 'abc');
    assert.equal(rendered.querySelectorAll('strong strong').length, 0);
    assert.equal(rendered.querySelector('strong').textContent, 'abc');
    if (source.includes('`')) assert.equal(rendered.querySelector('code').textContent, 'b');
  }
});

test('行内代码部分加粗保持代码文字与选区边界', () => {
  const p = page(['`abcdef`']);
  const text = p.preview.querySelector('code').firstChild;
  p.select(text, 2, text, 4);
  const rendered = new JSDOM(markdown.render(p.edit({ before: '**', after: '**' }))).window.document;
  assert.equal(rendered.body.textContent.trim(), 'abcdef');
  assert.equal(rendered.querySelector('strong').textContent, 'cd');
  assert.deepEqual([...rendered.querySelectorAll('code')].map(node => node.textContent), ['ab', 'cd', 'ef']);
});

test('行内代码格式连续应用以及边缘选区保留实际正文', () => {
  const p = page(['a`b`c']);
  const paragraph = p.preview.querySelector('p');
  p.select(paragraph, 0, paragraph, paragraph.childNodes.length);
  const rendered = new JSDOM(markdown.render(p.edit({ before: '`', after: '`' }))).window.document;
  assert.equal(rendered.querySelector('code').textContent, 'abc');
  assert.equal(rendered.body.textContent.trim(), 'abc');
  for (const [before, after, selector, start, end] of [['*', '*', 'em', 0, 4], ['~~', '~~', 's', 2, 6]]) {
    const q = page(['a`abcdef`z']);
    const text = q.preview.querySelector('code').firstChild;
    q.select(text, start, text, end);
    const result = new JSDOM(markdown.render(q.edit({ before, after }))).window.document;
    assert.equal(result.body.textContent.trim(), 'aabcdefz');
    assert.equal(result.querySelector(selector).textContent, 'abcdef'.slice(start, end));
  }
});

test('实际文件保存与重新读取保留混合换行和选区之外的内容', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DocumentSession } = require('../web/js/core/document-session.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuart-selection-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('stuart-selection-'));
    fs.rmSync(directory, { recursive: true });
  });
  const file = path.join(directory, '正文.md');
  const original = '甲删除\r\n\r\n删除乙\n\n末尾😀\r\n';
  fs.writeFileSync(file, original);
  const session = new DocumentSession({ content: fs.readFileSync(file, 'utf8') });
  const p = page(['甲删除', '删除乙', '末尾😀\n']);
  const paragraphs = p.preview.querySelectorAll('p');
  p.select(paragraphs[0].firstChild, 1, paragraphs[1].firstChild, 2);
  session.updateEditor(p.edit());
  fs.writeFileSync(file, session.source);
  assert.equal(fs.readFileSync(file, 'utf8'), '甲\r\n\r\n乙\n\n末尾😀\r\n');
  session.updateSource(original);
  assert.equal(session.source, original);
});

test('页面分发的依赖和模块在同一 DOM 环境执行', t => {
  const fs = require('node:fs');
  const dom = new JSDOM('<main><div class="md-block" data-document-id="document" data-revision="2" data-source-offset="0" data-source-end="5"><p>重复 重复</p></div></main>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  for (const file of ['web/libs/markdown-it.min.js', 'web/libs/turndown.js', 'web/libs/turndown-plugin-gfm.js', 'web/js/core/preview-commands.js']) dom.window.eval(fs.readFileSync(file, 'utf8'));
  const preview = dom.window.document.querySelector('main'), selection = dom.window.getSelection();
  const text = preview.querySelector('p').firstChild;
  selection.setBaseAndExtent(text, 3, text, 5);
  assert.equal(dom.window.StuartCore.editPreviewSelection({ preview, selection, source: '重复 重复', documentId: 'document', revision: 2, format: { before: '**', after: '**' } }), '重复 **重复**');
});
