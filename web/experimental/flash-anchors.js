// web/js/ui/flash-anchors.js
/**
 * StuartMD Bidirectional Flash Anchors
 * Provides millisecond precision jump-to-source and visual golden pulse feedback.
 */
(function (global) {
  "use strict";

  class FlashAnchors {
    constructor() {
      this.currentPulseTimer = null;
    }

    /**
     * Parses anchor URI: stuart://anchor?file=...&line=...&end=...&page=...
     */
    parseAnchorUri(uri) {
      if (!uri) return null;
      try {
        const queryIdx = uri.indexOf("?");
        if (queryIdx === -1) return null;
        const search = uri.slice(queryIdx + 1);
        const params = new URLSearchParams(search);
        return {
          file: params.get("file"),
          line: params.get("line") ? parseInt(params.get("line"), 10) : null,
          endLine: params.get("end") ? parseInt(params.get("end"), 10) : null,
          page: params.get("page") ? parseInt(params.get("page"), 10) : null,
        };
      } catch (err) {
        console.error("[FlashAnchors] Failed to parse anchor:", uri, err);
        return null;
      }
    }

    /**
     * Executes jump to document and highlights target line or page
     */
    async jumpToAnchor(uri) {
      const anchor = this.parseAnchorUri(uri);
      if (!anchor || !anchor.file) return;

      console.info("[FlashAnchors] Jumping to anchor:", anchor);

      // Check if file is already active
      const currentPath = global.currentFilePath || "";
      const isSameFile = currentPath.endsWith(anchor.file) || anchor.file.endsWith(currentPath);

      if (!isSameFile && global.openFileByPath) {
        await global.openFileByPath(anchor.file);
        // Wait for DOM render
        await new Promise((r) => setTimeout(r, 200));
      }

      // 1. PDF Page Jump
      if (anchor.page != null && global.StuartPdfViewer && global.StuartPdfViewer.jumpToPage) {
        global.StuartPdfViewer.jumpToPage(anchor.page);
        this.pulseElement(document.getElementById("pdf-viewport") || document.body);
        return;
      }

      // 2. Markdown Line Jump (Editor or Preview)
      if (anchor.line != null) {
        this.highlightEditorOrPreviewLine(anchor.line, anchor.endLine);
      }
    }

    highlightEditorOrPreviewLine(startLine, endLine) {
      // Check for editor line elements or preview block anchors
      const preview = document.getElementById("preview-container") || document.getElementById("preview");
      if (preview) {
        // Find nearest block by data-line or text content
        const lineSelector = `[data-line="${startLine}"]`;
        let targetEl = preview.querySelector(lineSelector);

        if (!targetEl) {
          // Fallback: search child headings or paragraphs
          const blocks = preview.querySelectorAll("h1, h2, h3, h4, p, pre, blockquote, table");
          if (blocks.length > 0) {
            const index = Math.min(Math.max(0, startLine - 1), blocks.length - 1);
            targetEl = blocks[index];
          }
        }

        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
          this.pulseElement(targetEl);
          return;
        }
      }

      // Editor textarea/CodeMirror fallback
      const editorArea = document.getElementById("editor");
      if (editorArea) {
        editorArea.scrollIntoView({ behavior: "smooth", block: "center" });
        this.pulseElement(editorArea);
      }
    }

    pulseElement(el) {
      if (!el) return;
      el.classList.remove("stuart-flash-pulse");
      // Trigger reflow
      void el.offsetWidth;
      el.classList.add("stuart-flash-pulse");

      if (this.currentPulseTimer) clearTimeout(this.currentPulseTimer);
      this.currentPulseTimer = setTimeout(() => {
        el.classList.remove("stuart-flash-pulse");
      }, 2000);
    }
  }

  global.StuartFlashAnchors = new FlashAnchors();
})(window);
