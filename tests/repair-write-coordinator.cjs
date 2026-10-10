const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
require('../web/js/core/write-coord.js');

test('实际文件写入失败后，同一路径的后续写入可以完成', async t => {
  const coordinator = globalThis.StuartCore.writeCoord;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stuart-write-'));
  const parent = path.join(directory, 'parent');
  const target = path.join(parent, 'document.md');
  await fs.writeFile(parent, '父路径为文件');
  await assert.rejects(coordinator.enqueue(target, () => fs.writeFile(target, '写入正文')), error => ['ENOTDIR', 'ENOENT'].includes(error.code));
  await fs.unlink(parent); await fs.mkdir(parent);
  await coordinator.enqueue(target, () => fs.writeFile(target, '实际保存的正文'));
  assert.equal(await fs.readFile(target, 'utf8'), '实际保存的正文');
  t.after(async () => { await fs.unlink(target); await fs.rmdir(parent); await fs.rmdir(directory); });
});

test('Windows大小写路径别名依次执行实际文件写入', async t => {
  const coordinator = globalThis.StuartCore.writeCoord;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stuart-alias-'));
  const target = path.join(directory, 'Document.md');
  const events = [];
  const first = coordinator.enqueue(target, async () => {
    events.push('first-start');
    await fs.writeFile(target, '第一段正文');
    events.push('first-end');
  });
  const alias = target.toLowerCase().replace(/\\/g, '/');
  const second = coordinator.enqueue(alias, async () => { assert.equal(await fs.readFile(alias, 'utf8'), '第一段正文'); await fs.writeFile(alias, '第二段正文'); events.push('second'); });
  await Promise.all([first, second]);
  assert.equal(await fs.readFile(target, 'utf8'), '第二段正文');
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  t.after(async () => { await fs.unlink(target); await fs.rmdir(directory); });
});
