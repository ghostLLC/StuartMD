const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/validation/3.5.11');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.woff2': 'font/woff2' };

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [], missingResources = [], externalRequests = [], resources = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) missingResources.push(response.url()); resources.push(response.url()); });
    page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1' && !request.url().startsWith('data:')) externalRequests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/web/index.html`);
    await page.waitForFunction(() => window.StuartMDPdf && document.querySelector('#boot-splash').hidden);
    await page.evaluate(async () => {
      const data = new Uint8Array(await (await fetch('/tests/fixtures/pdf/layout-and-ocr.pdf')).arrayBuffer());
      await window.StuartMDPdf.openPdf({ documentId: crypto.randomUUID(), path: 'layout-and-ocr.pdf', name: '实际 PDF 页面', data, annotations: [] });
    });
    const measurements = [];
    for (const [number, phrase] of [[1, 'SINGLE COLUMN SOURCE ALPHA'], [4, 'ROTATION SOURCE CHARLIE'], [5, 'CROPBOX SOURCE DELTA']]) {
      await page.locator('#pdf-page-input').fill(String(number));
      await page.locator('#pdf-page-input').dispatchEvent('change');
      const selector = `.pdf-page[data-page="${number}"] .pdf-text-layer span`;
      await page.waitForFunction(({ selector, phrase }) => [...document.querySelectorAll(selector)].some(span => span.textContent.includes(phrase)), { selector, phrase });
      const selection = await page.evaluate(({ selector, phrase }) => {
        const span = [...document.querySelectorAll(selector)].find(span => span.textContent.includes(phrase));
        const range = document.createRange(); range.selectNodeContents(span);
        const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
        const box = span.getBoundingClientRect();
        span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
        return window.StuartMDPdf.getSelection();
      }, { selector, phrase });
      assert.equal(selection.text, phrase);
      assert.equal(selection.page, number);
      assert.equal(selection.fromPdf, true);
      assert.ok(selection.pdfRects.length > 0 && selection.pdfQuads.length > 0);
      for (const quad of selection.pdfQuads) {
        assert.ok(quad[2] > quad[0] + 100, `第${number}页文字方向必须保留：${quad}`);
        assert.ok(Math.abs(quad[3] - quad[1]) < 0.5);
        assert.ok(quad[1] > quad[5]);
      }
      measurements.push({ page: number, selection });
      await page.screenshot({ path: path.join(output, `pdf-viewer-page-${number}.png`) });
    }
    for (const number of [2, 3, 6, 7, 8]) {
      await page.locator('#pdf-page-input').fill(String(number)); await page.locator('#pdf-page-input').dispatchEvent('change');
      await page.waitForFunction(number => document.querySelector(`.pdf-page[data-page="${number}"]`)?.dataset.painted === '1', number);
      if (number === 6) {
        const text = await page.evaluate(() => window.StuartMDPdf.loadPageText(6));
        assert.ok(text.includes('简体中文 页面引用 来源坐标') && text.includes('繁體中文 頁面引用 來源座標'), `实际中文页面文字：${text}`);
        await page.screenshot({ path: path.join(output, 'pdf-viewer-chinese.png') });
      }
    }
    const generated = JSON.parse(fs.readFileSync(path.join(output, 'pdf-annotation-results.json'), 'utf8')).path;
    const relative = '/' + path.relative(root, generated).split(path.sep).join('/');
    const annotations = await page.evaluate(async url => {
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const document = await pdfjsLib.getDocument({ data, cMapUrl: new URL('libs/pdfjs/cmaps/', location.href).href, cMapPacked: true, standardFontDataUrl: new URL('libs/pdfjs/standard_fonts/', location.href).href }).promise;
      const annotations = [];
      for (const number of [1, 5]) annotations.push({ page: number, items: await (await document.getPage(number)).getAnnotations() });
      await document.destroy(); return annotations;
    }, relative);
    assert.equal(annotations[0].items[0].contentsObj.str, '修改后的评论😀');
    assert.deepEqual(Array.from(annotations[0].items[0].color), [255, 79, 89]);
    assert.ok(annotations.every(page => page.items[0].hasAppearance));
    assert.deepEqual(errors, []); assert.deepEqual(missingResources, []); assert.deepEqual(externalRequests, []);
    fs.writeFileSync(path.join(output, 'pdf-viewer-results.json'), JSON.stringify({ measurements, annotations, resources: [...new Set(resources)], passed: true }, null, 2));
    console.log('PDF.js 实际页面、旋转选区、CropBox、原生批注和本地资源检查通过');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
