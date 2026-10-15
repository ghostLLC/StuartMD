(function (global) {
  "use strict";
  const store = new global.StuartCore.ConversationStore(), events = new Map();
  const api = () => global.pywebview.api;
  let document = null, documentStamp = null, selectedScope = "document", active = null, starting = false, binding = null, transition = Promise.resolve();
  let eventQueue = Promise.resolve(), draftQueue = Promise.resolve(), draftTimer = null, workspaceRoot = null;
  function emit(type, payload) { for (const listener of events.get(type) || []) listener(payload); }
  function snapshot() {
    const value = store.snapshot(), metadata = document && value.target?.documentKey ? { documentId: document.documentId, documentKey: value.target?.documentKey,
      name: document.title || document.name, path: document.path, revision: document.revision, kind: document.kind } : null;
    return { ...value, document: metadata, meta: metadata, busy: starting || !!active };
  }
  store.subscribe(() => emit("change", snapshot()));
  global.addEventListener("stuart-ai-config", event => { store.setConfig(event.detail.ai); emit("config", event.detail.ai); });
  function on(type, listener) {
    if (!events.has(type)) events.set(type, new Set());
    events.get(type).add(listener); if (type === "change") listener(snapshot());
    return () => events.get(type).delete(listener);
  }
  const report = error => global.StuartMD.toast(error.message || String(error));
  async function digest(text) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async function bind() {
    if (!binding) binding = Promise.all([
      api().listen_event("ai-request-event", event => {
        const consume = () => consumeEvent(event.payload);
        eventQueue = eventQueue.then(consume, consume).catch(failEvent);
      }),
      api().listen_event("ai-config-changed", async () => {
        const config = await global.StuartAI.ensureConfig(true); store.setConfig(config);
        if (!config.enabled) await cancel(); emit("config", config);
      }),
      api().listen_event("sessionDeleted", event => {
        if (active?.sessionId === event.payload.sessionId) active.deleted = true;
        store.deleted(event.payload.sessionId); emit("document", { documentId: document?.documentId, messages: snapshot().messages });
      }),
      api().listen_event("conversationChanged", event => {
        if (event.payload.sessionId === snapshot().sessionId && !active) refresh().catch(report);
      }),
      api().listen_event("memoryChanged", event => emit("memory", event.payload)),
      api().listen_event("draftChanged", event => {
        const reconcile = async () => {
          const value = store.snapshot();
          if (!value.draft || value.draft.draftId !== event.payload.draftId || value.draft.draftVersion >= event.payload.draftVersion) return;
          const remote = await api().companion_get_conversation(null, null, value.target);
          if (store.snapshot().draft?.draftId !== value.draft.draftId) return;
          if (store.snapshot().draftDirty) store.setDraftConflict(remote, value.target);
          else await refresh(remote.session?.sessionId || null);
        };
        draftQueue.then(reconcile, reconcile).catch(report);
      }),
      api().listen_event("learningChanged", event => {
        const action = event.payload, key = store.resolveKey(action.target);
        if (store.records.get(key)?.sessionId === action.sessionId) store.addLearningAction({ ...action, mode: "automatic" }, action.target);
        emit("memory", action);
      }),
    ]);
    await binding;
  }
  async function flushDraft() {
    clearTimeout(draftTimer); draftTimer = null;
    const value = store.snapshot();
    if (!value.target || !value.draft || !value.loaded) return;
    const key = JSON.stringify([value.target.documentKey, value.target.workspaceKey]), draftId = value.draft.draftId;
    const save = async () => {
      const record = store.records.get(key);
      if (!record || record.draft.draftId !== draftId) return;
      if (record.draftConflict) throw new Error("其他窗口已经修改草稿，请处理草稿冲突后继续");
      if (record.draft.draftVersion > 0 && record.draftEdit === record.savedEdit) return;
      const draft = structuredClone(record.draft), submittedEdit = record.draftEdit;
      try { store.acknowledgeDraft(await api().companion_save_draft(draft, draft.draftVersion), submittedEdit); }
      catch (error) {
        if (String(error.message || error).includes("DraftVersionConflict")) store.setDraftConflict(await api().companion_get_conversation(null, null, record.target), record.target);
        throw error;
      }
    };
    draftQueue = draftQueue.then(save, save); await draftQueue;
  }
  function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => flushDraft().catch(report), 300); }
  function updateDraft(patch) {
    if (patch.scope && (patch.scope === "workspace") !== !store.snapshot().target?.documentKey) {
      const run = async () => { await activate(document, workspaceRoot, patch.scope); const result = store.updateDraft(patch); scheduleDraft(); return result; };
      transition = transition.then(run, run); transition.catch(report); return transition;
    }
    if (patch.scope) selectedScope = patch.scope;
    const result = store.updateDraft(patch); scheduleDraft(); return result;
  }
  function addReference(input) {
    if (input.kind === "selection") input = { ...input, selection: normalizeSelection(input.selection, global.StuartMD.getDocument()) };
    const result = store.addReference(input); scheduleDraft(); return result;
  }
  function removeReference(inputId) { const result = store.removeReference(inputId); scheduleDraft(); return result; }
  async function refresh(sessionId = snapshot().sessionId) {
    const target = store.snapshot().target; if (!target) return;
    if (store.snapshot().draftConflict) return;
    const result = await api().companion_get_conversation(sessionId, null, target);
    let cursor = result.nextCursor;
    while (cursor) {
      const page = await api().companion_get_conversation(result.session.sessionId, cursor, target);
      result.messages.push(...page.messages); result.turns.push(...page.turns); cursor = page.nextCursor;
      if (JSON.stringify(store.snapshot().target) !== JSON.stringify(target)) return;
    }
    result.nextCursor = null;
    if (JSON.stringify(store.snapshot().target) !== JSON.stringify(target)) return;
    const local = store.snapshot(), currentDraft = local.draft;
    const acceptedOwnDraft = active?.intent.draftId === currentDraft?.draftId && result.draft?.draftId === currentDraft?.draftId && result.draft.draftVersion === active.intent.draftVersion + 1;
    if (local.draftDirty && result.draft && !acceptedOwnDraft && (result.draft.draftId !== currentDraft.draftId || result.draft.draftVersion > currentDraft.draftVersion)) {
      store.setDraftConflict(result, target); return;
    }
    store.hydrate(result);
    if (currentDraft && result.draft && currentDraft.draftId === result.draft.draftId && currentDraft.updatedAt > result.draft.updatedAt) {
      const { draftId, target: ignoredTarget, sessionId: ignoredSession, draftVersion: ignoredVersion, ...unsent } = currentDraft;
      store.updateDraft(unsent);
    }
    emit("document", { documentId: document?.documentId, messages: snapshot().messages });
  }
  async function activate(next, root, scope = selectedScope) {
    await bind();
    const previous = store.snapshot(), nextId = next?.documentId || null;
    const identityChanged = nextId !== documentStamp?.documentId || root !== workspaceRoot || next?.path !== documentStamp?.path || (scope === "workspace") !== (selectedScope === "workspace");
    if (identityChanged) { await flushDraft(); await cancel(); }
    const revisionChanged = next?.revision !== documentStamp?.revision;
    document = next; documentStamp = next ? { documentId: nextId, path: next.path, revision: next.revision } : null; workspaceRoot = root;
    selectedScope = nextId ? scope : "workspace";
    if (!nextId && !root) { store.deactivate(); return; }
    const target = await api().companion_get_target(selectedScope === "workspace" ? null : nextId, root);
    if (!identityChanged && previous.target?.documentKey === target.documentKey && previous.target?.workspaceKey === target.workspaceKey) {
      if (revisionChanged && active) store.markSourceUpdated(); emit("change", snapshot()); return;
    }
    const current = store.activate(target);
    let hydrated = null;
    if (!current.loaded) { hydrated = await api().companion_get_conversation(null, null, target); store.hydrate(hydrated); if (hydrated.nextCursor) await refresh(hydrated.session.sessionId); }
    else if (identityChanged) await refresh(current.sessionId);
    const cfg = await global.StuartAI.ensureConfig(); store.setConfig(cfg);
    if (hydrated && !hydrated.draft) store.updateDraft({ scope: target.documentKey ? (scope === "workspace" ? cfg.context_scope : scope) : "workspace" });
    selectedScope = store.snapshot().draft.scope;
    emit("document", { documentId: nextId, messages: snapshot().messages });
  }
  function setDocument(next) {
    const root = global.StuartMD?.state?.workspaceRoot || null;
    const run = async () => activate(next, root, next?.documentId !== documentStamp?.documentId ? (await global.StuartAI.ensureConfig()).context_scope : selectedScope);
    transition = transition.then(run, run); transition.catch(report); return transition;
  }
  function setWorkspace(root) {
    const run = () => activate(document, root || null);
    transition = transition.then(run, run); transition.catch(report); return transition;
  }
  function wireSources(refs) {
    return refs.map(ref => ({ inputId: ref.inputId, kind: ref.kind, selection: ref.selection || null,
      chunkId: ref.chunkId || null, workspaceId: ref.workspaceId || null, indexGeneration: ref.indexGeneration || null,
      indexStatus: ref.indexStatus || null, rrfScore: ref.rrfScore || 0, partialConfirmed: !!ref.partialConfirmed,
      coverageHash: ref.coverageHash || null,
      memoryId: ref.memoryId || null, recordId: ref.recordId || null, version: ref.version || null,
      messageId: ref.messageId || null, requestId: ref.requestId || null }));
  }
  function normalizeSelection(selection, captured) {
    if (!captured) throw new Error("选区所属文档不存在");
    if (selection.documentId && selection.documentId !== captured.documentId || selection.revision != null && selection.revision !== captured.revision) throw new Error("选区所属文档或正文版本已经变化");
    let from = selection.from ?? null, to = selection.to ?? null, quote = String(selection.quote ?? selection.text ?? "");
    if (captured.kind === "markdown" && !selection.inPreview && selection.start != null && selection.end != null) {
      ({ from, to } = global.StuartMD.sourceSelectionRange(selection.start, selection.end));
      quote = captured.content.replace(/\r\n|\r/g, "\n").slice(from, to);
    }
    return { documentId: captured.documentId, revision: captured.revision, kind: captured.kind, quote,
      from, to, blockIndex: selection.blockIndex ?? null, page: selection.page ?? null,
      rects: captured.kind === "pdf" ? selection.pdfRects || selection.rects || [] : [],
      segments: captured.kind === "pdf" ? selection.segments || [] : [],
      fileFingerprint: captured.kind === "pdf" ? captured.diskRevision.rawByteSha256 : null };
  }
  async function capture(options = {}) {
    await transition;
    const value = store.snapshot(); if (!value.target) throw new Error("请打开文档或选择工作区");
    const captured = value.target.runtimeDocumentId ? global.StuartMD.getDocument() : null;
    if (captured && captured.documentId !== value.target.runtimeDocumentId) throw new Error("当前文档已经切换，请重新发送问题");
    const hash = captured ? captured.kind === "pdf" ? captured.diskRevision.rawByteSha256 : await digest(captured.content) : "";
    let selection = (options.scope || value.draft.scope) !== "selection" ? null : options.selection === null ? null : options.selection ?? value.draft.selection;
    if (selection?.text || selection?.quote) {
      selection = normalizeSelection(selection, captured);
    }
    let readingAnchor = null;
    if (captured && (options.scope || value.draft.scope) === "section") readingAnchor = { ...global.StuartMD.getReadingAnchor(), sourceHash: hash };
    return { captured, hash, selection, readingAnchor, value };
  }
  async function intentFor(question, options = {}) {
    const cfg = await global.StuartAI.ensureConfig(true); store.setConfig(cfg);
    const captured = await capture(options), value = captured.value;
    return { requestId: options.requestId || crypto.randomUUID(), turnId: options.turnId || null,
      sessionId: value.sessionId, expectedSessionVersion: value.sessionVersion, draftId: value.draft.draftId, draftVersion: value.draft.draftVersion,
      target: value.target, question, scope: options.scope || value.draft.scope,
      selection: captured.selection, readingAnchor: captured.readingAnchor,
      explicitSources: wireSources(options.explicitSources || value.draft.explicitSources),
      settingsRevision: global.StuartAI.state.settingsRevision, editorRevision: captured.captured?.revision || 0, sourceHash: captured.hash };
  }
  async function sendQuestion(question, options = {}) {
    if (starting || active) throw new Error("请等待当前回答结束，或者停止当前回答");
    if (!String(question).trim()) throw new Error("请输入问题");
    starting = true; emit("change", snapshot());
    let request = null;
    try {
    await transition; await bind();
    if (options.scope) await updateDraft({ scope: options.scope });
    if (Object.hasOwn(options, "selection")) updateDraft({ selection: options.selection });
    const submittedTarget = JSON.stringify(store.snapshot().target);
    await global.StuartMD.flushDraftJournal(); await flushDraft();
    const intent = await intentFor(String(question), options), cfg = structuredClone(global.StuartAI.config);
    if (JSON.stringify(intent.target) !== submittedTarget) throw new Error("提问目标已经变化，请检查当前材料");
    if (!cfg.enabled) throw new Error("请在设置中启用 AI");
    request = { requestId: intent.requestId, target: intent.target, documentId: intent.target.runtimeDocumentId,
      sessionId: intent.sessionId, seq: 0, text: "", accepted: false, pendingEvents: [], handlers: options.handlers,
      intent, config: cfg, finishing: false };
    request.completion = new Promise(resolve => { request.resolve = resolve; }); active = request;
    request.acceptance = api().companion_send_question(intent);
      const result = await request.acceptance;
      if (!result.ok || !result.sessionId || !result.turnId) throw new Error("问题接受结果缺少实际会话或问题身份");
      request.sessionId = result.sessionId; request.turnId = result.turnId; request.accepted = true;
      await refresh(result.sessionId);
      store.setRequest({ requestId: request.requestId, turnId: request.turnId, sessionId: request.sessionId,
        sessionVersion: result.sessionVersion, status: "Preparing", phase: "PreparingSources", text: "", seq: 0 }, request.target);
      emit("start", { ...result, documentId: request.documentId });
      const drain = async () => {
        for (const event of request.pendingEvents.splice(0)) await consumeEvent(event);
        if (active === request) { const actual = await api().ai_chat_status(request.requestId); if (actual.seq > request.seq) await consumeEvent(actual); }
      };
      eventQueue = eventQueue.then(drain, drain); await eventQueue;
      return { ok: true, requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId };
    } catch (error) {
      if (request && active === request) { active = null; store.setRequest(null, request.target); request.resolve({ ok: false, status: "Failed", error: error.message }); }
      throw error;
    } finally { starting = false; emit("change", snapshot()); }
  }
  async function consumeEvent(payload) {
    const request = active; if (!request || payload.requestId !== request.requestId) return;
    if (!request.accepted) { request.pendingEvents.push(payload); return; }
    if (payload.sessionId !== request.sessionId || payload.documentId !== request.documentId || payload.turnId !== request.turnId || payload.windowId !== request.target.windowId) throw new Error("请求事件的问题、会话、文档或窗口身份不一致");
    if (payload.seq <= request.seq) return;
    if (payload.type === "delta") {
      if (payload.seq !== request.seq + 1) {
        const actual = await api().ai_chat_status(request.requestId);
        if (actual.seq < payload.seq) throw new Error("请求事件顺序无法核对");
        return consumeEvent(actual);
      }
      request.text += payload.text;
    } else if (["phase", "snapshot", "done"].includes(payload.type)) request.text = payload.text;
    else throw new Error("请求事件类型无效");
    request.seq = payload.seq; store.setRequest({ ...payload, text: request.text }, request.target);
    if (payload.type === "done") {
      if (payload.finalHash !== await digest(payload.text)) throw new Error("最终回答内容校验失败");
      await finish(request, payload); return;
    }
    emit(payload.type === "delta" ? "delta" : "phase", { ...payload, text: request.text, full: true });
    if (payload.type === "delta") await request.handlers?.onDelta?.({ ...payload, text: request.text, full: true });
  }
  async function finish(request, payload) {
    if (request.finishing) return;
    request.finishing = true;
    const result = { ...payload, ok: payload.status === "Completed" };
    try {
      if (!request.deleted && JSON.stringify(snapshot().target) === JSON.stringify(request.target)) await refresh(request.sessionId);
    } catch (error) {
      if (!request.deleted) { result.archiveError = error.message; report(error); }
    } finally {
      if (active === request) active = null; store.setRequest(null, request.target);
      request.resolve(result);
    }
    if (result.ok && !request.deleted) {
      result.memory = { ask: request.config.learning_policy === "ask", mode: request.config.learning_policy };
      if (result.memory.ask) store.addLearningAction({ requestId: request.requestId, status: "Available", ...result.memory }, request.target);
    }
    emit("done", result); await request.handlers?.onDone?.(result);
  }
  async function terminalSnapshot(request) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await api().ai_chat_status(request.requestId);
      if (result.type === "done") return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("请求停止结果尚未确认");
  }
  async function cancel() {
    const request = active; if (!request) return;
    if (!request.accepted) { await request.acceptance; if (active !== request) return; }
    await api().ai_chat_cancel(request.requestId);
    const terminal = await terminalSnapshot(request), consume = () => consumeEvent(terminal);
    eventQueue = eventQueue.then(consume, consume); await eventQueue; await request.completion;
  }
  async function failEvent(error) {
    const request = active; report(error); if (!request || !request.accepted) return;
    await api().ai_chat_cancel(request.requestId);
    const actual = await terminalSnapshot(request);
    if (actual.finalHash !== await digest(actual.text)) throw new Error("请求终态无法核验");
    await finish(request, { ...actual, eventError: error.message });
  }
  async function send(options) {
    const question = options.question || options.messages?.findLast(message => message.role === "user")?.content;
    const refs = options.knowledgeSources?.map(ref => ({ ...ref, kind: "knowledge", inputId: "knowledge:" + ref.chunkId }));
    return sendQuestion(question, { ...options, explicitSources: refs || options.explicitSources });
  }
  async function explainSelection(options = {}, handlers) {
    const selection = { ...global.StuartMD.getSelectionInfo(), ...options }, quote = String(selection.quote ?? selection.text ?? "");
    if (!quote.trim()) throw new Error("请选择需要解释的正文");
    const captured = global.StuartMD.getDocument();
    const result = await sendQuestion("请解释选中内容的含义、关键概念和需要注意的疑点。", { scope: "selection", selection, handlers });
    return { ...result, quote, meta: { kind: captured.kind, name: captured.name, page: selection.page } };
  }
  async function reset() { await transition; await flushDraft(); await cancel(); store.reset(); await flushDraft(); }
  async function restoreSession(sessionId) {
    await flushDraft(); await cancel();
    const restored = await api().session_open_document(sessionId);
    await global.StuartMD.restoreCompanionDocument(restored); await transition;
    if (restored.kind === "workspace") await updateDraft({ scope: "workspace" });
    else { await activate(global.StuartMD.getDocument(), restored.session.workspaceRoot || null, "document"); await api().session_rebind(sessionId, document.documentId); }
    await refresh(sessionId); emit("restored", snapshot());
  }
  async function deleteSession(sessionId, sessionVersion, deleteLinkedMemories = false) {
    await flushDraft();
    if (active?.sessionId === sessionId) { await cancel(); const actual = await api().companion_get_conversation(sessionId, null, snapshot().target); sessionVersion = actual.session.sessionVersion; }
    await api().companion_delete_session(sessionId, sessionVersion, deleteLinkedMemories);
    store.deleted(sessionId); await flushDraft(); emit("history", { sessionId });
  }
  async function rememberMessage(messageId, content) {
    const value = snapshot(), message = value.messages.find(item => item.messageId === messageId);
    if (!message || message.role !== "assistant" || message.completionStatus !== "Completed") throw new Error("需要已保存的完整回答");
    const body = String(content ?? message.content);
    if (!body.trim() || Array.from(body).length > 800) throw new Error("请选择答案中需要保留的段落，记忆正文最多 800 个字符");
    if (!message.content.includes(body)) throw new Error("记忆摘录与实际回答不一致");
    return api().companion_create_memory_proposal({ content: body, category: "concept",
      scope: value.target.documentKey ? "document" : "workspace", workspaceKey: value.target.workspaceKey,
      documentKey: value.target.documentKey, preferenceKey: null, pinned: false,
      sourceMessageId: message.messageId, sourceRequestId: message.requestId, sourceAnchor: message.sourceAnchor });
  }
  async function resolveDraftConflict(choice) {
    await transition;
    const value = store.snapshot(); if (!value.draftConflict) return;
    if (choice === "remote") store.hydrate(await api().companion_get_conversation(null, null, value.target));
    else if (choice === "independent") {
      const { question, scope, selection, readingAnchor, explicitSources, viewState, partialConfirmed, partialAcknowledgement } = value.draft;
      store.reset(); store.updateDraft({ question, scope, selection, readingAnchor, explicitSources, viewState, partialConfirmed, partialAcknowledgement });
      await flushDraft();
    } else throw new Error("草稿冲突处理方式无效");
  }
  global.StuartAIService = { on, send, sendQuestion, explainSelection,
    followUp: (question, handlers, options = {}) => sendQuestion(question, { ...options, handlers }),
    cancel, reset, setDocument, setWorkspace, flushDraft: async () => { await transition; return flushDraft(); }, updateDraft, addReference, removeReference, refresh,
    restoreSession, rememberMessage, deleteSession, resolveDraftConflict, ensureConfig: force => global.StuartAI.ensureConfig(force),
    previewMaterials: async () => { await transition; await global.StuartMD.flushDraftJournal(); await flushDraft(); return api().companion_prepare_context(await intentFor(snapshot().draft?.question || "")); },
    previewSource: input => api().companion_preview_source(snapshot().target, wireSources([input])[0]),
    getSource: (sourceId, requestId) => api().companion_get_source(sourceId, requestId),
    retry: turnId => {
      const turn = snapshot().turns.find(item => item.turnId === turnId); if (!turn) throw new Error("需要重试的问题不存在");
      return sendQuestion(turn.question, { turnId });
    },
    async restoreConversation(session) { await transition; await refresh(session.sessionId); },
    async releaseDocument(documentId) {
      if (document?.documentId !== documentId) return;
      await flushDraft(); await cancel(); document = null;
      if (workspaceRoot) await activate(null, workspaceRoot); else store.deactivate();
    },
    get snapshot() { return snapshot(); }, get messages() { return snapshot().messages; },
    get streaming() { return starting || !!active; }, get requestId() { return active?.requestId; },
  };
})(typeof window !== "undefined" ? window : globalThis);
