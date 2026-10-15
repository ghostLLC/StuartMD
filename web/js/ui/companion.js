(function (global) {
  "use strict";
  const $ = selector => document.querySelector(selector), api = () => global.pywebview.api, host = () => global.StuartMD, service = () => global.StuartAIService;
  const state = { open: false, tab: "chat", width: 380, focus: null, availableSelection: null, status: null, hits: [], vaultEpoch: 0, previewEpoch: 0, referenceKey: null, vaultRenderKey: null, indexing: false, narrow: false, region: "companion", preview: false, targetKey: "" };
  const report = error => { const message = error.message || String(error); $("#sc-notice").textContent = message; host().toast(message); };
  const text = (tag, content, className) => { const element = document.createElement(tag); element.textContent = content; if (className) element.className = className; return element; };
  const button = (label, action) => global.StuartConversationView.button(label, action);
  const bindAction = (selector, action) => $(selector).addEventListener("click", () => Promise.resolve().then(action).catch(report));
  function ensureDom() {
    if ($("#stuart-companion")) return $("#stuart-companion");
    const panel = document.createElement("aside"); panel.id = "stuart-companion"; panel.className = "stuart-companion"; panel.hidden = true; panel.setAttribute("aria-label", "伴读");
    panel.innerHTML = `
      <header class="sc-head"><div><div class="sc-title">伴读</div><div id="sc-target" class="sc-card-meta"></div></div><button type="button" class="icon-btn sm" id="sc-close" aria-label="关闭伴读">×</button></header>
      <div class="sc-tabs" role="tablist" aria-label="伴读页面">${[["chat", "问答"], ["vault", "知识"], ["memory", "记忆"], ["history", "会话"]].map(([tab, label]) => `<button type="button" id="sc-tab-${tab}" class="sc-tab" data-tab="${tab}" role="tab" aria-controls="sc-page-${tab}">${label}</button>`).join("")}</div>
      <div id="sc-notice" class="sc-error" role="status"></div>
      <section id="sc-page-chat" class="sc-panel" role="tabpanel" aria-labelledby="sc-tab-chat" data-panel="chat">
        <div class="sc-available" id="sc-available"></div><div id="sc-references" class="sc-references"></div><div class="sc-list" id="sc-messages"></div>
        <div class="sc-input-zone"><label class="sc-field-label" for="sc-input">问题</label><textarea id="sc-input" rows="3" placeholder="结合所选材料提问"></textarea>
          <div class="sc-input-meta"><label class="sc-field-label">提问范围<select id="sc-scope"><option value="selection">选中内容</option><option value="section">当前章节</option><option value="document">整篇文档</option><option value="workspace">工作区资料</option></select></label><button type="button" id="sc-model-settings" class="btn sm">模型设置</button></div>
          <div id="sc-phase" class="sc-card-meta" role="status"></div><div class="sc-card-meta">Ctrl+Enter 发送问题</div>
          <div class="sc-actions"><button type="button" class="btn sm" id="sc-attach">引用选区</button><button type="button" class="btn sm" id="sc-materials">查看本次材料</button><button type="button" class="btn sm" id="sc-new">新建会话</button><button type="button" class="btn sm" id="sc-cancel" hidden>停止回答</button><button type="button" class="btn sm primary" id="sc-send">发送</button></div></div>
      </section>
      <section id="sc-page-vault" class="sc-panel" role="tabpanel" aria-labelledby="sc-tab-vault" data-panel="vault" hidden>
        <div class="sc-input-zone"><div id="sc-workspace" class="sc-card-title"></div><label class="sc-field-label">搜索资料<input id="sc-vault-q" type="search" placeholder="检索工作区正文与 PDF" /></label>
          <div class="sc-actions"><button type="button" class="btn sm primary" id="sc-vault-go">搜索</button><button type="button" class="btn sm" id="sc-index">建立索引</button><button type="button" class="btn sm" id="sc-index-cancel" hidden>取消索引</button></div><div id="sc-vault-status" class="sc-card-meta" role="status"></div>
          <details><summary>索引详情</summary><label class="sc-field-label">嵌入模型<select id="sc-model"><option value="BAAI/bge-m3">BGE-M3 · 1024 维</option><option value="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2">多语言 MiniLM · 384 维</option></select></label><div id="sc-index-details" class="sc-card-meta"></div></details>
          <div id="sc-partial-row" hidden><div class="sc-card-meta">部分资料尚未完成索引，请检查文件清单。</div><button type="button" class="btn sm" id="sc-partial">使用已完成的资料</button></div></div><div class="sc-list" id="sc-vault-list"></div>
      </section>
      <section id="sc-page-memory" class="sc-panel" role="tabpanel" aria-labelledby="sc-tab-memory" data-panel="memory" hidden><div class="sc-list" id="sc-memory-list"></div></section>
      <section id="sc-page-history" class="sc-panel" role="tabpanel" aria-labelledby="sc-tab-history" data-panel="history" hidden><div class="sc-list" id="sc-history-list"></div></section>
      <section class="sc-panel sc-preview" id="sc-preview" aria-label="材料详情" hidden><div class="sc-list" id="sc-preview-body"></div><div class="sc-input-zone"><button type="button" class="btn sm" id="sc-preview-back">返回原页面</button></div></section>
      <div class="sc-resize" id="sc-resize" role="separator" tabindex="0" aria-label="调整伴读宽度" aria-orientation="vertical" aria-valuemin="340" aria-valuemax="600"></div>`;
    const main = $("#main"); main.append(panel);
    const regions = document.createElement("div"); regions.id = "sc-regions"; regions.className = "sc-regions"; regions.hidden = true; regions.setAttribute("role", "group"); regions.setAttribute("aria-label", "选择显示区域");
    regions.append(button("文档", () => setRegion("document")), button("伴读", () => setRegion("companion"))); main.prepend(regions);
    bindAction("#sc-close", () => toggle(false)); bindAction("#sc-attach", attachSelection); bindAction("#sc-send", send); bindAction("#sc-cancel", () => service().cancel()); bindAction("#sc-new", () => service().reset());
    global.StuartAIUI.bindModelPicker($("#sc-model-settings")); bindAction("#sc-materials", previewMaterials); bindAction("#sc-vault-go", vaultSearch); bindAction("#sc-index", indexWorkspace); bindAction("#sc-preview-back", closePreview);
    bindAction("#sc-index-cancel", async () => { if (!state.status?.jobId) throw new Error("当前工作区没有索引任务"); await api().rag_cancel_sync(host().state.workspaceRoot, state.status.jobId); await refreshVault(); });
    bindAction("#sc-partial", async () => { await refreshVault(); const status = state.status; if (status.status !== "Partial") throw new Error("工作区索引覆盖已经变化"); await service().updateDraft({ partialAcknowledgement: { workspaceKey: status.workspaceKey, indexGeneration: status.indexGeneration, coverageHash: status.coverageHash } }); renderStatus(); });
    panel.querySelectorAll("[data-tab]").forEach(item => item.addEventListener("click", () => switchTab(item.dataset.tab).catch(report)));
    panel.querySelector(".sc-tabs").addEventListener("keydown", event => {
      const tabs = [...panel.querySelectorAll("[data-tab]")], current = tabs.indexOf(document.activeElement); if (current < 0) return; let index = current;
      if (event.key === "ArrowRight") index = (current + 1) % tabs.length; else if (event.key === "ArrowLeft") index = (current + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") index = 0; else if (event.key === "End") index = tabs.length - 1; else if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); tabs[index].focus(); switchTab(tabs[index].dataset.tab).catch(report);
    });
    $("#sc-input").addEventListener("input", () => { resizeInput(); Promise.resolve().then(() => service().updateDraft({ question: $("#sc-input").value })).catch(report); });
    $("#sc-scope").addEventListener("change", () => Promise.resolve().then(() => service().updateDraft({ scope: $("#sc-scope").value })).catch(report));
    $("#sc-input").addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send().catch(report); } });
    $("#sc-vault-q").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); vaultSearch().catch(report); } });
    $("#sc-model").addEventListener("change", () => setEmbeddingModel().catch(report));
    panel.addEventListener("keydown", event => { if (event.key !== "Escape" || document.querySelector("dialog[open]")) return; event.preventDefault(); if (state.preview) closePreview(); else toggle(false).catch(report); });
    let drag = null; const resize = $("#sc-resize");
    resize.addEventListener("pointerdown", event => { drag = { x: event.clientX, width: state.width }; resize.setPointerCapture(event.pointerId); event.preventDefault(); });
    resize.addEventListener("pointermove", event => { if (drag) setWidth(drag.width + drag.x - event.clientX); });
    resize.addEventListener("pointerup", () => { drag = null; localStorage.setItem("stuart_companion_width", String(state.width)); }); resize.addEventListener("pointercancel", () => { drag = null; });
    resize.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); setWidth(state.width + (event.key === "ArrowLeft" ? 16 : -16)); localStorage.setItem("stuart_companion_width", String(state.width)); });
    const stored = Number(localStorage.getItem("stuart_companion_width")); if (stored >= 340 && stored <= 600) state.width = stored;
    const observer = new ResizeObserver(layout); for (const item of [main, $("#sidebar"), $("#sidebar-resizer")]) if (item) observer.observe(item); global.addEventListener("resize", layout);
    new MutationObserver(layout).observe($("#editor-area"), { attributes: true, attributeFilter: ["class", "hidden"] });
    state.view = global.StuartConversationView.create({ list: $("#sc-messages"), onSnapshot: renderSnapshot });
    $("#sc-messages").addEventListener("scroll", () => { clearTimeout(state.scrollTimer); state.scrollTimer = setTimeout(() => { if (service().snapshot.draft) Promise.resolve().then(() => service().updateDraft({ viewState: { ...(service().snapshot.draft.viewState || {}), scrollTop: $("#sc-messages").scrollTop, followLatest: state.view.isFollowing() } })).catch(report); }, 300); });
    global.addEventListener("stuart-session-restored", () => { toggle(true).then(() => switchTab("chat")).catch(report); });
    service().on("restored", () => { toggle(true).then(() => switchTab("chat")).catch(report); });
    service().on("memory", () => { if (state.open && state.tab === "memory" && !state.preview && $("#sc-memory-list").dataset.memoryView === "list") global.StuartMemoryUI.renderMemory($("#sc-memory-list")).catch(report); });
    service().on("history", () => { if (state.open && state.tab === "history" && !state.preview && $("#sc-history-list").dataset.historyView === "list") global.StuartMemoryUI.renderSessions($("#sc-history-list")).catch(report); });
    if (global.pywebview?.api) bindKnowledgeEvents().catch(report); else global.addEventListener("pywebviewready", () => bindKnowledgeEvents().catch(report), { once: true });
    return panel;
  }
  function setWidth(width) { state.width = Math.min(600, Math.max(340, width)); layout(); }
  function layout() {
    const main = $("#main"), panel = $("#stuart-companion"); if (!panel) return;
    const minimum = host()?.state?.mode === "split" ? 800 : 480, sidebar = $("#sidebar"), divider = $("#sidebar-resizer");
    const sidebarWidth = sidebar?.getBoundingClientRect().width || 0, dividerWidth = divider?.getBoundingClientRect().width || 0;
    const left = sidebarWidth + (dividerWidth ? dividerWidth + parseFloat(getComputedStyle(divider).marginLeft) : 0), available = Math.max(0, main.clientWidth - left); state.narrow = available < minimum + 346;
    main.style.setProperty("--sc-left", `${left}px`);
    main.classList.toggle("sc-open", state.open); main.classList.toggle("sc-narrow", state.open && state.narrow); main.classList.toggle("sc-show-companion", state.open && state.narrow && state.region === "companion"); $("#sc-regions").hidden = !state.open || !state.narrow;
    for (const [index, item] of [...$("#sc-regions").children].entries()) item.setAttribute("aria-pressed", String((index === 0 ? "document" : "companion") === state.region));
    const actualWidth = state.narrow ? available : Math.min(state.width, Math.max(340, available - minimum - 6));
    main.style.setProperty("--sc-width", `${actualWidth}px`); $("#sc-resize").setAttribute("aria-valuenow", String(Math.round(actualWidth))); $("#sc-resize").hidden = state.narrow;
  }
  function setRegion(region) { state.region = region; layout(); if (region === "companion") $("#sc-input").focus(); }
  function resizeInput() { const input = $("#sc-input"); input.style.height = "auto"; input.style.height = `${Math.min(206, Math.max(80, input.scrollHeight))}px`; }
  async function switchTab(tab, persist = true) {
    const panel = ensureDom(); state.tab = tab; closePreview();
    panel.querySelectorAll("[data-tab]").forEach(item => { const selected = item.dataset.tab === tab; item.classList.toggle("active", selected); item.setAttribute("aria-selected", String(selected)); item.tabIndex = selected ? 0 : -1; }); panel.querySelectorAll("[data-panel]").forEach(item => { item.hidden = item.dataset.panel !== tab; });
    if (persist && service().snapshot.draft) await service().updateDraft({ viewState: { ...(service().snapshot.draft.viewState || {}), tab } });
    if (tab === "memory") await global.StuartMemoryUI.renderMemory($("#sc-memory-list")); if (tab === "history") await global.StuartMemoryUI.renderSessions($("#sc-history-list")); if (tab === "vault") await refreshVault();
  }
  async function toggle(force) {
    const panel = ensureDom(), open = force == null ? !state.open : !!force;
    if (open && !state.open) { state.focus = document.activeElement; host().captureSelectionCache?.(); state.availableSelection = host().getSelectionInfo(); state.region = "companion"; }
    if (!open && service().snapshot.draft) await service().updateDraft({ viewState: { ...(service().snapshot.draft.viewState || {}), tab: state.tab, scrollTop: $("#sc-messages").scrollTop, followLatest: state.view.isFollowing() } });
    state.open = open; panel.hidden = !open; host().state.companionOpen = open; $("#btn-companion")?.classList.toggle("active", open); $("#btn-companion")?.setAttribute("aria-expanded", String(open)); layout();
    if (open) { renderSnapshot(service().snapshot); await switchTab(service().snapshot.draft?.viewState?.tab || state.tab, false); $("#sc-tab-" + state.tab).focus(); } else state.focus?.focus?.();
  }
  function renderSnapshot(snapshot) {
    if (!snapshot) return; const targetKey = JSON.stringify([snapshot.target?.documentKey, snapshot.target?.workspaceKey, snapshot.sessionId]);
    if (targetKey !== state.targetKey) { state.targetKey = targetKey; state.vaultEpoch += 1; state.hits = []; state.status = null; state.referenceKey = null; state.vaultRenderKey = null; if (state.availableSelection?.documentId !== snapshot.document?.documentId) state.availableSelection = null; closePreview(); $("#sc-vault-list").replaceChildren(); if (state.open) switchTab(snapshot.draft?.viewState?.tab || "chat", false).catch(report); }
    const current = host().getDocument(); $("#sc-target").textContent = [snapshot.target?.documentKey ? current?.name || current?.path || "未保存文档" : "工作区会话", snapshot.target?.workspaceKey || "未选择工作区"].join(" · ");
    const input = $("#sc-input"), question = snapshot.draft?.question || ""; if (input.value !== question) { const start = input.selectionStart, end = input.selectionEnd; input.value = question; if (document.activeElement === input) input.setSelectionRange(Math.min(start, question.length), Math.min(end, question.length)); resizeInput(); }
    $("#sc-scope").value = snapshot.draft?.scope || "document"; $("#sc-scope option[value='section']").textContent = current?.kind === "pdf" ? "当前页面" : "当前章节";
    for (const item of $("#sc-scope").options) item.disabled = item.value === "workspace" ? !snapshot.target?.workspaceKey : !current?.documentId;
    const cfg = snapshot.config || global.StuartAI.config, model = global.StuartAI.activeModel(cfg); $("#sc-model-settings").textContent = model?.display_name || "选择模型";
    const active = snapshot.activeRequest, phase = active?.phase || active?.status; $("#sc-phase").textContent = [global.StuartConversationView.phases[phase] || phase, snapshot.sourceUpdated ? "正文已更新，本次回答依据发送时版本" : "", snapshot.meta?.error, cfg?.enabled === false ? "AI 尚未启用，请打开模型设置" : "", !snapshot.target ? "请打开文档或选择工作区" : ""].filter(Boolean).join(" · ");
    $("#sc-send").disabled = !!active || snapshot.busy || cfg?.enabled === false || !snapshot.target; $("#sc-new").disabled = !!active || snapshot.busy || !snapshot.target; $("#sc-cancel").hidden = !active; $("#btn-companion")?.setAttribute("title", active ? "伴读正在回答 (Alt+I)" : "伴读 (Alt+I)");
    $("#sc-available").textContent = state.availableSelection?.text ? `可引用的选中内容：${state.availableSelection.text.slice(0, 120)}` : ""; renderReferences(); renderVaultResults(); layout();
  }
  async function attachSelection() {
    const selection = host().getSelectionInfo(); if (!selection.text?.trim()) throw new Error("请先选中需要引用的正文"); const current = host().getDocument();
    await service().addReference({ ...selection, kind: "selection", selection: { ...selection, quote: selection.text }, quote: selection.text, documentId: current.documentId, revision: current.revision, title: "正文选区", excerpt: selection.text }); await service().updateDraft({ selection: { ...selection, quote: selection.text } });
  }
  function referenceInput(hit) { return { ...hit, kind: "knowledge", inputId: `knowledge:${hit.workspaceId}:${hit.indexGeneration}:${hit.chunkId}`, title: hit.relPath, excerpt: hit.content, coverageHash: state.status?.coverageHash, partialConfirmed: partialConfirmed() }; }
  function references() { return service().snapshot.references || service().snapshot.draft?.explicitSources || []; }
  function renderReferences() {
    const container = $("#sc-references"), items = references(), signature = JSON.stringify([items, state.status?.indexGeneration, state.status?.coverageHash, state.status?.sourceChanged]); if (signature === state.referenceKey) return; state.referenceKey = signature;
    const expanded = new Set([...container.querySelectorAll("details[open]")].map(item => item.dataset.inputId)); container.replaceChildren(); if (!items.length) return; container.append(text("div", `已引用 ${items.length} 项材料`, "sc-card-meta"));
    for (const input of items) {
      const card = document.createElement("details"); card.className = "sc-reference"; card.dataset.inputId = input.inputId; card.open = expanded.has(input.inputId); card.append(text("summary", input.title || input.relPath || "引用材料")); card.append(text("div", input.excerpt || input.content || input.quote || input.selection?.quote || "打开预览查看实际材料", "sc-reference-excerpt"));
      const changed = input.kind === "knowledge" && state.status && (input.workspaceId !== state.status.workspaceId || input.indexGeneration !== state.status.indexGeneration || state.status.sourceChanged || input.indexStatus === "Partial" && input.coverageHash !== state.status.coverageHash);
      const reason = input.error || input.invalidReason || (input.status === "stale" || changed) && "来源已经变化，请重新选择材料"; if (reason) card.append(text("div", reason, "sc-error")); card.append(button("预览来源", () => previewSource(input)), button("移除引用", () => service().removeReference(input.inputId))); container.append(card);
    }
  }
  async function send() {
    if (service().snapshot.activeRequest) throw new Error("请等待当前回答完成"); const scope = $("#sc-scope").value, draft = service().snapshot.draft || {}; let question = $("#sc-input").value.trim(); if (!question && scope === "selection" && draft.selection) question = "请结合原文解释选中内容。"; if (!question) throw new Error("请输入具体问题");
    await service().sendQuestion(question, { scope, selection: draft.selection, explicitSources: draft.explicitSources, readingAnchor: scope === "section" ? host().getReadingAnchor() : null });
  }
  function openPreview() { state.previewEpoch += 1; state.previewFocus = document.activeElement; state.preview = true; $("#sc-preview").hidden = false; $("#stuart-companion").querySelectorAll("[data-panel]").forEach(item => { item.hidden = true; }); $("#sc-preview-body").replaceChildren(); $("#sc-preview-back").focus(); }
  function closePreview() { if (!$("#sc-preview")) return; const open = state.preview; state.previewEpoch += 1; state.preview = false; $("#sc-preview").hidden = true; $("#stuart-companion").querySelectorAll("[data-panel]").forEach(item => { item.hidden = item.dataset.panel !== state.tab; }); if (open) state.previewFocus?.focus?.(); }
  function materialCard(source) {
    const card = document.createElement("article"); card.className = "sc-card"; card.append(text("div", source.title || source.relPath || source.kind || "材料", "sc-card-title"), text("div", [source.anchor?.heading || source.anchor?.headingPath || source.headingPath, source.anchor?.page || source.pageNumber ? `第 ${source.anchor?.page || source.pageNumber} 页` : "", source.status, source.anchor?.version || source.version ? `版本 ${source.anchor?.version || source.version}` : "", source.mandatory ? "明确引用" : "", source.used === true ? "本次已使用" : source.used === false ? "本次未使用" : "", source.reason || source.invalidReason].filter(Boolean).join(" · "), "sc-card-meta"), text("div", source.excerpt || source.content || source.text || "", "sc-card-snippet")); return card;
  }
  async function previewSource(source, message) {
    if (!state.open) await toggle(true); const targetKey = state.targetKey; openPreview(); const epoch = state.previewEpoch; $("#sc-preview-body").textContent = "正在读取实际来源…";
    const result = source.sourceId && message?.requestId ? await service().getSource(source.sourceId, message.requestId) : await service().previewSource(source); if (targetKey !== state.targetKey || !state.preview || epoch !== state.previewEpoch) return; const material = result.source; $("#sc-preview-body").replaceChildren(materialCard({ ...material, used: message ? material.used : undefined }));
    if (material.relPath || material.path || material.anchor?.path) $("#sc-preview-body").append(button("打开原文", async () => { if (service().snapshot.draft) await service().updateDraft({ viewState: { ...(service().snapshot.draft.viewState || {}), tab: state.tab } }); await host().openKnowledgeSource({ ...source, ...material, ...(material.anchor || {}) }); }));
  }
  async function previewMaterials() {
    const key = state.targetKey; openPreview(); const epoch = state.previewEpoch; $("#sc-preview-body").textContent = "正在读取本次材料…"; const result = await service().previewMaterials(); if (key !== state.targetKey || !state.preview || epoch !== state.previewEpoch) return; const container = $("#sc-preview-body"); container.replaceChildren(); container.append(text("div", result.promptTokens == null ? "容量：发送时核算" : `本地计数：${result.promptTokens}`, "sc-card-meta"));
    for (const source of result.sources) container.append(materialCard({ ...source, used: undefined }));
  }
  function partialConfirmed() { const saved = service().snapshot.draft?.partialAcknowledgement, status = state.status; return !!(saved && status && saved.workspaceKey === status.workspaceKey && saved.indexGeneration === status.indexGeneration && saved.coverageHash === status.coverageHash); }
  async function refreshVault() {
    const root = host().state.workspaceRoot, epoch = ++state.vaultEpoch; if (!root) { state.status = null; state.hits = []; $("#sc-vault-list").replaceChildren(); $("#sc-workspace").textContent = "请从文件菜单打开工作区目录"; $("#sc-vault-status").textContent = ""; return; } await api().rag_set_workspace(root); const status = await api().companion_workspace_status(root); if (epoch !== state.vaultEpoch || root !== host().state.workspaceRoot) return; state.status = status; $("#sc-model").value = status.selectedModelId; renderStatus(); renderReferences();
  }
  function renderStatus() {
    const status = state.status; if (!status) return; const labels = { Uninitialized: "尚未建立索引", Loading: "正在加载模型", Scanning: "正在检查文件", Indexing: "正在处理资料", Validating: "正在检查来源", Ready: "资料索引已完成", Partial: "部分资料已完成", Failed: "索引未完成", Cancelled: "索引已经停止" };
    $("#sc-workspace").textContent = host().state.workspaceRoot; $("#sc-vault-status").textContent = [`已覆盖 ${status.docCount || 0} 个文件`, `已处理 ${status.processedFiles || 0}/${status.totalFiles || 0} 个文件`, status.lastIndexed ? `更新于 ${new Date(status.lastIndexed).toLocaleString()}` : "", status.currentFile, labels[status.status] || status.status, status.errorMessage, status.sourceChanged ? "资料已经变化，请更新索引" : ""].filter(Boolean).join(" · ");
    $("#sc-index-details").textContent = [`当前模型：${status.modelId || "尚未建立索引"}`, ...((status.failedFiles || []).map(item => `未完成文件：${item.path} · ${item.stage} · ${item.message}`)), ...((status.excludedFiles || []).map(item => `排除文件：${item.path} · ${item.reason}`))].join("\n"); $("#sc-index").textContent = status.docCount ? "更新索引" : "建立索引"; $("#sc-index-cancel").hidden = !status.jobId || !["Loading", "Indexing", "Scanning", "Validating"].includes(status.status); $("#sc-partial-row").hidden = status.status !== "Partial"; $("#sc-partial").textContent = partialConfirmed() ? "已确认当前资料范围" : "使用已完成的资料"; $("#sc-partial").disabled = partialConfirmed();
  }
  async function setEmbeddingModel() { const model = $("#sc-model"); model.disabled = true; try { await api().rag_set_model(model.value, host().state.workspaceRoot); state.hits = []; await refreshVault(); renderVaultResults(); } finally { model.disabled = false; } }
  async function indexWorkspace() { if (state.indexing) return; await refreshVault(); const root = host().state.workspaceRoot; if (!root) throw new Error("请先打开工作区"); state.indexing = true; $("#sc-index").disabled = true; try { await api().rag_sync_workspace(root); } finally { state.indexing = false; $("#sc-index").disabled = false; if (root === host().state.workspaceRoot) await refreshVault(); } }
  async function vaultSearch() { const query = $("#sc-vault-q").value.trim(); if (!query) throw new Error("请输入检索问题"); await refreshVault(); const root = host().state.workspaceRoot; if (!root) throw new Error("请先打开工作区"); const epoch = ++state.vaultEpoch; $("#sc-vault-list").textContent = "正在搜索资料…"; const hits = await api().rag_query(query, 20, root, partialConfirmed()); if (epoch !== state.vaultEpoch || root !== host().state.workspaceRoot) return; state.hits = hits; renderVaultResults(); if (!hits.length) $("#sc-vault-list").textContent = "没有找到相关内容"; }
  function renderVaultResults() {
    const container = $("#sc-vault-list"); if (!container) return; const signature = JSON.stringify([state.hits, references().map(item => item.inputId), state.status?.coverageHash]); if (signature === state.vaultRenderKey) return; state.vaultRenderKey = signature; container.replaceChildren(); if (!state.hits.length) return;
    for (const hit of state.hits) { const source = referenceInput(hit), card = materialCard({ ...hit, title: hit.relPath, excerpt: hit.content }); const attached = references().find(item => item.inputId === source.inputId || item.chunkId === hit.chunkId && item.workspaceId === hit.workspaceId && item.indexGeneration === hit.indexGeneration); const actions = document.createElement("div"); actions.className = "sc-detail-actions"; actions.append(button("预览来源", () => previewSource(source)), button(attached ? "已引用 · 移除" : "加入引用", () => { if (attached) return service().removeReference(attached.inputId); if (hit.indexStatus === "Partial" && !partialConfirmed()) throw new Error("请先确认使用当前已完成资料的范围"); return service().addReference(source); })); card.append(actions); container.append(card); }
  }
  async function bindKnowledgeEvents() {
    for (const name of ["rag-sync-progress", "rag-status-changed", "rag-source-changed", "rag-sync-error"]) await api().listen_event(name, event => { const payload = event.payload; if (payload.workspaceId !== state.status?.workspaceId) return; if (name === "rag-sync-error") $("#sc-vault-status").textContent = payload.message; else if (name === "rag-sync-progress") { state.status = { ...state.status, ...payload }; renderStatus(); } else refreshVault().catch(report); });
  }
  global.StuartCompanion = { toggle, isOpen: () => state.open, attachSelection, previewSource, previewMaterials, layout, switchTab };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureDom); else ensureDom();
})(typeof window !== "undefined" ? window : globalThis);
