// StuartMD — runtime bridge: prefer Tauri invoke; else leave pywebview as-is.
// Loaded before app.js. Does not change pywebview behavior when Tauri is absent.
(function () {
  "use strict";
  if (!window.__TAURI__ && !window.__TAURI_INTERNALS__) return;

  function invoke(cmd, args) {
    // Tauri v2 global
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args || {});
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    }
    return Promise.reject(new Error("tauri invoke missing"));
  }

  const api = {
    get_app_info: () => invoke("stuart_get_app_info"),
    get_settings: () => invoke("stuart_get_settings"),
    save_settings: (data) => invoke("stuart_save_settings", { data }),
    read_file: (path) => invoke("stuart_read_file", { path }),
    write_file: (path, content) => invoke("stuart_write_file", { path, content }),
    read_pdf: (path) => invoke("stuart_read_pdf", { path }),
    read_dir_tree: (path) => invoke("stuart_read_dir_tree", { path }),
    open_in_new_window: (path) => invoke("stuart_open_in_new_window", { path }),
    open_url: (url) => invoke("stuart_open_url", { url }),
    check_update: () => invoke("stuart_check_update"),
    list_plugins: () => invoke("stuart_list_plugins"),
    read_plugin_source: (path) => invoke("stuart_read_plugin_source", { path }),
    import_wallpaper: (b64, name) => invoke("stuart_import_wallpaper_ex", { b64, name }),
    get_wallpaper: () => invoke("stuart_get_wallpaper"),
    open_welcome: () => invoke("stuart_open_welcome"),
    open_sample: () => invoke("stuart_open_sample"),
    file_exists: (path) => invoke("stuart_file_exists", { path }),
    resolve_asset: (base, rel) => invoke("stuart_resolve_asset", { baseFile: base, rel }),
    open_data_dir: () => invoke("stuart_open_data_dir"),
    open_plugins_dir: () => invoke("stuart_open_plugins_dir"),
    open_default_apps_settings: () => invoke("stuart_open_default_apps_settings"),
    get_file_association_status: () => invoke("stuart_get_file_association_status"),
    register_file_association: () => invoke("stuart_register_file_association"),
    load_annotations: (path) => invoke("stuart_load_annotations", { pdfPath: path }),
    save_annotations: (path, items) => invoke("stuart_save_annotations", { pdfPath: path, items }),
    add_annotation: (path, ann) => invoke("stuart_add_annotation", { pdfPath: path, ann }),
    delete_annotation: (path, id) => invoke("stuart_delete_annotation", { pdfPath: path, annId: id }),
    clear_annotations: (path) => invoke("stuart_clear_annotations", { pdfPath: path }),
    // Dialogs: use tauri-plugin-dialog if present; otherwise stub
    open_file_dialog: async () => {
      if (window.__TAURI__?.dialog?.open) {
        const path = await window.__TAURI__.dialog.open({
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
      return { error: "请使用文件菜单或系统对话框" };
    },
    save_file_dialog: async (content, suggested) => {
      if (window.__TAURI__?.dialog?.save) {
        const path = await window.__TAURI__.dialog.save({
          defaultPath: suggested || "untitled.md",
          filters: [
            { name: "Markdown", extensions: ["md", "markdown"] },
            { name: "文本", extensions: ["txt"] },
          ],
        });
        if (!path) return null;
        return api.write_file(path, content || "");
      }
      return { error: "另存为需要 dialog 插件" };
    },
    open_folder_dialog: async () => {
      if (window.__TAURI__?.dialog?.open) {
        const path = await window.__TAURI__.dialog.open({ directory: true, multiple: false });
        return path || null;
      }
      return null;
    },
    clear_wallpaper: () => invoke("stuart_save_settings", { data: { wallpaper: {}, theme: "light" } }).then(() => ({ ok: true })),
  };

  window.pywebview = window.pywebview || {};
  window.pywebview.api = api;
  // Fire ready so app.js onReady path works
  setTimeout(() => {
    window.dispatchEvent(new Event("pywebviewready"));
  }, 0);
})();
