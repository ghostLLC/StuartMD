(function (global) {
  "use strict";
  const $ = selector => document.querySelector(selector), AI = () => global.StuartAI, service = () => global.StuartAIService;
  const uiState = { recordingShortcut: false, selection: null, selectionTarget: null, focus: null, view: null, settings: null, bound: false };
  const pickers = new Map();
  const toast = message => global.StuartMD.toast(String(message));
  const report = error => toast(error.message || String(error));
  function bind(selector, event, action) { $(selector)?.addEventListener(event, value => Promise.resolve().then(() => action(value)).catch(report)); }
  function getShortcut() { return AI().config?.explain_shortcut || "Alt+E"; }
  function validateShortcut(shortcut) {
    const context = global.StuartAIContext, parsed = context.parseShortcut(shortcut);
    if (!parsed?.key) throw new Error("快捷键格式无效");
    const canonical = value => { const item = context.parseShortcut(value); return JSON.stringify([!!item.mods.ctrl, !!item.mods.alt, !!item.mods.shift, !!item.mods.meta, String(item.key).toLowerCase()]); };
    const conflict = global.StuartMD.getShortcutRegistrations().find(item => item.action !== "ai-explain" && canonical(item.shortcut) === canonical(shortcut));
    if (conflict) throw new Error(`快捷键与「${conflict.label}」冲突`);
  }
  function renderConfiguration(snapshot) {
    const active = snapshot.ai.models.find(model => model.id === snapshot.ai.active_model_id);
    for (const [anchor, picker] of pickers) { anchor.textContent = active?.display_name || "选择模型"; anchor.title = `当前模型：${active?.display_name || "尚未选择"}`; anchor.setAttribute("aria-label", `选择模型，当前${active?.display_name || "尚未选择"}`); picker.refresh(snapshot); }
    const container = $("#set-ai-section"); if (container) { if (uiState.settings) uiState.settings.refresh(snapshot); else uiState.settings = global.StuartAISettings.mount(container, snapshot); }
  }
  async function refreshChrome() { const config = await AI().ensureConfig(true); renderConfiguration(AI().snapshot); return config; }
  async function openSettingsFocus() { for (const picker of pickers.values()) picker.close(false); $("#btn-settings").click(); await refreshChrome(); $("#set-ai-section").scrollIntoView({ behavior: "smooth", block: "start" }); }
  function bindModelPicker(anchor) {
    if (pickers.has(anchor)) return pickers.get(anchor);
    const picker = global.StuartModelPicker.create({ anchor, onSelect: id => AI().updateConfig({ kind: "selectModel", model_id: id }), onManage: openSettingsFocus });
    pickers.set(anchor, picker); anchor.classList.add("ai-model-trigger");
    anchor.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); Promise.resolve().then(async () => { await AI().ensureConfig(true); if (anchor.getAttribute("aria-expanded") === "true") picker.close(); else picker.open(AI().snapshot); }).catch(report); });
    if (AI().config) renderConfiguration(AI().snapshot); return picker;
  }
  function renderQuick(snapshot) {
    const active = snapshot.activeRequest, config = snapshot.config || AI().config, model = AI().activeModel(config);
    const identity = JSON.stringify([global.StuartMD.getDocument()?.documentId, snapshot.target?.workspaceKey]); if (uiState.selectionTarget !== identity) uiState.selection = null;
    $("#ai-panel-badge").textContent = global.StuartConversationView.phases[active?.phase || active?.status] || "就绪";
    $("#ai-panel-meta").textContent = [model?.display_name, snapshot.target?.documentKey, getShortcut()].filter(Boolean).join(" · "); $("#ai-panel-cancel").hidden = !active;
    const input = $("#ai-panel-follow-input"); if (input.value !== (snapshot.draft?.question || "")) input.value = snapshot.draft?.question || "";
    $("#ai-panel-follow-send").disabled = !!active || snapshot.busy || config?.enabled === false || !snapshot.target || !model; $("#ai-panel-reask").disabled = !!active || snapshot.busy || config?.enabled === false || !uiState.selection || !model;
    const quote = snapshot.draft?.selection?.quote || snapshot.draft?.selection?.text || uiState.selection?.text; $("#ai-panel-quote").textContent = quote || ""; $("#ai-panel-quote").hidden = !quote;
  }
  function bindPanel() {
    const panel = $("#ai-panel"); if (!panel || panel.dataset.bound === "1") return; panel.dataset.bound = "1";
    $("#ai-panel-body").replaceChildren(); const list = document.createElement("div"); list.id = "ai-chat"; $("#ai-panel-body").append(list);
    uiState.view = global.StuartConversationView.create({ list, scroll: $("#ai-panel-body"), onSnapshot: renderQuick });
    $("#ai-panel-follow-row").hidden = false; $("#ai-panel-feedback").hidden = false; $("#ai-panel-follow-input").placeholder = "输入追问（Ctrl+Enter 发送）";
    $("#ai-panel-reask").textContent = "解释选中内容"; $("#ai-panel-follow").textContent = "在伴读中继续";
    for (const selector of ["#ai-panel-copy", "#ai-panel-remember"]) $(selector).hidden = true;
    bind("#ai-panel-close", "click", closePanel); bind("#ai-panel-cancel", "click", () => service().cancel()); bind("#ai-panel-reask", "click", explainCaptured);
    bind("#ai-panel-follow", "click", async () => { closePanel(); await global.StuartCompanion.toggle(true); await global.StuartCompanion.switchTab("chat"); });
    bind("#ai-panel-follow-send", "click", sendFollowUp); bind("#ai-panel-follow-input", "input", event => service().updateDraft({ question: event.target.value }));
    $("#ai-panel-follow-input").addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendFollowUp().catch(report); } });
    panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closePanel(); } });
    bind("#ai-panel-feedback", "click", async event => { const item = event.target.closest("[data-fb]"); if (!item) return; await AI().recordStyleFeedback(item.dataset.fb); toast("回答风格反馈已经保存"); });
    const hint = document.createElement("div"); hint.className = "sc-card-meta"; hint.textContent = "Ctrl+Enter 发送问题"; $("#ai-panel-follow-row").after(hint);
  }
  function openPanel() {
    bindPanel(); const panel = $("#ai-panel"); if (window.innerWidth < 640 || window.innerHeight < 460) { global.StuartCompanion.toggle(true).catch(report); return; }
    if (panel.hidden) uiState.focus = document.activeElement; panel.hidden = false;
    const range = global.getSelection()?.rangeCount ? global.getSelection().getRangeAt(0) : null, rect = range?.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 24), height = Math.min(500, window.innerHeight - 24); panel.style.width = `${width}px`; panel.style.height = `${height}px`;
    panel.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect?.right ? rect.right - width : window.innerWidth - width - 24))}px`; panel.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, rect?.bottom ? rect.bottom + 12 : 88))}px`; panel.style.right = "auto"; renderQuick(service().snapshot); $("#ai-panel-reask").focus();
  }
  function closePanel() { $("#ai-panel").hidden = true; uiState.focus?.focus?.(); }
  async function triggerExplain() { global.StuartMD.captureSelectionCache(); const selection = global.StuartMD.getSelectionInfo(); if (!selection.text?.trim()) throw new Error("请先选择需要解释的正文"); uiState.selectionTarget = JSON.stringify([selection.documentId, service().snapshot.target?.workspaceKey]); uiState.selection = { ...selection, quote: selection.text }; await service().updateDraft({ selection: uiState.selection }); openPanel(); }
  async function explainCaptured() { if (!uiState.selection) throw new Error("请先选择正文"); await service().sendQuestion("请结合原文解释选中内容。", { scope: "selection", selection: uiState.selection }); }
  async function sendFollowUp() { const question = $("#ai-panel-follow-input").value.trim(); if (!question) throw new Error("请输入追问内容"); await service().sendQuestion(question, { scope: service().snapshot.draft?.scope || "document" }); }
  function handleShortcutKeydown(event) {
    const context = global.StuartAIContext;
    if (uiState.recordingShortcut) { if (event.key === "Escape") { uiState.recordingShortcut = false; return true; } if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return false; const shortcut = context.shortcutFromEvent(event); if (!shortcut) return false; event.preventDefault(); uiState.recordingShortcut = false; const control = $("#ai-shortcut-input"); control.value = shortcut; control.dispatchEvent(new Event("input", { bubbles: true })); return true; }
    if (event.target.closest?.("input,textarea,select,[contenteditable=true]") && !event.target.closest("#editor")) return false;
    if (!context.eventMatchesShortcut(event, context.parseShortcut(getShortcut()))) return false; event.preventDefault(); event.stopPropagation(); triggerExplain().catch(report); return true;
  }
  function classifyAiError(raw) { return { kind: "request", title: "问答未完成", detail: String(raw || "请求没有完成"), action: "retry" }; }
  function bindAll() {
    if (!uiState.bound) { uiState.bound = true; global.addEventListener("stuart-ai-config", event => renderConfiguration(event.detail)); }
    bindModelPicker($("#btn-ai-model")); bindPanel(); document.querySelectorAll('[data-sel="ai-explain"]').forEach(item => { if (item.dataset.aiBound) return; item.dataset.aiBound = "1"; item.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); triggerExplain().catch(report); }); }); refreshChrome().catch(report);
  }
  global.StuartAIUI = { bindAll, bindModelPicker, refreshChrome, validateShortcut, triggerExplain, handleShortcutKeydown, openSettingsFocus, openPanel, closePanel, classifyAiError, uiState };
})(typeof window !== "undefined" ? window : globalThis);
