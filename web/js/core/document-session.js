(function (global) {
  "use strict";
  const TextBuffer = typeof module === "object" ? require("./text-buffer.js").TextBuffer : global.StuartCore.TextBuffer;
  class DocumentSession {
    constructor(record = {}) {
      this.documentId = record.documentId || global.crypto.randomUUID();
      this.kind = record.kind || "markdown";
      this.path = record.path || null;
      this.title = record.title || record.name || "未命名.md";
      this.encoding = record.encoding || "UTF-8";
      this.bom = !!record.bom;
      this.accessState = record.accessState || "Editable";
      this.diskRevision = record.diskRevision || { exists: false, rawByteSha256: "", size: 0, modifiedAt: 0 };
      this.buffer = new TextBuffer(record.source ?? record.content ?? "", record.defaultSeparator);
      this.persistedSource = record.baseSource ?? this.buffer.source;
      this.revision = record.revision || 0;
      this.persistedRevision = record.persistedRevision ?? this.revision;
      this.journalRevision = record.journalRevision ?? (record.baseSource !== undefined ? this.revision : this.persistedRevision);
      this.renderRevision = -1;
      this.renderEpoch = 0;
      this.selection = null;
      this.sessionId = null;
      this.conflict = null;
    }
    get source() { return this.buffer.source; }
    get dirty() { return this.revision !== this.persistedRevision; }
    updateEditor(text) {
      if (this.accessState !== "Editable") throw new Error("请确认文件编码后编辑");
      const edits = this.buffer.updateEditor(text);
      if (edits.length) { this.revision++; this.selection = null; this.renderEpoch++; }
      return edits;
    }
    updateSource(text) {
      if (this.accessState !== "Editable") throw new Error("请确认文件编码后编辑");
      if (text !== this.source) { this.buffer = new TextBuffer(text, this.buffer.defaultSeparator); this.revision++; this.selection = null; this.renderEpoch++; }
    }
    snapshot() {
      return Object.freeze({ documentId: this.documentId, revision: this.revision, source: this.source, path: this.path, title: this.title,
        encoding: this.encoding, bom: this.bom, defaultSeparator: this.buffer.defaultSeparator, persistedSource: this.persistedSource,
        diskRevision: Object.freeze({ ...this.diskRevision }), sourceEdits: Object.freeze(this.buffer.editsFrom(this.persistedSource).map(edit => Object.freeze(edit))) });
    }
    confirmSave(result, source) {
      if (result.documentId && result.documentId !== this.documentId) throw new Error("保存结果与文档身份不一致");
      if (result.savedEditorRevision > this.revision) throw new Error("保存结果超出当前编辑版本");
      if (result.result === "Conflict") { this.conflict = result.conflict; return; }
      if (result.savedEditorRevision < this.persistedRevision) throw new Error("保存结果早于已经确认的保存版本");
      this.persistedRevision = result.savedEditorRevision;
      this.persistedSource = source;
      this.diskRevision = result.diskRevision;
      this.conflict = null;
    }
    beginRender(mode, theme, fontRevision) {
      return Object.freeze({ documentId: this.documentId, revision: this.revision, epoch: ++this.renderEpoch, mode, theme, fontRevision });
    }
    confirmRender(render) {
      if (render.documentId !== this.documentId || render.revision !== this.revision || render.epoch !== this.renderEpoch) return false;
      this.renderRevision = render.revision;
      return true;
    }
  }
  global.StuartCore = global.StuartCore || {};
  global.StuartCore.DocumentSession = DocumentSession;
  if (typeof module === "object") module.exports = { DocumentSession };
})(typeof window !== "undefined" ? window : globalThis);
