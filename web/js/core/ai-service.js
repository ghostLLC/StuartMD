/**
 * StuartAIService — single AI session orchestration (3.2.0)
 * All streaming UIs (assist panel / companion) go through here.
 */
(function (global) {
  "use strict";

  const api = () => (global.pywebview && global.pywebview.api) || null;

  const state = {
    requestId: null,
    streaming: false,
    messages: [], // [{role, content}]
    listeners: { delta: [], done: [], error: [] },
    bound: false,
  };

  function emit(type, payload) {
    (state.listeners[type] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function on(type, fn) {
    if (!state.listeners[type]) state.listeners[type] = [];
    state.listeners[type].push(fn);
    return () => {
      state.listeners[type] = state.listeners[type].filter((f) => f !== fn);
    };
  }

  function bindStream() {
    if (state.bound) return;
    state.bound = true;
    const handleDelta = (payload) => {
      const p = (payload && (payload.payload || payload)) || {};
      if (p.requestId && state.requestId && p.requestId !== state.requestId) return;
      // Canonical field: text (ignore legacy delta)
      const text = p.text != null ? p.text : p.delta != null ? p.delta : "";
      emit("delta", { requestId: p.requestId, text, full: p.full });
    };
    const handleDone = (payload) => {
      const p = (payload && (payload.payload || payload)) || {};
      if (p.requestId && state.requestId && p.requestId !== state.requestId) return;
      state.streaming = false;
      const text = p.text != null ? p.text : "";
      emit("done", {
        requestId: p.requestId,
        ok: p.ok !== false && !p.error,
        text,
        error: p.error || null,
      });
      if (p.error) emit("error", { requestId: p.requestId, error: p.error });
      state.requestId = null;
    };
    const tauri = global.__TAURI__;
    if (tauri?.event?.listen) {
      tauri.event.listen("ai-chat-delta", (e) => handleDelta(e.payload || e));
      tauri.event.listen("ai-chat-done", (e) => handleDone(e.payload || e));
    } else {
      global.addEventListener("ai-chat-delta", (e) => handleDelta(e.detail || e));
      global.addEventListener("ai-chat-done", (e) => handleDone(e.detail || e));
    }
  }

  function rid() {
    return "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  async function ensureConfig(force) {
    if (global.StuartAI?.ensureConfig) return global.StuartAI.ensureConfig(force);
    return null;
  }

  /**
   * messages: full history to send, or we append `user` if only text given.
   */
  async function send({ messages, providerId, model, thinking, maxTokens }) {
    bindStream();
    const a = api();
    if (!a || !a.ai_chat_start) return { error: "bridge missing" };
    if (state.streaming) await cancel();
    const cfg = await ensureConfig();
    const provider = providerId
      ? null
      : (cfg && global.StuartAI?.activeProvider?.(cfg)) || null;
    const msgList = Array.isArray(messages) && messages.length
      ? messages
      : state.messages.length
        ? state.messages
        : [{ role: "user", content: "" }];
    if (Array.isArray(messages) && messages.length) state.messages = msgList.slice();
    const requestId = rid();
    state.requestId = requestId;
    state.streaming = true;
    const res = await a.ai_chat_start(
      requestId,
      providerId || (provider && provider.id) || null,
      model || (provider && provider.model) || null,
      msgList,
      thinking || (cfg && cfg.thinking) || "balanced",
      maxTokens || (cfg && cfg.max_output_tokens) || 2048
    );
    return { ok: !res || !res.error, requestId, error: res && res.error };
  }

  async function explainSelection(opts) {
    const C = global.StuartAIContext;
    const host = global.StuartMD;
    const cfg = await ensureConfig();
    const style = global.StuartAI?.getStyle?.(cfg) || {};
    const memoryProfile = (await global.StuartAI?.loadMemoryProfile?.()) || "";
    let quote = opts?.quote || "";
    if (!quote) {
      quote = String(host?.getSelectionInfo?.()?.text || "").trim();
    }
    if (!quote) return { error: "请先选中要问答的内容" };
    let built;
    if (opts?.kind === "pdf") {
      let ctx = { quote, page: opts.page, name: opts.name, pageText: "", neighborText: "" };
      try {
        if (global.StuartMDPdf?.getAiContext) {
          ctx = Object.assign(ctx, await global.StuartMDPdf.getAiContext());
          ctx.quote = quote;
        }
      } catch (_) {}
      built = C.buildPdfExplain(
        { quote, page: ctx.page, pageText: ctx.pageText, neighborText: ctx.neighborText, name: ctx.name },
        { memoryProfile, maxChars: cfg?.context_max_chars || 8000 }
      );
    } else {
      built = C.buildMarkdownExplain(host, {
        quote,
        scope: cfg?.context_scope || "neighborhood",
        maxChars: cfg?.context_max_chars || 8000,
        memoryProfile,
      });
    }
    const messages = [
      { role: "system", content: C.systemPrompt(style) },
      { role: "user", content: built.promptUser },
    ];
    const res = await send({ messages });
    return Object.assign({ meta: built.meta, quote }, res);
  }

  async function followUp(userText) {
    const q = String(userText || "").trim();
    if (!q) return { error: "内容为空" };
    if (!state.messages.length) return { error: "请先进行一次问答" };
    state.messages.push({ role: "user", content: q });
    return send({ messages: state.messages });
  }

  async function cancel() {
    const a = api();
    const id = state.requestId;
    state.streaming = false;
    state.requestId = null;
    if (a?.ai_chat_cancel && id) {
      try {
        await a.ai_chat_cancel(id);
      } catch (_) {}
    }
    return { ok: true, requestId: id };
  }

  global.StuartAIService = {
    on,
    send,
    explainSelection,
    followUp,
    cancel,
    ensureConfig,
    get streaming() {
      return state.streaming;
    },
    get requestId() {
      return state.requestId;
    },
    get messages() {
      return state.messages;
    },
    reset() {
      state.messages = [];
      state.requestId = null;
      state.streaming = false;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
