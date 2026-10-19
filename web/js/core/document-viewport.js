(function (global) {
  "use strict";
  const core = typeof module === "object" ? require("./text-buffer.js") : global.StuartCore;

  class DocumentViewport {
    constructor({ preview, previewPane, source, editorArea }) {
      this.preview = preview;
      this.pane = previewPane;
      this.source = source;
      this.area = editorArea;
      this.window = preview.ownerDocument.defaultView;
      this.document = null;
      this.mode = "preview";
      this.epoch = 0;
      this.binding = 0;
      this.renderedText = "";
      this.restoring = null;
      this.frame = null;
      this.ready = false;
      this.userScrolling = false;
      this.sourceMoving = false;
    }
    visible(part) {
      return this.document?.kind === "markdown" && !this.area.hidden &&
        (part === "preview" ? this.mode !== "source" : this.mode !== "preview");
    }
    ticket() {
      return { document: this.document, revision: this.document?.revision, epoch: this.epoch };
    }
    current(ticket) {
      return ticket.document === this.document && ticket.revision === this.document?.revision && ticket.epoch === this.epoch;
    }
    cancelRestore() {
      this.epoch++;
      this.restoring = null;
      if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    userIntent() {
      this.userScrolling = true;
      this.cancelRestore();
    }
    detach() {
      this.cancelRestore();
      this.binding++;
      this.document = null;
      this.ready = false;
    }
    attach(document, mode) {
      this.detach();
      this.document = document;
      this.mode = mode;
      this.renderedText = document.buffer.editorText;
      this.userScrolling = false;
      this.sourceMoving = false;
      // 共享容器在装入正文前清除上一个文件的位置。
      this.pane.scrollTop = 0;
      this.pane.scrollLeft = 0;
      this.source.scrollTop = 0;
      this.source.scrollLeft = 0;
    }
    capturePreview() {
      if (!this.ready || !this.visible("preview") || this.pane.clientHeight === 0 || this.restoring) return;
      const top = this.pane.getBoundingClientRect().top + this.pane.clientTop;
      const nodes = Array.from(this.preview.children).filter(node => node.matches(".md-block[data-source-offset]"));
      if (!nodes.length) return;
      const node = nodes.find(item => item.getBoundingClientRect().bottom > top);
      let anchor = null;
      if (node) {
        const offset = Number(node.dataset.sourceOffset);
        const edits = core.editsBetween(this.renderedText, this.document.buffer.editorText);
        anchor = { offset: core.mapTextOffset(offset, edits), top: node.getBoundingClientRect().top - top };
      }
      this.document.viewState.preview = { top: this.pane.scrollTop, left: this.pane.scrollLeft, anchor };
    }
    captureSource() {
      if (!this.visible("source") || this.source.clientHeight === 0) return;
      const layout = this.sourceLayout();
      const previous = this.document.viewState.source;
      if (previous?.anchor && previous.layout !== layout && !this.sourceMoving) return;
      const selection = { start: this.source.selectionStart, end: this.source.selectionEnd, direction: this.source.selectionDirection };
      if (previous?.anchor && previous.layout === layout && previous.top === this.source.scrollTop && previous.left === this.source.scrollLeft) {
        Object.assign(previous, selection);
        return;
      }
      let low = 0, high = this.source.value.length;
      const height = parseFloat(this.window.getComputedStyle(this.source).lineHeight);
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.caret(middle).top + height > this.source.scrollTop) high = middle;
        else low = middle + 1;
      }
      const offset = this.characterBoundary(low);
      this.document.viewState.source = {
        top: this.source.scrollTop, left: this.source.scrollLeft,
        ...selection,
        anchor: { offset, top: this.caret(offset).top - this.source.scrollTop }, layout,
      };
    }
    characterBoundary(offset) {
      const text = this.source.value;
      return offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]) ? offset - 1 : offset;
    }
    caret(offset) {
      return this.window.getCaretCoordinates(this.source, this.characterBoundary(offset));
    }
    sourceLayout() {
      const style = this.window.getComputedStyle(this.source);
      return [this.source.clientWidth, style.fontFamily, style.fontSize, style.lineHeight, style.tabSize].join("|");
    }
    capture() {
      this.capturePreview();
      this.captureSource();
    }
    restoreSource(selection = true) {
      if (!this.visible("source")) return;
      const position = this.document.viewState.source;
      if (selection) this.source.setSelectionRange(position?.start ?? 0, position?.end ?? 0, position?.direction ?? "none");
      this.source.scrollTop = position?.anchor && this.source.clientHeight > 0 ?
        Math.max(0, this.caret(position.anchor.offset).top - position.anchor.top) : position?.top ?? 0;
      this.source.scrollLeft = position?.left ?? 0;
      if (position && this.source.clientHeight > 0) position.layout = this.sourceLayout();
      if (selection) this.sourceMoving = false;
    }
    navigateSource(start, end, marginLines = 1) {
      this.sourceMoving = true;
      this.source.focus({ preventScroll: true });
      this.source.setSelectionRange(start, end);
      const height = parseFloat(this.window.getComputedStyle(this.source).lineHeight);
      this.source.scrollTop = Math.max(0, this.caret(start).top - marginLines * height);
      this.captureSource();
      this.sourceMoving = false;
    }
    restorePreview(ticket) {
      if (!this.current(ticket) || !this.visible("preview") || this.pane.clientHeight === 0) return;
      const position = this.document.viewState.preview;
      let top = position?.top ?? 0;
      if (position?.anchor) {
        const nodes = Array.from(this.preview.children).filter(node => node.matches(".md-block[data-source-offset]"));
        const node = nodes.find(item => Number(item.dataset.sourceEnd) > position.anchor.offset) || nodes.at(-1);
        if (node) top = this.pane.scrollTop + node.getBoundingClientRect().top -
          this.pane.getBoundingClientRect().top - this.pane.clientTop - position.anchor.top;
      }
      this.pane.scrollTop = Math.max(0, top);
      this.pane.scrollLeft = position?.left ?? 0;
    }
    scheduleRestore() {
      if (!this.ready || !this.visible("preview") || this.frame !== null) return;
      const ticket = this.ticket();
      this.restoring = ticket;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = null;
        this.restorePreview(ticket);
      });
    }
    rendered() {
      if (!this.document) return;
      this.renderedText = this.document.buffer.editorText;
      this.ready = true;
      this.userScrolling = false;
      this.cancelRestore();
      this.restoring = this.ticket();
      this.restorePreview(this.restoring);
      this.scheduleRestore();
    }
    changeMode(mode) {
      this.capture();
      this.cancelRestore();
      this.mode = mode;
    }
    bind() {
      const navigationKey = event => event.type !== "keydown" || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        this.pane.addEventListener(type, event => { if (navigationKey(event)) this.userIntent(); }, { capture: true, passive: true });
        this.source.addEventListener(type, () => { this.sourceMoving = true; }, { capture: true, passive: true });
      }
      this.source.addEventListener("keyup", () => { this.captureSource(); this.sourceMoving = false; });
      this.window.addEventListener("pointerup", () => {
        if (this.sourceMoving) { this.captureSource(); this.sourceMoving = false; }
      }, { passive: true });
      this.pane.addEventListener("scroll", () => {
        this.capturePreview();
      }, { passive: true });
      this.pane.addEventListener("scrollend", () => {
        this.capturePreview();
        this.userScrolling = false;
      }, { passive: true });
      this.source.addEventListener("scrollend", () => { this.captureSource(); this.sourceMoving = false; }, { passive: true });
      this.observer = new this.window.ResizeObserver(() => {
        if (!this.userScrolling && this.renderedText === this.document?.buffer.editorText) this.scheduleRestore();
        if (!this.sourceMoving) this.restoreSource(false);
      });
      this.observer.observe(this.preview);
      this.observer.observe(this.pane);
      this.observer.observe(this.source);
      this.preview.ownerDocument.fonts.addEventListener("loadingdone", () => {
        if (!this.userScrolling) this.scheduleRestore();
        if (!this.sourceMoving) this.restoreSource(false);
      });
    }
  }
  global.StuartCore = global.StuartCore || {};
  global.StuartCore.DocumentViewport = DocumentViewport;
  if (typeof module === "object") module.exports = { DocumentViewport };
})(typeof window !== "undefined" ? window : globalThis);
