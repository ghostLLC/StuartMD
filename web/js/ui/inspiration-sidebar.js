// web/js/ui/inspiration-sidebar.js
/**
 * StuartMD Inspiration Companion Sidebar & Wiki RAG Interface
 * Implements Socratic inquiry, Vault RAG sync & search, and Organic Memory management.
 */
(function (global) {
  "use strict";

  class InspirationSidebar {
    constructor() {
      this.containerEl = null;
      this.activeTab = "chat"; // "chat" | "rag" | "memory"
      this.currentSessionId = null;
      this.sessions = [];
      this.messages = [];
      this.isGenerating = false;
      this.currentRequestId = null;
      this.initDom();
      this.bindEvents();
      this.listenSyncProgress();
    }

    initDom() {
      let sidebar = document.getElementById("inspiration-sidebar");
      if (!sidebar) {
        sidebar = document.createElement("aside");
        sidebar.id = "inspiration-sidebar";
        sidebar.className = "inspiration-sidebar";
        sidebar.hidden = true;

        sidebar.innerHTML = `
          <div class="is-header">
            <div class="is-tabs">
              <button type="button" class="is-tab-btn active" data-tab="chat">💭 伴读思辨</button>
              <button type="button" class="is-tab-btn" data-tab="rag">📚 知识库</button>
              <button type="button" class="is-tab-btn" data-tab="memory">🧠 记忆网</button>
            </div>
            <button type="button" class="icon-btn sm is-close-btn" id="is-close-btn" title="收起伴读栏">✕</button>
          </div>

          <!-- TAB 1: COMPANION CHAT -->
          <div class="is-panel" id="is-panel-chat">
            <div class="socratic-bar">
              <button type="button" class="socratic-chip" data-prompt="请运用苏格拉底提问法，针对当前选区或核心观点提出三个启发式追问：">🔍 苏格拉底追问</button>
              <button type="button" class="socratic-chip" data-prompt="请作为严苛的审稿人（Devil's Advocate），挑出当前段落的论证漏洞与反例：">⚖️ 批判反思</button>
              <button type="button" class="socratic-chip" data-prompt="请萃取当前内容中的原子概念与核心脉络，生成卡片化要点：">💡 概念萃取</button>
              <button type="button" class="socratic-chip" data-prompt="请结合知识库中其他文档，找出与当前观点相关的跨文档线索：">🔗 跨文档联想</button>
            </div>

            <div class="is-message-list" id="is-message-list">
              <div class="is-welcome-hint">
                <p>👋 我是您的阅读与灵感伴侣。</p>
                <p class="small">在正文中选中任意文本，点击上方启发按钮或输入问题即可开启思辨。</p>
              </div>
            </div>

            <div class="is-input-zone">
              <div class="is-selection-preview" id="is-selection-preview" hidden>
                <span class="sel-label">📌 已附带选区:</span>
                <span class="sel-text" id="is-selection-text"></span>
                <button type="button" class="icon-btn xs" id="is-clear-sel-btn">✕</button>
              </div>
              <div class="is-input-row">
                <textarea id="is-input" rows="2" placeholder="问答或探讨… (Ctrl+Enter 发送)"></textarea>
                <div class="is-input-actions">
                  <button type="button" class="btn sm" id="is-attach-sel-btn" title="引用选区">附带选区</button>
                  <button type="button" class="btn sm primary" id="is-send-btn">发送</button>
                  <button type="button" class="btn sm danger" id="is-cancel-btn" hidden>停止</button>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB 2: RAG KNOWLEDGE VAULT -->
          <div class="is-panel" id="is-panel-rag" hidden>
            <div class="rag-status-card">
              <div class="rag-status-header">
                <span class="rag-badge" id="rag-status-badge">就绪</span>
                <span class="rag-meta" id="rag-meta-info">0 文档 · 0 知识切片</span>
              </div>
              <div class="rag-progress-wrap" id="rag-progress-wrap" hidden>
                <div class="rag-progress-bar" id="rag-progress-bar" style="width:0%"></div>
                <div class="rag-progress-text" id="rag-progress-text">正在扫描...</div>
              </div>
              <div class="rag-actions">
                <button type="button" class="btn sm" id="rag-choose-folder-btn">切换知识库目录…</button>
                <button type="button" class="btn sm primary" id="rag-sync-btn">🔄 增量同步索引</button>
              </div>
            </div>

            <div class="rag-search-box">
              <input type="text" id="rag-search-input" placeholder="输入搜索词检索跨文档切片 (回车)..." />
            </div>

            <div class="rag-results-list" id="rag-results-list">
              <div class="rag-placeholder">在上方搜索框输入关键词，以 RRF 融合算法毫秒级检索知识库。</div>
            </div>
          </div>

          <!-- TAB 3: ORGANIC MEMORY -->
          <div class="is-panel" id="is-panel-memory" hidden>
            <div class="memory-actions-bar">
              <div class="mem-tier-filters">
                <button type="button" class="mem-filter-btn active" data-tier="all">全部</button>
                <button type="button" class="mem-filter-btn" data-tier="1">T1 决策</button>
                <button type="button" class="mem-filter-btn" data-tier="2">T2 批注</button>
                <button type="button" class="mem-filter-btn" data-tier="3">T3 偏好</button>
              </div>
              <button type="button" class="btn sm" id="mem-evolve-btn" title="按艾宾浩斯曲线沉淀记忆">⚡ 记忆演进</button>
            </div>

            <div class="memory-list" id="memory-list">
              <div class="mem-empty">暂无沉淀记忆。与 AI 伴读探讨中的核心决策与偏好将自动在此沉淀。</div>
            </div>
          </div>
        `;

        const mainArea = document.getElementById("main") || document.body;
        mainArea.appendChild(sidebar);
      }
      this.containerEl = sidebar;
    }

    bindEvents() {
      const el = this.containerEl;

      // Close sidebar
      el.querySelector("#is-close-btn").addEventListener("click", () => this.toggle(false));

      // Tab switching
      el.querySelectorAll(".is-tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          el.querySelectorAll(".is-tab-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const tab = btn.getAttribute("data-tab");
          this.switchTab(tab);
        });
      });

      // Socratic Chips
      el.querySelectorAll(".socratic-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const prompt = chip.getAttribute("data-prompt");
          const input = el.querySelector("#is-input");
          input.value = prompt + " ";
          input.focus();
        });
      });

      // Send & Cancel
      el.querySelector("#is-send-btn").addEventListener("click", () => this.handleSendMessage());
      el.querySelector("#is-cancel-btn").addEventListener("click", () => this.handleCancelGeneration());

      // Hotkey Enter
      el.querySelector("#is-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.handleSendMessage();
        }
      });

      // Attach selection
      el.querySelector("#is-attach-sel-btn").addEventListener("click", () => this.attachCurrentSelection());
      el.querySelector("#is-clear-sel-btn").addEventListener("click", () => this.clearSelection());

      // RAG actions
      el.querySelector("#rag-sync-btn").addEventListener("click", () => this.handleRagSync());
      el.querySelector("#rag-choose-folder-btn").addEventListener("click", () => this.handleChooseVaultFolder());
      el.querySelector("#rag-search-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          this.handleRagSearch(e.target.value);
        }
      });

      // Memory actions
      el.querySelector("#mem-evolve-btn").addEventListener("click", () => this.handleMemoryEvolve());
      el.querySelectorAll(".mem-filter-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          el.querySelectorAll(".mem-filter-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const tier = btn.getAttribute("data-tier");
          this.loadOrganicMemories(tier === "all" ? null : parseInt(tier, 10));
        });
      });
    }

    listenSyncProgress() {
      if (global.pywebview?.api?.listen_event) {
        global.pywebview.api.listen_event("rag-sync-progress", (evt) => {
          const p = evt.payload;
          if (!p) return;
          const wrap = this.containerEl.querySelector("#rag-progress-wrap");
          const bar = this.containerEl.querySelector("#rag-progress-bar");
          const text = this.containerEl.querySelector("#rag-progress-text");

          if (p.status === "indexing" || p.status === "scanning") {
            wrap.hidden = false;
            const pct = p.total_files > 0 ? Math.round((p.processed_files / p.total_files) * 100) : 0;
            bar.style.width = `${pct}%`;
            text.textContent = `[${pct}%] ${p.current_file || "处理中..."}`;
          } else if (p.status === "completed") {
            bar.style.width = "100%";
            text.textContent = "✅ 增量索引已同步完成";
            setTimeout(() => {
              wrap.hidden = true;
              this.refreshRagStatus();
            }, 1500);
          }
        });
      }
    }

    toggle(forceState) {
      if (this.containerEl) {
        const next = forceState !== undefined ? !forceState : !this.containerEl.hidden;
        this.containerEl.hidden = next;
        if (!this.containerEl.hidden) {
          this.refreshRagStatus();
          this.loadOrganicMemories();
        }
      }
    }

    switchTab(tab) {
      this.activeTab = tab;
      const el = this.containerEl;
      el.querySelector("#is-panel-chat").hidden = tab !== "chat";
      el.querySelector("#is-panel-rag").hidden = tab !== "rag";
      el.querySelector("#is-panel-memory").hidden = tab !== "memory";

      if (tab === "rag") this.refreshRagStatus();
      if (tab === "memory") this.loadOrganicMemories();
    }

    attachCurrentSelection() {
      let sel = "";
      if (window.getSelection) {
        sel = window.getSelection().toString().trim();
      }
      if (!sel) {
        const editor = document.getElementById("editor");
        if (editor && editor.value) {
          const start = editor.selectionStart;
          const end = editor.selectionEnd;
          if (start !== end) {
            sel = editor.value.slice(start, end).trim();
          }
        }
      }

      if (sel) {
        const preview = this.containerEl.querySelector("#is-selection-preview");
        const txt = this.containerEl.querySelector("#is-selection-text");
        txt.textContent = sel.slice(0, 100) + (sel.length > 100 ? "..." : "");
        preview.hidden = false;
        this.selectedText = sel;
      }
    }

    clearSelection() {
      this.selectedText = null;
      this.containerEl.querySelector("#is-selection-preview").hidden = true;
    }

    async handleSendMessage() {
      const inputEl = this.containerEl.querySelector("#is-input");
      const userText = inputEl.value.trim();
      if (!userText || this.isGenerating) return;

      inputEl.value = "";
      const attachedQuote = this.selectedText || null;
      this.clearSelection();

      // Append user message to UI
      this.appendMessage("user", userText, attachedQuote);

      // Start assistant message box
      const assistantMsgEl = this.appendMessage("assistant", "Thinking...");
      const textContainer = assistantMsgEl.querySelector(".msg-bubble");

      this.isGenerating = true;
      this.updateGeneratingState(true);

      const requestId = "req_" + Date.now();
      this.currentRequestId = requestId;

      try {
        // Query L3 knowledge context
        let ragChunks = [];
        if (global.pywebview?.api?.rag_query) {
          ragChunks = await global.pywebview.api.rag_query(userText, 5).catch(() => []);
        }

        // Assemble L1-L5 context pyramid
        const currentFile = global.currentFilePath || "document.md";
        const pyramid = {
          l1Focus: attachedQuote
            ? {
                relPath: currentFile,
                headingPath: null,
                startLine: null,
                endLine: null,
                quote: attachedQuote,
              }
            : null,
          l2Document: null,
          l3RagChunks: ragChunks.map((c) => ({
            chunkId: c.chunkId,
            relPath: c.relPath,
            headingPath: c.headingPath,
            content: c.content,
            rrfScore: c.rrfScore,
          })),
          l4Conversation: this.messages.slice(-6).map((m) => ({
            role: m.role,
            content: m.content,
            compressed: false,
          })),
          l5UserProfile: null,
        };

        let xmlContext = "";
        if (global.pywebview?.api?.context_assemble) {
          const asm = await global.pywebview.api.context_assemble(pyramid, 6000, 2048);
          xmlContext = asm.xmlKnowledgeBlock || "";
        }

        // Send streaming prompt through ai_chat_start
        const promptWithContext = xmlContext
          ? `${xmlContext}\n\n[用户问题或指令]:\n${userText}`
          : userText;

        const messagesPayload = [
          { role: "system", content: "你是一位善用苏格拉底追问法与批判性思维的高级阅读与灵感伴侣。以启发性、严密性见长。" },
          { role: "user", content: promptWithContext },
        ];

        let accumulated = "";
        let unlisten = null;

        if (global.pywebview?.api?.listen_event) {
          unlisten = await global.pywebview.api.listen_event("ai-chat-delta", (evt) => {
            const p = evt.payload;
            if (p.requestId === requestId) {
              if (p.delta) {
                accumulated += p.delta;
                global.StuartCompanionRenderer.streamUpdate(textContainer, accumulated);
              }
              if (p.done) {
                this.isGenerating = false;
                this.updateGeneratingState(false);
                global.StuartCompanionRenderer.renderFinal(textContainer, accumulated);
                this.attachMessageActions(assistantMsgEl, accumulated);
                if (typeof unlisten === "function") unlisten();
              }
            }
          });
        }

        await global.pywebview.api.ai_chat_start(
          requestId,
          null,
          null,
          messagesPayload,
          "balanced",
          2048
        );
      } catch (err) {
        textContainer.innerHTML = `<span class="err">生成出错: ${err}</span>`;
        this.isGenerating = false;
        this.updateGeneratingState(false);
      }
    }

    appendMessage(role, content, quote) {
      const list = this.containerEl.querySelector("#is-message-list");
      const item = document.createElement("div");
      item.className = `is-msg is-msg-${role}`;

      let quoteHtml = "";
      if (quote) {
        quoteHtml = `<div class="msg-quote">📌 引用: ${escapeHtml(quote.slice(0, 120))}</div>`;
      }

      item.innerHTML = `
        <div class="msg-avatar">${role === "user" ? "👤" : "✨"}</div>
        <div class="msg-body">
          ${quoteHtml}
          <div class="msg-bubble">${escapeHtml(content)}</div>
        </div>
      `;

      list.appendChild(item);
      list.scrollTop = list.scrollHeight;

      this.messages.push({ role, content });
      return item;
    }

    attachMessageActions(msgEl, markdownContent) {
      const actions = document.createElement("div");
      actions.className = "msg-actions-row";

      // 1. Review Diff button
      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.className = "btn xs";
      diffBtn.textContent = "🔍 审查改写 Diff";
      diffBtn.addEventListener("click", () => {
        const curPath = global.currentFilePath;
        if (!curPath) {
          alert("未打开文件，无法审查 Diff");
          return;
        }
        if (global.StuartDiffModal) {
          global.StuartDiffModal.open(curPath, markdownContent, 1);
        }
      });
      actions.appendChild(diffBtn);

      // 2. Save companion note
      const noteBtn = document.createElement("button");
      noteBtn.type = "button";
      noteBtn.className = "btn xs";
      noteBtn.textContent = "📝 存为伴生笔记";
      noteBtn.addEventListener("click", async () => {
        const curPath = global.currentFilePath;
        if (!curPath) {
          alert("未打开文件");
          return;
        }
        try {
          const res = await global.pywebview.api.companion_save_note(curPath, markdownContent, "ai-notes.md");
          if (res.ok) {
            alert("伴生笔记已保存至: " + res.notePath);
          }
        } catch (e) {
          alert("保存失败: " + e);
        }
      });
      actions.appendChild(noteBtn);

      msgEl.querySelector(".msg-body").appendChild(actions);
    }

    handleCancelGeneration() {
      if (this.currentRequestId && global.pywebview?.api?.ai_chat_cancel) {
        global.pywebview.api.ai_chat_cancel(this.currentRequestId);
        this.isGenerating = false;
        this.updateGeneratingState(false);
      }
    }

    updateGeneratingState(generating) {
      this.containerEl.querySelector("#is-send-btn").hidden = generating;
      this.containerEl.querySelector("#is-cancel-btn").hidden = !generating;
    }

    async refreshRagStatus() {
      if (!global.pywebview?.api?.rag_get_status) return;
      try {
        const status = await global.pywebview.api.rag_get_status();
        const badge = this.containerEl.querySelector("#rag-status-badge");
        const meta = this.containerEl.querySelector("#rag-meta-info");

        badge.textContent = status.status === "ready" ? "知识库就绪" : status.status === "indexing" ? "索引同步中" : "空闲";
        badge.className = `rag-badge status-${status.status}`;
        meta.textContent = `${status.docCount || 0} 文档 · ${status.chunkCount || 0} 知识切片`;
      } catch (_) {}
    }

    async handleRagSync() {
      if (!global.pywebview?.api?.rag_sync_workspace) return;
      try {
        const btn = this.containerEl.querySelector("#rag-sync-btn");
        btn.disabled = true;
        btn.textContent = "同步中...";
        await global.pywebview.api.rag_sync_workspace();
      } catch (err) {
        alert("同步知识库失败: " + err);
      } finally {
        const btn = this.containerEl.querySelector("#rag-sync-btn");
        btn.disabled = false;
        btn.textContent = "🔄 增量同步索引";
        this.refreshRagStatus();
      }
    }

    async handleChooseVaultFolder() {
      if (!global.pywebview?.api?.open_folder_dialog) return;
      const folder = await global.pywebview.api.open_folder_dialog();
      if (folder && global.pywebview?.api?.rag_set_workspace) {
        await global.pywebview.api.rag_set_workspace(folder);
        this.refreshRagStatus();
        this.handleRagSync();
      }
    }

    async handleRagSearch(query) {
      if (!query || !global.pywebview?.api?.rag_query) return;
      const list = this.containerEl.querySelector("#rag-results-list");
      list.innerHTML = `<div class="rag-placeholder">正在检索知识切片...</div>`;

      try {
        const hits = await global.pywebview.api.rag_query(query, 10);
        if (!hits || hits.length === 0) {
          list.innerHTML = `<div class="rag-placeholder">未检索到与 "${escapeHtml(query)}" 相关的知识切片。</div>`;
          return;
        }

        let html = "";
        for (const hit of hits) {
          const score = (hit.rrfScore * 100).toFixed(1);
          html += `
            <div class="rag-hit-card" data-link="${escapeHtml(hit.deepLink)}">
              <div class="hit-header">
                <span class="hit-file">${escapeHtml(hit.relPath)}</span>
                <span class="hit-score">RRF: ${score}%</span>
              </div>
              <div class="hit-heading">${escapeHtml(hit.headingPath)}</div>
              <div class="hit-snippet">${escapeHtml(hit.content.slice(0, 150))}...</div>
            </div>
          `;
        }
        list.innerHTML = html;

        list.querySelectorAll(".rag-hit-card").forEach((card) => {
          card.addEventListener("click", () => {
            const link = card.getAttribute("data-link");
            if (global.StuartFlashAnchors) {
              global.StuartFlashAnchors.jumpToAnchor(link);
            }
          });
        });
      } catch (e) {
        list.innerHTML = `<div class="rag-placeholder err">检索出错: ${e}</div>`;
      }
    }

    async loadOrganicMemories(tierFilter = null) {
      if (!global.pywebview?.api?.organic_memory_list) return;
      const list = this.containerEl.querySelector("#memory-list");
      try {
        const memories = await global.pywebview.api.organic_memory_list(tierFilter);
        if (!memories || memories.length === 0) {
          list.innerHTML = `<div class="mem-empty">暂无沉淀记忆项。</div>`;
          return;
        }

        let html = "";
        for (const m of memories) {
          html += `
            <div class="mem-card tier-${m.tier}">
              <div class="mem-card-header">
                <span class="mem-category">${escapeHtml(m.category)}</span>
                <span class="mem-tier-badge">Tier ${m.tier}</span>
                ${m.pinned ? '<span class="mem-pin-icon" title="已固定">📌</span>' : ""}
              </div>
              <div class="mem-card-content">${escapeHtml(m.content)}</div>
              <div class="mem-card-footer">
                <span>置信度: ${(m.confidence * 100).toFixed(0)}%</span>
                <span>访问: ${m.accessCount} 次</span>
              </div>
            </div>
          `;
        }
        list.innerHTML = html;
      } catch (_) {}
    }

    async handleMemoryEvolve() {
      if (!global.pywebview?.api?.organic_memory_evolve) return;
      try {
        const pruned = await global.pywebview.api.organic_memory_evolve();
        alert(`已执行艾宾浩斯记忆演化，清理了 ${pruned} 条过期遗忘项。`);
        this.loadOrganicMemories();
      } catch (e) {
        alert("记忆演进失败: " + e);
      }
    }
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  global.StuartInspirationSidebar = new InspirationSidebar();
})(window);
