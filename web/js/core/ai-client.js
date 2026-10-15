(function (global) {
  "use strict";
  const state = { ai: null, catalog: null, settingsRevision: null };
  function api() {
    const bridge = global.pywebview?.api;
    if (!bridge) throw new Error("原生接口尚未加载");
    return bridge;
  }
  function checked(result) {
    if (result?.error) throw new Error(result.error);
    return result;
  }
  async function ensureConfig(force = false) {
    if (state.ai && !force) return state.ai;
    const result = checked(await api().ai_get_config());
    if (!result.ai) throw new Error("AI设置响应缺少配置");
    acceptSnapshot(result);
    if (!result.settingsRevision) throw new Error("AI设置响应缺少配置版本");
    state.settingsRevision = result.settingsRevision;
    return state.ai;
  }
  function acceptSnapshot(result) {
    if (!result?.ai || !result.catalog || !result.settingsRevision) throw new Error("AI 配置快照不完整");
    state.ai = result.ai; state.catalog = result.catalog; state.settingsRevision = result.settingsRevision;
    global.dispatchEvent?.(new CustomEvent("stuart-ai-config", { detail: result }));
    return result;
  }
  async function updateConfig(change, expectedRevision = state.settingsRevision, confirm = false) {
    let result;
    try { result = checked(await api().ai_update_config(change, expectedRevision, confirm)); }
    catch (reason) {
      if (!String(reason.message || reason).startsWith("HostConfirmationRequired：")) throw reason;
      if (!await global.StuartUIConfirm(`${reason.message || reason}。确认使用这个服务地址吗？`)) throw new Error("服务地址修改已经取消");
      result = checked(await api().ai_update_config(change, expectedRevision, true));
    }
    return acceptSnapshot(result);
  }
  const setApiKey = async (providerId, key, revision = state.settingsRevision) => acceptSnapshot(checked(await api().ai_set_api_key(providerId, key, revision)));
  const clearApiKey = async (providerId, revision = state.settingsRevision) => acceptSnapshot(checked(await api().ai_clear_api_key(providerId, revision)));
  function getStyle(ai = state.ai || {}) {
    const style = ai.style || {};
    return { length: style.length || "normal", tone: style.tone || "neutral", custom: style.custom || "",
      length_hint: style.length_hint || "", feedback: style.feedback || { short: 0, ok: 0, long: 0 } };
  }
  async function saveStyle(patch) {
    const cfg = await ensureConfig(true);
    const previous = getStyle(cfg);
    const result = await updateConfig({ kind: "updatePreferences", preferences: { style: { ...previous, ...patch, feedback: { ...previous.feedback, ...patch.feedback } } } });
    return { ...result, style: getStyle(state.ai) };
  }
  function activeModel(ai = state.ai) { return ai?.models?.find(model => model.id === ai.active_model_id) || null; }
  function activeProvider(ai = state.ai) { const model = activeModel(ai); return ai?.providers?.find(provider => provider.id === model?.provider_id) || null; }
  async function rememberSnippet(content, metadata = {}) {
    const text = String(content ?? "");
    if (!text.trim()) throw new Error("记忆正文为空");
    const current = global.StuartMD.getDocument();
    const target = global.StuartAIService.snapshot.target;
    const scope = metadata.scope || (metadata.category === "preference" ? "global" : "document");
    const edit = { content: text, category: metadata.category || "note", scope,
      workspaceKey: scope === "global" ? null : metadata.workspaceKey ?? target?.workspaceKey ?? null,
      documentKey: scope === "document" ? metadata.documentKey ?? target?.documentKey : null,
      preferenceKey: metadata.preferenceKey || null, pinned: metadata.pinned || false,
      sourceMessageId: metadata.sourceMessageId || null, sourceRequestId: metadata.requestId || null,
      sourceAnchor: metadata.sourceAnchor || { documentId: current.documentId, path: current.path,
        revision: current.revision, createdBy: "manual-confirmation" } };
    const saved = await api().companion_save_memory(metadata.recordId || null, metadata.expectedVersion || 0, edit);
    return { ok: true, memoryId: saved.memoryId, recordId: saved.recordId, version: saved.version };
  }
  async function recordStyleFeedback(kind) {
    if (!["short", "ok", "long"].includes(kind)) throw new Error("回答长度反馈类型无效");
    const cfg = await ensureConfig(true), style = getStyle(cfg);
    const feedback = { ...style.feedback, [kind]: (style.feedback[kind] || 0) + 1 };
    const hint = global.StuartAIContext.lengthHintFromFeedback(feedback, style.length);
    const result = await saveStyle({ feedback, length_hint: hint });
    if (cfg.use_saved_memories) {
      const effective = await api().companion_list_memories({ scope: "global", preferenceKey: "answer-length", limit: 1 });
      const previous = effective.items[0];
      await rememberSnippet(hint || "保持当前回答长度。", { category: "preference", preferenceKey: "answer-length",
        recordId: previous?.recordId, expectedVersion: previous?.version || 0,
        sourceMessageId: previous?.sourceMessageId, requestId: previous?.requestId, sourceAnchor: previous?.sourceAnchor });
    }
    return result;
  }
  async function handleMemoryAfterExplain(metadata, quote, answer) {
    const cfg = await ensureConfig(true);
    if (cfg.learning_policy === "off") return { skipped: true };
    if (cfg.learning_policy === "ask") return { ok: true, mode: "ask", ask: true };
    if (!metadata.sessionId || !metadata.requestId) throw new Error("学习记录缺少会话或请求编号");
    const messages = await api().session_get_messages(metadata.sessionId);
    const source = messages.find(message => message.requestId === metadata.requestId && message.role === "assistant" && message.completionStatus === "Completed");
    if (!source || source.content !== answer) throw new Error("学习正文与已经保存的完整回答不一致");
    const learned = await api().companion_learn_request(metadata.requestId);
    return { ok: true, mode: "automatic", ...learned };
  }
  global.StuartAI = { state, get config() { return state.ai; }, get snapshot() { return { ai: state.ai, catalog: state.catalog, settingsRevision: state.settingsRevision }; }, ensureConfig, updateConfig, acceptSnapshot, getStyle, saveStyle, activeModel,
    recordStyleFeedback, setApiKey, clearApiKey, activeProvider, rememberSnippet, handleMemoryAfterExplain,
    explain: (options, handlers) => global.StuartAIService.explainSelection(options, handlers),
    cancel: () => global.StuartAIService.cancel(), get streaming() { return global.StuartAIService.streaming; } };
})(typeof window !== "undefined" ? window : globalThis);
