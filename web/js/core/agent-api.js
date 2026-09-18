/**
 * StuartMD Agent API — stable host facade for plugins and the mid-term AI layer.
 * Does not change UI; only exposes document/memory/tool operations.
 * Host: window.StuartAgent (also mirrored on window.Stuart)
 */
(function (global) {
  "use strict";

  const API_VERSION = 1;

  function host() {
    return global.StuartMD || null;
  }

  function api() {
    return (global.pywebview && global.pywebview.api) || null;
  }

  function ready() {
    const h = host();
    return !!(h && h.state && h.state.apiReady);
  }

  function sanitizeUntrustedMarkdown(text) {
    return String(text == null ? "" : text)
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
      .replace(/<object\b[\s\S]*?<\/object>/gi, "")
      .replace(/<embed\b[^>]*>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  }

  /** In-process tool registry for plugins / AI tools. */
  const tools = new Map();

  const agent = {
    apiVersion: API_VERSION,

    get ready() {
      return ready();
    },

    get hostVersion() {
      const h = host();
      return (h && h.state && h.state.appInfo && h.state.appInfo.version) || null;
    },

    // ----- Document -----
    getDocument() {
      const h = host();
      if (!h || !h.getDocument) return null;
      return h.getDocument();
    },

    /**
     * Replace active markdown source.
     * @param {string} text
     * @param {{fromUser?:boolean, sanitize?:boolean, source?:string}} [opts]
     */
    setDocument(text, opts) {
      const h = host();
      if (!h || !h.setDocumentText) return { error: "host not ready" };
      const o = opts || {};
      let body = text == null ? "" : String(text);
      // AI/plugin writes are sanitized by default; user typing path never hits this API
      if (o.sanitize !== false) body = sanitizeUntrustedMarkdown(body);
      return h.setDocumentText(body, {
        fromUser: o.fromUser !== false,
        source: o.source || "agent",
      });
    },

    getPath() {
      const h = host();
      return (h && h.state && h.state.path) || null;
    },

    getName() {
      const h = host();
      return (h && h.state && h.state.name) || null;
    },

    getMode() {
      const h = host();
      return (h && h.state && h.state.mode) || "preview";
    },

    setMode(mode) {
      const h = host();
      if (!h || !h.setMode) return { error: "host missing" };
      h.setMode(mode);
      return { ok: true, mode };
    },

    getTheme() {
      const h = host();
      return (h && h.state && h.state.theme) || null;
    },

    setTheme(theme) {
      const h = host();
      if (!h || !h.setTheme) return { error: "host missing" };
      h.setTheme(theme);
      return { ok: true, theme };
    },

    getStats() {
      const h = host();
      return h && h.getStats ? h.getStats() : null;
    },

    getOutline() {
      const h = host();
      return h && h.getOutline ? h.getOutline() : [];
    },

    getBlocks() {
      const h = host();
      return h && h.getBlocks ? h.getBlocks() : [];
    },

    getSelection() {
      const h = host();
      return h && h.getSelectionInfo ? h.getSelectionInfo() : null;
    },

    insertText(text) {
      const h = host();
      if (!h || !h.insertTextAtSelection) return { error: "host missing" };
      return h.insertTextAtSelection(String(text == null ? "" : text));
    },

    applyBlockAction(index, action) {
      const h = host();
      if (!h || !h.applyBlockActionAt) return { error: "host missing" };
      return h.applyBlockActionAt(index, action);
    },

    findInDocument(query) {
      const h = host();
      return h && h.findInDocument ? h.findInDocument(query) : { hits: 0 };
    },

    undo() {
      const h = host();
      return h && h.undo ? h.undo() : false;
    },

    redo() {
      const h = host();
      return h && h.redo ? h.redo() : false;
    },

    toast(msg) {
      const h = host();
      if (h && h.toast) h.toast(String(msg == null ? "" : msg));
    },

    // ----- Events -----
    on(type, fn) {
      const h = host();
      if (!h || !h.onAgentEvent || typeof fn !== "function") return () => {};
      return h.onAgentEvent(type, fn);
    },

    off(type, fn) {
      const h = host();
      if (h && h.offAgentEvent) h.offAgentEvent(type, fn);
    },

    // ----- Tools -----
    registerTool(def) {
      if (!def || !def.name || typeof def.run !== "function") {
        return { error: "tool needs {name, run}" };
      }
      tools.set(String(def.name), {
        name: String(def.name),
        description: def.description || "",
        run: def.run,
        source: def.source || "plugin",
      });
      return { ok: true, name: def.name };
    },

    listTools() {
      return [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        source: t.source,
      }));
    },

    async invokeTool(name, args) {
      const t = tools.get(String(name));
      if (!t) return { error: "tool not found: " + name };
      try {
        const result = await t.run(args || {});
        return { ok: true, result };
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
      }
    },

    // ----- Backend memory / search -----
    async capabilities() {
      const a = api();
      if (!a?.get_capabilities) return { error: "bridge missing" };
      return a.get_capabilities();
    },

    async memoryList() {
      const a = api();
      if (!a?.memory_list) return { error: "bridge missing" };
      return a.memory_list();
    },

    async memoryGet(key) {
      const a = api();
      if (!a?.memory_get) return { error: "bridge missing" };
      return a.memory_get(key);
    },

    async memorySet(key, content) {
      const a = api();
      if (!a?.memory_set) return { error: "bridge missing" };
      return a.memory_set(key, content);
    },

    async memoryDelete(key) {
      const a = api();
      if (!a?.memory_delete) return { error: "bridge missing" };
      return a.memory_delete(key);
    },

    async searchWorkspace(root, query, limit) {
      const a = api();
      if (!a?.search_md) return { error: "bridge missing" };
      return a.search_md(root, query, limit);
    },

    async workspaceFiles(root) {
      const a = api();
      if (!a?.workspace_files) return { error: "bridge missing" };
      return a.workspace_files(root);
    },

    sanitizeUntrustedMarkdown,
  };

  // Built-in document tools (always available for AI layer)
  agent.registerTool({
    name: "get_document",
    description: "读取当前 Markdown 文档全文与路径",
    source: "builtin",
    run: async () => agent.getDocument(),
  });
  agent.registerTool({
    name: "set_document",
    description: "写入当前 Markdown 文档（默认做脚本清洗）",
    source: "builtin",
    run: async (args) => agent.setDocument(args && args.text, args),
  });
  agent.registerTool({
    name: "get_outline",
    description: "获取当前文档大纲",
    source: "builtin",
    run: async () => agent.getOutline(),
  });
  agent.registerTool({
    name: "memory_get",
    description: "按 key 读取 AI 记忆",
    source: "builtin",
    run: async (args) => agent.memoryGet(args && args.key),
  });
  agent.registerTool({
    name: "memory_set",
    description: "按 key 写入 AI 记忆",
    source: "builtin",
    run: async (args) => agent.memorySet(args && args.key, args && args.content),
  });
  agent.registerTool({
    name: "search_workspace",
    description: "在工作区目录全文搜索 Markdown",
    source: "builtin",
    run: async (args) =>
      agent.searchWorkspace(args && args.root, args && args.query, args && args.limit),
  });

  global.StuartAgent = agent;
  // Short alias for AI host
  global.Stuart = agent;
})(typeof window !== "undefined" ? window : globalThis);
