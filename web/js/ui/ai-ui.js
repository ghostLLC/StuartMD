/**
 * StuartMD AI UI 3.0.0 — model menu, settings form, explain panel.
 * Host: window.StuartAIUI
 */
(function (global) {
  "use strict";

  const $ = (sel, root = document) => (root || document).querySelector(sel);
  const $$ = (sel, root = document) => [...(root || document).querySelectorAll(sel)];

  const uiState = {
    lastQuote: "",
    lastMeta: null,
    lastMessages: [],
    lastAnswer: "",
    recordingShortcut: false,
    isFirstAnswer: false,
    userMoved: false,
    chat: [],
    _lastTriggerAt: 0,
  };

  function toast(msg) {
    if (global.StuartMD && global.StuartMD.toast) global.StuartMD.toast(String(msg));
  }

  function panelGeomKey() {
    return "StuartMD-ai-panel";
  }

  function loadPanelGeom() {
    try {
      return JSON.parse(localStorage.getItem(panelGeomKey()) || "null");
    } catch (_) {
      return null;
    }
  }

  function savePanelGeom(extra) {
    const p = panelEls().root;
    if (!p) return;
    const prev = loadPanelGeom() || {};
    const geom = Object.assign({}, prev, extra || {}, {
      w: p.offsetWidth || prev.w || 440,
      h: p.offsetHeight || prev.h || 420,
      moved: !!(extra && extra.moved != null ? extra.moved : uiState.userMoved || prev.moved),
    });
    const left = parseInt(p.style.left, 10);
    const top = parseInt(p.style.top, 10);
    if (Number.isFinite(left)) geom.left = left;
    if (Number.isFinite(top)) geom.top = top;
    try {
      localStorage.setItem(panelGeomKey(), JSON.stringify(geom));
    } catch (_) {}
  }

  function classifyAiError(raw) {
    const s = String(raw == null ? "" : raw);
    const low = s.toLowerCase();
    if (/尚未配置|api key|unauthorized|401|invalid api|authentication|密钥/.test(s) || /unauthorized|401/.test(low)) {
      return {
        kind: "key",
        title: "API Key 无效或未配置",
        detail: "请在右上角「模型」→ 设置中保存有效的 API Key。",
        action: "open_settings",
      };
    }
    if (/404|not found|模型|model id|base_url|bad gateway|no such|invalid.*url/.test(low + s)) {
      return {
        kind: "model",
        title: "模型名或接口地址可能有误",
        detail: "请检查模型 ID 与 API Base（OpenAI 兼容根地址）。",
        action: "open_settings",
      };
    }
    if (
      /timeout|timed out|connection|network|dns|reset|unreachable|offline|连接|网络|error sending|failed to lookup/.test(
        low + s
      )
    ) {
      return {
        kind: "network",
        title: "网络连接失败",
        detail: "请检查本机网络后重试；若使用代理请确认系统代理可用。",
        action: "retry",
      };
    }
    if (/429|rate limit|too many/.test(low)) {
      return {
        kind: "rate",
        title: "请求过于频繁",
        detail: "请稍候片刻再试。",
        action: "retry",
      };
    }
    return {
      kind: "other",
      title: "问答未完成",
      detail: s || "请稍后重试。",
      action: "retry",
    };
  }

  function setThinking(on, label) {
    const node = $("#ai-thinking");
    if (!node) return;
    node.hidden = !on;
    const t = node.querySelector(".ai-thinking-text");
    if (t) t.textContent = label || "正在思考…";
  }

  function scrollPanelBottom() {
    // Do not auto-scroll: panel is small; user scrolls while reading streams.
  }

  function scrollPanelTop() {
    try {
      const body = $("#ai-panel-body");
      if (body) body.scrollTop = 0;
    } catch (_) {}
  }

  function renderChat() {
    const wrap = $("#ai-chat");
    const out = $("#ai-panel-out");
    const empty = $("#ai-panel-empty");
    const C = global.StuartAIContext;
    if (!wrap) return;
    const items = uiState.chat || [];
    wrap.innerHTML = items
      .map((m) => {
        if (m.role === "user") {
          return (
            '<div class="ai-msg ai-msg-user"><div class="ai-msg-role">你</div><div class="ai-msg-body">' +
            (C.escapeHtml ? C.escapeHtml(m.text || "") : m.text || "") +
            "</div></div>"
          );
        }
        if (m.role === "error") {
          return (
            '<div class="ai-msg ai-msg-error"><div class="ai-msg-role">提示</div><div class="ai-msg-body">' +
            (m.html || (C.escapeHtml ? C.escapeHtml(m.text || "") : m.text || "")) +
            "</div></div>"
          );
        }
        if (m.role === "system") {
          return (
            '<div class="ai-msg ai-msg-system"><div class="ai-msg-body">' +
            (C.escapeHtml ? C.escapeHtml(m.text || "") : m.text || "") +
            "</div></div>"
          );
        }
        const body =
          m.streaming || !m.text
            ? ""
            : C && C.renderSafeMarkdown
              ? C.renderSafeMarkdown(m.text)
              : "";
        return (
          '<div class="ai-msg ai-msg-ai"><div class="ai-msg-role">AI</div><div class="ai-msg-body">' +
          body +
          "</div></div>"
        );
      })
      .join("");
    if (out) {
      const last = items[items.length - 1];
      const live = !!(last && last.role === "ai" && last.streaming);
      out.hidden = !live;
    }
    if (empty) empty.hidden = items.length > 0;
    scrollPanelBottom();
  }

  function pushChat(role, text, extra) {
    uiState.chat = uiState.chat || [];
    uiState.chat.push(Object.assign({ role: role, text: text || "" }, extra || {}));
    renderChat();
  }

  function updateStreamingChat(text) {
    uiState.chat = uiState.chat || [];
    for (let i = uiState.chat.length - 1; i >= 0; i--) {
      if (uiState.chat[i].role === "ai" && uiState.chat[i].streaming) {
        uiState.chat[i].text = text || "";
        break;
      }
    }
    uiState.lastAnswer = text || "";
    const out = $("#ai-panel-out");
    const C = global.StuartAIContext;
    if (out) {
      out.hidden = false;
      out.innerHTML = C && C.renderSafeMarkdown ? C.renderSafeMarkdown(text || "") : "";
    }
    const empty = $("#ai-panel-empty");
    if (empty) empty.hidden = true;
    scrollPanelBottom();
  }

  function finishStreamingChat(text, errMsg) {
    uiState.chat = uiState.chat || [];
    for (let i = uiState.chat.length - 1; i >= 0; i--) {
      if (uiState.chat[i].role === "ai" && uiState.chat[i].streaming) {
        uiState.chat[i].streaming = false;
        uiState.chat[i].text = text != null ? text : uiState.chat[i].text || "";
        break;
      }
    }
    uiState.lastAnswer = text != null ? text : uiState.lastAnswer || "";
    setThinking(false);
    if (errMsg) {
      const info = classifyAiError(errMsg);
      const C = global.StuartAIContext;
      const esc = (x) => (C && C.escapeHtml ? C.escapeHtml(x) : x);
      pushChat("error", "", {
        html:
          "<strong>" +
          esc(info.title) +
          '</strong><div class="ai-err-detail">' +
          esc(info.detail) +
          "</div>",
      });
      const badge = $("#ai-panel-badge");
      if (badge) {
        badge.textContent = "失败";
        badge.dataset.state = "err";
      }
      toast(info.title);
      if (info.action === "open_settings") openSettingsFocus();
    }
    renderChat();
  }

  function resetChatForExplain(quote) {
    uiState.chat = [];
    if (quote) pushChat("user", quote);
    renderChat();
    scrollPanelTop();
  }

  function getShortcut() {
    const cfg = global.StuartAI && global.StuartAI.config;
    return (cfg && cfg.explain_shortcut) || "Alt+E";
  }

  function panelEls() {
    return {
      root: $("#ai-panel"),
      drag: $("#ai-panel-drag"),
      quote: $("#ai-panel-quote"),
      meta: $("#ai-panel-meta"),
      body: $("#ai-panel-body"),
      empty: $("#ai-panel-empty"),
      out: $("#ai-panel-out"),
      cancel: $("#ai-panel-cancel"),
      copy: $("#ai-panel-copy"),
      remember: $("#ai-panel-remember"),
      follow: $("#ai-panel-follow"),
      reask: $("#ai-panel-reask"),
      followRow: $("#ai-panel-follow-row"),
      followInput: $("#ai-panel-follow-input"),
      followSend: $("#ai-panel-follow-send"),
      close: $("#ai-panel-close"),
      feedback: $("#ai-panel-feedback"),
    };
  }

  function positionNearSelection() {
    const p = panelEls().root;
    if (!p || p.hidden) return;
    if (uiState.userMoved) return;
    const saved = loadPanelGeom();
    if (saved && saved.moved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      p.style.left = saved.left + "px";
      p.style.top = saved.top + "px";
      p.style.right = "auto";
      uiState.userMoved = true;
      return;
    }
    const sel = window.getSelection();
    let rect = null;
    try {
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        rect = sel.getRangeAt(0).getBoundingClientRect();
      }
    } catch (_) {}
    const w = p.offsetWidth || 440;
    const h = p.offsetHeight || 420;
    if (rect && rect.width) {
      let top = rect.bottom + 12;
      if (top + h > window.innerHeight - 12) top = Math.max(8, rect.top - h - 12);
      const left = Math.max(8, Math.min(window.innerWidth - w - 12, rect.right - w));
      p.style.top = top + "px";
      p.style.left = left + "px";
      p.style.right = "auto";
    } else if (!p.style.left || p.style.left === "auto") {
      p.style.top = "88px";
      p.style.right = "24px";
      p.style.left = "auto";
    }
  }

  function openPanel(opts) {
    const p = panelEls();
    if (!p.root) return;
    const o = opts || {};
    const wasHidden = !!p.root.hidden;
    p.root.hidden = false;
    const saved = loadPanelGeom();
    if (saved && saved.w > 0 && saved.h > 0) {
      p.root.style.width = Math.min(saved.w, window.innerWidth - 16) + "px";
      p.root.style.height = Math.min(saved.h, window.innerHeight - 16) + "px";
    }
    if (saved && saved.moved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      p.root.style.left = saved.left + "px";
      p.root.style.top = saved.top + "px";
      p.root.style.right = "auto";
      uiState.userMoved = true;
      return;
    }
    // Follow-up / already open: keep current position
    if (!wasHidden && !o.reposition) return;
    if (!uiState.userMoved) positionNearSelection();
  }

  function persistPanelSize() {
    savePanelGeom({});
  }

  function closePanel() {
    const p = panelEls();
    if (p.root) p.root.hidden = true;
    if (p.followRow) p.followRow.hidden = true;
    setThinking(false);
  }

  function setStatus(html, showOut) {
    const p = panelEls();
    if (!p.empty) return;
    const hasChat = (uiState.chat || []).length > 0;
    if (hasChat && showOut) {
      // errors/notes go to chat stream instead of empty slot
      return;
    }
    p.empty.hidden = !!showOut || hasChat;
    p.empty.innerHTML = html || "";
  }

  function setOutput(text) {
    updateStreamingChat(text || "");
  }

  function updateThink(root, thinking) {
    if (!root) return;
    root.querySelectorAll("[data-think]").forEach((b) => {
      b.classList.toggle("active", b.dataset.think === thinking);
    });
  }

  function fillProviders(sel, ai, selectedId) {
    if (!sel) return;
    const list = (ai && ai.providers) || [];
    sel.innerHTML = list
      .map((p) => {
        const mark = p.key_set ? "" : " · 未配Key";
        return `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>${(p.label || p.id) + mark}</option>`;
      })
      .join("");
  }

  function currentProvider(ai) {
    const list = (ai && ai.providers) || [];
    const id = (ai && ai.active_provider_id) || "deepseek";
    return list.find((p) => p.id === id) || list[0] || null;
  }

  function isTypingTarget(target) {
    if (!target || !target.tagName) return false;
    const tag = String(target.tagName).toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (target.isContentEditable) return true;
    return !!(target.closest && target.closest("input,textarea,select,[contenteditable=true]"));
  }

  function setInputValue(input, value) {
    if (!input) return;
    if (document.activeElement === input) return; // don't clobber while typing
    if (input.dataset.editing === "1") return;
    input.value = value == null ? "" : String(value);
  }

  async function refreshChrome() {
    const AI = global.StuartAI;
    if (!AI) return null;
    let cfg = AI.config;
    try {
      cfg = await AI.ensureConfig(true);
    } catch (_) {}
    const provider = currentProvider(cfg);
    fillProviders($("#ai-mm-provider"), cfg, provider && provider.id);
    const mi = $("#ai-mm-model");
    setInputValue(mi, provider ? provider.model || "" : "");
    if (mi) {
      mi.placeholder = provider && provider.id === "custom" ? "必填，例如 gpt-4o-mini" : "模型 ID（可手动修改）";
      mi.readOnly = false;
      mi.disabled = false;
    }
    updateThink($("#ai-mm-think"), (cfg && cfg.thinking) || "balanced");
    const st = $("#ai-mm-status");
    if (st) {
      const keyOk = provider && provider.key_set;
      st.textContent = `${getShortcut()} 问答 · ${provider ? provider.label || provider.id : "未配置"}${keyOk ? "" : " · 请配置 API Key"}`;
    }
    fillProviders($("#ai-provider-select"), cfg, provider && provider.id);
    const smi = $("#ai-model-input");
    const sbi = $("#ai-base-input");
    setInputValue(smi, provider ? provider.model || "" : "");
    setInputValue(sbi, provider ? provider.base_url || "" : "");
    if (smi) {
      smi.placeholder = "模型 ID，可手动输入";
      smi.readOnly = false;
      smi.disabled = false;
    }
    if (sbi) {
      sbi.readOnly = false;
      sbi.disabled = false;
    }
    const sc = $("#ai-shortcut-input");
    setInputValue(sc, getShortcut());
    updateThink($("#ai-thinking-pick"), (cfg && cfg.thinking) || "balanced");
    const en = $("#ai-enabled");
    if (en) en.textContent = cfg && cfg.enabled === false ? "启用：关" : "启用：开";
    const scopeBtn = $("#ai-scope-btn");
    if (scopeBtn) {
      scopeBtn.textContent =
        cfg && cfg.context_scope === "full" ? "范围：结合全文" : "范围：邻近";
    }
    const memBtn = $("#ai-memory-btn");
    if (memBtn) {
      const m = (cfg && cfg.memory_mode) || "always";
      memBtn.textContent =
        m === "always" ? "记忆：默认学习" : m === "ask" ? "记忆：询问" : "记忆：关闭";
    }
    // Style / 自定义风格
    const style = (global.StuartAI && global.StuartAI.getStyle && global.StuartAI.getStyle(cfg)) || {};
    const lenRoot = $("#ai-length-pick");
    if (lenRoot) {
      lenRoot.querySelectorAll("[data-length]").forEach((b) => {
        b.classList.toggle("active", b.dataset.length === (style.length || "normal"));
      });
    }
    const toneRoot = $("#ai-tone-pick");
    if (toneRoot) {
      toneRoot.querySelectorAll("[data-tone]").forEach((b) => {
        b.classList.toggle("active", b.dataset.tone === (style.tone || "neutral"));
      });
    }
    const customTa = $("#ai-custom-style");
    if (customTa && document.activeElement !== customTa) {
      customTa.value = style.custom || "";
    }
    const hintTa = $("#ai-length-hint");
    if (hintTa && document.activeElement !== hintTa) {
      hintTa.value = style.length_hint || "";
    }
    return cfg;
  }

  async function collectForm() {
    const AI = global.StuartAI;
    const cfg = (await AI.ensureConfig(true)) || {};
    const next = Object.assign({}, cfg);
    next.enabled = !(cfg.enabled === false);
    const pid = $("#ai-provider-select")?.value || next.active_provider_id || "deepseek";
    next.active_provider_id = pid;
    next.explain_shortcut = $("#ai-shortcut-input")?.value?.trim() || "Alt+E";
    next.providers = (cfg.providers || []).map((p) => {
      if (p.id !== pid) return p;
      return Object.assign({}, p, {
        model: $("#ai-model-input")?.value?.trim() || p.model,
        base_url: $("#ai-base-input")?.value?.trim() || p.base_url,
      });
    });
    const thinkActive = $("#ai-thinking-pick [data-think].active");
    next.thinking = thinkActive ? thinkActive.dataset.think : cfg.thinking || "balanced";
    next.context_scope = cfg.context_scope || "neighborhood";
    next.memory_mode = cfg.memory_mode || "always";
    next.max_output_tokens = cfg.max_output_tokens || 2048;
    next.context_max_chars = cfg.context_max_chars || 8000;
    const style = AI.getStyle ? AI.getStyle(cfg) : {};
    const lenBtn = $("#ai-length-pick [data-length].active");
    const toneBtn = $("#ai-tone-pick [data-tone].active");
    next.style = Object.assign({}, style, {
      length: lenBtn ? lenBtn.dataset.length : style.length || "normal",
      tone: toneBtn ? toneBtn.dataset.tone : style.tone || "neutral",
      custom: $("#ai-custom-style")?.value?.trim() || "",
      length_hint: $("#ai-length-hint")?.value?.trim() || "",
    });
    return next;
  }

  async function applyForm() {
    const AI = global.StuartAI;
    if (!AI) return;
    const next = await collectForm();
    const res = await AI.saveAi(next);
    if (res && res.error) {
      toast(res.error);
      return;
    }
    await refreshChrome();
    const status = $("#ai-set-status");
    if (status) status.textContent = "AI 设置已应用";
    toast("AI 设置已应用");
  }

  async function applyFormQuiet() {
    const AI = global.StuartAI;
    if (!AI) return;
    const next = await collectForm();
    const res = await AI.saveAi(next);
    if (res && !res.error) await refreshChrome();
  }

  function bindModelMenu() {
    const btn = $("#btn-ai-model");
    const menu = $("#ai-model-menu");
    if (!btn || !menu || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    // Titlebar is a window-drag region — form controls must stop mousedown
    // or WebView2 may never focus the input/select.
    menu.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.addEventListener("input", (e) => {
      const t = e.target;
      if (t && t.dataset) t.dataset.editing = "1";
    });
    menu.addEventListener("focusout", (e) => {
      const t = e.target;
      if (t && t.dataset) t.dataset.editing = "0";
    });
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await refreshChrome();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) {
        const first = $("#ai-provider-select") || $("#ai-mm-model");
        try {
          first && first.focus({ preventScroll: true });
        } catch (_) {
          first && first.focus();
        }
      }
    });
    document.addEventListener("click", (e) => {
      if (menu.hidden) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      menu.hidden = true;
    });
    $("#ai-mm-provider")?.addEventListener("change", async (e) => {
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      const p = (cfg.providers || []).find((x) => x.id === e.target.value);
      const modelInput = $("#ai-mm-model");
      if (modelInput && p) {
        modelInput.dataset.editing = "0";
        modelInput.value = p.model || "";
        modelInput.focus();
        modelInput.select?.();
      }
    });
    $("#ai-mm-model")?.addEventListener("mousedown", (e) => e.stopPropagation());
    $("#ai-mm-model")?.addEventListener("input", (e) => {
      e.target.dataset.editing = "1";
    });
    $("#ai-mm-think")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-think]");
      if (!b) return;
      updateThink($("#ai-mm-think"), b.dataset.think);
    });
    $("#ai-mm-save")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      const next = Object.assign({}, cfg);
      next.active_provider_id = $("#ai-mm-provider")?.value || cfg.active_provider_id;
      const thinkActive = $("#ai-mm-think [data-think].active");
      next.thinking = thinkActive ? thinkActive.dataset.think : cfg.thinking;
      const typedModel = ($("#ai-mm-model")?.value || "").trim();
      next.providers = (cfg.providers || []).map((p) => {
        if (p.id !== next.active_provider_id) return p;
        return Object.assign({}, p, {
          model: typedModel || p.model,
          enabled: true,
        });
      });
      const res = await AI.saveAi(next);
      if (res?.error) toast(res.error);
      else {
        const mi = $("#ai-mm-model");
        if (mi) mi.dataset.editing = "0";
        await refreshChrome();
        menu.hidden = true;
        toast("已切换 AI 模型：" + (typedModel || "默认"));
      }
    });
    $("#ai-mm-settings")?.addEventListener("click", () => openSettingsFocus());
  }

  async function openSettingsFocus() {
    const menu = $("#ai-model-menu");
    if (menu) menu.hidden = true;
    // open settings modal via host if available
    const gear = $("#btn-settings");
    if (gear) gear.click();
    await refreshChrome();
    const sec = $("#set-ai-section");
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindSettingsForm() {
    const applyBtn = $("#ai-apply-btn");
    if (!applyBtn || applyBtn.dataset.bound === "1") return;
    applyBtn.dataset.bound = "1";
    // Allow free typing in AI settings (modal is outside titlebar, but keep guards)
    ["#ai-model-input", "#ai-base-input", "#ai-key-input", "#ai-shortcut-input"].forEach((sel) => {
      const node = $(sel);
      if (!node || node.dataset.inputBound === "1") return;
      node.dataset.inputBound = "1";
      node.readOnly = false;
      node.disabled = false;
      node.addEventListener("mousedown", (e) => e.stopPropagation());
      node.addEventListener("input", () => {
        node.dataset.editing = "1";
      });
      node.addEventListener("focusout", () => {
        node.dataset.editing = "0";
      });
    });
    const providerSel = $("#ai-provider-select");
    if (providerSel) {
      providerSel.disabled = false;
      providerSel.addEventListener("mousedown", (e) => e.stopPropagation());
    }
    $("#ai-enabled")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      cfg.enabled = cfg.enabled === false;
      await AI.saveAi(cfg);
      await refreshChrome();
    });
    $("#ai-provider-select")?.addEventListener("change", async (e) => {
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      const p = (cfg.providers || []).find((x) => x.id === e.target.value);
      if (p) {
        const mi = $("#ai-model-input");
        const bi = $("#ai-base-input");
        if (mi) {
          mi.dataset.editing = "0";
          mi.value = p.model || "";
        }
        if (bi) {
          bi.dataset.editing = "0";
          bi.value = p.base_url || "";
        }
      }
    });
    $("#ai-thinking-pick")?.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-think]");
      if (!b) return;
      updateThink($("#ai-thinking-pick"), b.dataset.think);
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      cfg.thinking = b.dataset.think;
      await AI.saveAi(cfg);
    });
    $("#ai-scope-btn")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      cfg.context_scope = cfg.context_scope === "full" ? "neighborhood" : "full";
      await AI.saveAi(cfg);
      await refreshChrome();
    });
    $("#ai-memory-btn")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const cfg = await AI.ensureConfig(true);
      const order = ["always", "ask", "off"];
      const cur = cfg.memory_mode || "always";
      cfg.memory_mode = order[(order.indexOf(cur) + 1) % order.length];
      await AI.saveAi(cfg);
      await refreshChrome();
    });
    $("#ai-length-pick")?.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-length]");
      if (!b) return;
      const AI = global.StuartAI;
      await AI.saveStyle({ length: b.dataset.length });
      await refreshChrome();
    });
    $("#ai-tone-pick")?.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-tone]");
      if (!b) return;
      const AI = global.StuartAI;
      await AI.saveStyle({ tone: b.dataset.tone });
      await refreshChrome();
    });
    $("#ai-custom-style")?.addEventListener("change", async (e) => {
      const AI = global.StuartAI;
      await AI.saveStyle({ custom: e.target.value });
      toast("自定义风格已保存");
    });
    $("#ai-length-hint")?.addEventListener("change", async (e) => {
      const AI = global.StuartAI;
      await AI.saveStyle({ length_hint: e.target.value });
      toast("长度提示已保存");
    });
    $("#ai-shortcut-reset")?.addEventListener("click", () => {
      const inp = $("#ai-shortcut-input");
      if (inp) inp.value = "Alt+E";
    });
    $("#ai-shortcut-record")?.addEventListener("click", () => {
      uiState.recordingShortcut = !uiState.recordingShortcut;
      document.body.classList.toggle("ai-shortcut-recording", uiState.recordingShortcut);
      const inp = $("#ai-shortcut-input");
      if (uiState.recordingShortcut) {
        if (inp) {
          inp.value = "";
          inp.placeholder = "请按下快捷键…";
        }
        toast("按下新的快捷键（建议含 Alt 或 Ctrl，避开 Ctrl+Shift+Z）");
      }
    });
    $("#ai-key-save")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const pid = $("#ai-provider-select")?.value;
      const key = $("#ai-key-input")?.value || "";
      if (!pid || !key.trim()) {
        toast("请选择服务商并填写 API Key");
        return;
      }
      const res = await AI.setApiKey(pid, key.trim());
      if (res?.error) toast(res.error);
      else {
        const ki = $("#ai-key-input");
        if (ki) ki.value = "";
        await refreshChrome();
        toast("API Key 已保存到本机（DPAPI）");
      }
    });
    $("#ai-key-clear")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const pid = $("#ai-provider-select")?.value;
      if (!pid) return;
      const res = await AI.clearApiKey(pid);
      if (res?.error) toast(res.error);
      else {
        await refreshChrome();
        toast("已清除该服务商密钥");
      }
    });
    $("#ai-test-btn")?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      const pid = $("#ai-provider-select")?.value;
      const st = $("#ai-set-status");
      if (st) st.textContent = "正在测试连接…";
      await applyFormQuiet();
      const res = await AI.testProvider(pid);
      if (res?.error) {
        if (st)
          st.textContent = "连接失败：" + res.error + (res.body ? " · " + res.body : "");
        toast("连接失败：" + res.error);
      } else {
        const n = (res.models || []).length;
        if (st) st.textContent = `连接成功${n ? " · 可用模型 " + n + " 个" : ""}`;
        toast("连接成功");
      }
    });
    applyBtn.addEventListener("click", () => applyForm());
  }

  function setFeedbackVisible(v, highlight) {
    const fb = panelEls().feedback;
    if (!fb) return;
    fb.hidden = !v;
    if (v) {
      fb.querySelectorAll(".ai-fb-btn").forEach((b) => {
        b.classList.toggle("picked", !!highlight && b.dataset.fb === highlight);
      });
    }
  }

  async function onStyleFeedback(kind) {
    const AI = global.StuartAI;
    if (!AI || !AI.recordStyleFeedback) return;
    const res = await AI.recordStyleFeedback(kind);
    if (res && res.error) {
      toast(res.error);
      return;
    }
    const style = AI.getStyle ? AI.getStyle() : {};
    setFeedbackVisible(true, kind);
    const label =
      kind === "short" ? "太短" : kind === "long" ? "太长" : "满意";
    const hint = (style && style.length_hint) || "";
    setStatus(
      `已记录「${label}」。自定义风格中的长度提示已更新，可在设置中编辑。`,
      true
    );
    toast("已写入自定义风格" + (hint ? "（长度提示已更新）" : ""));
    try {
      global.StuartAIUI.refreshChrome?.();
    } catch (_) {}
  }

  function bindPanel() {
    const p = panelEls();
    if (!p.root || p.root.dataset.bound === "1") return;
    p.root.dataset.bound = "1";
    let drag = null;
    p.drag?.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const rect = p.root.getBoundingClientRect();
      drag = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      p.root.style.right = "auto";
      uiState.userMoved = true;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      // Free drag inside the app WebView; host window clips overflow (cannot paint outside).
      const maxX = Math.max(0, window.innerWidth - 48);
      const maxY = Math.max(0, window.innerHeight - 36);
      const left = Math.min(maxX, Math.max(-p.root.offsetWidth + 48, e.clientX - drag.x));
      const top = Math.min(maxY, Math.max(0, e.clientY - drag.y));
      p.root.style.left = left + "px";
      p.root.style.top = top + "px";
    });
    document.addEventListener("mouseup", () => {
      if (drag) {
        savePanelGeom({ moved: true });
      }
      drag = null;
    });
    try {
      if (window.ResizeObserver && p.root) {
        let t = 0;
        const ro = new ResizeObserver(() => {
          clearTimeout(t);
          t = setTimeout(() => savePanelGeom({}), 200);
        });
        ro.observe(p.root);
      }
    } catch (_) {}
    p.close?.addEventListener("click", async () => {
      await global.StuartAI?.cancel();
      closePanel();
    });
    p.cancel?.addEventListener("click", async () => {
      await global.StuartAI?.cancel();
      setThinking(false);
      finishStreamingChat(uiState.lastAnswer || "", "已取消生成");
    });
    p.copy?.addEventListener("click", () => {
      const text = uiState.lastAnswer || "";
      if (!text) {
        toast("暂无问答内容");
        return;
      }
      try {
        navigator.clipboard?.writeText(text);
        toast("已复制问答");
      } catch (_) {
        toast("复制失败");
      }
    });
    p.remember?.addEventListener("click", async () => {
      const AI = global.StuartAI;
      if (!AI) return;
      const snippet = (uiState.lastQuote || "").slice(0, 80);
      const res = await AI.rememberSnippet(snippet || (uiState.lastAnswer || "").slice(0, 80));
      if (res?.error) toast(res.error);
      else toast("已记入 AI 记忆");
    });
    p.reask?.addEventListener("click", () => triggerExplain({ reposition: false }));
    p.follow?.addEventListener("click", () => {
      if (!uiState.lastMessages || !uiState.lastMessages.length) {
        toast("请先进行一次问答");
        return;
      }
      p.followRow.hidden = !p.followRow.hidden;
      if (!p.followRow.hidden) p.followInput?.focus();
    });
    p.followSend?.addEventListener("click", () => sendFollowUp());
    p.followInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendFollowUp();
      }
    });
    p.feedback?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-fb]");
      if (!btn) return;
      onStyleFeedback(btn.dataset.fb);
    });
  }

  function listenChat(requestId, onDelta, onDone) {
    const tauri = global.__TAURI__;
    if (tauri?.event?.listen) {
      let un1 = null;
      let un2 = null;
      tauri.event
        .listen("ai-chat-delta", (e) => {
          const payload = e.payload || e;
          if (payload.requestId && payload.requestId !== requestId) return;
          onDelta(payload);
        })
        .then((f) => {
          un1 = f;
        });
      tauri.event
        .listen("ai-chat-done", (e) => {
          const payload = e.payload || e;
          if (payload.requestId && payload.requestId !== requestId) return;
          onDone(payload);
          try {
            un1 && un1();
            un2 && un2();
          } catch (_) {}
        })
        .then((f) => {
          un2 = f;
        });
      return;
    }
    const onD = (ev) => {
      const payload = ev.detail || ev;
      if (payload.requestId && payload.requestId !== requestId) return;
      onDelta(payload);
    };
    const onE = (ev) => {
      const payload = ev.detail || ev;
      if (payload.requestId && payload.requestId !== requestId) return;
      onDone(payload);
      global.removeEventListener("ai-chat-delta", onD);
      global.removeEventListener("ai-chat-done", onE);
    };
    global.addEventListener("ai-chat-delta", onD);
    global.addEventListener("ai-chat-done", onE);
  }

  async function sendFollowUp() {
    const p = panelEls();
    const q = (p.followInput?.value || "").trim();
    if (!q) return;
    if (p.followInput) p.followInput.value = "";
    const AI = global.StuartAI;
    const C = global.StuartAIContext;
    const api = global.pywebview && global.pywebview.api;
    if (!AI || !api) return;
    const cfg = await AI.ensureConfig();
    const provider = currentProvider(cfg);
    if (!provider) {
      toast("请先配置 AI 模型");
      return;
    }
    if (!uiState.lastMessages || !uiState.lastMessages.length) {
      toast("请先进行一次问答，再追问");
      return;
    }
    openPanel(); // keep position — no reposition
    pushChat("user", q);
    uiState.lastMessages = [
      ...(uiState.lastMessages || []),
      { role: "user", content: q },
    ];
    uiState.lastAnswer = "";
    uiState.isFirstAnswer = false;
    setFeedbackVisible(false);
    pushChat("ai", "", { streaming: true });
    setThinking(true, "正在思考…");
    const requestId = "ai-" + Date.now().toString(36) + "-f";
    uiState.requestId = requestId;
    const res = await api.ai_chat_start(
      requestId,
      provider.id,
      provider.model,
      uiState.lastMessages,
      cfg.thinking || "balanced",
      cfg.max_output_tokens || 2048
    );
    if (res?.error) {
      setThinking(false);
      finishStreamingChat("", res.error);
      return;
    }
    listenChat(
      requestId,
      (payload) => {
        setThinking(false);
        uiState.lastAnswer += payload.text || "";
        updateStreamingChat(uiState.lastAnswer);
      },
      (payload) => {
        const text = payload.text || uiState.lastAnswer || "";
        uiState.lastAnswer = text;
        const errMsg = payload.error && !text ? payload.error : payload.error || null;
        finishStreamingChat(text, errMsg && !text ? errMsg : null);
        if (text) {
          uiState.lastMessages.push({ role: "assistant", content: text });
        }
        if (payload.error && text) {
          // partial + error note
          const info = classifyAiError(payload.error);
          toast(info.title);
        }
      }
    );
  }

  function resolveSelectedQuote() {
    const host = global.StuartMD;
    let text = "";
    let page = null;
    let inPdf = false;
    try {
      const info = host && host.getSelectionInfo && host.getSelectionInfo();
      text = String((info && info.text) || "").trim();
      if (info && info.inPdf) {
        inPdf = true;
        page = info.page != null ? info.page : null;
      }
    } catch (_) {}
    if (!text) {
      try {
        const cache = host && host.getSelectionCache && host.getSelectionCache();
        text = String((cache && cache.text) || "").trim();
        if (cache && cache.inPdf) {
          inPdf = true;
          page = cache.page != null ? cache.page : page;
        }
      } catch (_) {}
    }
    return { text, page, inPdf };
  }

  function isPdfDoc() {
    try {
      if (global.StuartMDPdf && global.StuartMDPdf.isActive && global.StuartMDPdf.isActive()) {
        return true;
      }
    } catch (_) {}
    try {
      const d = global.StuartMD && global.StuartMD.getDocument && global.StuartMD.getDocument();
      return !!(d && d.kind === "pdf");
    } catch (_) {
      return false;
    }
  }

  async function triggerExplain(opts) {
    try {
      const o = opts || {};
      const now = Date.now();
      if (now - (uiState._lastTriggerAt || 0) < 350) return;
      uiState._lastTriggerAt = now;
      const AI = global.StuartAI;
      const C = global.StuartAIContext;
      if (!AI || !C) {
        toast("AI 模块未加载（StuartAI/StuartAIContext）");
        return;
      }
      try {
        global.StuartMD?.captureSelectionCache?.();
      } catch (_) {}
      const picked = resolveSelectedQuote();
      const quote = typeof picked === "string" ? picked : picked.text;
      const pdfMode = isPdfDoc() || (picked && picked.inPdf);
      if (!quote) {
        toast("请先选中要问答的内容");
        return;
      }
      openPanel({ reposition: o.reposition !== false && !uiState.userMoved });
      const cfg = await AI.ensureConfig();
      const provider = currentProvider(cfg);
      if (cfg && cfg.enabled === false) {
        toast("AI 已关闭，请在右上角「模型」中启用");
        return;
      }
      const p = panelEls();
      if (p.quote) {
        p.quote.hidden = false;
        p.quote.textContent = quote.slice(0, 120);
      }
      if (p.meta) {
        p.meta.textContent = `${(provider && provider.label) || ""} · ${(cfg && cfg.thinking) || "balanced"} · ${getShortcut()}`;
      }
      resetChatForExplain(quote);
      pushChat("ai", "", { streaming: true });
      setThinking(true, "正在思考…");
      const badge = $("#ai-panel-badge");
      if (badge) {
        badge.textContent = "问答中";
        badge.dataset.state = "busy";
      }
      uiState.lastQuote = quote;
      uiState.lastAnswer = "";
      uiState.lastMessages = [];
      uiState.isFirstAnswer = true;
      setFeedbackVisible(false);

      let explainInput = { kind: "markdown", quote };
      let builtForHistory = null;
      if (pdfMode) {
        let pdfCtx = { quote, page: (picked && picked.page) || null, name: "PDF", pageText: "", neighborText: "" };
        try {
          if (global.StuartMDPdf?.getAiContext) {
            pdfCtx = Object.assign(pdfCtx, await global.StuartMDPdf.getAiContext());
            pdfCtx.quote = quote || pdfCtx.quote;
          }
        } catch (_) {}
        explainInput = {
          kind: "pdf",
          quote,
          page: pdfCtx.page,
          pageText: pdfCtx.pageText || "",
          neighborText: pdfCtx.neighborText || "",
          name: pdfCtx.name || "PDF",
        };
        const stylePdf = AI.getStyle ? AI.getStyle() : {};
        builtForHistory = C.buildPdfExplain(explainInput, {
          maxChars: cfg.context_max_chars || C.DEFAULT_MAX,
          scope: cfg.context_scope,
          memoryProfile: "",
        });
        void stylePdf;
      } else {
        builtForHistory = C.buildMarkdownExplain(global.StuartMD, {
          quote,
          scope: (cfg && cfg.context_scope) || "neighborhood",
          maxChars: (cfg && cfg.context_max_chars) || 8000,
        });
      }

      const res = await AI.explain(explainInput, {
        onDelta: (full) => {
          setThinking(false);
          uiState.lastAnswer = full;
          updateStreamingChat(full);
        },
        onDone: async (payload) => {
          const text = payload && payload.text != null ? payload.text : uiState.lastAnswer;
          uiState.lastAnswer = text || "";
          const err = payload && payload.error && !text ? payload.error : null;
          finishStreamingChat(uiState.lastAnswer, err);
          const badge2 = $("#ai-panel-badge");
          if (badge2) {
            badge2.textContent = err ? "失败" : "完成";
            badge2.dataset.state = err ? "err" : "ok";
          }
          if (err) {
            const info = classifyAiError(err);
            toast(info.title);
            if (info.action === "open_settings") openSettingsFocus();
            return;
          }
          const styleNow = AI.getStyle ? AI.getStyle() : {};
          uiState.lastMessages = [
            { role: "system", content: C.systemPrompt(styleNow) },
            { role: "user", content: (builtForHistory && builtForHistory.promptUser) || quote },
            { role: "assistant", content: uiState.lastAnswer },
          ];
          try {
            const mm = await AI.handleMemoryAfterExplain(
              (builtForHistory && builtForHistory.meta) || { name: pdfMode ? "PDF" : "Markdown" },
              quote,
              uiState.lastAnswer
            );
            if (mm && mm.ask) pushChat("system", "问答完成。可点「记入记忆」保存偏好（记忆策略：询问）。");
            else if (mm && mm.ok && mm.mode === "always") pushChat("system", "已按「默认学习」记录本次活动。");
          } catch (_) {}
          if (uiState.isFirstAnswer) {
            setFeedbackVisible(true);
            uiState.isFirstAnswer = false;
          }
        },
      });
      if (res && res.error) {
        setThinking(false);
        finishStreamingChat("", res.error);
        const badge3 = $("#ai-panel-badge");
        if (badge3) {
          badge3.textContent = "失败";
          badge3.dataset.state = "err";
        }
      } else if (res && res.meta && p.meta) {
        uiState.lastMeta = res.meta;
        const label = res.meta.page != null ? `P${res.meta.page}` : res.meta.heading || "";
        p.meta.textContent = `${(provider && provider.label) || ""} · ${label} · ${getShortcut()}`;
      }
    } catch (err) {
      console.error("triggerExplain failed", err);
      setThinking(false);
      finishStreamingChat("", err && err.message ? err.message : String(err));
      openPanel();
    }
  }

  function handleShortcutKeydown(e) {
    const C = global.StuartAIContext;
    if (!C) return false;
    if (uiState.recordingShortcut) {
      if (e.key === "Escape") {
        uiState.recordingShortcut = false;
        document.body.classList.remove("ai-shortcut-recording");
        return true;
      }
      if (!e.key || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return false;
      const label = C.shortcutFromEvent(e);
      if (!label) return false;
      e.preventDefault();
      uiState.recordingShortcut = false;
      document.body.classList.remove("ai-shortcut-recording");
      const inp = $("#ai-shortcut-input");
      if (inp) {
        inp.value = label;
        inp.placeholder = "Alt+E";
      }
      toast("快捷键已录入，点「应用 AI 设置」保存：" + label);
      return true;
    }
    // Never steal keys while user is typing in model/key/shortcut fields
    if (isTypingTarget(e.target) && !e.target?.closest?.("#ai-panel")) return false;
    const sc = C.parseShortcut(getShortcut());
    if (C.eventMatchesShortcut(e, sc)) {
      e.preventDefault();
      e.stopPropagation();
      triggerExplain();
      return true;
    }
    return false;
  }

  function bindAll() {
    bindModelMenu();
    bindPanel();
    bindSettingsForm();
    // Direct bind on selection-bar AI button (belt & suspenders)
    document.querySelectorAll('[data-sel="ai-explain"]').forEach((btn) => {
      if (btn.dataset.aiBound === "1") return;
      btn.dataset.aiBound = "1";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerExplain().catch((err) => {
          console.error(err);
          toast(String(err && err.message ? err.message : err));
        });
      });
    });
    refreshChrome().catch(() => {});
  }

  global.StuartAIUI = {
    bindAll,
    refreshChrome,
    triggerExplain,
    handleShortcutKeydown,
    openSettingsFocus,
    openPanel,
    closePanel,
    classifyAiError,
    uiState,
  };
})(typeof window !== "undefined" ? window : globalThis);
