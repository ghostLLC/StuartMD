(function (global) {
  "use strict";
  const diff = typeof module === "object" ? require("diff") : global.Diff;

  function mapSelectionOffset(changes, offset, start) {
    let before = 0, after = 0;
    for (let i = 0; i < changes.length; i++) {
      const part = changes[i];
      if (!part.added && !part.removed) {
        if (offset < before + part.value.length) return after + offset - before;
        before += part.value.length;
        after += part.value.length;
        continue;
      }
      let removed = 0, added = 0;
      while (i < changes.length && (changes[i].added || changes[i].removed)) {
        if (changes[i].removed) removed += changes[i].value.length;
        else added += changes[i].value.length;
        i++;
      }
      i--;
      if (offset === before) return after + (removed === 0 && start ? added : 0);
      if (offset <= before + removed) return after + (offset === before + removed || !start ? added : 0);
      before += removed;
      after += added;
    }
    return after;
  }

  class PreviewSelection {
    constructor(preview, commit, enabled = () => true) {
      this.preview = preview;
      this.document = preview.ownerDocument;
      this.selection = this.document.defaultView.getSelection();
      this.commit = commit;
      this.enabled = enabled;
      this.gesture = null;
    }

    offset(node, offset) {
      const range = this.document.createRange();
      range.selectNodeContents(this.preview);
      range.setEnd(node, offset);
      return range.toString().length;
    }

    point(offset, forward) {
      const walker = this.document.createTreeWalker(this.preview, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (offset < node.length || (!forward && offset === node.length)) return [node, offset];
        offset -= node.length;
      }
      return [this.preview, this.preview.childNodes.length];
    }

    commitSelection() {
      const sel = this.selection;
      if (!this.preview.contains(sel.anchorNode) || !this.preview.contains(sel.focusNode)) {
        this.commit();
        return;
      }
      const oldText = this.preview.textContent;
      const anchor = this.offset(sel.anchorNode, sel.anchorOffset);
      const focus = this.offset(sel.focusNode, sel.focusOffset);
      const forward = anchor <= focus;
      this.commit();
      // 编辑提交可能重新生成段落，按实际文字变化恢复正向或反向选区。
      const changes = diff.diffChars(oldText, this.preview.textContent);
      sel.setBaseAndExtent(...this.point(mapSelectionOffset(changes, anchor, forward), forward),
        ...this.point(mapSelectionOffset(changes, focus, !forward), !forward));
    }

    begin(event) {
      if (!this.enabled() || event.button !== 0 || !this.preview.contains(event.target) ||
          event.target.closest("button, input, textarea, select")) return;
      this.end(false);
      const blocks = [...this.preview.querySelectorAll(".md-block.editing")]
        .filter(block => !block.querySelector("textarea"));
      if (!blocks.length) return;
      const hosts = blocks.flatMap(block => [block, ...block.querySelectorAll("[contenteditable]")])
        .filter(host => host.hasAttribute("contenteditable"));
      this.gesture = { blocks, hosts: hosts.map(host => [host, host.getAttribute("contenteditable")]) };
      blocks.forEach(block => { block._stuartSelecting = true; });
      hosts.forEach(host => host.removeAttribute("contenteditable"));
    }

    end(restoreEditing = true) {
      if (!this.gesture) return;
      const { blocks, hosts } = this.gesture;
      this.gesture = null;
      const sel = this.selection;
      const inside = this.preview.contains(sel.anchorNode) && this.preview.contains(sel.focusNode);
      const local = inside && hosts.some(([host]) => host.contains(sel.anchorNode) && host.contains(sel.focusNode));
      try {
        if (local && restoreEditing) {
          const anchor = [sel.anchorNode, sel.anchorOffset], focus = [sel.focusNode, sel.focusOffset];
          hosts.forEach(([host, value]) => { if (host.isConnected) host.setAttribute("contenteditable", value); });
          const host = hosts.find(([element]) => element.contains(focus[0]))?.[0];
          host?.focus({ preventScroll: true });
          sel.setBaseAndExtent(...anchor, ...focus);
        } else {
          this.commitSelection();
        }
      } finally {
        blocks.forEach(block => { delete block._stuartSelecting; });
      }
    }

    selectContents(node) {
      const range = this.document.createRange();
      range.selectNodeContents(node);
      this.selection.removeAllRanges();
      this.selection.addRange(range);
    }

    selectAll(event) {
      if (!this.enabled() || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
      const target = event.target;
      if (target.closest("input, select, [role=dialog]")) return;
      const textarea = target.closest("textarea");
      if (textarea && !this.preview.contains(textarea)) return;
      const sel = this.selection;
      const inside = this.preview.contains(sel.anchorNode) && this.preview.contains(sel.focusNode);
      if (!this.preview.contains(target) && !(inside && (target === this.document.body || target === this.document.documentElement))) return;
      event.preventDefault();
      event.stopPropagation();
      if (textarea) {
        if (textarea.selectionStart !== 0 || textarea.selectionEnd !== textarea.value.length) {
          textarea.select();
          return;
        }
      } else {
        const element = sel.focusNode?.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement;
        const paragraph = element?.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, pre, .md-block");
        if (paragraph && this.preview.contains(paragraph) && paragraph.contains(sel.anchorNode)) {
          const range = this.document.createRange();
          range.selectNodeContents(paragraph);
          const selected = sel.rangeCount ? sel.getRangeAt(0) : null;
          const prefix = range.cloneRange(), suffix = range.cloneRange();
          if (selected) {
            prefix.setEnd(selected.startContainer, selected.startOffset);
            suffix.setStart(selected.endContainer, selected.endOffset);
          }
          if (!selected || sel.isCollapsed || prefix.toString().length || suffix.toString().length) {
            this.selectContents(paragraph);
            return;
          }
        }
      }
      this.commit();
      this.selectContents(this.preview);
    }

    bind() {
      this.document.addEventListener("mousedown", event => this.begin(event), true);
      this.document.addEventListener("mouseup", () => this.end(), true);
      this.document.defaultView.addEventListener("blur", () => this.end(false));
      this.document.addEventListener("keydown", event => this.selectAll(event), true);
    }
  }
  const api = { PreviewSelection, mapSelectionOffset };
  if (typeof module === "object") module.exports = api;
  global.StuartCore = Object.assign(global.StuartCore || {}, api);
})(typeof window !== "undefined" ? window : globalThis);
