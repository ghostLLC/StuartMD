const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const toml = require('@iarna/toml');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const version = toml.parse(fs.readFileSync(path.join(root, 'tauri/src-tauri/Cargo.toml'), 'utf8')).package.version;
const configuration = JSON.parse(fs.readFileSync(path.join(root, 'tauri/src-tauri/tauri.conf.json'), 'utf8'));
assert.equal(version, '3.5.16');
assert.equal(configuration.version, version);
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, version);
for (const file of ['README.md', 'samples/示例文档.md', 'samples/欢迎使用 StuartMD.md']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(source.includes(version), file);
  assert.ok(!source.includes('3.5.10'), file);
  require('../web/libs/markdown-it.min.js')().parse(source, {});
}
assert.ok(fs.readFileSync(path.join(root, 'tauri/src-tauri/src/fs_api.rs'), 'utf8').includes('env!("CARGO_PKG_VERSION")'));
assert.match(execFileSync('rustc', ['--version'], { cwd: root, encoding: 'utf8' }), /^rustc 1\.98\.1 /);
const resources = JSON.parse(fs.readFileSync(path.join(root, 'resources/native-manifest.json'), 'utf8'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const home = new JSDOM(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'));
const homeLogo = home.window.document.querySelector('#welcome img.logo-mark');
assert.ok(homeLogo, '开始页面必须使用应用图标');
assert.equal(homeLogo.getAttribute('src'), 'assets/app.ico');
assert.equal(homeLogo.getAttribute('alt'), 'StuartMD');
assert.equal(sha256(path.join(root, 'web/assets/app.ico')), sha256(path.join(root, 'assets/app.ico')));
assert.deepEqual(configuration.bundle.icon, ['../../assets/app.ico']);
home.window.close();
assert.equal(sha256(path.join(root, 'web/libs/textarea-caret.js')), sha256(path.join(root, 'node_modules/textarea-caret/index.js')));
assert.equal(sha256(path.join(root, 'web/libs/textarea-caret-LICENSE')), sha256(path.join(root, 'node_modules/textarea-caret/LICENSE')));
const evidence = { version, pdfjs: require('pdfjs-dist/package.json').version, resourceManifestHash: sha256(path.join(root, 'resources/native-manifest.json')), nativeManifest: resources };
assert.equal(evidence.pdfjs, '3.11.174');
for (const resource of resources.files) assert.equal(sha256(path.join(root, 'resources/native', resource.path)), resource.sha256, resource.path);
for (const directory of ['cmaps', 'standard_fonts']) {
  const dependency = path.join(root, 'node_modules/pdfjs-dist', directory);
  for (const file of fs.readdirSync(dependency)) assert.equal(sha256(path.join(root, 'web/libs/pdfjs', directory, file)), sha256(path.join(dependency, file)), file);
}
for (const file of ['pdf.min.js', 'pdf.worker.min.js']) assert.equal(sha256(path.join(root, 'web/libs', file)), sha256(path.join(root, 'node_modules/pdfjs-dist/build', file)), file);
const tokenizers = JSON.parse(fs.readFileSync(path.join(root, 'resources/tokenizers-manifest.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'resources/ai-model-catalog.json'), 'utf8'));
assert.equal(catalog.schema_version, 1); assert.equal(catalog.models.length, 12);
evidence.aiModelCatalog = { version: catalog.catalog_version, verifiedAt: catalog.verified_at, sha256: sha256(path.join(root, 'resources/ai-model-catalog.json')), models: catalog.models.map(model => model.model_id) };
for (const resource of tokenizers.archives) for (const [file, hash] of Object.entries(resource.files)) assert.equal(sha256(path.join(root, 'resources/tokenizers', resource.id, file)), hash, resource.id + '/' + file);
fs.mkdirSync(path.join(root, 'docs/validation', version), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/validation', version, 'version-resources.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ version, pdfjs: evidence.pdfjs, resourceManifestHash: evidence.resourceManifestHash }));
if (process.argv.includes('--publication')) {
  const { sourceFingerprint, modes } = require('./validation-state.cjs');
  const fingerprint = sourceFingerprint();
  for (const mode of modes) {
    const result = JSON.parse(fs.readFileSync(path.join(root, 'docs/validation', version, mode.toLowerCase() + '-status.json'), 'utf8'));
    assert.equal(result.status, 'Passed', mode + ' 必要验收尚未通过');
    assert.equal(result.sourceFingerprint, fingerprint, mode + ' 验证记录与当前软件源码不同');
  }
  console.log('全部必要验收与当前软件源码一致，可以公开发布。');
}
