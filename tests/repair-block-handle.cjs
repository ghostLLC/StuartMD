const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const workspace = path.resolve(__dirname, '..');
const output = path.join(workspace, 'docs/validation/3.5.11');
const welcome = fs.readFileSync(path.join(workspace, 'samples/欢迎使用 StuartMD.md'), 'utf8');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

async function measureHover(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const point = await locator.evaluate(element => {
    const pane = document.querySelector('#preview-pane').getBoundingClientRect();
    const rect = [...element.getClientRects()].find(rect => rect.bottom > pane.top + 4 && rect.top < pane.bottom - 4);
    if (!rect) throw new Error('待检查的内容必须位于阅读区域内');
    return { x: rect.left + Math.min(rect.width / 2, 12), y: Math.max(pane.top + 4, rect.top) + Math.min(rect.height / 2, 8) };
  });
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(80);
  await page.waitForFunction(() => !document.querySelector('#block-handle').hidden);
  return locator.evaluate(element => {
    const rectangle = node => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const block = element.closest('.md-block');
    const anchor = window.StuartMD.state._handleAnchor;
    return { handle: rectangle(document.querySelector('#block-handle')), block: rectangle(block), pane: rectangle(document.querySelector('#preview-pane')), anchorTag: anchor.tagName, blockIndex: Number(block.dataset.index), handleIndex: window.StuartMD.state._activeBlockIndex };
  });
}

async function main() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const file = path.resolve(workspace, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(workspace + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const cases = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1340, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/web/index.html`);
    await page.waitForFunction(() => window.StuartMD && document.querySelector('#boot-splash').hidden);
    await page.evaluate(() => document.querySelector('#btn-tab-new').click());
    await page.waitForFunction(() => window.StuartMD.state.activeTabId != null);
    const targets = [
      ['paragraph-bold', '#preview p strong', '同时清除评论'],
      ['paragraph-code', '#preview p code', '%APPDATA%'],
      ['paragraph-link', '#preview p a', 'StuartMD'],
      ['paragraph-emphasis', '#preview p em', '斜体'],
      ['paragraph-underline', '#preview p u', '下划线'],
      ['paragraph-math', '#preview p .katex', 'mc'],
      ['heading', '#preview h2', '常用快捷键'],
      ['list-bold', '#preview li strong', '文件 → 打开文件'],
      ['table-code', '#preview td code', 'Ctrl+O'],
      ['code-block', '#preview pre code', 'function greet'],
    ];
    for (const viewportWidth of [1340, 760]) {
      await page.setViewportSize({ width: viewportWidth, height: 820 });
      for (const mode of ['preview', 'split']) {
        for (const contentWidth of ['default', 'wide', 'full']) {
          await page.evaluate(({ welcome, mode }) => {
            window.getSelection().removeAllRanges();
            window.StuartMD.setMode(mode);
            window.StuartMD.setDocumentText(welcome);
          }, { welcome, mode });
          await page.locator('#btn-width').click();
          await page.locator(`#width-menu [data-width="${contentWidth}"]`).click();
          for (const [name, selector, text] of targets) {
            const locator = page.locator(selector).filter({ hasText: text }).first();
            const measured = await measureHover(page, locator);
            cases.push({ name, viewportWidth, mode, contentWidth, ...measured });
            assert.ok(measured.handle.right <= measured.block.left - 6, `${name}：块手柄必须完整位于正文左侧`);
            assert.ok(measured.handle.left >= measured.pane.left + 4, `${name}：块手柄必须位于阅读区域内`);
            assert.equal(measured.handleIndex, measured.blockIndex, `${name}：操作对象必须是所在的完整内容块`);
            assert.ok(!['STRONG', 'CODE', 'A', 'EM', 'U', 'SPAN'].includes(measured.anchorTag), `${name}：行内内容不得成为独立的定位对象`);
          }
        }
      }
    }
    await page.setViewportSize({ width: 1340, height: 820 });
    await page.evaluate(() => window.StuartMD.setMode('preview'));
    await measureHover(page, page.locator('#preview p strong').filter({ hasText: '同时清除评论' }));
    await page.locator('#bh-type').click();
    await page.locator('#block-menu [data-bm="duplicate-block"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#preview p strong').length > 0 && [...document.querySelectorAll('#preview p strong')].filter(element => element.textContent === '同时清除评论').length === 2);
    assert.equal((await page.locator('#source').inputValue()).split('同时清除评论').length - 1, 2, '块操作必须复制完整段落');
    await page.evaluate(() => window.StuartMD.undo());
    await page.waitForFunction(() => [...document.querySelectorAll('#preview p strong')].filter(element => element.textContent === '同时清除评论').length === 1);
    for (const selector of ['#preview .mermaid-diagram svg', '#preview .katex-display']) {
      const media = page.locator(selector).first();
      await media.scrollIntoViewIfNeeded();
      const bounds = await media.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.waitForFunction(() => document.querySelector('#block-handle').hidden);
    }
    await page.locator('#btn-sidebar').click();
    const closedSidebar = await measureHover(page, page.locator('#preview p code').filter({ hasText: '%APPDATA%' }));
    assert.ok(closedSidebar.handle.right <= closedSidebar.block.left - 6, '关闭侧栏后手柄必须完整位于正文左侧');
    await page.screenshot({ path: path.join(output, 'block-handle-current.png') });
    const paragraph = page.locator('#preview p').filter({ hasText: '清除批注会要求确认' });
    await paragraph.scrollIntoViewIfNeeded();
    const selectionRect = await paragraph.boundingBox();
    await page.mouse.move(selectionRect.x + 6, selectionRect.y + 12);
    await page.mouse.down();
    await page.mouse.move(selectionRect.x + Math.min(selectionRect.width - 6, 260), selectionRect.y + 12, { steps: 12 });
    await page.mouse.up();
    assert.ok(await page.evaluate(() => !window.getSelection().isCollapsed && window.getSelection().toString().length > 0), '必须实际选择正文');
    await page.waitForFunction(() => document.querySelector('#block-handle').hidden);
    await page.evaluate(() => window.StuartMD.setMode('source'));
    await page.mouse.move(500, 200);
    await page.waitForFunction(() => document.querySelector('#block-handle').hidden);
    assert.deepEqual(errors, [], '真实页面不得出现运行错误');
    fs.writeFileSync(path.join(output, 'block-handle-matrix.json'), JSON.stringify({ cases, closedSidebar, blockAction: 'duplicate-and-undo', mediaHidden: true, selectionHidden: true, sourceModeHidden: true, errors }, null, 2));
    console.log(JSON.stringify({ passed: true, hoverCases: cases.length, blockAction: 'duplicate-and-undo', mediaHidden: true, selectionHidden: true, sourceModeHidden: true }));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
