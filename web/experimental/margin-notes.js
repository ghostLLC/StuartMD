// web/js/ui/margin-notes.js
/**
 * StuartMD Margin Notes Track with Nudge-Stacking Collision Avoidance
 * Renders annotations and AI reflections parallel to paragraphs without blocking content.
 */
(function (global) {
  "use strict";

  class MarginNotesTrack {
    constructor() {
      this.trackEl = null;
      this.notes = [];
      this.initTrack();
    }

    initTrack() {
      let track = document.getElementById("margin-notes-track");
      if (!track) {
        track = document.createElement("div");
        track.id = "margin-notes-track";
        track.className = "margin-notes-track";
        const contentContainer = document.getElementById("main") || document.body;
        contentContainer.appendChild(track);
      }
      this.trackEl = track;
    }

    setNotes(notes) {
      this.notes = notes || [];
      this.render();
    }

    addNote(note) {
      this.notes.push(note);
      this.render();
    }

    clear() {
      this.notes = [];
      if (this.trackEl) {
        this.trackEl.innerHTML = "";
      }
    }

    render() {
      if (!this.trackEl) return;
      this.trackEl.innerHTML = "";

      let lastBottom = 0;
      const PADDING = 8; // vertical spacing

      for (const note of this.notes) {
        const item = document.createElement("div");
        item.className = `margin-note-card tier-${note.tier || 1}`;
        item.innerHTML = `
          <div class="mn-header">
            <span class="mn-badge">${escapeHtml(note.category || "伴读思考")}</span>
            <span class="mn-time">${note.timestamp ? new Date(note.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ""}</span>
          </div>
          <div class="mn-content">${escapeHtml(note.content)}</div>
        `;

        // Calculate vertical anchor
        let targetTop = 0;
        if (note.anchorLine != null) {
          const lineEl = document.querySelector(`[data-line="${note.anchorLine}"]`);
          if (lineEl) {
            targetTop = lineEl.offsetTop;
          }
        }

        // Nudge Stacking algorithm: push down if overlapping previous card
        const computedTop = Math.max(targetTop, lastBottom + PADDING);
        item.style.top = `${computedTop}px`;

        item.addEventListener("click", () => {
          if (note.anchorFile && global.StuartFlashAnchors) {
            const uri = `stuart://anchor?file=${encodeURIComponent(note.anchorFile)}&line=${note.anchorLine || 1}`;
            global.StuartFlashAnchors.jumpToAnchor(uri);
          }
        });

        this.trackEl.appendChild(item);
        lastBottom = computedTop + (item.offsetHeight || 60);
      }
    }
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  global.StuartMarginNotes = new MarginNotesTrack();
})(window);
