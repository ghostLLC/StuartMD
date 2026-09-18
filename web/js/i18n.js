/* StuartMD i18n — zh-CN / zh-TW / en-US */
(function () {
  "use strict";
  const dict = {
    "zh-CN": {
      file: "文件",
      newDoc: "新建文档",
      open: "打开文件…",
      openFolder: "打开文件夹…",
      openSample: "打开示例",
      save: "保存",
      saveAs: "另存为…",
      exportHtml: "导出 HTML…",
      print: "打印 / 另存为 PDF…",
      newWindow: "新窗口打开当前文档",
      emptyWindow: "新建空窗口",
      read: "阅读",
      split: "分栏",
      source: "源码",
      find: "查找",
      outline: "大纲",
      theme: "切换主题",
      settings: "设置",
      sidebar: "侧边栏",
      more: "更多",
      light: "浅色",
      gray: "灰色",
      dark: "深色",
      sepia: "羊皮纸",
      minion: "小黄人",
      glass: "毛玻璃",
      wallpaper: "壁纸",
      uploadWallpaper: "上传壁纸图片…",
      clearWallpaper: "移除壁纸",
      language: "语言",
      plugins: "插件",
      autosave: "自动保存",
      highlight: "标黄",
      erase: "擦除",
      copy: "复制",
      clear: "清除",
      saved: "已保存",
      noFile: "未打开文件",
      words: "字",
      lines: "行",
      pluginHint: "将 .js 插件放入插件目录后重启，即可即插即用。",
      openPluginDir: "打开插件目录",
      wallpaperHint: "上传图片后自动提取主色，用于界面强调色。",
    },
    "zh-TW": {
      file: "檔案",
      newDoc: "新增文件",
      open: "開啟檔案…",
      openFolder: "開啟資料夾…",
      openSample: "開啟範例",
      save: "儲存",
      saveAs: "另存新檔…",
      exportHtml: "匯出 HTML…",
      print: "列印 / 另存 PDF…",
      newWindow: "新視窗開啟目前文件",
      emptyWindow: "新增空白視窗",
      read: "閱讀",
      split: "並排",
      source: "原始碼",
      find: "尋找",
      outline: "大綱",
      theme: "切換主題",
      settings: "設定",
      sidebar: "側邊欄",
      more: "更多",
      light: "淺色",
      gray: "灰色",
      dark: "深色",
      sepia: "羊皮紙",
      minion: "小小兵",
      glass: "毛玻璃",
      wallpaper: "桌布",
      uploadWallpaper: "上傳桌布圖片…",
      clearWallpaper: "移除桌布",
      language: "語言",
      plugins: "外掛",
      autosave: "自動儲存",
      highlight: "標黃",
      erase: "擦除",
      copy: "複製",
      clear: "清除",
      saved: "已儲存",
      noFile: "尚未開啟檔案",
      words: "字",
      lines: "行",
      pluginHint: "將 .js 外掛放入外掛目錄後重新啟動即可使用。",
      openPluginDir: "開啟外掛目錄",
      wallpaperHint: "上傳圖片後會自動擷取主色作為介面強調色。",
    },
    "en-US": {
      file: "File",
      newDoc: "New document",
      open: "Open file…",
      openFolder: "Open folder…",
      openSample: "Open sample",
      save: "Save",
      saveAs: "Save as…",
      exportHtml: "Export HTML…",
      print: "Print / Save as PDF…",
      newWindow: "Open current in new window",
      emptyWindow: "New empty window",
      read: "Read",
      split: "Split",
      source: "Source",
      find: "Find",
      outline: "Outline",
      theme: "Switch theme",
      settings: "Settings",
      sidebar: "Sidebar",
      more: "More",
      light: "Light",
      gray: "Gray",
      dark: "Dark",
      sepia: "Sepia",
      minion: "Minion",
      glass: "Frosted",
      wallpaper: "Wallpaper",
      uploadWallpaper: "Upload wallpaper…",
      clearWallpaper: "Remove wallpaper",
      language: "Language",
      plugins: "Plugins",
      autosave: "Auto-save",
      highlight: "Highlight",
      erase: "Erase",
      copy: "Copy",
      clear: "Clear",
      saved: "Saved",
      noFile: "No file open",
      words: "chars",
      lines: "lines",
      pluginHint: "Drop .js plugins into the plugins folder and restart.",
      openPluginDir: "Open plugins folder",
      wallpaperHint: "Upload an image; main color is used as accent.",
    },
  };

  let current = "zh-CN";

  function detect() {
    try {
      const saved = localStorage.getItem("StuartMD-lang");
      if (saved && dict[saved]) return saved;
    } catch (_) {}
    const nav = (navigator.language || "zh-CN").toLowerCase();
    if (nav.startsWith("zh-tw") || nav.startsWith("zh-hk") || nav.startsWith("zh-hant")) return "zh-TW";
    if (nav.startsWith("zh")) return "zh-CN";
    if (nav.startsWith("en")) return "en-US";
    return "zh-CN";
  }

  function t(key) {
    return (dict[current] && dict[current][key]) || dict["zh-CN"][key] || key;
  }

  function applyStatic() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    document.documentElement.lang = current === "zh-TW" ? "zh-Hant" : current === "en-US" ? "en" : "zh-Hans";
  }

  function setLang(lang) {
    if (!dict[lang]) lang = "zh-CN";
    current = lang;
    try {
      localStorage.setItem("StuartMD-lang", lang);
    } catch (_) {}
    applyStatic();
    if (window.pywebview?.api?.save_settings) {
      window.pywebview.api.save_settings({ language: lang }).catch(() => {});
    }
    window.dispatchEvent(new CustomEvent("stuart-lang", { detail: lang }));
  }

  function init() {
    current = detect();
    if (window.pywebview?.api?.get_settings) {
      window.pywebview.api
        .get_settings()
        .then((s) => {
          if (s?.language && dict[s.language]) current = s.language;
          applyStatic();
        })
        .catch(() => applyStatic());
    } else {
      applyStatic();
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  window.StuartI18n = {
    t,
    setLang,
    get lang() {
      return current;
    },
    languages: Object.keys(dict),
    apply: applyStatic,
  };
})();
