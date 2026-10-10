const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const workspace = path.resolve(__dirname, '..');
const outputDirectory = path.join(workspace, 'docs', 'handover');
const results = [];

async function main() {
  await fs.mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:8765/web/index.html');
    await page.waitForFunction(() => window.StuartMD && window.pdfjsLib && window.mermaid);
    const versions = await page.evaluate(() => ({
      pdf: window.pdfjsLib.version,
      katex: window.katex.version,
      highlight: window.hljs.versionString,
      apiReady: window.StuartMD.state.apiReady,
      tauri: !!window.__TAURI__,
    }));
    assert.equal(versions.tauri, false);
    assert.equal(versions.apiReady, false);

    async function verify(name, operation) {
      await test(name, async context => {
        let passed = false;
        let details;
        context.after(async () => {
          if (!passed) {
            details = await page.evaluate(() => ({
              source: document.querySelector('#source').value,
              previewItems: [...document.querySelectorAll('#preview li')].map(item => item.textContent),
              activeElement: document.activeElement.outerHTML.slice(0, 300),
              editingHtml: document.querySelector('#preview .editing')?.innerHTML,
              paintedPdfPages: document.querySelectorAll('#pdf-scroll .pdf-page[data-painted="1"]').length,
            }));
          }
          results.push({ name, passed, details });
        });
        details = await operation();
        passed = true;
      });
    }

    async function enterSource(content) {
      await page.locator('[data-mode="source"]').click();
      await page.locator('#source').fill(content);
      assert.equal(await page.locator('#source').inputValue(), content);
    }

    await verify('新建文档', async () => {
      await page.locator('#btn-file-menu').click();
      await page.locator('#file-menu [data-action="new"]').click();
      assert(await page.locator('#editor-area').isVisible());
      assert.equal(await page.evaluate(() => window.StuartMD.state.tabs.length), 1);
    });

    const markdown = [
      '# 接手验证', '',
      '中文正文 **加粗** 与 `code`。', '',
      '| 项目 | 状态 |', '| --- | --- |', '| Markdown | 正常 |', '',
      '- [ ] 阅读任务', '',
      '$$E=mc^2$$', '',
      '```mermaid', 'graph LR', 'A[文件] --> B[预览]', '```', '',
      '```javascript', 'const result = 42;', '```', '',
    ].join('\n');

    await verify('Markdown、表格、任务列表、KaTeX、Mermaid 和代码高亮', async () => {
      await enterSource(markdown);
      await page.locator('[data-mode="preview"]').click();
      await page.waitForFunction(() => document.querySelector('#preview .mermaid-diagram svg') && document.querySelector('#preview .katex'));
      assert.equal(await page.locator('#preview h1').textContent(), '接手验证');
      assert.equal(await page.locator('#preview table').count(), 1);
      assert.equal(await page.locator('#preview input[type="checkbox"]').count(), 1);
      assert(await page.locator('#preview code .hljs-keyword').count() > 0);
      await page.screenshot({ path: path.join(outputDirectory, 'frontend-preview.png'), fullPage: true });
      return { sourcePreserved: await page.locator('#source').inputValue() === markdown };
    });

    await verify('Mermaid 节点完整容纳中文文字', async () => {
      const nodes = await page.evaluate(() => [...document.querySelectorAll('#preview .mermaid-diagram g.node')].map(node => {
        const label = node.querySelector('.nodeLabel');
        const range = document.createRange();
        range.selectNodeContents(label);
        return { text: label.textContent, textWidth: range.getBoundingClientRect().width, nodeWidth: node.querySelector('rect').getBoundingClientRect().width };
      }));
      await fs.writeFile(path.join(outputDirectory, 'mermaid-layout.json'), JSON.stringify(nodes, null, 2) + '\n');
      assert(nodes.length === 2);
      assert(nodes.every(node => node.nodeWidth >= node.textWidth));
      return { nodes };
    });

    await verify('Markdown 分块与重组保留 LF、CRLF 原文', async () => {
      const inputs = [
        '\r\n\r\n标题\r\n\r\n正文  \r\n下一行\r\n',
        '```js\nconst result = 42;\n\nresult;\n```\n\n$$\nE=mc^2\n$$\n',
        '- [ ] 任务\n\n1. 项目\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n',
      ];
      const outputs = await page.evaluate(values => values.map(value => window.StuartCore.docStats.joinBlocks(window.StuartCore.docStats.splitMarkdownBlocks(value))), inputs);
      assert.deepEqual(outputs, inputs);
      return { cases: inputs.length };
    });

    await verify('Markdown 分块与重组保留混合换行符', async () => {
      const input = '\n\n标题\r\n\r\n正文  \r\n下一行\r\n';
      const output = await page.evaluate(value => window.StuartCore.docStats.joinBlocks(window.StuartCore.docStats.splitMarkdownBlocks(value)), input);
      assert.equal(output, input);
      return { input, output };
    });

    await verify('Ctrl+Z 撤销与 Ctrl+Y 重做', async () => {
      await enterSource('alpha');
      await page.waitForTimeout(350);
      await page.locator('#source').fill('beta');
      await page.waitForTimeout(350);
      await page.locator('#source').press('Control+z');
      assert.equal(await page.locator('#source').inputValue(), 'alpha');
      await page.locator('#source').press('Control+y');
      assert.equal(await page.locator('#source').inputValue(), 'beta');
      return { ctrlZ: 'undo', ctrlY: 'redo' };
    });

    await verify('Ctrl+Shift+Z 撤销与文档约定一致', async () => {
      await page.locator('#source').press('Control+Shift+z');
      assert.equal(await page.locator('#source').inputValue(), 'alpha');
    });

    for (const item of [
      { name: '替换全文后任务列表进入编辑并延续类型', text: '- [ ] 阅读任务', label: '阅读任务', next: '- [ ] ' },
      { name: '有序列表 Enter 延续编号', text: '1. 第一项', label: '第一项', next: '2. ' },
    ]) {
      await verify(item.name, async () => {
        await enterSource(item.text);
        await page.locator('[data-mode="preview"]').click();
        await page.waitForFunction(expected => document.querySelectorAll('#preview .md-block').length === 1 && document.querySelector('#preview li')?.textContent.trim() === expected, item.label);
        const row = page.locator('#preview li').last();
        await row.click();
        await page.waitForFunction(() => document.activeElement.isContentEditable);
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.waitForFunction(expected => document.querySelector('#source').value === expected, item.text + '\n' + item.next);
        const source = await page.locator('#source').inputValue();
        assert(source.includes(item.text));
        assert(source.includes(item.next));
        return { source };
      });
    }

    await verify('新建文档后任务列表 Enter 延续类型', async () => {
      await page.locator('#btn-file-menu').click();
      await page.locator('#file-menu [data-action="new"]').click();
      await enterSource('- [ ] 阅读任务');
      await page.locator('[data-mode="preview"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#preview .md-block').length === 1 && document.querySelector('#preview li')?.textContent.trim() === '阅读任务');
      await page.locator('#preview li').click();
      await page.waitForFunction(() => document.activeElement.isContentEditable);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#source').value === '- [ ] 阅读任务\n- [ ] ');
      return { source: await page.locator('#source').inputValue() };
    });

    await verify('不可信 HTML 清洗', async () => {
      await enterSource('# 清洗验证\n\n<img src="missing-image" onerror="window.stuartUnsafeExecuted=true">\n\n<script>window.stuartUnsafeExecuted=true</script>\n\n[链接](javascript:alert(1))');
      await page.locator('[data-mode="preview"]').click();
      await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === '清洗验证');
      const status = await page.evaluate(() => ({
        scripts: document.querySelectorAll('#preview script').length,
        handlers: document.querySelectorAll('#preview [onerror], #preview [onclick]').length,
        unsafeLinks: [...document.querySelectorAll('#preview a')].filter(anchor => anchor.getAttribute('href')?.startsWith('javascript:')).length,
        executed: window.stuartUnsafeExecuted === true,
      }));
      assert.deepEqual(status, { scripts: 0, handlers: 0, unsafeLinks: 0, executed: false });
      return status;
    });

    await verify('PDF.js 阅读、文字提取、分页和 Canvas 回收', async () => {
      const document = await PDFDocument.create();
      const font = await document.embedFont(StandardFonts.Helvetica);
      for (let number = 1; number <= 12; number++) {
        const pdfPage = document.addPage([612, 792]);
        pdfPage.drawText(`StuartMD handover page ${number}`, { x: 50, y: 700, size: 24, font });
      }
      const pdfBytes = await document.save();
      await page.evaluate(async bytes => {
        await window.StuartMDPdf.openPdf({ name: 'handover.pdf', data: new Uint8Array(bytes), annotations: [] });
      }, Array.from(pdfBytes));
      await page.waitForFunction(() => [...document.querySelectorAll('#pdf-scroll canvas')].some(canvas => canvas.width > 0 && canvas.height > 0));
      assert(await page.evaluate(() => window.StuartMDPdf.isActive()));
      const text = await page.evaluate(() => window.StuartMDPdf.loadPageText(1));
      assert(text.includes('StuartMD handover page 1'));
      await page.locator('#pdf-page-input').fill('12');
      await page.locator('#pdf-page-input').press('Enter');
      await page.locator('#pdf-page-input').blur();
      await page.waitForFunction(() => document.querySelector('#pdf-scroll .pdf-page[data-page="12"]')?.dataset.painted === '1');
      const status = await page.evaluate(() => ({
        pages: document.querySelectorAll('#pdf-scroll .pdf-page').length,
        paintedPages: document.querySelectorAll('#pdf-scroll .pdf-page[data-painted="1"]').length,
        renderedCanvases: [...document.querySelectorAll('#pdf-scroll canvas')].filter(canvas => canvas.width > 0 && canvas.height > 0).length,
        pageLabel: document.querySelector('#pdf-page-label').textContent,
      }));
      assert.equal(status.pages, 12);
      assert(status.paintedPages > 0 && status.paintedPages <= 5);
      await page.screenshot({ path: path.join(outputDirectory, 'frontend-pdf.png'), fullPage: true });
      return status;
    });

    await verify('浏览器 JavaScript 运行状态', async () => {
      assert.deepEqual(pageErrors, []);
      return { pageErrors };
    });
    const report = { verifiedAt: new Date().toISOString(), scope: 'shared-frontend-in-real-edge', versions, results, pageErrors };
    await fs.writeFile(path.join(outputDirectory, 'browser-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length }));
  } finally {
    await browser.close();
  }
}

main();
