import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = path.join(workspace, 'docs', 'handover');
const inventory = JSON.parse(await readFile(path.join(evidenceDirectory, 'copy-manifest.json'), 'utf8'));
const baseline = new Map(inventory.manifest.map(entry => [entry.path.replaceAll('\\', '/'), entry]));
const gitOptions = { cwd: workspace, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
const files = execFileSync('git', ['ls-files', '-z'], gitOptions).split('\0').filter(Boolean);
const head = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim();
assert.equal(head, '07e10aaf0df835040c53edf27b3f418abb9b20bc');

for (const relativePath of files) {
  const expected = baseline.get(relativePath);
  assert(expected, `复制清单必须包含受 Git 管理的文件：${relativePath}`);
  const current = await readFile(path.join(workspace, relativePath));
  const original = await readFile(path.join(inventory.sourceRoot, relativePath));
  assert.equal(createHash('sha256').update(current).digest('hex'), expected.sha256, `工作区源码必须保持复制时的内容：${relativePath}`);
  assert.equal(createHash('sha256').update(original).digest('hex'), expected.sha256, `原目录源码必须保持复制时的内容：${relativePath}`);
}

const report = { verifiedAt: new Date().toISOString(), head, trackedFileCount: files.length, passed: true };
await writeFile(path.join(evidenceDirectory, 'source-integrity.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
