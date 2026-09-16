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
    import_wallpaper: (b64, name) => invoke("stuart_import_wallpaper", { b64, name }),
    get_wallpaper: () => invoke("stuart_get_wallpaper"),
    open_welcome: () => invoke("stuart_open_welcome"),
    file_exists: (path) => invoke("stuart_file_exists", { path }),
    // Dialogs: use tauri-plugin-dialog if present; otherwise stub
    open_file_dialog: async () => {
      if (window.__TAURI__?.dialog?.open) {
        const path = await window.__TAURI__.dialog.open({ multiple: false });
        if (!path) return null;
        return api.read_file(path);
      }
      return { error: "请使用文件菜单或系统对话框（Tauri scaffold）" };
    },
    save_file_dialog: async (content, suggested) => {
      if (window.__TAURI__?.dialog?.save) {
        const path = await window.__TAURI__.dialog.save({ defaultPath: suggested || "untitled.md" });
        if (!path) return null;
        return api.write_file(path, content || "");
      }
      return { error: "另存为需要 dialog 插件" };
    },
    open_folder_dialog: async () => {
      if (window.__TAURI__?.dialog?.open) {
        const path = await window.__TAURI__.dialog.open({ directory: true });
        return path || null;
      }
      return null;
    },
  };

  window.pywebview = window.pywebview || {};
  window.pywebview.api = api;
  // Fire ready so app.js onReady path works
  setTimeout(() => {
    window.dispatchEvent(new Event("pywebviewready"));
  }, 0);
})();
