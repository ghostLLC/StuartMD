/**
 * StuartMD core — settings defaults & light migration (pure, testable).
 * Host: window.StuartCore.settings
 */
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 2;

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

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.settings = {
    SCHEMA_VERSION,
    DEFAULTS,
    migrate,
    isValidOpenMode,
    isValidNewDocMode,
  };
})(typeof window !== "undefined" ? window : globalThis);
