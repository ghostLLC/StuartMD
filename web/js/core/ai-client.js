/**
 * StuartMD AI client — config, explain streaming, memory assist.
 * Host: window.StuartAI
 */
(function (global) {
  "use strict";

  const Ctx = () => global.StuartAIContext || null;
  const api = () => (global.pywebview && global.pywebview.api) || null;

  function rid() {
    return "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  const state = {
    ai: null,
    requestId: null,
    streaming: false,
    answer: "",
    listenersBound: false,
    onDelta: null,
    onDone: null,
  };

  function defaultAi() {
    const core = global.StuartCore && global.StuartCore.settings;
    return core && core.defaultAi ? core.defaultAi() : { providers: [] };
  }

  async function ensureConfig(force) {
    if (state.ai && !force) return state.ai;
    const a = api();
    if (a && a.ai_get_config) {
      const res = await a.ai_get_config();
      if (res && res.ai) {
        state.ai = res.ai;
        return state.ai;
      }
    }
    // fallback: settings payload
    if (a && a.get_settings) {
      const s = await a.get_settings();
      state.ai = (s && s.ai) || defaultAi();
      return state.ai;
    }
    state.ai = defaultAi();
    return state.ai;
  }

  async function saveAi(next) {
    const a = api();
    state.ai = next;
    if (a && a.ai_save_config) {
      const res = await a.ai_save_config(next);
      if (res && res.ai) state.ai = res.ai;
      return res;
    }
    if (a && a.save_settings) {
      return a.save_settings({ ai: next });
    }
    return { error: "bridge missing" };
  }

  async function setApiKey(providerId, key) {
    const a = api();
    if (!a || !a.ai_set_api_key) return { error: "bridge missing" };
    return a.ai_set_api_key(providerId, key);
  }

  async function clearApiKey(providerId) {
    const a = api();
    if (!a || !a.ai_clear_api_key) return { error: "bridge missing" };
    return a.ai_clear_api_key(providerId);
  }

  async function testProvider(providerId) {
    const a = api();
    if (!a || !a.ai_test_provider) return { error: "bridge missing" };
    return a.ai_test_provider(providerId);
  }

  async function bindEvents() {
    if (state.listenersBound) return;
    const tauri = global.__TAURI__ || global.__TAURI_INTERNALS__;
    let listen = null;
    if (global.__TAURI__ && global.__TAURI__.event && global.__TAURI__.event.listen) {
      listen = global.__TAURI__.event.listen;
    } else if (
      global.__TAURI_INTERNALS__ &&
      typeof global.__TAURI_INTERNALS__.listen === "function"
    ) {
      listen = global.__TAURI_INTERNALS__.listen.bind(global.__TAURI_INTERNALS__);
    }
    if (!listen) {
      // polling fallback via custom window events emitted by bridge
      global.addEventListener("ai-chat-delta", (e) => onDelta(e.detail));
      global.addEventListener("ai-chat-done", (e) => onDone(e.detail));
      state.listenersBound = true;
      return;
    }
    await Promise.all([
      listen("ai-chat-delta", (e) => onDelta(e.payload || e)),
      listen("ai-chat-done", (e) => onDone(e.payload || e)),
    ]);
    state.listenersBound = true;
    void tauri;
  }

  function onDelta(payload) {
    if (!payload || (payload.requestId && state.requestId && payload.requestId !== state.requestId)) {
      return;
    }
    const piece = payload.text || "";
    state.answer += piece;
    if (typeof state.onDelta === "function") state.onDelta(state.answer, piece);
  }

  function onDone(payload) {
    if (!payload || (payload.requestId && state.requestId && payload.requestId !== state.requestId)) {
      return;
    }
    state.streaming = false;
    const text = payload.text || state.answer || "";
    state.answer = text;
    if (typeof state.onDone === "function") state.onDone(payload);
    state.requestId = null;
  }

  async function cancel(reqId) {
    const a = api();
    const id = reqId || state.requestId;
    state.streaming = false;
    state.requestId = null;
    if (a && a.ai_chat_cancel && id) {
      try {
        await a.ai_chat_cancel(id);
      } catch (_) {}
    }
    return { ok: true, request_id: id };
  }

  async function memoryGet(key) {
    const a = api();
    if (!a || !a.memory_get) return { error: "bridge missing" };
    return a.memory_get(key);
  }

  async function memorySet(key, content) {
    const a = api();
    if (!a || !a.memory_set) return { error: "bridge missing" };
    return a.memory_set(key, content);
  }

  function getStyle(ai) {
    const cfg = ai || state.ai || {};
    const s = cfg.style || {};
    return {
      length: s.length || "normal",
      tone: s.tone || "neutral",
      custom: s.custom || "",
      length_hint: s.length_hint || "",
      feedback: s.feedback || { short: 0, ok: 0, long: 0 },
    };
  }

  async function saveStyle(patch) {
    const cfg = await ensureConfig(true);
    const next = Object.assign({}, cfg);
    const cur = getStyle(cfg);
    next.style = Object.assign({}, cur, patch || {});
    if (patch && patch.feedback) {
      next.style.feedback = Object.assign({}, cur.feedback || {}, patch.feedback);
    }
    const res = await saveAi(next);
    return res && res.error ? res : { ok: true, style: getStyle(state.ai) };
  }

  /** Record first-answer length feedback → mild style constraint + memory note. */
  async function recordStyleFeedback(kind) {
    if (!["short", "ok", "long"].includes(kind)) return { error: "invalid feedback" };
    const cfg = await ensureConfig(true);
    const style = getStyle(cfg);
    const fb = Object.assign({ short: 0, ok: 0, long: 0 }, style.feedback || {});
    fb[kind] = (fb[kind] || 0) + 1;
    const C = global.StuartAIContext;
    const hint =
      C && C.lengthHintFromFeedback
        ? C.lengthHintFromFeedback(fb, style.length)
        : style.length_hint;
    const res = await saveStyle({ feedback: fb, length_hint: hint });
    try {
      const label =
        kind === "short" ? "首答偏短" : kind === "long" ? "首答偏长" : "首答长度满意";
      await rememberSnippet(`回答长度反馈：${label}`);
    } catch (_) {}
    return res;
  }

  async function loadMemoryProfile() {
    const cfg = await ensureConfig();
    const mode = (cfg && cfg.memory_mode) || "always";
    if (mode === "off") return "";
    try {
      const res = await memoryGet("user_profile");
      if (res && res.content) return String(res.content).slice(0, 2000);
    } catch (_) {}
    return "";
  }

  async function rememberSnippet(snippet) {
    const text = String(snippet || "").trim().slice(0, 400);
    if (!text) return { error: "内容为空" };
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    let prev = "";
    try {
      const res = await memoryGet("user_profile");
      prev = (res && res.content) || "";
    } catch (_) {}
    const lines = prev ? prev.split("\n") : [];
    if (lines.some((l) => l.includes(text))) {
      return { ok: true, deduped: true };
    }
    lines.push(`- [${stamp}] ${text}`);
    // keep profile compact
    const next = lines.slice(-80).join("\n");
    return memorySet("user_profile", next);
  }

  async function rememberActivity(meta, quote) {
    const stamp = new Date().toISOString();
    const line = `- ${stamp} | ${(meta && meta.name) || ""} | ${String(quote || "").slice(0, 80).replace(/\n/g, " ")}`;
    let prev = "";
    try {
      const res = await memoryGet("activity_explains");
      prev = (res && res.content) || "";
    } catch (_) {}
    const body = prev ? prev + "\n" + line : `# StuartMD 讲解活动\n${line}`;
    return memorySet("activity_explains", body.split("\n").slice(-200).join("\n"));
  }

  function activeProvider(ai) {
    const list = (ai && ai.providers) || [];
    const id = (ai && ai.active_provider_id) || "deepseek";
    return list.find((p) => p.id === id) || list[0] || null;
  }

  function hasKey(provider) {
    return !!(provider && (provider.key_set || provider.has_key));
  }

  /**
   * Start explain. Returns {ok, requestId} or {error}.
   */
  async function explain(input, handlers) {
    const C = Ctx();
    if (!C) return { error: "AI context module missing" };
    await bindEvents();
    const cfg = await ensureConfig();
    if (!cfg || cfg.enabled === false) {
      return { error: "AI 功能已关闭，请在「模型」中启用" };
    }
    const provider = activeProvider(cfg);
    if (!provider) return { error: "请先配置 AI 服务商" };
    if (!hasKey(provider) && provider.id !== "custom") {
      // key_set may be backend-enforced; still try and surface error
    }
    if (state.streaming) {
      await cancel();
    }

    let built;
    const memoryProfile = await loadMemoryProfile();
    if (input && input.kind === "pdf") {
      built = C.buildPdfExplain(input, {
        maxChars: cfg.context_max_chars || C.DEFAULT_MAX,
        scope: cfg.context_scope,
        memoryProfile,
      });
    } else {
      const host = global.StuartMD;
      const quoteIn = (input && input.quote) || "";
      built = C.buildMarkdownExplain(host, {
        maxChars: cfg.context_max_chars || C.DEFAULT_MAX,
        scope: cfg.context_scope,
        quote: quoteIn,
        memoryProfile,
      });
      if (!built.quote && host && host.getSelectionCache) {
        const cache = host.getSelectionCache();
        if (cache && cache.text) {
          built = C.buildMarkdownExplain(host, {
            maxChars: cfg.context_max_chars || C.DEFAULT_MAX,
            scope: cfg.context_scope,
            quote: cache.text,
            memoryProfile,
          });
        }
      }
    }

    if (!built.quote || !String(built.quote).trim()) {
      return { error: "请先选中要问答的内容" };
    }

    const style = getStyle(cfg);
    const messages = [
      { role: "system", content: C.systemPrompt(style) },
      { role: "user", content: built.promptUser },
    ];

    const requestId = rid();
    state.requestId = requestId;
    state.answer = "";
    state.streaming = true;
    state.onDelta = handlers && handlers.onDelta;
    state.onDone = handlers && handlers.onDone;

    const a = api();
    if (!a || !a.ai_chat_start) {
      state.streaming = false;
      state.requestId = null;
      return { error: "bridge missing ai_chat_start" };
    }

    const res = await a.ai_chat_start(
      requestId,
      provider.id,
      provider.model,
      messages,
      cfg.thinking || "balanced",
      cfg.max_output_tokens || 2048
    );
    if (res && res.error) {
      state.streaming = false;
      state.requestId = null;
      return res;
    }
    return { ok: true, requestId, meta: built.meta, quote: built.quote };
  }

  async function handleMemoryAfterExplain(meta, quote, answer) {
    const cfg = await ensureConfig();
    const mode = (cfg && cfg.memory_mode) || "always";
    if (mode === "off") return { skipped: true };
    try {
      await rememberActivity(meta, quote);
      if (mode === "always") {
        const tip = `讲解偏好：关注 ${(meta && meta.heading) || (meta && meta.name) || "文档"} 相关内容`;
        await rememberSnippet(tip);
        if (answer && answer.length > 0) {
          // light topic line
          const topic = String(quote || "").slice(0, 40);
          if (topic) await rememberSnippet(`常用主题片段：${topic}`);
        }
        return { ok: true, mode };
      }
      return { ok: true, mode, ask: true };
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    }
  }

  global.StuartAI = {
    state,
    get config() {
      return state.ai;
    },
    ensureConfig,
    saveAi,
    getStyle,
    saveStyle,
    recordStyleFeedback,
    setApiKey,
    clearApiKey,
    testProvider,
    explain,
    cancel,
    memoryGet,
    memorySet,
    loadMemoryProfile,
    rememberSnippet,
    handleMemoryAfterExplain,
    activeProvider,
    get streaming() {
      return state.streaming;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
