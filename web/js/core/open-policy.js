/**
 * StuartMD core — path & open policy (pure, testable).
 * Host: window.StuartCore.paths
 */
(function (global) {
  "use strict";

  function normalizePath(p) {
    return String(p || "").replace(/\//g, "\\");
  }

  function parentDir(p) {
    if (!p) return "";
    const parts = normalizePath(p).split("\\");
    parts.pop();
    return parts.join("\\");
  }

  function pathEqualsOrUnder(child, root) {
    if (!child || !root) return false;
    const c = normalizePath(child).toLowerCase();
    const r = normalizePath(root).toLowerCase().replace(/\\+$/, "");
    return c === r || c.startsWith(r + "\\");
  }

  function isWelcomeOrSamplePath(path, name) {
    const p = normalizePath(path).toLowerCase();
    const n = String(name || "");
    if (n === "欢迎使用 StuartMD.md" || n === "示例文档.md") return true;
    if (!path && n && n.includes("欢迎")) return true;
    if (p.includes("\\samples\\") || p.endsWith("\\samples")) {
      if (n.includes("示例") || n.includes("欢迎") || n.includes("sample")) {
        return true;
      }
    }
    return false;
  }

  function hasRealDocument(tabs, currentPath, currentName) {
    const list = Array.isArray(tabs) ? tabs : [];
    if (list.some((t) => t && t.path && !isWelcomeOrSamplePath(t.path, t.name))) {
      return true;
    }
    return !!(currentPath && !isWelcomeOrSamplePath(currentPath, currentName));
  }

  function workspaceRootFrom(state) {
    if (!state) return "";
    if (state.workspaceRoot) return state.workspaceRoot;
    if (state.folder) return state.folder;
    const tabs = state.tabs || [];
    const real = tabs.find((t) => t.path && !isWelcomeOrSamplePath(t.path, t.name));
    const src =
      real ||
      (state.path && !isWelcomeOrSamplePath(state.path, state.name)
        ? { path: state.path }
        : null);
    if (src && src.path) return parentDir(src.path);
    return "";
  }

  /**
   * Decide how a sidebar / smart open should land.
   * @returns {"focus"|"replace"|"add-tab"|"new-window"|"error"}
   */
  function decideSidebarOpen(opts) {
    const {
      path,
      openMode,
      tabs,
      activeTabId,
      currentPath,
      currentName,
      fromTree,
      forceTab,
    } = opts || {};
    if (fromTree || forceTab) return "add-tab";
    const active = (tabs || []).find((t) => t.id === activeTabId);
    if (path) {
      const exist = (tabs || []).find((t) => t.path === path);
      if (exist) return "focus";
    }
    const shouldReplace = (tabs || []).length > 0 && active && !active.pinned;
    if (shouldReplace) return "replace";
    if (openMode === "new_window" && path) return "new-window";
    return "add-tab";
  }

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.paths = {
    normalizePath,
    parentDir,
    pathEqualsOrUnder,
    isWelcomeOrSamplePath,
    hasRealDocument,
    workspaceRootFrom,
    decideSidebarOpen,
  };
})(typeof window !== "undefined" ? window : globalThis);
