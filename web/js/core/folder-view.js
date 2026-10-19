(function (global) {
  "use strict";
  const pathKey = path => String(path || "").replaceAll("\\", "/").toLowerCase();

  class FolderView {
    constructor(tree, label, button) {
      this.tree = tree;
      this.label = label;
      this.button = button;
      this.path = "";
      this.sequence = 0;
      this.pending = null;
    }
    cancel() {
      this.sequence += 1;
      this.pending = null;
    }
    update(document, ready) {
      this.button.disabled = !ready || !document?.path || !!this.pending;
      this.button.title = !document ? "打开文件后可刷新所在目录" : !document.path ? "保存文档后可定位所在文件夹" : this.pending ? "正在刷新当前文件所在目录" : "刷新当前文件所在目录";
      this.button.setAttribute("aria-label", this.button.title);
      this.button.setAttribute("aria-busy", String(!!this.pending));
    }
    begin(document) {
      this.cancel();
      const ticket = { sequence: this.sequence, document, path: document?.path };
      this.pending = ticket;
      return ticket;
    }
    current(ticket, document) {
      return ticket.sequence === this.sequence && ticket.document === document && ticket.path === document?.path;
    }
    matchesPath(first, second) { return pathKey(first) === pathKey(second); }
    finish(ticket) {
      if (this.pending === ticket) this.pending = null;
    }
    highlight(path) {
      let selected = null;
      for (const row of this.tree.querySelectorAll(".tree-item.file")) {
        const active = !!path && pathKey(row.dataset.path) === pathKey(path);
        row.classList.toggle("active", active);
        if (active) selected = row;
      }
      return selected;
    }
    render(result, activePath) {
      const same = pathKey(this.path) === pathKey(result.path);
      const expanded = new Set(same ? [...this.tree.querySelectorAll(".tree-item.dir.expanded")].map(row => pathKey(row.dataset.path)) : []);
      const top = same ? this.tree.scrollTop : 0;
      const left = same ? this.tree.scrollLeft : 0;
      const document = this.tree.ownerDocument;
      const fragment = document.createDocumentFragment();
      const walk = (items, parent, depth) => {
        for (const item of items) {
          const row = document.createElement("div");
          row.className = `tree-item ${item.type === "dir" ? "dir" : "file"}`;
          row.dataset.path = item.path;
          row.style.paddingLeft = `${8 + depth * 14 + (item.type === "dir" ? 0 : 14)}px`;
          parent.appendChild(row);
          if (item.type === "dir") {
            const chevron = document.createElement("span");
            chevron.className = "chev"; chevron.textContent = "›";
            const name = document.createElement("span");
            name.className = "name"; name.textContent = item.name;
            row.append(chevron, name);
            const children = document.createElement("div");
            children.className = "tree-children";
            const open = expanded.has(pathKey(item.path));
            row.classList.toggle("expanded", open);
            children.classList.toggle("open", open);
            walk(item.children || [], children, depth + 1);
            parent.appendChild(children);
          } else {
            row.textContent = item.name;
            row.title = `${item.path}（中键或右键：新窗口打开）`;
          }
        }
      };
      walk(result.items, fragment, 0);
      if (!result.items.length) {
        const hint = document.createElement("div");
        hint.className = "empty-hint"; hint.textContent = "目录中没有可打开的文档";
        fragment.appendChild(hint);
      }
      this.tree.replaceChildren(fragment);
      this.path = result.path;
      this.label.textContent = result.name || result.path;
      this.label.title = result.path;
      const selected = this.highlight(activePath);
      if (selected) {
        let parent = selected.parentElement;
        while (parent && parent !== this.tree) {
          if (parent.classList.contains("tree-children")) {
            parent.classList.add("open");
            parent.previousElementSibling.classList.add("expanded");
          }
          parent = parent.parentElement;
        }
      }
      this.tree.scrollTop = top;
      this.tree.scrollLeft = left;
      return { selected, changedDirectory: !same };
    }
  }
  if (typeof module === "object") module.exports = { FolderView };
  else global.StuartCore = Object.assign(global.StuartCore || {}, { FolderView });
})(typeof window === "object" ? window : globalThis);
