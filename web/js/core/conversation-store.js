(function (global) {
  "use strict";
  const copy = value => structuredClone(value);
  const keyOf = target => JSON.stringify([target.documentKey, target.workspaceKey]);

  function newDraft(target, scope = "document") {
    return { draftId: global.crypto.randomUUID(), target: copy(target), sessionId: null, question: "", scope,
      selection: null, readingAnchor: null, explicitSources: [], viewState: { tab: "chat", followLatest: true },
      draftVersion: 0, updatedAt: Date.now(), partialConfirmed: false, partialAcknowledgement: null };
  }

  class ConversationStore {
    constructor() {
      this.records = new Map(); this.aliases = new Map(); this.listeners = new Set(); this.currentKey = null; this.config = null;
    }
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("会话订阅需要有效函数");
      this.listeners.add(listener); listener(this.snapshot());
      return () => this.listeners.delete(listener);
    }
    snapshot() {
      const current = this.currentKey ? this.records.get(this.currentKey) : null;
      return copy(current ? { ...current, draftDirty: current.draftEdit !== current.savedEdit, references: current.draft.explicitSources, config: this.config } : {
        target: null, sessionId: null, sessionVersion: 0, messages: [], turns: [], activeRequest: null,
        draft: null, references: [], learningActions: [], config: this.config,
      });
    }
    emit() { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
    current() {
      if (!this.currentKey) throw new Error("请打开文档或选择工作区");
      return this.records.get(this.currentKey);
    }
    activate(target) {
      if (!target || (!target.documentKey && !target.workspaceKey)) throw new Error("会话目标缺少文档或工作区身份");
      const key = keyOf(target);
      if (!this.records.has(key)) this.records.set(key, { target: copy(target), sessionId: null, sessionVersion: 0,
        messages: [], turns: [], activeRequest: null, draft: newDraft(target, target.documentKey ? "document" : "workspace"),
        learningActions: [], loaded: false, sourceUpdated: false, draftEdit: 0, savedEdit: 0, draftConflict: null });
      const record = this.records.get(key); record.target = copy(target); record.draft.target = copy(target);
      this.currentKey = key; this.emit(); return this.snapshot();
    }
    deactivate() { this.currentKey = null; this.emit(); }
    setConfig(config) { this.config = copy(config); this.emit(); }
    updateDraft(patch) {
      const record = this.current(), previous = record.draft;
      if (patch.scope && !["selection", "section", "document", "workspace"].includes(patch.scope)) throw new Error("提问范围无效");
      record.draft = { ...previous, ...copy(patch), target: copy(record.target), updatedAt: Date.now() };
      if (patch.viewState) record.draft.viewState = { ...previous.viewState, ...copy(patch.viewState) };
      record.draftEdit++;
      this.emit(); return copy(record.draft);
    }
    acknowledgeDraft(saved, submittedEdit) {
      const key = keyOf(saved.target);
      let record = this.records.get(key);
      if (!record) {
        const original = [...this.records.entries()].find(([, value]) => value.draft.draftId === saved.draftId);
        if (original) {
          const [previousKey, value] = original;
          this.aliases.set(previousKey, key);
          this.records.delete(previousKey); this.records.set(key, value);
          if (this.currentKey === previousKey) this.currentKey = key;
          value.target = copy(saved.target); value.draft.target = copy(saved.target); record = value;
        }
      }
      if (!record || record.draft.draftId !== saved.draftId) return;
      if (saved.draftVersion < record.draft.draftVersion) throw new Error("草稿保存结果早于已确认版本");
      record.draft.draftVersion = saved.draftVersion;
      if (submittedEdit != null) record.savedEdit = submittedEdit;
      if (key === this.currentKey) this.emit();
    }
    referenceId(input) {
      if (input.inputId) return input.inputId;
      if (input.kind === "knowledge" && input.chunkId) return "knowledge:" + input.workspaceId + ":" + input.indexGeneration + ":" + input.chunkId;
      if (input.kind === "memory" && (input.recordId || input.memoryId)) return "memory:" + (input.recordId || input.memoryId) + ":" + input.version;
      if (input.kind === "message" && input.messageId) return "message:" + input.messageId;
      if (input.kind === "selection" && input.selection) return "selection:" + input.selection.documentId + ":" + input.selection.revision + ":" + input.selection.quote;
      throw new Error("引用缺少实际来源身份");
    }
    addReference(input) {
      const inputId = this.referenceId(input), refs = copy(this.current().draft.explicitSources);
      const index = refs.findIndex(ref => ref.inputId === inputId), value = { ...copy(input), inputId };
      if (index < 0) refs.push(value); else refs[index] = value;
      return this.updateDraft({ explicitSources: refs });
    }
    removeReference(inputId) { return this.updateDraft({ explicitSources: this.current().draft.explicitSources.filter(ref => ref.inputId !== inputId) }); }
    hydrate(data) {
      const record = this.current();
      if (data.draft?.draftId === record.draft.draftId && data.draft.draftVersion < record.draft.draftVersion) throw new Error("DraftVersionConflict：会话读取结果早于已经确认的草稿版本");
      if (data.session) {
        record.sessionId = data.session.sessionId; record.sessionVersion = data.session.sessionVersion;
      } else { record.sessionId = null; record.sessionVersion = 0; }
      if (!Array.isArray(data.messages) || !Array.isArray(data.turns)) throw new Error("会话响应缺少消息和问题列表");
      record.messages = copy(data.messages); record.turns = copy(data.turns);
      record.learningActions = copy(data.learningActions || []);
      if (data.draft) record.draft = { ...copy(data.draft), target: copy(record.target),
        explicitSources: copy(data.draft.explicitSources || []), viewState: copy(data.draft.viewState || { tab: "chat", followLatest: true }) };
      record.draftEdit = 0; record.savedEdit = 0; record.draftConflict = null;
      record.loaded = true; record.nextCursor = data.nextCursor || null; this.emit();
    }
    resolveKey(target) {
      let key = keyOf(target); const seen = new Set();
      while (this.aliases.has(key)) {
        if (seen.has(key)) throw new Error("文档身份迁移存在循环关联");
        seen.add(key); key = this.aliases.get(key);
      }
      return key;
    }
    setRequest(request, target = this.current().target) {
      const key = this.resolveKey(target), record = this.records.get(key);
      if (!record) throw new Error("请求所属会话尚未建立");
      record.activeRequest = request ? copy(request) : null;
      if (request?.sessionId) record.sessionId = request.sessionId;
      if (request?.sessionVersion) record.sessionVersion = request.sessionVersion;
      if (key === this.currentKey) this.emit();
    }
    markSourceUpdated() { this.current().sourceUpdated = true; this.emit(); }
    setDraftConflict(remote, target = this.current().target) {
      const record = this.records.get(this.resolveKey(target));
      if (!record) throw new Error("草稿冲突所属目标不存在");
      record.draftConflict = copy(remote); this.emit();
    }
    addLearningAction(action, target) {
      const key = this.resolveKey(target), record = this.records.get(key);
      if (!record) throw new Error("记忆操作所属会话不存在");
      const index = record.learningActions.findIndex(item => item.requestId === action.requestId);
      if (index < 0) record.learningActions.push(copy(action)); else record.learningActions[index] = copy(action);
      if (key === this.currentKey) this.emit();
    }
    reset() {
      const record = this.current(), scope = record.draft.scope;
      record.sessionId = null; record.sessionVersion = 0; record.messages = []; record.turns = [];
      record.activeRequest = null; record.learningActions = []; record.draft = newDraft(record.target, scope); record.loaded = true;
      record.draftEdit = 0; record.savedEdit = 0; record.draftConflict = null;
      this.emit(); return copy(record.draft);
    }
    deleted(sessionId) {
      for (const record of this.records.values()) if (record.sessionId === sessionId) {
        const draft = newDraft(record.target, record.draft.scope);
        record.draft = { ...draft, question: record.draft.question, selection: record.draft.selection,
          explicitSources: copy(record.draft.explicitSources), readingAnchor: record.draft.readingAnchor, viewState: copy(record.draft.viewState) };
        record.sessionId = null; record.sessionVersion = 0; record.messages = []; record.turns = [];
        record.activeRequest = null; record.learningActions = [];
      }
      this.emit();
    }
  }
  global.StuartCore = global.StuartCore || {};
  global.StuartCore.ConversationStore = ConversationStore;
  if (typeof module === "object") module.exports = { ConversationStore };
})(typeof window !== "undefined" ? window : globalThis);
