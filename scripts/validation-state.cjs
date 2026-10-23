const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
  collect('tauri/src-tauri/windows');
  const hash = crypto.createHash('sha256');
  for (const relative of files.sort()) { hash.update(relative); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, relative))); hash.update('\0'); }
  return hash.digest('hex');
}

function verificationFingerprint() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'scripts', 'tests'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    if (!fs.existsSync(path.join(root, file))) continue;
    hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, file))); hash.update('\0');
  }
  return hash.digest('hex');
}

function validatePublication(records, fingerprints, policy) {
  assert.equal(policy.schemaVersion, 1, '发布规则版本无效');
  assert.equal(records.length, modes.length, '验收记录数量不完整');
  for (const mode of modes) {
    const matching = records.filter(record => record.mode === mode);
    assert.equal(matching.length, 1, mode + ' 验收记录缺失或重复');
    const record = matching[0];
    assert.equal(record.sourceFingerprint, fingerprints.sourceFingerprint, mode + ' 软件源码指纹不同');
    assert.equal(record.verificationFingerprint, fingerprints.verificationFingerprint, mode + ' 检查程序指纹不同');
    assert.ok(record.startedAt && record.endedAt, mode + ' 验收时间缺失');
    if (record.status === 'SkippedByUser') {
      const authorization = policy.authorizedSkips.find(item => item.mode === mode);
      assert.ok(authorization?.reason && authorization?.authorizedAt && authorization?.scope, mode + ' 缺少跳过授权');
      assert.deepEqual(record.authorization, authorization, mode + ' 跳过授权与当前规则不同');
      assert.equal(record.reason, authorization.reason, mode + ' 跳过原因不一致');
    } else {
      assert.equal(record.status, 'Passed', mode + ' 必要验收尚未通过');
    }
  }
}

function record(action, mode) {
  if (!modes.includes(mode) || !['begin', 'pass', 'fail', 'skip'].includes(action)) throw new Error('验证状态参数无效');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const file = path.join(root, 'docs/validation', version, mode.toLowerCase() + '-status.json');
  const fingerprint = sourceFingerprint(), verification = verificationFingerprint(), now = new Date().toISOString();
  const result = ['begin', 'skip'].includes(action) ? { schemaVersion: 2, mode, status: 'Running', sourceFingerprint: fingerprint, verificationFingerprint: verification, startedAt: now } : JSON.parse(fs.readFileSync(file, 'utf8'));
  if (action === 'skip') {
    const policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-policy.json'), 'utf8'));
    const authorization = policy.authorizedSkips.find(item => item.mode === mode);
    if (!authorization?.reason || !authorization?.authorizedAt || !authorization?.scope) throw new Error(mode + ' 没有用户跳过授权');
    result.status = 'SkippedByUser'; result.endedAt = now;
    result.reason = authorization.reason;
    result.authorization = authorization;
  } else if (action !== 'begin') {
    if (result.status !== 'Running') throw new Error('验证没有对应的实际运行记录');
    result.status = action === 'pass' && result.sourceFingerprint === fingerprint && result.verificationFingerprint === verification ? 'Passed' : 'Failed';
    result.endedAt = now;
    if (action === 'pass' && result.status !== 'Passed') result.error = '验证过程中软件源码或检查程序发生变化';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  if (action === 'pass' && result.status !== 'Passed') throw new Error(result.error);
}

module.exports = { sourceFingerprint, verificationFingerprint, validatePublication, modes };
if (require.main === module) record(process.argv[2], process.argv[3]);
