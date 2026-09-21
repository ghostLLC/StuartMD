// StuartMD — runtime bridge: prefer Tauri invoke; else leave pywebview as-is.
// Loaded before app.js. Does not change pywebview behavior when Tauri is absent.
(function () {
  "use strict";
  if (!window.__TAURI__ && !window.__TAURI_INTERNALS__) return;

  function invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args || {});
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    }
    return Promise.reject(new Error("tauri invoke missing"));
  }

  function dialogApi() {
    return window.__TAURI__?.dialog || null;
  }

  const api = {
    get_app_info: () => invoke("stuart_get_app_info"),
    get_settings: () => invoke("stuart_get_settings"),
    save_settings: (data) => invoke("stuart_save_settings", { data }),
    read_file: (path) => invoke("stuart_read_file", { path }),
    write_file: (path, content) => invoke("stuart_write_file", { path, content }),
    read_pdf: (path) => invoke("stuart_read_pdf", { path }),
    read_dir_tree: (path) => invoke("stuart_read_dir_tree", { path }),
    get_recents: () => invoke("stuart_get_recents"),
    open_path: (path) => invoke("stuart_open_path", { path }),
    open_in_new_window: (path) => invoke("stuart_open_in_new_window", { path }),
    open_new_window: () => invoke("stuart_open_new_window"),
    open_url: (url) => invoke("stuart_open_url", { url }),
    check_update: () => invoke("stuart_check_update"),
    list_plugins: () => invoke("stuart_list_plugins"),
    read_plugin_source: (path) => invoke("stuart_read_plugin_source", { path }),
    set_plugin_enabled: (pluginId, enabled) =>
      invoke("stuart_set_plugin_enabled", { pluginId, enabled }),
    import_wallpaper: (b64, name) => invoke("stuart_import_wallpaper_ex", { b64, name }),
    get_wallpaper: () => invoke("stuart_get_wallpaper"),
    clear_wallpaper: () => invoke("stuart_clear_wallpaper"),
    open_welcome: () => invoke("stuart_open_welcome"),
    open_sample: () => invoke("stuart_open_sample"),
    file_exists: (path) => invoke("stuart_file_exists", { path }),
    resolve_asset: (base, rel) => invoke("stuart_resolve_asset", { baseFile: base, rel }),
    open_data_dir: () => invoke("stuart_open_data_dir"),
    open_plugins_dir: () => invoke("stuart_open_plugins_dir"),
    reveal_in_explorer: (path) => invoke("stuart_reveal_in_explorer", { path: path || null }),
    open_default_apps_settings: () => invoke("stuart_open_default_apps_settings"),
    get_file_association_status: () => invoke("stuart_get_file_association_status"),
    register_file_association: () => invoke("stuart_register_file_association"),
    load_annotations: (path) => invoke("stuart_load_annotations", { pdfPath: path }),
    save_annotations: (path, items) => invoke("stuart_save_annotations", { pdfPath: path, items }),
    add_annotation: (path, ann) => invoke("stuart_add_annotation", { pdfPath: path, ann }),
    delete_annotation: (path, id) =>
      invoke("stuart_delete_annotation", { pdfPath: path, annId: id }),
    clear_annotations: (path) => invoke("stuart_clear_annotations", { pdfPath: path }),
    export_pdf_annotations: (path, items) =>
      invoke("stuart_export_pdf_annotations", { pdfPath: path, items }),
    capture_window: () => invoke("stuart_capture_window"),
    apply_window_state: () => invoke("stuart_apply_window_state"),
    // AI / memory / tool surface (medium-term)
    get_capabilities: () => invoke("stuart_get_capabilities"),
    ai_home: () => invoke("stuart_ai_home"),
    memory_list: () => invoke("stuart_memory_list"),
    memory_get: (key) => invoke("stuart_memory_get", { key }),
    memory_set: (key, content) => invoke("stuart_memory_set", { key, content }),
    memory_delete: (key) => invoke("stuart_memory_delete", { key }),
    search_md: (root, query, limit) =>
      invoke("stuart_search_md", { root, query, limit: limit == null ? null : limit }),
    workspace_files: (root) => invoke("stuart_workspace_files", { root }),
    // AI 3.0.0
    ai_get_config: () => invoke("stuart_ai_get_config"),
    ai_save_config: (ai) => invoke("stuart_ai_save_config", { ai }),
    ai_set_api_key: (providerId, apiKey) =>
      invoke("stuart_ai_set_api_key", { providerId, apiKey }),
    ai_clear_api_key: (providerId) => invoke("stuart_ai_clear_api_key", { providerId }),
    ai_test_provider: (providerId) => invoke("stuart_ai_test_provider", { providerId }),
    ai_chat_start: (requestId, providerId, model, messages, thinking, maxOutputTokens) =>
      invoke("stuart_ai_chat_start", {
        requestId,
        providerId: providerId || null,
        model: model || null,
        messages,
        thinking: thinking || null,
        maxOutputTokens: maxOutputTokens == null ? null : maxOutputTokens,
      }),
    ai_chat_cancel: (requestId) => invoke("stuart_ai_chat_cancel", { requestId }),

    open_file_dialog: async () => {
      const dlg = dialogApi();
      if (dlg?.open) {
        const path = await dlg.open({
          multiple: false,
          filters: [
            { name: "文档", extensions: ["md", "markdown", "mdown", "mkd", "pdf", "txt"] },
            { name: "Markdown", extensions: ["md", "markdown"] },
            { name: "PDF", extensions: ["pdf"] },
            { name: "全部", extensions: ["*"] },
          ],
        });
        if (!path) return null;
        return api.read_file(path);
      }
      return { error: "系统文件对话框不可用" };
    },

    save_file_dialog: async (content, suggested) => {
      const dlg = dialogApi();
      if (dlg?.save) {
        const path = await dlg.save({
          defaultPath: suggested || "untitled.md",
          filters: [
            { name: "Markdown", extensions: ["md", "markdown"] },
            { name: "文本", extensions: ["txt"] },
          ],
        });
        if (!path) return null;
        let finalPath = path;
        if (!/\.(md|markdown|txt)$/i.test(finalPath)) finalPath += ".md";
        return api.write_file(finalPath, content || "");
      }
      return { error: "另存为需要系统对话框" };
    },

    open_folder_dialog: async () => {
      const dlg = dialogApi();
      if (dlg?.open) {
        const path = await dlg.open({ directory: true, multiple: false });
        return path || null;
      }
      return null;
    },

    export_html: async (html, suggested) => {
      const dlg = dialogApi();
      if (dlg?.save) {
        const path = await dlg.save({
          defaultPath: suggested || "export.html",
          filters: [{ name: "HTML", extensions: ["html", "htm"] }],
        });
        if (!path) return null;
        let finalPath = path;
        if (!/\.html?$/i.test(finalPath)) finalPath += ".html";
        return api.write_file(finalPath, html || "");
      }
      return invoke("stuart_export_html", { html: html || "", suggestedName: suggested || null });
    },
  };

  window.pywebview = window.pywebview || {};
  window.pywebview.api = api;
  setTimeout(() => {
    window.dispatchEvent(new Event("pywebviewready"));
  }, 0);
})();
