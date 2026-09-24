// web/js/ui/diff-modal.js
/**
 * StuartMD Visual Diff Review Modal
 * Implements side-by-side / unified diff comparison, conflict checking, and atomic apply.
 */
(function (global) {
  "use strict";

  class DiffModal {
    constructor() {
      this.modalEl = null;
      this.currentDiff = null;
      this.viewMode = "unified"; // "unified" | "split"
      this.initDom();
    }

    initDom() {
      const existing = document.getElementById("stuart-diff-modal");
      if (existing) {
        this.modalEl = existing;
        return;
      }

      const modal = document.createElement("div");
      modal.id = "stuart-diff-modal";
      modal.className = "stuart-diff-modal";
      modal.hidden = true;
      modal.innerHTML = `
        <div class="diff-dialog" role="dialog" aria-modal="true">
          <div class="diff-header">
            <div class="diff-title-wrap">
              <span class="diff-badge">AI 改写审查</span>
              <span class="diff-filename" id="diff-target-path"></span>
              <span class="diff-stats" id="diff-stats-summary"></span>
            </div>
            <div class="diff-controls">
              <button type="button" class="btn sm" id="diff-mode-toggle">切换为分栏对比</button>
              <button type="button" class="icon-btn sm" id="diff-close-btn" title="关闭 (Esc)">✕</button>
            </div>
          </div>
          <div class="diff-body" id="diff-content-container"></div>
          <div class="diff-footer">
            <div class="diff-notice">
              ⚠️ 原文档具有最高物理主权。采纳将经过 Win32 代际令牌原子校验与安全刷盘。
            </div>
            <div class="diff-actions">
              <button type="button" class="btn" id="diff-save-companion-btn">另存为伴生笔记 (.ai-notes.md)</button>
              <button type="button" class="btn" id="diff-cancel-btn">放弃修改 (Esc)</button>
              <button type="button" class="btn primary" id="diff-apply-btn">采纳并原子覆盖 (Ctrl+Enter)</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      this.modalEl = modal;

      // Event listeners
      modal.querySelector("#diff-close-btn").addEventListener("click", () => this.close());
      modal.querySelector("#diff-cancel-btn").addEventListener("click", () => this.close());
      modal.querySelector("#diff-mode-toggle").addEventListener("click", () => this.toggleViewMode());
      modal.querySelector("#diff-save-companion-btn").addEventListener("click", () => this.saveAsCompanion());
      modal.querySelector("#diff-apply-btn").addEventListener("click", () => this.applyDiff());

      // Hotkey trap
      window.addEventListener("keydown", (e) => {
        if (this.modalEl.hidden) return;
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          this.close();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.stopPropagation();
          e.preventDefault();
          this.applyDiff();
        }
      }, true);
    }

    async open(originalPath, proposedContent, currentRev = 1) {
      if (!global.pywebview?.api?.companion_preview_diff) {
        alert("Diff preview API is unavailable");
        return;
      }

      try {
        const payload = await global.pywebview.api.companion_preview_diff(
          originalPath,
          proposedContent,
          currentRev
        );
        this.currentDiff = {
          ...payload,
          proposedContent,
        };
        this.renderDiff();
        this.modalEl.hidden = false;
      } catch (err) {
        alert("生成 Diff 审查失败: " + err);
      }
    }

    close() {
      if (this.modalEl) {
        this.modalEl.hidden = true;
      }
      this.currentDiff = null;
    }

    toggleViewMode() {
      this.viewMode = this.viewMode === "unified" ? "split" : "unified";
      const btn = this.modalEl.querySelector("#diff-mode-toggle");
      btn.textContent = this.viewMode === "unified" ? "切换为分栏对比" : "切换为行内统一";
      this.renderDiff();
    }

    renderDiff() {
      if (!this.currentDiff) return;
      const d = this.currentDiff;

      this.modalEl.querySelector("#diff-target-path").textContent = d.originalPath;
      this.modalEl.querySelector("#diff-stats-summary").innerHTML = `
        <span class="diff-add">+${d.additions}</span>
        <span class="diff-del">-${d.deletions}</span>
      `;

      const container = this.modalEl.querySelector("#diff-content-container");
      container.className = `diff-body diff-mode-${this.viewMode}`;

      let rowsHtml = "";
      for (const line of d.lines) {
        const tag = line.tag;
        const oldL = line.oldLine != null ? line.oldLine : "";
        const newL = line.newLine != null ? line.newLine : "";
        const prefix = tag === "insert" ? "+" : tag === "delete" ? "-" : " ";
        const escapedText = escapeHtml(line.text);

        rowsHtml += `
          <div class="diff-row diff-${tag}">
            <span class="diff-gutter diff-gutter-old">${oldL}</span>
            <span class="diff-gutter diff-gutter-new">${newL}</span>
            <span class="diff-marker">${prefix}</span>
            <span class="diff-line-code">${escapedText}</span>
          </div>
        `;
      }

      container.innerHTML = rowsHtml;
    }

    async applyDiff() {
      if (!this.currentDiff) return;
      const d = this.currentDiff;

      try {
        const ok = await global.pywebview.api.companion_apply_diff(
          d.originalPath,
          d.proposedContent,
          d.baseRev,
          d.originalHash
        );
        if (ok) {
          this.close();
          // Reload current file in editor
          if (global.openFileByPath) {
            await global.openFileByPath(d.originalPath);
          }
          if (global.showToast) {
            global.showToast("已成功原子应用 AI 修改并刷盘", "success");
          } else {
            console.log("Diff applied successfully");
          }
        }
      } catch (err) {
        alert("应用修改失败: " + err);
      }
    }

    async saveAsCompanion() {
      if (!this.currentDiff) return;
      const d = this.currentDiff;

      try {
        const res = await global.pywebview.api.companion_save_note(
          d.originalPath,
          d.proposedContent,
          "ai-notes.md"
        );
        if (res.ok) {
          this.close();
          if (global.showToast) {
            global.showToast("已安全保存为伴生笔记: " + res.notePath, "success");
          } else {
            alert("伴生笔记已保存至: " + res.notePath);
          }
        }
      } catch (err) {
        alert("保存伴生笔记失败: " + err);
      }
    }
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  global.StuartDiffModal = new DiffModal();
})(window);
