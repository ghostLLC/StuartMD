const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const markdownit = require('../web/libs/markdown-it.min.js');

const workspace = path.resolve(__dirname, '..');
const baseline = 'C:/Users/Administrator/XiaomiMiMoProjects/.mimo-sessions/2026-09-15/StuartMD';
const output = path.join(workspace, 'docs/validation/3.5.11');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

function verifyNodes(measurements) {
  assert.ok(measurements.nodes.length > 0, '流程图必须包含节点');
  for (const { rect, label, foreignObject, text } of measurements.nodes) {
    assert.ok(rect.width > 20 && rect.height > 12, text);
    assert.ok(!foreignObject || foreignObject.width > 0, text);
    assert.ok(label.x >= rect.x - 1 && label.x + label.width <= rect.x + rect.width + 1, text);
    assert.ok(label.y >= rect.y - 1 && label.y + label.height <= rect.y + rect.height + 1, text);
  }
}

async function run(directory, name, experiment) {
  const code = markdownit().parse(fs.readFileSync(path.join(directory, 'samples/欢迎使用 StuartMD.md'), 'utf8'), {})
    .find(token => token.type === 'fence' && token.info === 'mermaid').content;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const file = path.resolve(directory, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(path.resolve(directory) + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1768, height: 1006 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/web/index.html`);
    await page.waitForFunction(() => window.StuartMD && window.mermaid);
    await page.waitForFunction(() => document.querySelector('#boot-splash').hidden);
    await page.evaluate(() => document.querySelector('#btn-tab-new').click());
    await page.waitForFunction(() => window.StuartMD.state.activeTabId != null);
    if (experiment) await page.addStyleTag({ content: experiment });
    await page.evaluate(code => {
      window.StuartMD.setMode('preview');
      window.StuartMD.setDocumentText('```mermaid\n' + code + '```\n');
    }, code);
    await page.waitForSelector('.mermaid-diagram svg', { timeout: 15000 });
    assert.deepEqual(errors, [], '页面必须正常运行');
    const measurements = await page.evaluate(() => {
      const svg = document.querySelector('.mermaid-diagram svg');
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display, fontSize: style.fontSize, padding: style.padding, cssWidth: style.width };
      };
      return { viewBox: svg.getAttribute('viewBox'), svg: bounds(svg), nodes: [...svg.querySelectorAll('g.node')].map(node => ({
        text: node.textContent, rect: bounds(node.querySelector('rect,polygon,circle,ellipse,path')),
        foreignObject: node.querySelector('foreignObject') ? bounds(node.querySelector('foreignObject')) : null,
        label: bounds(node.querySelector('.nodeLabel') || node.querySelector('text')),
      })) };
    });
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `mermaid-${name}.json`), JSON.stringify({ code, errors, ...measurements }, null, 2));
    await page.screenshot({ path: path.join(output, `mermaid-${name}.png`), fullPage: false });
    console.log(JSON.stringify({ name, errors, nodeCount: measurements.nodes.length }));
    if (directory === workspace) {
      verifyNodes(measurements);
      const cases = [];
      for (const theme of ['light', 'gray', 'dark', 'sepia', 'minion', 'wallpaper']) {
        for (const mode of ['preview', 'split']) {
          await page.evaluate(({ theme, mode }) => {
            window.StuartMD.setTheme(theme);
            window.StuartMD.setMode(mode);
            window.StuartMD.setDocumentText('```mermaid\nflowchart TB\n A[打开包含中文与English的长文档] --> B[保存当前修改并保留恢复草稿]\n B --> C[第一行中文<br/>第二行English与中文]\n```\n');
          }, { theme, mode });
          await page.waitForFunction(() => document.querySelector('.mermaid-diagram svg')?.textContent.includes('第二行English'));
          const result = await page.evaluate(() => ({ nodes: [...document.querySelectorAll('.mermaid-diagram g.node')].map(node => {
            const rectangle = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            const label = node.querySelector('.nodeLabel');
            return { text: node.textContent, rect: rectangle(node.querySelector('rect')), label: rectangle(label), foreignObject: rectangle(node.querySelector('foreignObject')), labelStyle: { display: getComputedStyle(label).display, lineHeight: getComputedStyle(label).lineHeight, fontSize: getComputedStyle(label).fontSize }, html: label.innerHTML };
          }) }));
          fs.writeFileSync(path.join(output, `mermaid-${theme}-${mode}.json`), JSON.stringify(result, null, 2));
          await page.screenshot({ path: path.join(output, `mermaid-${theme}-${mode}.png`) });
          verifyNodes(result);
          cases.push({ theme, mode, nodeCount: result.nodes.length });
        }
      }
      for (const diagram of [
        'sequenceDiagram\n participant A as 中文用户\n participant B as 文档服务\n A->>B: 保存真实文档\n B-->>A: 返回保存结果',
        'classDiagram\n class Document {\n +save()\n +restore()\n }\n class Window\n Window --> Document',
        'stateDiagram-v2\n [*] --> Editing\n Editing --> Saved: 保存文档\n Saved --> Editing: 修改文档',
        'pie title 文档类型\n "Markdown" : 70\n "PDF" : 30',
      ]) {
        await page.evaluate(code => window.StuartMD.setDocumentText('```mermaid\n' + code + '\n```\n'), diagram);
        await page.waitForSelector('.mermaid-diagram svg');
        const valid = await page.evaluate(() => {
          const svg = document.querySelector('.mermaid-diagram svg');
          return svg.viewBox.baseVal.width > 0 && svg.viewBox.baseVal.height > 0 && !svg.querySelector('script, a');
        });
        assert.equal(valid, true, diagram);
        cases.push({ diagram: diagram.split('\n')[0], valid });
      }
      await page.setViewportSize({ width: 1000, height: 760 });
      await page.evaluate(() => {
        window.StuartMD.setMode('preview');
        window.StuartMD.setDocumentText('```mermaid\nflowchart LR\n A[旧文档节点] --> B[旧文档结果]\n```\n');
        document.querySelector('#btn-tab-new').click();
      });
      await page.waitForFunction(() => window.StuartMD.state.name === '未命名.md' && window.StuartMD.getDocument().content.includes('开始书写'));
      await page.evaluate(() => window.StuartMD.setDocumentText('```mermaid\nflowchart LR\n A[活动文档中文节点] --> B[活动文档结果]\n```\n'));
      await page.waitForFunction(() => document.querySelector('.mermaid-diagram svg')?.textContent.includes('活动文档结果') && !document.querySelector('.mermaid-measure'));
      assert.equal(await page.locator('#preview').textContent().then(text => text.includes('旧文档')), false);
      assert.deepEqual(errors, [], '图表和文档切换必须正常运行');
      cases.push({ rapidDocumentSwitch: true, viewportWidth: 1000 });
      fs.writeFileSync(path.join(output, 'mermaid-matrix.json'), JSON.stringify(cases, null, 2));
      console.log(JSON.stringify({ matrixCases: cases.length, passed: true }));
    }
    return measurements;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

async function main() {
  const baselineResult = await run(baseline, 'baseline');
  assert.ok(baselineResult.nodes.some(({ rect, label }) => rect.width < label.width), '原始版本必须复现节点小于标签');
  if (process.argv.includes('--diagnose')) {
    await run(baseline, 'measure-display', 'foreignObject > div { display: inline-block !important; }');
    await run(baseline, 'measure-width', 'foreignObject > div { width: max-content !important; }');
    return;
  }
  const current = await run(workspace, 'current');
  verifyNodes(current);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
