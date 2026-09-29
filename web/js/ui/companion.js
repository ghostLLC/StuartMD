/**
 * StuartCompanion — 伴读侧栏 3.2.0（自 Gemini 灵感伴读收编，去 emoji、统一 AI 流式契约）
 * Tabs: 伴读问答 / 知识检索 / 记忆
 */
(function (global) {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  const state = {
    open: false,
    tab: "chat",
    width: 380,
    quote: "",
    busy: false,
    memFilter: "all",
    unsub: [],
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(msg) {
    global.StuartMD?.toast?.(String(msg));
  }

  function ensureDom() {
    let el = $("#stuart-companion");
    if (el) return el;
    el = document.createElement("aside");
    el.id = "stuart-companion";
    el.className = "stuart-companion";
    el.hidden = true;
    el.innerHTML = `
      <div class="sc-head">
        <div class="sc-title">伴读</div>
        <button type="button" class="icon-btn sm" id="sc-close" title="关闭" aria-label="关闭">×</button>
      </div>
      <div class="sc-tabs" role="tablist">
        <button type="button" class="sc-tab active" data-tab="chat">问答</button>
        <button type="button" class="sc-tab" data-tab="vault">知识</button>
        <button type="button" class="sc-tab" data-tab="memory">记忆</button>
      </div>
      <div class="sc-panel" data-panel="chat">
        <div class="sc-quote" id="sc-quote" hidden></div>
        <div class="sc-list" id="sc-messages"><div class="sc-empty sc-guide"><strong>问答</strong>：选中正文后点「引用选区」，或直接提问；<kbd>Alt+E</kbd> 可快速问答。</div></div>
        <div class="sc-input-zone">
          <textarea id="sc-input" rows="2" placeholder="结合选区提问…"></textarea>
          <div class="sc-actions">
            <button type="button" class="btn sm" id="sc-attach">引用选区</button>
            <button type="button" class="btn sm" id="sc-cancel" hidden>停止</button>
            <button type="button" class="btn sm primary" id="sc-send">发送</button>
          </div>
        </div>
      </div>
      <div class="sc-panel" data-panel="vault" hidden>
        <div class="sc-input-zone">
          <input type="text" id="sc-vault-q" placeholder="在工作区 Markdown 中检索…" />
          <div class="sc-actions">
            <button type="button" class="btn sm primary" id="sc-vault-go">检索</button>
          </div>
        </div>
        <div class="sc-list" id="sc-vault-list">
          <div class="sc-empty sc-guide"><strong>知识</strong>：在当前工作区 Markdown 中全文检索；点卡片可复制路径。不含向量索引，关键词即可。</div>
        </div>
      </div>
      <div class="sc-panel" data-panel="memory" hidden>
        <div class="sc-filters">
          <button type="button" class="sc-chip active" data-mem="all">全部</button>
          <button type="button" class="sc-chip" data-mem="profile">偏好</button>
          <button type="button" class="sc-chip" data-mem="notes">备忘</button>
        </div>
        <div class="sc-list" id="sc-memory-list">
          <div class="sc-empty sc-guide"><strong>记忆</strong>：问答后「记入记忆」会写在这里；点卡片可查看与删除。</div>
        </div>
      </div>
      <div class="sc-resize" id="sc-resize" title="拖动调整宽度"></div>
    `;
    document.body.appendChild(el);
    bind(el);
    return el;
  }

  function bind(el) {
    $("#sc-close", el)?.addEventListener("click", () => toggle(false));
    $$(".sc-tab", el).forEach((b) => {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
    });
    $("#sc-send", el)?.addEventListener("click", () => send());
    $("#sc-cancel", el)?.addEventListener("click", async () => {
      await global.StuartAIService?.cancel?.();
    });
    $("#sc-attach", el)?.addEventListener("click", () => attachSelection());
    $("#sc-input", el)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });
    $("#sc-vault-go", el)?.addEventListener("click", () => vaultSearch());
    $("#sc-vault-q", el)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        vaultSearch();
      }
    });
    $$(".sc-chip", el).forEach((b) => {
      b.addEventListener("click", () => {
        $$(".sc-chip", el).forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        state.memFilter = b.dataset.mem;
        loadMemory();
      });
    });

    // resize
    const grip = $("#sc-resize", el);
    let drag = null;
    const onMove = (e) => {
      if (!drag) return;
      const w = Math.min(560, Math.max(320, drag.w + (drag.x - e.clientX)));
      state.width = w;
      el.style.width = w + "px";
    };
    const onUp = () => {
      if (drag) {
        try {
          localStorage.setItem("stuart_companion_width", String(state.width));
        } catch (_) {}
      }
      drag = null;
    };
    grip?.addEventListener("mousedown", (e) => {
      drag = { x: e.clientX, w: el.offsetWidth };
      e.preventDefault();
    });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    // stream
    if (global.StuartAIService) {
      state.unsub.push(
        global.StuartAIService.on("delta", (p) => {
          appendStream(p.text || "");
        })
      );
      state.unsub.push(
        global.StuartAIService.on("done", (p) => {
          finishStream(p);
        })
      );
    }

    try {
      const w = parseInt(localStorage.getItem("stuart_companion_width") || "380", 10);
      if (w >= 320 && w <= 560) {
        state.width = w;
        el.style.width = w + "px";
      }
    } catch (_) {}
  }

  function switchTab(tab) {
    state.tab = tab;
    const el = ensureDom();
    $$(".sc-tab", el).forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    $$(".sc-panel", el).forEach((p) => {
      p.hidden = p.dataset.panel !== tab;
    });
    if (tab === "memory") loadMemory();
  }

  function toggle(force) {
    const el = ensureDom();
    const open = force != null ? !!force : el.hidden;
    el.hidden = !open;
    state.open = open;
    const btn = $("#btn-companion");
    if (btn) {
      btn.classList.toggle("active", open);
      btn.setAttribute("aria-expanded", String(open));
    }
    if (open) {
      attachSelection();
      switchTab(state.tab);
    }
    try {
      global.StuartMD.state.companionOpen = open;
    } catch (_) {}
  }

  function attachSelection() {
    const info = global.StuartMD?.getSelectionInfo?.() || {};
    const text = String(info.text || "").trim();
    const q = $("#sc-quote");
    if (!q) return;
    if (text) {
      state.quote = text;
      q.hidden = false;
      q.textContent = text.length > 140 ? text.slice(0, 140) + "…" : text;
    }
  }

  function msgEl(role, html) {
    const list = $("#sc-messages");
    const d = document.createElement("div");
    d.className = "sc-msg sc-msg--" + role;
    d.innerHTML = html;
    list.appendChild(d);
    return d;
  }

  let streamEl = null;

  function appendStream(text) {
    if (!streamEl) {
      streamEl = msgEl("ai", `<div class="sc-msg-body"></div>`);
    }
    const body = streamEl.querySelector(".sc-msg-body");
    const C = global.StuartAIContext;
    body.innerHTML = C?.renderSafeMarkdown ? C.renderSafeMarkdown(text) : esc(text);
  }

  function finishStream(p) {
    const body = streamEl?.querySelector(".sc-msg-body");
    if (body) {
      const C = global.StuartAIContext;
      const t = p.text || body.textContent || "";
      body.innerHTML = C?.renderSafeMarkdown ? C.renderSafeMarkdown(t) : esc(t);
    }
    streamEl = null;
    state.busy = false;
    const cancel = $("#sc-cancel");
    if (cancel) cancel.hidden = true;
    const send = $("#sc-send");
    if (send) send.disabled = false;
    if (p && p.error) {
      msgEl("err", `<div class="sc-msg-body">${esc(p.error)}</div>`);
    }
  }

  async function send() {
    const input = $("#sc-input");
    const q = (input?.value || "").trim();
    if (!q && !state.quote) {
      toast("请先选中内容或输入问题");
      return;
    }
    const AI = global.StuartAIService;
    if (!AI) {
      toast("AI 服务未加载");
      return;
    }
    attachSelection();
    const text = q || "请结合选区讲解。";
    msgEl("user", `<div class="sc-msg-body">${esc(state.quote ? "【选区】" + state.quote.slice(0, 80) + "\n\n" : "")}${esc(text)}</div>`);
    if (input) input.value = "";
    state.busy = true;
    const cancel = $("#sc-cancel");
    if (cancel) cancel.hidden = false;
    const sendBtn = $("#sc-send");
    if (sendBtn) sendBtn.disabled = true;

    let res;
    if (state.quote && !q) {
      res = await AI.explainSelection({ quote: state.quote });
    } else if (AI.messages && AI.messages.length) {
      res = await AI.followUp(text);
    } else {
      const cfg = await AI.ensureConfig();
      const style = global.StuartAI?.getStyle?.(cfg) || {};
      const C = global.StuartAIContext;
      const built = C.buildMarkdownExplain(global.StuartMD, {
        quote: state.quote || text,
        scope: "neighborhood",
      });
      const messages = [
        { role: "system", content: C.systemPrompt(style) },
        {
          role: "user",
          content: built.promptUser + (q && state.quote ? `\n\n【追问】${q}` : ""),
        },
      ];
      res = await AI.send({ messages });
    }
    if (res && res.error) {
      state.busy = false;
      if (cancel) cancel.hidden = true;
      if (sendBtn) sendBtn.disabled = false;
      msgEl("err", `<div class="sc-msg-body">${esc(res.error)}</div>`);
    }
  }

  async function vaultSearch() {
    const q = ($("#sc-vault-q")?.value || "").trim();
    const list = $("#sc-vault-list");
    if (!q) {
      list.innerHTML = `<div class="sc-empty">请输入关键词</div>`;
      return;
    }
    const api = global.pywebview?.api;
    if (!api?.search_md) {
      list.innerHTML = `<div class="sc-empty">检索接口不可用</div>`;
      return;
    }
    list.innerHTML = `<div class="sc-empty">检索中…</div>`;
    try {
      const root = global.StuartMD?.state?.workspaceRoot || "";
      const res = await api.search_md(root || ".", q, 20);
      const hits = (res && res.hits) || [];
      if (!hits.length) {
        list.innerHTML = `<div class="sc-empty">未找到相关内容</div>`;
        return;
      }
      list.innerHTML = hits
        .map(
          (h) => `<div class="sc-card sc-card-click" data-path="${esc(h.path || "")}" title="点击复制路径">
          <div class="sc-card-title">${esc(h.name || h.path)}</div>
          <div class="sc-card-meta">L${esc(String(h.line || ""))} · 点击复制路径</div>
          <div class="sc-card-snippet">${esc(h.preview || "")}</div>
        </div>`
        )
        .join("");
      list.querySelectorAll("[data-path]").forEach((el) => {
        el.addEventListener("click", () => {
          const path = el.dataset.path;
          try {
            navigator.clipboard?.writeText(path);
            toast("已复制路径");
          } catch (_) {}
        });
      });
    } catch (e) {
      list.innerHTML = `<div class="sc-empty">${esc(e && e.message ? e.message : e)}</div>`;
    }
  }

  async function loadMemory() {
    const list = $("#sc-memory-list");
    const api = global.pywebview?.api;
    if (!api?.memory_list) return;
    try {
      const res = await api.memory_list();
      const keys = (res && res.keys) || [];
      if (!keys.length) {
        list.innerHTML = `<div class="sc-empty">记忆会在问答与「记入记忆」后逐渐丰富。</div>`;
        return;
      }
      const filter = state.memFilter;
      const rows = keys.filter((k) => {
        if (filter === "all") return true;
        if (filter === "profile") return String(k.key || "").includes("profile") || String(k.key || "").includes("prefs");
        return true;
      });
      if (!rows.length) {
        list.innerHTML = `<div class="sc-empty">该分类下暂无记忆</div>`;
        return;
      }
      list.innerHTML = rows
        .map(
          (k) => `<div class="sc-card sc-card-click" data-mem-key="${esc(k.key)}" role="button" tabindex="0" title="点击查看内容">
          <div class="sc-card-title">${esc(k.key)}</div>
          <div class="sc-card-meta">${esc(String(k.size || 0))} bytes · 点击查看</div>
        </div>`
        )
        .join("");
      list.querySelectorAll("[data-mem-key]").forEach((el) => {
        el.addEventListener("click", () => showMemoryDetail(el.dataset.memKey));
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            showMemoryDetail(el.dataset.memKey);
          }
        });
      });
    } catch (e) {
      list.innerHTML = `<div class="sc-empty">${esc(e && e.message ? e.message : e)}</div>`;
    }
  }

  global.StuartCompanion = {
    toggle,
    isOpen: () => state.open,
    attachSelection,
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensureDom());
  } else {
    ensureDom();
  }
})(typeof window !== "undefined" ? window : globalThis);
