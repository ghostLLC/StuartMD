const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DocumentSession } = require('../web/js/core/document-session.js');

test('同一个文件的窗口分别拥有文档身份和编辑版本', () => {
  const a = new DocumentSession({ path: 'C:/资料.md', content: '原文' });
  const b = new DocumentSession({ path: 'C:/资料.md', content: '原文' });
  assert.notEqual(a.documentId, b.documentId);
  a.updateEditor('修改');
  assert.equal(b.source, '原文');
  assert.equal(a.revision, 1);
});

test('旧保存完成不能清除新编辑', () => {
  const document = new DocumentSession({ content: '原文' });
  document.updateEditor('第一版');
  const snapshot = document.snapshot();
  document.updateEditor('第二版');
  document.confirmSave({ savedEditorRevision: snapshot.revision, diskRevision: { rawByteSha256: 'confirmed' } }, snapshot.source);
  assert.equal(document.dirty, true);
  assert.equal(document.persistedSource, '第一版');
});

test('渲染确认只接受对应文档版本和epoch', () => {
  const document = new DocumentSession({ content: '原文' });
  const render = document.beginRender('preview', 'light', 0);
  document.updateEditor('修改');
  assert.equal(document.confirmRender(render), false);
  assert.equal(document.renderRevision, -1);
  const current = document.beginRender('preview', 'light', 0);
  assert.equal(document.confirmRender(current), true);
  assert.equal(document.renderRevision, 1);
});

test('保存快照冻结磁盘版本和编辑操作', () => {
  const diskRevision = { exists: true, rawByteSha256: 'original', size: 2, modifiedAt: 1 };
  const document = new DocumentSession({ documentId: crypto.randomUUID(), content: '原文', diskRevision });
  document.updateEditor('修改原文');
  const snapshot = document.snapshot();
  diskRevision.rawByteSha256 = 'changed';
  assert.equal(snapshot.diskRevision.rawByteSha256, 'original');
  assert.equal(Object.isFrozen(snapshot.diskRevision), true);
  assert.equal(Object.isFrozen(snapshot.sourceEdits), true);
  assert.equal(Object.isFrozen(snapshot.sourceEdits[0]), true);
});

test('恢复正文保留草稿版本和原文件保存版本', () => {
  const document = new DocumentSession({ documentId: crypto.randomUUID(), title: '恢复草稿', source: '', baseSource: '原文', revision: 2, persistedRevision: 0 });
  assert.equal(document.source, '');
  assert.equal(document.dirty, true);
  assert.equal(document.title, '恢复草稿');
});
