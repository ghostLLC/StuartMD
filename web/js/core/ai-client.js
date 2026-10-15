(function (global) {
  "use strict";
  const state = { ai: null, settingsRevision: null };
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
    state.ai = result.ai;
    if (!result.settingsRevision) throw new Error("AI设置响应缺少配置版本");
    state.settingsRevision = result.settingsRevision;
    return state.ai;
  }
  async function saveAi(next) {
    let result = checked(await api().ai_save_config(next));
    if (result.needs_confirm) {
      const accepted = await global.StuartUIConfirm(`保存后会把已保存的 API Key 发送到 ${result.detail.key_sent_to}。确认使用这个服务地址吗？`);
      if (!accepted) throw new Error("服务地址修改已经取消");
      result = checked(await api().ai_save_config(next, true));
    }
    if (!result.ok || !result.ai) throw new Error("AI设置没有完成保存");
    state.ai = result.ai;
    state.settingsRevision = result.settingsRevision;
    if (!result.ai.enabled) await global.StuartAIService.cancel();
    return result;
  }
  const setApiKey = async (providerId, key) => checked(await api().ai_set_api_key(providerId, key));
  const clearApiKey = async providerId => checked(await api().ai_clear_api_key(providerId));
  const testProvider = async providerId => checked(await api().ai_test_provider(providerId));
  function getStyle(ai = state.ai || {}) {
    const style = ai.style || {};
    return { length: style.length || "normal", tone: style.tone || "neutral", custom: style.custom || "",
      length_hint: style.length_hint || "", feedback: style.feedback || { short: 0, ok: 0, long: 0 } };
  }
  async function saveStyle(patch) {
    const cfg = await ensureConfig(true);
    const previous = getStyle(cfg);
    const result = await saveAi({ ...cfg, style: { ...previous, ...patch, feedback: { ...previous.feedback, ...patch.feedback } } });
    return { ...result, style: getStyle(state.ai) };
  }
  function activeProvider(ai) { return ai?.providers?.find(provider => provider.id === ai.active_provider_id) || null; }
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
  global.StuartAI = { state, get config() { return state.ai; }, ensureConfig, saveAi, getStyle, saveStyle,
    recordStyleFeedback, setApiKey, clearApiKey, testProvider, activeProvider, rememberSnippet, handleMemoryAfterExplain,
    explain: (options, handlers) => global.StuartAIService.explainSelection(options, handlers),
    cancel: () => global.StuartAIService.cancel(), get streaming() { return global.StuartAIService.streaming; } };
})(typeof window !== "undefined" ? window : globalThis);
