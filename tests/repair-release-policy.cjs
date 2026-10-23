const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { sourceFingerprint, verificationFingerprint, validatePublication, modes } = require('../scripts/validation-state.cjs');
const policy = require('../scripts/release-policy.json');

test('当前验收程序拥有可重复计算的独立指纹', () => {
  assert.match(verificationFingerprint(), /^[a-f0-9]{64}$/);
  assert.equal(verificationFingerprint(), verificationFingerprint());
  assert.notEqual(verificationFingerprint(), sourceFingerprint());
});

test('历史发布记录无法作为当前源码和检查程序的验收', () => {
  const records = modes.map(mode => JSON.parse(fs.readFileSync(`docs/validation/3.5.20/${mode.toLowerCase()}-status.json`, 'utf8')));
  assert.throws(() => validatePublication(records, { sourceFingerprint: sourceFingerprint(), verificationFingerprint: verificationFingerprint() }, policy), /指纹/);
});

test('界面豁免仅覆盖用户授权的两种模式', () => {
  assert.deepEqual(policy.authorizedSkips.map(item => item.mode).sort(), ['Browser', 'Native']);
  for (const authorization of policy.authorizedSkips) {
    assert.ok(authorization.reason.includes('用户'));
    assert.ok(authorization.authorizedAt);
  }
});

test('没有跳过授权的 Core 命令拒绝执行并保留实际验收记录', () => {
  const { spawnSync } = require('node:child_process');
  const version = require('../package.json').version;
  const file = `docs/validation/${version}/core-status.json`;
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const result = spawnSync(process.execPath, ['scripts/validation-state.cjs', 'skip', 'Core'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /没有用户跳过授权/);
  if (before) assert.deepEqual(fs.readFileSync(file), before);
  else assert.equal(fs.existsSync(file), false);
});
