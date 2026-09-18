/* StuartMD plugin loader — sandboxed-ish eval of user JS with a small API */
(function () {
  "use strict";

  const loaded = new Map();

  const api = {
    registerMarkdownIt(fn) {
      if (typeof fn !== "function") return;
      try {
        if (window.__stuartMd) fn(window.__stuartMd);
        else window.__stuartMdHooks = (window.__stuartMdHooks || []).concat(fn);
      } catch (e) {
        console.warn("plugin markdownit failed", e);
      }
    },
    addStyle(css) {
      const el = document.createElement("style");
      el.setAttribute("data-stuart-plugin", "1");
      el.textContent = String(css || "");
      document.head.appendChild(el);
    },
    onAppReady(fn) {
      if (typeof fn === "function") {
        if (window.Stuart) try { fn(window.Stuart); } catch (_) {}
        else window.addEventListener("stuart-ready", () => { try { fn(window.Stuart); } catch (_) {} }, { once: true });
      }
    },
    toast(msg) {
      const t = document.getElementById("toast");
      if (!t) return;
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(api.toast._t);
      api.toast._t = setTimeout(() => { t.hidden = true; }, 2000);
    },
    /** Register an AI/plugin tool on StuartAgent. */
    registerTool(def) {
      const host = window.StuartAgent || window.Stuart;
      if (!host || !host.registerTool) return { error: "agent api missing" };
      return host.registerTool(def);
    },
    /** Access the stable agent facade (document / memory / tools). */
    agent() {
      return window.StuartAgent || window.Stuart || null;
    },
  };

  async function loadAll() {
    if (!window.pywebview?.api?.list_plugins) return [];
    try {
      const res = await window.pywebview.api.list_plugins();
      const list = (res && res.plugins) || [];
      for (const p of list) {
        if (!p.enabled) continue;
        const src = await window.pywebview.api.read_plugin_source(p.path);
        if (src?.error || !src?.source) continue;
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function("StuartPlugin", "window", "document", src.source);
          fn(api, window, document);
          loaded.set(p.id, p);
        } catch (e) {
          console.warn("plugin load failed", p.id, e);
        }
      }
      return [...loaded.values()];
    } catch (_) {
      return [];
    }
  }

  window.StuartPlugins = { loadAll, api, loaded };
})();
