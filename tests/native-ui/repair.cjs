const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { remote } = require('webdriverio');

const workspace = path.resolve(__dirname, '../..');
const artifacts = path.join(workspace, 'tests/native-artifacts/ui');
const output = path.join(workspace, 'docs/validation/3.5.11');
const application = process.env.STUART_TEST_APPLICATION ? path.resolve(process.env.STUART_TEST_APPLICATION) : path.join(workspace, 'tauri/src-tauri/target/release/stuartmd.exe');

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.accessSync(application);
  const sourcePath = path.join(artifacts, '混合换行.md');
  const original = '# 混合文档\r\n\r\n第一段😀\n\n第二段\r\n\r\n';
  fs.writeFileSync(sourcePath, original);
  const direct = process.env.STUART_NATIVE_DRIVER_DIRECT === '1';
  const driverPath = path.join(workspace, 'tests/native-artifacts/driver/msedgedriver.exe');
  const driver = spawn(direct ? driverPath : path.join(process.env.USERPROFILE, '.cargo/bin/tauri-driver.exe'), direct ? ['--port=4444', '--verbose', '--log-path=' + path.join(output, 'edge-native-driver.log')] : ['--native-driver', driverPath], {
    windowsHide: true, env: { ...process.env, TAURI_AUTOMATION: 'true', TAURI_WEBVIEW_AUTOMATION: 'true', STUART_DATA_DIR: path.join(artifacts, 'app-data') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(output, 'native-driver.log'));
  driver.stdout.pipe(log); driver.stderr.pipe(log);
  let browser;
  const results = [];
  async function verify(name, operation) { await operation(); results.push({ name, passed: true }); console.log(name); }
  try {
    const deadline = Date.now() + 20000;
    let startupError;
    driver.on('error', error => { startupError = error; });
    while (true) {
      if (startupError) throw startupError;
      if (driver.exitCode != null) throw new Error('原生测试驱动提前退出：' + driver.exitCode);
      try {
        const response = await fetch('http://127.0.0.1:4444/status');
        if (!response.ok) throw new Error('原生测试驱动状态异常：' + response.status);
        const status = await response.json();
        if (status.value.ready) break;
      } catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED') throw error;
      }
      if (Date.now() > deadline) throw new Error('原生测试驱动未准备完成');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const webviewOptions = { userDataFolder: path.join(artifacts, 'webview-profile') };
    const capabilities = direct ? { browserName: 'webview2', 'ms:edgeChromium': true, 'ms:edgeOptions': { binary: application, webviewOptions }, 'wdio:enforceWebDriverClassic': true } : { 'tauri:options': { application }, 'ms:edgeOptions': { webviewOptions }, 'wdio:enforceWebDriverClassic': true };
    browser = await remote({ hostname: '127.0.0.1', port: 4444, logLevel: 'error', connectionRetryTimeout: 30000, connectionRetryCount: 0, capabilities });
    await browser.waitUntil(() => browser.execute(() => window.StuartMD?.state?.apiReady && window.StuartMD.state.appInfo), { timeout: 60000 });
    await verify('运行时版本与原生IPC', async () => {
      assert.equal(await browser.execute(() => window.StuartMD.state.appInfo.version), '3.5.11');
      assert.equal(await browser.execute(() => !!window.__TAURI__), true);
    });
    await verify('源码模式打开文件后切换阅读并正确渲染', async () => {
      await browser.execute(async file => { window.StuartMD.setMode('source'); await window.openFileByPath(file); }, sourcePath);
      assert.equal(await browser.execute(() => window.StuartMD.getDocument().content), original);
      await browser.execute(() => window.StuartMD.setMode('preview'));
      await browser.waitUntil(() => browser.execute(() => document.querySelector('#preview').textContent.includes('第一段😀')));
    });
    await verify('源码真实编辑与保存保留未编辑换行', async () => {
      await browser.execute(() => window.StuartMD.setMode('source'));
      const source = await browser.$('#source');
      await source.click();
      await browser.execute(() => {
        const textarea = document.querySelector('#source');
        textarea.setSelectionRange(textarea.value.indexOf('第一段'), textarea.value.indexOf('第一段'));
      });
      await browser.keys('修改');
      await browser.keys(['Control', 's']);
      await browser.waitUntil(() => !fs.readFileSync(sourcePath, 'utf8').includes('\n第一段'), { timeout: 15000 });
      assert.equal(fs.readFileSync(sourcePath, 'utf8'), '# 混合文档\r\n\r\n修改第一段😀\n\n第二段\r\n\r\n');
    });
    await verify('中文Mermaid标签位于节点边框内', async () => {
      await browser.execute(() => {
        window.StuartMD.setDocumentText('```mermaid\nflowchart LR\n A[打开中文文档] --> B[保存修改与恢复草稿]\n```\n');
        window.StuartMD.setMode('preview');
      });
      await browser.waitUntil(() => browser.execute(() => !!document.querySelector('.mermaid-diagram svg')), { timeout: 30000 });
      const measurements = await browser.execute(() => Array.from(document.querySelectorAll('.mermaid-diagram g.node')).map(node => {
        const rect = node.querySelector('rect').getBoundingClientRect();
        const label = node.querySelector('.nodeLabel').getBoundingClientRect();
        return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, label: { x: label.x, y: label.y, width: label.width, height: label.height } };
      }));
      assert.equal(measurements.length, 2);
      for (const { rect, label } of measurements) {
        assert.ok(rect.width > 30 && rect.height > 15);
        assert.ok(label.x >= rect.x - 1 && label.x + label.width <= rect.x + rect.width + 1);
        assert.ok(label.y >= rect.y - 1 && label.y + label.height <= rect.y + rect.height + 1);
      }
      fs.writeFileSync(path.join(output, 'mermaid-measurements.json'), JSON.stringify(measurements, null, 2));
    });
    await browser.saveScreenshot(path.join(output, 'native-ui.png'));
    fs.writeFileSync(path.join(output, 'native-ui-results.json'), JSON.stringify(results, null, 2));
  } finally {
    try { if (browser) await browser.deleteSession(); }
    finally {
      try {
        execFileSync('pwsh.exe', ['-NoProfile', '-File', path.join(__dirname, 'stop-driver-children.ps1'), '-DriverProcessId', String(driver.pid), '-ApplicationPath', application], { windowsHide: true });
      } finally { driver.kill(); log.end(); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
