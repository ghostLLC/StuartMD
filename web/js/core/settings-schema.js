/**
 * StuartMD core — settings defaults & light migration (pure, testable).
 * Host: window.StuartCore.settings
 */
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 4;

  function defaultAi() {
    return {
      enabled: true,
      active_provider_id: "deepseek",
      explain_shortcut: "Alt+E",
      thinking: "balanced",
      context_scope: "neighborhood",
      context_max_chars: 8000,
      max_output_tokens: 2048,
      memory_mode: "always",
      style: {
        length: "normal",
        tone: "neutral",
        custom: "",
        length_hint: "",
        feedback: { short: 0, ok: 0, long: 0 },
      },
      providers: [
        {
          id: "deepseek",
          label: "DeepSeek",
          kind: "openai_compat",
          base_url: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          enabled: true,
          builtin: true,
        },
        {
          id: "qwen",
          label: "通义千问 Qwen",
          kind: "openai_compat",
          base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "qwen-plus",
          enabled: true,
          builtin: true,
        },
        {
          id: "kimi",
          label: "Kimi (Moonshot)",
          kind: "openai_compat",
          base_url: "https://api.moonshot.cn/v1",
          model: "moonshot-v1-8k",
          enabled: true,
          builtin: true,
        },
        {
          id: "glm",
          label: "智谱 GLM",
          kind: "openai_compat",
          base_url: "https://open.bigmodel.cn/api/paas/v4",
          model: "glm-4-air",
          enabled: true,
          builtin: true,
        },
        {
          id: "custom",
          label: "自定义 OpenAI 兼容",
          kind: "openai_compat",
          base_url: "",
          model: "",
          enabled: false,
          builtin: true,
        },
      ],
    };
  }

  const DEFAULTS = {
    schema_version: SCHEMA_VERSION,
    recent: [],
    theme: "light",
    last_folder: "",
    sidebar: true,
    mode: "preview",
    autosave: true,
    glass: false,
    language: "zh-CN",
    plugins_disabled: [],
    wallpaper: {},
    open_mode: "smart",
    new_doc_mode: "tab",
    content_width: "default",
    music: { volume: 0.4, currentId: "rain", customName: "", playing: false },
    // Session restore: first launch opens sample; after sample closed → home
    sample_dismissed: false,
    session: { tabs: [], active_path: "" },
    last_open_files: [],
    window_state: null,
    ai: defaultAi(),
  };

  function migrate(raw) {
    const s = Object.assign({}, raw || {});
    const from = parseInt(s.schema_version, 10) || 1;
    if (from < 2) {
      if (!s.language) s.language = "zh-CN";
      if (!s.plugins_disabled) s.plugins_disabled = [];
      if (!s.wallpaper) s.wallpaper = {};
      if (s.theme === "glass" || s.theme === "frosted") s.theme = "light";
      s.glass = false;
      if (s.theme === "Stuart" || s.theme === "MiniTypora" || s.theme === "StuartMD") {
        s.theme = "light";
      }
    }
    if (from < 3 && typeof s.sample_dismissed === "undefined") {
      const hasRecent = Array.isArray(s.recent) && s.recent.length > 0;
      const hasFolder = !!(s.last_folder && String(s.last_folder).length);
      s.sample_dismissed = hasRecent || hasFolder;
    }
    if (from < 4 || !s.ai || typeof s.ai !== "object") {
      const base = defaultAi();
      s.ai = Object.assign(base, s.ai && typeof s.ai === "object" ? s.ai : {});
      if (!Array.isArray(s.ai.providers) || !s.ai.providers.length) {
        s.ai.providers = base.providers;
      }
    }
    if (!s.session || typeof s.session !== "object") {
      s.session = { tabs: [], active_path: "" };
    }
    if (!Array.isArray(s.session.tabs)) s.session.tabs = [];
    if (typeof s.session.active_path !== "string") s.session.active_path = "";
    Object.keys(DEFAULTS).forEach((k) => {
      if (typeof s[k] === "undefined") s[k] = DEFAULTS[k];
    });
    s.schema_version = SCHEMA_VERSION;
    return s;
  }

  function isValidOpenMode(m) {
    return m === "smart" || m === "new_window" || m === "current_window";
  }

  function isValidNewDocMode(m) {
    return m === "tab" || m === "new_window";
  }

  function isValidMemoryMode(m) {
    return m === "always" || m === "ask" || m === "off";
  }

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.settings = {
    SCHEMA_VERSION,
    DEFAULTS,
    defaultAi,
    migrate,
    isValidOpenMode,
    isValidNewDocMode,
    isValidMemoryMode,
  };
})(typeof window !== "undefined" ? window : globalThis);
