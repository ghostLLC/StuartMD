(function (global) {
  "use strict";
  let queue = Promise.resolve();
  function render(code, theme, valid) {
    const operation = queue.then(async () => {
      await document.fonts.ready;
      if (!valid()) return null;
      if (!global.mermaid) throw new Error("Mermaid资源尚未加载");
      const container = document.createElement("div");
      container.className = "mermaid-measure";
      container.style.cssText = "position:fixed;left:0;top:100vh;width:1200px;opacity:0;pointer-events:none;overflow:visible";
      document.body.append(container);
      try {
        global.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" || theme === "gray" ? "dark" : "default",
          fontFamily: "Segoe UI, Microsoft YaHei, sans-serif", fontSize: 14,
          flowchart: { htmlLabels: true, useMaxWidth: false, padding: 12 },
          themeVariables: { fontSize: "14px", fontFamily: "Segoe UI, Microsoft YaHei, sans-serif" } });
        const result = await global.mermaid.render("diagram-" + crypto.randomUUID(), code, container);
        if (!valid()) return null;
        const wrapper = document.createElement("div");
        wrapper.className = "mermaid-diagram";
        wrapper.innerHTML = global.DOMPurify.sanitize(result.svg, {
          USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ["foreignObject", "style"],
          ADD_ATTR: ["dominant-baseline", "xmlns", "xmlns:xlink"], FORBID_TAGS: ["script", "iframe", "object", "embed", "a", "animate", "set"],
        });
        const svg = wrapper.querySelector("svg");
        if (!svg || !svg.viewBox.baseVal.width || !svg.viewBox.baseVal.height) throw new Error("Mermaid图表没有有效尺寸");
        svg.style.width = Math.min(svg.viewBox.baseVal.width, 900) + "px";
        svg.style.maxWidth = "100%"; svg.style.height = "auto";
        return wrapper;
      } finally { container.remove(); }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  global.StuartMermaidRenderer = { render };
})(window);
