// web/js/ui/companion-renderer.js
/**
 * StuartMD Streaming Markdown Renderer with RAF 100ms Debounce
 * Handles auto-closing syntax guards (``` and $$) and stuart://anchor deep-links.
 */
(function (global) {
  "use strict";

  class CompanionRenderer {
    constructor() {
      this.rafPending = false;
      this.lastRenderTime = 0;
      this.pendingText = "";
      this.targetEl = null;
      this.onRenderComplete = null;
    }

    /**
     * Completes unclosed Markdown code blocks and LaTeX math blocks during streaming
     */
    sanitizeStreamingMarkdown(text) {
      if (!text) return "";
      let sanitized = text;

      // 1. Auto-close code fences
      const fenceMatches = sanitized.match(/```/g);
      if (fenceMatches && fenceMatches.length % 2 !== 0) {
        sanitized += "\n```";
      }

      // 2. Auto-close display math blocks ($$)
      const displayMathMatches = sanitized.match(/\$\$/g);
      if (displayMathMatches && displayMathMatches.length % 2 !== 0) {
        sanitized += "\n$$";
      }

      return sanitized;
    }

    /**
     * Throttled streaming update using RequestAnimationFrame (100ms minimum window)
     */
    streamUpdate(targetEl, rawMarkdown, onComplete) {
      this.targetEl = targetEl;
      this.pendingText = rawMarkdown;
      this.onRenderComplete = onComplete;

      const now = performance.now();
      if (!this.rafPending && now - this.lastRenderTime >= 100) {
        this.renderImmediate();
      } else if (!this.rafPending) {
        this.rafPending = true;
        const delay = Math.max(0, 100 - (now - this.lastRenderTime));
        setTimeout(() => {
          requestAnimationFrame(() => {
            this.rafPending = false;
            this.renderImmediate();
          });
        }, delay);
      }
    }

    renderImmediate() {
      if (!this.targetEl) return;
      this.lastRenderTime = performance.now();
      const safeText = this.sanitizeStreamingMarkdown(this.pendingText);

      // Render markdown using markdown-it if available, or fallback
      let html = "";
      if (global.markdownit) {
        const md = global.markdownit({
          html: false,
          linkify: true,
          breaks: true,
        });
        html = md.render(safeText);
      } else {
        html = `<pre>${escapeHtml(safeText)}</pre>`;
      }

      this.targetEl.innerHTML = html;

      // Render LaTeX math formulas with KaTeX if present
      if (global.renderMathInElement) {
        try {
          global.renderMathInElement(this.targetEl, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false },
            ],
            throwOnError: false,
          });
        } catch (_) {}
      }

      // Bind stuart://anchor deep-links
      this.bindDeepLinks(this.targetEl);

      if (typeof this.onRenderComplete === "function") {
        this.onRenderComplete(this.targetEl);
      }
    }

    bindDeepLinks(container) {
      if (!container) return;
      const links = container.querySelectorAll('a[href^="stuart://anchor"]');
      links.forEach((a) => {
        a.classList.add("stuart-flash-anchor-link");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const href = a.getAttribute("href");
          if (global.StuartFlashAnchors && global.StuartFlashAnchors.jumpToAnchor) {
            global.StuartFlashAnchors.jumpToAnchor(href);
          } else {
            console.log("[CompanionRenderer] Flash anchor clicked:", href);
          }
        });
      });
    }

    renderFinal(targetEl, finalMarkdown) {
      this.targetEl = targetEl;
      this.pendingText = finalMarkdown;
      this.renderImmediate();
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  global.StuartCompanionRenderer = new CompanionRenderer();
})(window);
