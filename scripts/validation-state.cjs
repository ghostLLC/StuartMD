const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const modes = ['Core', 'Browser', 'Native', 'Models', 'Providers', 'Installer'];

function sourceFingerprint() {
  const files = [];
  function collect(relative) {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isFile()) { files.push(relative.replaceAll('\\', '/')); return; }
    for (const entry of fs.readdirSync(absolute).sort()) collect(path.join(relative, entry));
  }
  for (const relative of ['web', 'samples', 'tauri/src-tauri/src', 'tauri/src-tauri/capabilities', 'tauri/src-tauri/Cargo.toml', 'tauri/src-tauri/Cargo.lock', 'tauri/src-tauri/tauri.conf.json', 'package.json', 'package-lock.json', 'rust-toolchain.toml', 'resources/models/manifest.json', 'resources/native-manifest.json', 'resources/tokenizers-manifest.json']) collect(relative);
  collect('resources/ai-model-catalog.json');
  const hash = crypto.createHash('sha256');
  for (const relative of files.sort()) { hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, relative))); hash.update('\0'); }
  return hash.digest('hex');
}

function record(action, mode) {
  if (!modes.includes(mode) || !['begin', 'pass', 'fail', 'skip'].includes(action)) throw new Error('验证状态参数无效');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const file = path.join(root, 'docs/validation', version, mode.toLowerCase() + '-status.json');
  const fingerprint = sourceFingerprint(), now = new Date().toISOString();
  const result = ['begin', 'skip'].includes(action) ? { schemaVersion: 1, mode, status: 'Running', sourceFingerprint: fingerprint, startedAt: now } : JSON.parse(fs.readFileSync(file, 'utf8'));
  if (action === 'skip') {
    result.status = 'SkippedByUser'; result.endedAt = now;
    result.reason = '用户禁止 computer use，并允许跳过依赖界面操作的检查。';
  } else if (action !== 'begin') {
    if (result.status !== 'Running') throw new Error('验证没有对应的实际运行记录');
    result.status = action === 'pass' && result.sourceFingerprint === fingerprint ? 'Passed' : 'Failed';
    result.endedAt = now;
    if (action === 'pass' && result.status !== 'Passed') result.error = '验证过程中软件源码发生变化';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  if (action === 'pass' && result.status !== 'Passed') throw new Error(result.error);
}

module.exports = { sourceFingerprint, modes };
if (require.main === module) record(process.argv[2], process.argv[3]);
