(function (global) {
  "use strict";
  const events = new Map(), conversations = new Map();
  let document = null, documentVersion = null, active = null, binding = null, starting = false;
  let eventQueue = Promise.resolve();
  const api = () => global.pywebview.api;

  function on(type, listener) {
    if (!events.has(type)) events.set(type, new Set());
    events.get(type).add(listener);
    return () => events.get(type).delete(listener);
  }
  function emit(type, payload) { for (const listener of events.get(type) || []) listener(payload); }
  function conversation(documentId = document?.documentId) {
    if (!documentId) throw new Error("当前文档未注册");
    if (!conversations.has(documentId)) conversations.set(documentId, { messages: [], sessionId: null });
    return conversations.get(documentId);
  }
  async function digest(text) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function sameSource(request) { return document?.documentId === request.documentId && documentVersion?.revision === request.document.revision && documentVersion?.diskHash === request.document.diskRevision?.rawByteSha256; }
  function current(request) { return active === request && sameSource(request); }
  async function finish(request, payload) {
    if (request.finishing) { await request.completion; return; }
    request.finishing = true;
    const result = { ...payload, ok: payload.status === "Completed", error: payload.error || (payload.status === "Cancelled" ? "已取消生成" : null) };
    if (result.ok) {
      request.conversation.messages = [...request.messages, { role: "assistant", content: payload.text }];
      try {
        result.memory = await global.StuartAI.handleMemoryAfterExplain({
          requestId: request.requestId, sessionId: request.sessionId, documentId: request.documentId,
          workspaceRoot: request.contextInput.workspaceRoot,
          sourceAnchor: { documentId: request.documentId, path: request.document.path, revision: request.document.revision, sourceHash: request.contextInput.sourceHash, selection: request.contextInput.selection },
        }, request.messages.findLast(message => message.role === "user").content, payload.text);
      } catch (error) { result.memoryError = error.message; global.StuartMD.toast("学习记录保存失败：" + error.message); }
    }
    if (active === request) active = null;
    request.resolve(result);
    if (!sameSource(request)) return;
    emit("done", result);
    await request.handlers?.onDone?.(result);
  }
  async function handle(payload, request) {
    if (!request || active !== request || payload.requestId !== request.requestId || payload.documentId !== request.documentId || payload.sessionId !== request.sessionId) return;
    if (payload.seq <= request.seq) return;
    if (payload.type === "delta") {
      if (payload.seq !== request.seq + 1) {
        const snapshot = await api().ai_chat_status(request.requestId);
        if (active !== request) return;
        if (snapshot.seq < payload.seq) throw new Error("AI请求事件顺序不完整");
        if (snapshot.type === "done") { await handle(snapshot, request); return; }
        request.text = snapshot.text; request.seq = snapshot.seq;
      } else { request.text += payload.text; request.seq = payload.seq; }
      if (!current(request)) return;
      const update = { ...payload, text: request.text, full: true };
      emit("delta", update);
      await request.handlers?.onDelta?.(update);
      return;
    }
    if (payload.type !== "done") throw new Error("AI请求事件类型无效");
    if (payload.finalHash !== await digest(payload.text)) throw new Error("AI最终回答校验失败");
    request.seq = payload.seq;
    await finish(request, payload);
  }
  async function fail(request, error) {
    global.StuartMD.toast(error.message);
    if (active !== request) return;
    await api().ai_chat_cancel(request.requestId);
    const result = await terminalSnapshot(request);
    await finish(request, { ...result, status: "Failed", backendStatus: result.status, error: error.message });
  }
  async function bind() {
    if (!binding) binding = Promise.all([
      api().listen_event("ai-request-event", event => {
        const request = active;
        const consume = () => handle(event.payload, request);
        eventQueue = eventQueue.then(consume, consume).catch(error => fail(request, error));
      }),
      api().listen_event("ai-config-changed", async () => {
        const config = await global.StuartAI.ensureConfig(true);
        if (!config.enabled) await cancel();
        emit("config", config);
      }),
    ]);
    await binding;
  }
  async function captureContext(captured, selection, options) {
    const sourceHash = captured.kind === "pdf" ? captured.diskRevision?.rawByteSha256 : await digest(captured.content);
    if (!sourceHash) throw new Error("当前文档缺少来源指纹");
    let ref = null;
    if (selection?.quote || selection?.text) {
      const quote = String(selection.quote ?? selection.text);
      ref = {
        documentId: captured.documentId, revision: captured.revision, kind: captured.kind, quote,
        from: captured.kind === "markdown" && !selection.inPreview ? selection.start ?? null : null,
        to: captured.kind === "markdown" && !selection.inPreview ? selection.end ?? null : null,
        blockIndex: selection.blockIndex ?? null, page: selection.page ?? null,
        rects: captured.kind === "pdf" ? selection.pdfRects || [] : [], fileFingerprint: captured.kind === "pdf" ? sourceHash : null,
      };
    }
    return { editorRevision: captured.revision, sourceHash, selection: ref, page: captured.kind === "pdf" ? selection?.page || global.StuartMDPdf.getCurrentPage() : null, scope: options.scope || "neighborhood", workspaceRoot: Object.hasOwn(options, "workspaceRoot") ? options.workspaceRoot : global.StuartMD.state.workspaceRoot || null, knowledgeSources: options.knowledgeSources || [] };
  }
  async function send(options) {
    if (starting) throw new Error("AI请求正在准备，请等待当前操作完成");
    const captured = options.document || global.StuartMD.getDocument();
    if (!captured.documentId || captured.documentId !== document?.documentId) throw new Error("请求文档身份已经失效");
    const selection = options.selection === null ? null : options.selection ?? global.StuartMD.getSelectionInfo();
    starting = true;
    let request;
    try {
      await bind();
      await cancel();
      await global.StuartMD.flushDraftJournal();
      const cfg = await global.StuartAI.ensureConfig(true);
      if (!cfg.enabled) throw new Error("AI功能未启用");
      const provider = global.StuartAI.activeProvider(cfg);
      if (!provider) throw new Error("请配置AI服务商");
      const contextInput = await captureContext(captured, selection, { ...options, scope: options.scope || cfg.context_scope });
      const latest = global.StuartMD.getDocument();
      if (captured.documentId !== latest.documentId || captured.revision !== latest.revision) throw new Error("请求准备期间文档已经变化，请重新选择正文");
      const history = conversation(captured.documentId);
      if (!history.sessionId) {
        const session = await api().session_create(captured.name, contextInput.workspaceRoot, captured.documentId, captured.path);
        history.sessionId = session.sessionId;
      }
      if (captured.documentId !== document?.documentId) throw new Error("请求准备期间已经切换文档");
      let resolve;
      const completion = new Promise(done => { resolve = done; });
      request = { requestId: crypto.randomUUID(), documentId: captured.documentId, sessionId: history.sessionId, document: captured, contextInput, seq: 0, text: "", messages: options.messages, conversation: history, handlers: options.handlers, completion, resolve };
      active = request;
      emit("start", { requestId: request.requestId, documentId: request.documentId, sessionId: request.sessionId });
      const result = await api().ai_chat_start(request.requestId, options.providerId || provider.id, options.model || provider.model,
        request.messages, options.thinking || cfg.thinking, options.maxTokens ?? cfg.max_output_tokens, request.documentId, request.sessionId, contextInput);
      if (result.error) throw new Error(result.error);
      return { ok: true, requestId: request.requestId };
    } catch (error) {
      if (request && active === request) {
        active = null;
        request.resolve({ ok: false, status: "Failed", error: error.message });
      }
      throw error;
    } finally { starting = false; }
  }
  async function explainSelection(options = {}, handlers) {
    const host = global.StuartMD, captured = host.getDocument();
    const selection = { ...host.getSelectionInfo(), ...options };
    const quote = String(selection.quote ?? selection.text ?? "");
    if (!quote.trim()) throw new Error("请选中需要解释的正文");
    const cfg = await global.StuartAI.ensureConfig();
    const context = global.StuartAIContext;
    const built = captured.kind === "pdf" ? context.buildPdfExplain({ ...selection, name: captured.name, quote }) : context.buildMarkdownExplain(host, { ...selection, quote });
    const result = await send({ document: captured, selection, messages: [{ role: "system", content: context.systemPrompt(global.StuartAI.getStyle(cfg)) }, { role: "user", content: built.promptUser }], handlers });
    return { ...result, quote, meta: built.meta };
  }
  async function followUp(text, handlers, options = {}) {
    if (!String(text).trim()) throw new Error("问题内容为空");
    const history = conversation();
    if (!history.messages.length) throw new Error("请先完成一次问答");
    const config = await global.StuartAI.ensureConfig(true);
    const system = global.StuartAIContext.systemPrompt(global.StuartAI.getStyle(config));
    return send({ ...options, messages: [{ role: "system", content: system }, ...history.messages.filter(message => message.role !== "system"), { role: "user", content: text }], handlers });
  }
  async function terminalSnapshot(request) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const snapshot = await api().ai_chat_status(request.requestId);
      if (snapshot.type === "done") return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("AI请求尚未确认结束");
  }
  async function cancel() {
    const request = active;
    if (!request) return;
    await api().ai_chat_cancel(request.requestId);
    const snapshot = await terminalSnapshot(request);
    await handle(snapshot, request);
    await request.completion;
  }
  global.StuartAIService = {
    on, send, explainSelection, followUp, cancel, ensureConfig: force => global.StuartAI.ensureConfig(force),
    setDocument(next) {
      const changed = next.documentId !== documentVersion?.documentId || next.revision !== documentVersion?.revision || next.diskRevision?.rawByteSha256 !== documentVersion?.diskHash;
      document = next;
      documentVersion = { documentId: next.documentId, revision: next.revision, diskHash: next.diskRevision?.rawByteSha256 };
      if (!changed) return;
      emit("document", { documentId: next.documentId, messages: conversation(next.documentId).messages });
      if (active) cancel().catch(error => global.StuartMD.toast(error.message));
    },
    restoreConversation(session, messages) {
      if (session.documentId !== document?.documentId) throw new Error("恢复的会话与当前文档身份不一致");
      const history = conversation();
      const complete = new Set(messages.filter(message => message.role === "assistant" && message.completionStatus === "Completed").map(message => message.requestId));
      history.sessionId = session.sessionId;
      history.messages = messages.filter(message => message.completionStatus === "Completed" && (!message.requestId || complete.has(message.requestId))).map(({ role, content }) => ({ role, content }));
      emit("document", { documentId: document.documentId, messages: history.messages });
    },
    get streaming() { return starting || !!active; }, get requestId() { return active?.requestId; },
    get messages() { return document ? conversation().messages : []; },
    async releaseDocument(documentId) {
      if (active?.documentId === documentId) await cancel();
      conversations.delete(documentId);
      if (document?.documentId === documentId) {
        document = null; documentVersion = null;
        emit("document", { documentId: null, messages: [] });
      }
    },
    async reset() { await cancel(); if (document) conversations.delete(document.documentId); emit("document", { documentId: document?.documentId, messages: [] }); },
  };
})(typeof window !== "undefined" ? window : globalThis);
