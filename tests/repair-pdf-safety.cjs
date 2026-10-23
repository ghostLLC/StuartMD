const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const path = require('node:path');
const pdfjs = require('pdfjs-dist/build/pdf.js');

test('PDF 页面入口关闭动态代码执行，实际 PDF 仍可提取正文', async () => {
  assert.ok(/isEvalSupported:\s*false/.test(fs.readFileSync('web/js/pdf-viewer.js', 'utf8')));
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync('tests/fixtures/pdf/layout-and-ocr.pdf')), isEvalSupported: false, standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + path.sep });
  const document = await task.promise;
  try {
    assert.equal(document.numPages, 8);
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    assert.ok(content.items.map(item => item.str).join(' ').includes('SINGLE COLUMN SOURCE ALPHA'));
    const operators = await page.getOperatorList();
    assert.ok(operators.fnArray.length > 0);
  } finally {
    await document.destroy();
  }
});
