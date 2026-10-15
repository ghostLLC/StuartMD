(function (global) {
  "use strict";
  let parser;
  const renders = new WeakMap();
  function getParser() {
    if (parser) return parser;
    if (!global.markdownit || !global.texmath || !global.katex) throw new Error("Markdown 与公式资源尚未加载");
    parser = global.markdownit({ html: false, linkify: true, breaks: false });
    parser.use(global.texmath, { engine: global.katex, delimiters: ["dollars", "brackets"], katexOptions: { trust: false, throwOnError: true } });
    for (const name of ["math_inline", "math_inline_double", "math_block", "math_block_eqno"]) {
      parser.renderer.rules[name] = (tokens, index) => {
        const token = tokens[index], displayMode = name !== "math_inline";
        const formula = global.katex.renderToString(token.content, { displayMode, trust: false, throwOnError: true });
        return name === "math_block_eqno" ? `<div class="sc-math-numbered">${formula}<span>(${parser.utils.escapeHtml(token.info)})</span></div>` : formula;
      };
    }
    const fence = parser.renderer.rules.fence;
    parser.renderer.rules.fence = (tokens, index, options, env, renderer) => {
      const token = tokens[index];
      if (token.info.trim().split(/\s+/)[0] !== "mermaid" || env.streaming) return fence(tokens, index, options, env, renderer);
      const diagram = env.diagrams.push(token.content) - 1;
      return `<div class="sc-diagram" data-diagram="${diagram}"><pre><code>${parser.utils.escapeHtml(token.content)}</code></pre></div>`;
    };
    const link = parser.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
    parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
      const token = tokens[index], href = token.attrGet("href") || "";
      const id = href.replace(/^(?:stuart-source:|source:\/\/|source:|#source-|#)/, "");
      const source = env.sources.find(item => item.sourceId === id);
      if (source) { token.attrSet("href", "#"); token.attrSet("data-source-id", id); }
      else if (/^(?:stuart-source:|source:|#source-)/.test(href) || /^S\d+$/.test(id)) {
        token.attrSet("href", "#"); token.attrSet("data-unverified-source", "true"); token.attrSet("title", "来源未核验");
      }
      return link(tokens, index, options, env, renderer);
    };
    return parser;
  }
  function sourcesFor(message) {
    const anchor = message.sourceAnchor || {};
    const sources = message.sources || anchor.sources || anchor.validatedContext?.sources || anchor.usedSources || [];
    return Array.isArray(sources) ? sources : Object.values(sources);
  }
  async function render(container, message, options = {}) {
    const revision = (renders.get(container) || 0) + 1;
    renders.set(container, revision);
    const valid = () => renders.get(container) === revision && container.isConnected;
    const env = { streaming: !!options.streaming, diagrams: [], sources: sourcesFor(message) };
    let html;
    try { html = getParser().render(String(message.content || ""), env); }
    catch (error) { const source = document.createElement("pre"); source.textContent = String(message.content || ""); container.replaceChildren(source); throw error; }
    container.innerHTML = global.DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true }, ADD_ATTR: ["data-diagram", "data-source-id", "data-unverified-source"], FORBID_TAGS: ["script", "iframe", "object", "embed"] });
    for (const table of container.querySelectorAll("table")) {
      const wrapper = document.createElement("div"); wrapper.className = "sc-table-scroll"; table.before(wrapper); wrapper.append(table);
    }
    for (const anchor of container.querySelectorAll("a")) {
      if (anchor.dataset.sourceId) {
        anchor.addEventListener("click", event => { event.preventDefault(); options.onSource?.(env.sources.find(item => item.sourceId === anchor.dataset.sourceId), message); });
      } else if (anchor.dataset.unverifiedSource) {
        anchor.addEventListener("click", event => event.preventDefault());
        anchor.setAttribute("aria-label", `${anchor.textContent}，来源未核验`);
        const label = document.createElement("span"); label.className = "sc-card-meta"; label.textContent = "（来源未核验）"; anchor.after(label);
      } else { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    }
    if (env.sources.length) {
      const sources = document.createElement("details"); sources.className = "sc-answer-sources";
      const title = document.createElement("summary"); title.textContent = `本次来源 ${env.sources.length} 项`; sources.append(title);
      for (const source of env.sources) {
        const item = document.createElement("div"); item.className = "sc-reference";
        const label = document.createElement("button"); label.type = "button"; label.className = "btn sm"; label.textContent = source.title || source.kind;
        label.addEventListener("click", () => options.onSource?.(source, message));
        const meta = document.createElement("div"); meta.className = "sc-card-meta"; meta.textContent = [source.mandatory ? "明确引用" : "自动材料", source.used ? "本次已使用" : "本次未使用"].join(" · ");
        const excerpt = document.createElement("div"); excerpt.className = "sc-reference-excerpt"; excerpt.textContent = source.excerpt;
        item.append(label, meta, excerpt); sources.append(item);
      }
      container.append(sources);
    }
    const mathError = container.querySelector(".katex-error");
    if (mathError) throw new Error(`公式解析失败：${mathError.getAttribute("title") || mathError.textContent}`);
    for (const element of container.querySelectorAll("[data-diagram]")) {
      const code = env.diagrams[Number(element.dataset.diagram)];
      try {
        const diagram = await global.StuartMermaidRenderer.render(code, global.StuartMD?.state?.theme, valid);
        if (valid() && diagram) element.replaceChildren(diagram);
      } catch (error) { throw new Error(`图表解析失败：${error.message || String(error)}`); }
    }
  }
  global.StuartMessageRenderer = { render, getParser, sourcesFor };
})(typeof window !== "undefined" ? window : globalThis);
