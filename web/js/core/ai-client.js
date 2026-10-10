(function (global) {
  "use strict";
  const state = { ai: null };
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
    const now = Date.now(), memoryId = crypto.randomUUID();
    const workspace = Object.hasOwn(metadata, "workspaceRoot") ? metadata.workspaceRoot : global.StuartMD.state.workspaceRoot || null;
    const documentId = metadata.documentId || current.documentId;
    const item = {
      memoryId, tier: metadata.category === "preference" ? 3 : 2, category: metadata.category || "note", content: text,
      confidence: 1, createdAt: now, lastAccessedAt: now, accessCount: 0, pinned: false,
      scope: metadata.category === "preference" ? "global" : "document", workspaceId: metadata.category === "preference" ? null : workspace,
      documentId: metadata.category === "preference" ? null : documentId, preferenceKey: metadata.preferenceKey || null,
      version: metadata.version || 1, sourceMessageId: metadata.sourceMessageId || null,
      sourceAnchor: metadata.sourceAnchor || { documentId, path: current.path, revision: current.revision, createdBy: "manual-confirmation" },
      confirmed: true, supersededBy: null, requestId: metadata.requestId || null,
    };
    await api().organic_memory_upsert(item);
    return { ok: true, memoryId };
  }
  async function recordStyleFeedback(kind) {
    if (!["short", "ok", "long"].includes(kind)) throw new Error("回答长度反馈类型无效");
    const cfg = await ensureConfig(true), style = getStyle(cfg);
    const feedback = { ...style.feedback, [kind]: (style.feedback[kind] || 0) + 1 };
    const hint = global.StuartAIContext.lengthHintFromFeedback(feedback, style.length);
    const result = await saveStyle({ feedback, length_hint: hint });
    if (cfg.memory_mode !== "off") {
      const effective = await api().organic_memory_effective(null, null);
      const previous = effective.find(item => item.preferenceKey === "answer-length");
      await rememberSnippet(hint || "保持当前回答长度。", { category: "preference", preferenceKey: "answer-length", version: (previous?.version || 0) + 1 });
    }
    return result;
  }
  async function handleMemoryAfterExplain(metadata, quote, answer) {
    const cfg = await ensureConfig(true);
    if (cfg.memory_mode === "off") return { skipped: true };
    if (cfg.memory_mode === "ask") return { ok: true, mode: "ask", ask: true };
    if (!metadata.sessionId || !metadata.requestId) throw new Error("学习记录缺少会话或请求编号");
    const messages = await api().session_get_messages(metadata.sessionId);
    const source = messages.find(message => message.requestId === metadata.requestId && message.role === "assistant" && message.completionStatus === "Completed");
    if (!source || source.content !== answer) throw new Error("学习正文与已经保存的完整回答不一致");
    await rememberSnippet(`问题及引用：\n${quote}\n\n完整回答：\n${answer}`, {
      ...metadata, category: "concept", preferenceKey: "learning:" + metadata.requestId, sourceMessageId: source.messageId,
      sourceAnchor: { ...metadata.sourceAnchor, sessionId: metadata.sessionId, requestId: metadata.requestId, sourceHash: source.sourceHash },
    });
    return { ok: true, mode: "always" };
  }
  global.StuartAI = { state, get config() { return state.ai; }, ensureConfig, saveAi, getStyle, saveStyle,
    recordStyleFeedback, setApiKey, clearApiKey, testProvider, activeProvider, rememberSnippet, handleMemoryAfterExplain,
    explain: (options, handlers) => global.StuartAIService.explainSelection(options, handlers),
    cancel: () => global.StuartAIService.cancel(), get streaming() { return global.StuartAIService.streaming; } };
})(typeof window !== "undefined" ? window : globalThis);
