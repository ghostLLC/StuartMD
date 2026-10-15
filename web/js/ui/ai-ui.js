(function (global) {
  "use strict";
  const $ = selector => document.querySelector(selector), AI = () => global.StuartAI, service = () => global.StuartAIService;
  const uiState = { recordingShortcut: false, selection: null, selectionTarget: null, focus: null, view: null };
  const toast = message => global.StuartMD.toast(String(message));
  const report = error => { toast(error.message || String(error)); const status = $("#ai-set-status"); if (status) status.textContent = error.message || String(error); };
  function bind(selector, event, action) { const element = $(selector); if (element) element.addEventListener(event, value => Promise.resolve().then(() => action(value)).catch(report)); }
  function currentProvider(config) { return config.providers.find(item => item.id === config.active_provider_id); }
  function getShortcut() { return AI().config?.explain_shortcut || "Alt+E"; }
  function setInput(selector, value) { const element = $(selector); if (element && document.activeElement !== element && element.dataset.editing !== "1") element.value = value ?? ""; }
  function fillProviders(selector, config) {
    const element = $(selector); if (!element) return; const selected = document.activeElement === element ? element.value : config.active_provider_id; element.replaceChildren();
    for (const provider of config.providers) { const option = document.createElement("option"); option.value = provider.id; option.textContent = `${provider.label || provider.id}${provider.key_set ? "" : " · 尚未设置密钥"}`; element.append(option); } element.value = selected;
  }
  function updatePick(selector, key, value) { $(selector)?.querySelectorAll(`[data-${key}]`).forEach(item => item.classList.toggle("active", item.dataset[key] === value)); }
  async function refreshChrome() {
    const config = await AI().ensureConfig(true), provider = currentProvider(config), style = AI().getStyle(config);
    fillProviders("#ai-mm-provider", config); fillProviders("#ai-provider-select", config);
    setInput("#ai-mm-model", provider?.model); setInput("#ai-model-input", provider?.model); setInput("#ai-base-input", provider?.base_url); setInput("#ai-shortcut-input", getShortcut());
    updatePick("#ai-mm-think", "think", config.thinking); updatePick("#ai-thinking-pick", "think", config.thinking); updatePick("#ai-length-pick", "length", style.length); updatePick("#ai-tone-pick", "tone", style.tone);
    setInput("#ai-custom-style", style.custom); setInput("#ai-length-hint", style.length_hint);
    if ($("#ai-mm-status")) $("#ai-mm-status").textContent = `${getShortcut()} 选区问答 · ${provider?.label || "尚未配置服务商"}${provider?.key_set ? "" : " · 请设置密钥"}`;
    if ($("#ai-enabled")) $("#ai-enabled").textContent = config.enabled ? "关闭 AI" : "启用 AI";
    if ($("#ai-scope-btn")) $("#ai-scope-btn").textContent = `默认范围：${global.StuartConversationView.scopeLabels[config.context_scope] || "整篇文档"}`;
    if ($("#ai-memory-btn")) $("#ai-memory-btn").textContent = `整理新记忆：${{ off: "关闭", ask: "询问", automatic: "自动" }[config.learning_policy] || "询问"}`;
    if ($("#ai-use-memory")) $("#ai-use-memory").checked = config.use_saved_memories;
    return config;
  }
  function validateShortcut(shortcut) {
    const context = global.StuartAIContext, parsed = context.parseShortcut(shortcut);
    if (!parsed?.key) throw new Error("快捷键格式无效");
    const canonical = value => { const item = context.parseShortcut(value); return JSON.stringify([!!item.mods.ctrl, !!item.mods.alt, !!item.mods.shift, !!item.mods.meta, String(item.key).toLowerCase()]); };
    const conflict = global.StuartMD.getShortcutRegistrations().find(item => item.action !== "ai-explain" && canonical(item.shortcut) === canonical(shortcut));
    if (conflict) throw new Error(`快捷键与「${conflict.label}」冲突`);
  }
  async function collectForm() {
    const config = await AI().ensureConfig(true), providerId = $("#ai-provider-select").value, shortcut = $("#ai-shortcut-input").value.trim(); validateShortcut(shortcut);
    const style = AI().getStyle(config);
    return { ...config, active_provider_id: providerId, explain_shortcut: shortcut, use_saved_memories: $("#ai-use-memory").checked,
      thinking: $("#ai-thinking-pick [data-think].active")?.dataset.think || config.thinking,
      providers: config.providers.map(item => item.id === providerId ? { ...item, model: $("#ai-model-input").value.trim(), base_url: $("#ai-base-input").value.trim() } : item),
      style: { ...style, length: $("#ai-length-pick [data-length].active")?.dataset.length || style.length, tone: $("#ai-tone-pick [data-tone].active")?.dataset.tone || style.tone, custom: $("#ai-custom-style").value, length_hint: $("#ai-length-hint").value } };
  }
  async function applyForm(quiet = false) { const result = await AI().saveAi(await collectForm()); if (result?.error) throw new Error(result.error); await refreshChrome(); if (!quiet) { $("#ai-set-status").textContent = "AI 设置已经保存"; toast("AI 设置已经保存"); } }
  async function openSettingsFocus() { if ($("#ai-model-menu")) $("#ai-model-menu").hidden = true; $("#btn-settings").click(); await refreshChrome(); $("#set-ai-section").scrollIntoView({ behavior: "smooth", block: "start" }); }
  function bindModelMenu() {
    const trigger = $("#btn-ai-model"), menu = $("#ai-model-menu"); if (!trigger || trigger.dataset.bound === "1") return; trigger.dataset.bound = "1";
    menu.addEventListener("mousedown", event => event.stopPropagation()); menu.addEventListener("click", event => event.stopPropagation()); menu.addEventListener("input", event => { event.target.dataset.editing = "1"; }); menu.addEventListener("focusout", event => { event.target.dataset.editing = "0"; });
    bind("#btn-ai-model", "click", async event => { event.preventDefault(); event.stopPropagation(); await refreshChrome(); menu.hidden = !menu.hidden; if (!menu.hidden) $("#ai-mm-model").focus(); });
    document.addEventListener("click", event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) menu.hidden = true; });
    bind("#ai-mm-provider", "change", async event => { const config = await AI().ensureConfig(true), provider = config.providers.find(item => item.id === event.target.value); if (!provider) throw new Error("服务商配置不存在"); $("#ai-mm-model").value = provider.model; $("#ai-mm-model").focus(); });
    bind("#ai-mm-think", "click", event => { const item = event.target.closest("[data-think]"); if (item) updatePick("#ai-mm-think", "think", item.dataset.think); });
    bind("#ai-mm-save", "click", async () => { const config = await AI().ensureConfig(true), id = $("#ai-mm-provider").value, model = $("#ai-mm-model").value.trim(); if (!model) throw new Error("请输入模型名称"); const result = await AI().saveAi({ ...config, active_provider_id: id, thinking: $("#ai-mm-think [data-think].active")?.dataset.think || config.thinking, providers: config.providers.map(item => item.id === id ? { ...item, model, enabled: true } : item) }); if (result?.error) throw new Error(result.error); $("#ai-mm-model").dataset.editing = "0"; await refreshChrome(); menu.hidden = true; toast(`当前模型：${model}`); });
    bind("#ai-mm-settings", "click", openSettingsFocus);
  }
  function bindSettingsForm() {
    const apply = $("#ai-apply-btn"); if (!apply || apply.dataset.bound === "1") return; apply.dataset.bound = "1";
    for (const selector of ["#ai-model-input", "#ai-base-input", "#ai-key-input", "#ai-shortcut-input"]) { $(selector).addEventListener("mousedown", event => event.stopPropagation()); $(selector).addEventListener("input", event => { event.target.dataset.editing = "1"; }); $(selector).addEventListener("focusout", event => { event.target.dataset.editing = "0"; }); }
    bind("#ai-provider-select", "change", async event => { const config = await AI().ensureConfig(true), provider = config.providers.find(item => item.id === event.target.value); if (!provider) throw new Error("服务商配置不存在"); $("#ai-model-input").value = provider.model; $("#ai-base-input").value = provider.base_url; });
    bind("#ai-enabled", "click", async () => { const config = await AI().ensureConfig(true); await AI().saveAi({ ...config, enabled: !config.enabled }); await refreshChrome(); });
    bind("#ai-scope-btn", "click", async () => { const config = await AI().ensureConfig(true), order = ["selection", "section", "document", "workspace"]; await AI().saveAi({ ...config, context_scope: order[(order.indexOf(config.context_scope) + 1) % order.length] }); await refreshChrome(); });
    bind("#ai-memory-btn", "click", async () => { const config = await AI().ensureConfig(true), order = ["off", "ask", "automatic"], policy = order[(order.indexOf(config.learning_policy) + 1) % order.length]; await AI().saveAi({ ...config, learning_policy: policy }); await refreshChrome(); });
    bind("#ai-use-memory", "change", async event => { const config = await AI().ensureConfig(true); await AI().saveAi({ ...config, use_saved_memories: event.target.checked }); await refreshChrome(); });
    for (const [selector, key] of [["#ai-thinking-pick", "think"], ["#ai-length-pick", "length"], ["#ai-tone-pick", "tone"]]) bind(selector, "click", async event => { const item = event.target.closest(`[data-${key}]`); if (!item) return; updatePick(selector, key, item.dataset[key]); if (key === "think") { const config = await AI().ensureConfig(true); await AI().saveAi({ ...config, thinking: item.dataset[key] }); } else await AI().saveStyle({ [key]: item.dataset[key] }); });
    bind("#ai-custom-style", "change", event => AI().saveStyle({ custom: event.target.value })); bind("#ai-length-hint", "change", event => AI().saveStyle({ length_hint: event.target.value }));
    bind("#ai-shortcut-reset", "click", () => { $("#ai-shortcut-input").value = "Alt+E"; });
    bind("#ai-shortcut-record", "click", () => { uiState.recordingShortcut = !uiState.recordingShortcut; document.body.classList.toggle("ai-shortcut-recording", uiState.recordingShortcut); if (uiState.recordingShortcut) { $("#ai-shortcut-input").value = ""; $("#ai-shortcut-input").placeholder = "请按下快捷键"; } });
    bind("#ai-key-save", "click", async () => { const id = $("#ai-provider-select").value, key = $("#ai-key-input").value.trim(); if (!key) throw new Error("请填写 API Key"); const result = await AI().setApiKey(id, key); if (result?.error) throw new Error(result.error); $("#ai-key-input").value = ""; await refreshChrome(); toast("API Key 已经保存"); });
    bind("#ai-key-clear", "click", async () => { const result = await AI().clearApiKey($("#ai-provider-select").value); if (result?.error) throw new Error(result.error); await refreshChrome(); toast("服务商密钥已经清除"); });
    bind("#ai-test-btn", "click", async () => { const control = $("#ai-test-btn"); control.disabled = true; $("#ai-set-status").textContent = "正在测试连接…"; try { await applyForm(true); const result = await AI().testProvider($("#ai-provider-select").value); if (!result.ok) throw new Error(result.error || "服务商没有确认连接成功"); $("#ai-set-status").textContent = `连接成功 · ${(result.models || []).length} 个可用模型`; } finally { control.disabled = false; } });
    bind("#ai-apply-btn", "click", () => applyForm()); bind("#ai-counting-btn", "click", async () => { await applyForm(true); await global.StuartMemoryUI.openCountingSettings($("#ai-provider-select").value); });
  }
  function renderQuick(snapshot) {
    const active = snapshot.activeRequest, config = snapshot.config || AI().config, provider = config && currentProvider(config);
    const identity = JSON.stringify([global.StuartMD.getDocument()?.documentId, snapshot.target?.workspaceKey]); if (uiState.selectionTarget !== identity) uiState.selection = null;
    $("#ai-panel-badge").textContent = global.StuartConversationView.phases[active?.phase || active?.status] || "就绪";
    $("#ai-panel-meta").textContent = [provider?.model, snapshot.target?.documentKey, getShortcut()].filter(Boolean).join(" · "); $("#ai-panel-cancel").hidden = !active;
    const input = $("#ai-panel-follow-input"); if (input.value !== (snapshot.draft?.question || "")) input.value = snapshot.draft?.question || "";
    $("#ai-panel-follow-send").disabled = !!active || snapshot.busy || config?.enabled === false || !snapshot.target; $("#ai-panel-reask").disabled = !!active || snapshot.busy || config?.enabled === false || !uiState.selection;
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
    bind("#ai-panel-feedback", "click", async event => { const item = event.target.closest("[data-fb]"); if (!item) return; const result = await AI().recordStyleFeedback(item.dataset.fb); if (result?.error) throw new Error(result.error); toast("回答风格反馈已经保存"); await refreshChrome(); });
    const hint = document.createElement("div"); hint.className = "sc-card-meta"; hint.textContent = "Ctrl+Enter 发送问题"; $("#ai-panel-follow-row").after(hint);
  }
  function openPanel() {
    bindPanel(); const panel = $("#ai-panel");
    if (window.innerWidth < 640 || window.innerHeight < 460) { global.StuartCompanion.toggle(true).catch(report); return; }
    if (panel.hidden) uiState.focus = document.activeElement; panel.hidden = false;
    const range = global.getSelection()?.rangeCount ? global.getSelection().getRangeAt(0) : null, rect = range?.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 24), height = Math.min(500, window.innerHeight - 24); panel.style.width = `${width}px`; panel.style.height = `${height}px`;
    panel.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect?.right ? rect.right - width : window.innerWidth - width - 24))}px`; panel.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, rect?.bottom ? rect.bottom + 12 : 88))}px`; panel.style.right = "auto";
    renderQuick(service().snapshot); $("#ai-panel-reask").focus();
  }
  function closePanel() { $("#ai-panel").hidden = true; uiState.focus?.focus?.(); }
  async function triggerExplain() { global.StuartMD.captureSelectionCache(); const selection = global.StuartMD.getSelectionInfo(); if (!selection.text?.trim()) throw new Error("请先选择需要解释的正文"); uiState.selectionTarget = JSON.stringify([selection.documentId, service().snapshot.target?.workspaceKey]); uiState.selection = { ...selection, quote: selection.text }; await service().updateDraft({ selection: uiState.selection }); openPanel(); }
  async function explainCaptured() { if (!uiState.selection) throw new Error("请先选择正文"); await service().sendQuestion("请结合原文解释选中内容。", { scope: "selection", selection: uiState.selection }); }
  async function sendFollowUp() { const question = $("#ai-panel-follow-input").value.trim(); if (!question) throw new Error("请输入追问内容"); await service().sendQuestion(question, { scope: service().snapshot.draft?.scope || "document" }); }
  function handleShortcutKeydown(event) {
    const context = global.StuartAIContext;
    if (uiState.recordingShortcut) { if (event.key === "Escape") { uiState.recordingShortcut = false; document.body.classList.remove("ai-shortcut-recording"); return true; } if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return false; const shortcut = context.shortcutFromEvent(event); if (!shortcut) return false; event.preventDefault(); uiState.recordingShortcut = false; document.body.classList.remove("ai-shortcut-recording"); $("#ai-shortcut-input").value = shortcut; return true; }
    if (event.target.closest?.("input,textarea,select,[contenteditable=true]") && !event.target.closest("#editor")) return false;
    if (!context.eventMatchesShortcut(event, context.parseShortcut(getShortcut()))) return false; event.preventDefault(); event.stopPropagation(); triggerExplain().catch(report); return true;
  }
  function classifyAiError(raw) { return { kind: "request", title: "问答未完成", detail: String(raw || "请求没有完成"), action: "retry" }; }
  function bindAll() { bindModelMenu(); bindSettingsForm(); bindPanel(); document.querySelectorAll('[data-sel="ai-explain"]').forEach(item => { if (item.dataset.aiBound) return; item.dataset.aiBound = "1"; item.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); triggerExplain().catch(report); }); }); refreshChrome().catch(report); }
  global.StuartAIUI = { bindAll, refreshChrome, triggerExplain, handleShortcutKeydown, openSettingsFocus, openPanel, closePanel, classifyAiError, uiState };
})(typeof window !== "undefined" ? window : globalThis);
