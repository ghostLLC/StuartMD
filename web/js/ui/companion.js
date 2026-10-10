(function (global) {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const api = () => global.pywebview.api;
  const host = () => global.StuartMD;
  const escape = global.StuartAIContext.escapeHtml;
  const state = { open: false, tab: "chat", width: 380, selection: null, busy: false, requestId: null,
    streamElement: null, memoryFilter: "all", status: null, knowledge: new Map(), vaultEpoch: 0, indexing: false };
  const report = error => host().toast(error.message || String(error));
  function bindAction(selector, action) {
    $(selector).addEventListener("click", () => Promise.resolve().then(action).catch(report));
  }
  function ensureDom() {
    if ($("#stuart-companion")) return $("#stuart-companion");
    const panel = document.createElement("aside");
    panel.id = "stuart-companion"; panel.className = "stuart-companion"; panel.hidden = true;
    panel.innerHTML = `
      <div class="sc-head"><div class="sc-title">伴读</div><button type="button" class="icon-btn sm" id="sc-close" aria-label="关闭伴读">×</button></div>
      <div class="sc-tabs" role="tablist">${[["chat","问答"],["vault","知识"],["memory","记忆"],["history","会话"]].map(([tab,label]) => `<button type="button" class="sc-tab" data-tab="${tab}" role="tab">${label}</button>`).join("")}</div>
      <div class="sc-panel" data-panel="chat">
        <div class="sc-quote" id="sc-quote" hidden></div><div class="sc-quote" id="sc-knowledge" hidden></div>
        <div class="sc-list" id="sc-messages"></div>
        <div class="sc-input-zone"><textarea id="sc-input" rows="3" placeholder="结合当前文档提问…"></textarea>
          <div class="sc-actions"><button type="button" class="btn sm" id="sc-attach">引用选区</button><button type="button" class="btn sm" id="sc-new">新建会话</button><button type="button" class="btn sm" id="sc-cancel" hidden>停止</button><button type="button" class="btn sm primary" id="sc-send">发送</button></div>
        </div>
      </div>
      <div class="sc-panel" data-panel="vault" hidden>
        <div class="sc-input-zone"><input id="sc-vault-q" type="search" placeholder="检索工作区正文与 PDF…" />
          <div class="sc-actions"><button type="button" class="btn sm primary" id="sc-vault-go">检索</button><button type="button" class="btn sm" id="sc-index">建立索引</button><button type="button" class="btn sm" id="sc-index-cancel" hidden>取消索引</button></div>
          <label class="sc-field-label">嵌入模型<select id="sc-model"><option value="BAAI/bge-m3">BGE-M3 · 1024 维</option><option value="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2">多语言 MiniLM · 384 维</option></select></label>
          <label class="sc-field-label"><input type="checkbox" id="sc-partial" />允许使用已经列明失败资料的 Partial 索引</label>
          <div id="sc-vault-status" class="sc-card-meta" role="status"></div>
        </div><div class="sc-list" id="sc-vault-list"></div>
      </div>
      <div class="sc-panel" data-panel="memory" hidden><div class="sc-filters">${[["all","全部"],["profile","偏好"],["notes","备忘"]].map(([value,label]) => `<button type="button" class="sc-chip" data-memory="${value}">${label}</button>`).join("")}</div><div class="sc-list" id="sc-memory-list"></div></div>
      <div class="sc-panel" data-panel="history" hidden><div class="sc-list" id="sc-history-list"></div></div>
      <div class="sc-resize" id="sc-resize" title="拖动调整宽度"></div>`;
    document.body.append(panel);
    bindAction("#sc-close", () => toggle(false)); bindAction("#sc-attach", attachSelection);
    bindAction("#sc-send", send); bindAction("#sc-cancel", () => global.StuartAIService.cancel());
    bindAction("#sc-new", async () => { await global.StuartAIService.reset(); renderConversation([]); });
    bindAction("#sc-vault-go", vaultSearch); bindAction("#sc-index", indexWorkspace);
    bindAction("#sc-index-cancel", async () => {
      if (!state.status?.jobId) throw new Error("当前工作区没有可取消的索引任务");
      await api().rag_cancel_sync(host().state.workspaceRoot, state.status.jobId); await refreshVault();
    });
    panel.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
    panel.querySelectorAll("[data-memory]").forEach(button => button.addEventListener("click", () => {
      state.memoryFilter = button.dataset.memory;
      panel.querySelectorAll("[data-memory]").forEach(item => item.classList.toggle("active", item === button));
      global.StuartMemoryUI.renderMemory($("#sc-memory-list"), state.memoryFilter);
    }));
    $("#sc-input").addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send().catch(report); }
    });
    $("#sc-vault-q").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); vaultSearch().catch(report); } });
    $("#sc-partial").addEventListener("change", () => { state.knowledge.clear(); renderReferences(); });
    $("#sc-model").addEventListener("change", async () => {
      const model = $("#sc-model"), root = host().state.workspaceRoot;
      model.disabled = true; $("#sc-vault-status").textContent = "正在验证并加载嵌入模型…";
      try { state.status = await api().rag_set_model(model.value, root); renderStatus(); }
      catch (error) { report(error); await refreshVault(); }
      finally { model.disabled = false; }
    });
    let drag;
    $("#sc-resize").addEventListener("pointerdown", event => {
      drag = { x: event.clientX, width: panel.offsetWidth }; event.target.setPointerCapture(event.pointerId);
    });
    $("#sc-resize").addEventListener("pointermove", event => {
      if (!drag) return;
      state.width = Math.min(600, Math.max(340, drag.width + drag.x - event.clientX)); panel.style.width = state.width + "px";
    });
    $("#sc-resize").addEventListener("pointerup", () => { drag = null; localStorage.setItem("stuart_companion_width", String(state.width)); });
    const storedWidth = Number(localStorage.getItem("stuart_companion_width"));
    if (Number.isFinite(storedWidth) && storedWidth >= 340 && storedWidth <= 600) state.width = storedWidth;
    panel.style.width = state.width + "px";
    global.StuartAIService.on("document", payload => {
      state.selection = null; state.knowledge.clear(); state.busy = false; state.requestId = null; state.streamElement = null;
      renderReferences(); renderConversation(payload.messages); renderBusy();
    });
    global.addEventListener("stuart-session-restored", () => { toggle(true); switchTab("chat"); });
    if (global.pywebview?.api) bindKnowledgeEvents().catch(report);
    else global.addEventListener("pywebviewready", () => bindKnowledgeEvents().catch(report), { once: true });
    renderConversation(global.StuartAIService.messages); switchTab("chat");
    return panel;
  }
  async function bindKnowledgeEvents() {
    await api().listen_event("rag-sync-progress", event => {
      const progress = event.payload;
      if (progress.workspaceId !== state.status?.workspaceId) return;
      state.status = { ...state.status, ...progress }; renderStatus();
    });
    await api().listen_event("rag-status-changed", event => {
      if (event.payload.workspaceId !== state.status?.workspaceId) return;
      state.status = event.payload; renderStatus();
    });
    await api().listen_event("rag-source-changed", event => {
      if (event.payload.workspaceId !== state.status?.workspaceId) return;
      state.status.sourceChanged = true; state.knowledge.clear(); renderReferences(); renderStatus();
    });
    await api().listen_event("rag-sync-error", event => {
      if (event.payload.workspaceId === state.status?.workspaceId) $("#sc-vault-status").textContent = event.payload.message;
    });
  }
  function switchTab(tab) {
    state.tab = tab;
    const panel = ensureDom();
    panel.querySelectorAll("[data-tab]").forEach(button => { button.classList.toggle("active", button.dataset.tab === tab); button.setAttribute("aria-selected", String(button.dataset.tab === tab)); });
    panel.querySelectorAll("[data-panel]").forEach(item => { item.hidden = item.dataset.panel !== tab; });
    if (tab === "memory") global.StuartMemoryUI.renderMemory($("#sc-memory-list"), state.memoryFilter);
    if (tab === "history") global.StuartMemoryUI.renderSessions($("#sc-history-list"));
    if (tab === "vault") refreshVault().catch(error => { $("#sc-vault-status").textContent = error.message || String(error); });
  }
  function toggle(force) {
    const panel = ensureDom(); state.open = force == null ? panel.hidden : !!force; panel.hidden = !state.open;
    $("#btn-companion")?.classList.toggle("active", state.open); $("#btn-companion")?.setAttribute("aria-expanded", String(state.open));
    host().state.companionOpen = state.open;
    if (state.open) { attachSelection(); switchTab(state.tab); }
  }
  function attachSelection() {
    const selection = host().getSelectionInfo(), current = host().getDocument();
    state.selection = selection.text?.trim() ? { ...selection, quote: selection.text, documentId: current.documentId, revision: current.revision } : null;
    renderReferences();
  }
  function renderReferences() {
    const quote = $("#sc-quote"), knowledge = $("#sc-knowledge");
    quote.hidden = !state.selection; quote.textContent = state.selection ? `引用选区：${state.selection.quote}` : "";
    knowledge.hidden = state.knowledge.size === 0; knowledge.textContent = state.knowledge.size ? `已引用 ${state.knowledge.size} 个实际检索片段` : "";
  }
  function message(role, text) {
    const element = document.createElement("article"); element.className = "sc-msg sc-msg--" + (role === "assistant" ? "ai" : role);
    const body = document.createElement("div"); body.className = "sc-msg-body";
    if (role === "assistant") body.innerHTML = global.StuartAIContext.renderSafeMarkdown(text); else body.textContent = text;
    element.append(body); $("#sc-messages").append(element); return element;
  }
  function renderConversation(messages) {
    $("#sc-messages").replaceChildren();
    const visible = (messages || []).filter(item => item.role !== "system");
    for (const item of visible) message(item.role, item.content);
    if (!visible.length) $("#sc-messages").innerHTML = `<div class="sc-empty sc-guide">输入问题，或者选中正文后点击「引用选区」。知识页面可以引用实际检索结果，会话页面可以恢复完整历史。</div>`;
  }
  function renderBusy() { $("#sc-send").disabled = state.busy; $("#sc-new").disabled = state.busy; $("#sc-cancel").hidden = !state.busy; }
  async function send() {
    if (state.busy) return;
    const input = $("#sc-input"), question = input.value;
    if (!question.trim() && !state.selection) throw new Error("请输入问题或引用正文选区");
    const current = host().getDocument(), selection = state.selection;
    if (selection && (selection.documentId !== current.documentId || selection.revision !== current.revision)) throw new Error("引用选区所属的文档版本已经变化，请重新选择正文");
    const prompt = selection ? `【选区】\n${selection.quote}\n\n【问题】\n${question.trim() ? question : "请结合原文解释选区。"}` : question;
    const sources = [...state.knowledge.values()].map(hit => ({ chunkId: hit.chunkId, workspaceId: hit.workspaceId, indexGeneration: hit.indexGeneration, indexStatus: hit.indexStatus, rrfScore: hit.rrfScore, partialConfirmed: hit.indexStatus === "Partial" && $("#sc-partial").checked }));
    const handlers = {
      onDelta(payload) {
        if (host().getDocument().documentId !== current.documentId || (state.requestId && state.requestId !== payload.requestId)) return;
        state.requestId = payload.requestId;
        if (!state.streamElement) state.streamElement = message("assistant", "");
        state.streamElement.firstElementChild.innerHTML = global.StuartAIContext.renderSafeMarkdown(payload.text);
      },
      onDone(payload) {
        if (host().getDocument().documentId !== current.documentId || (state.requestId && state.requestId !== payload.requestId)) return;
        if (!state.streamElement && payload.text) state.streamElement = message("assistant", payload.text);
        if (state.streamElement) state.streamElement.firstElementChild.innerHTML = global.StuartAIContext.renderSafeMarkdown(payload.text);
        if (payload.status !== "Completed") message("err", payload.error || `回答状态：${payload.status}`);
        state.busy = false; state.requestId = null; state.streamElement = null; renderBusy();
      },
    };
    state.busy = true; state.streamElement = null; renderBusy(); message("user", prompt);
    try {
      const service = global.StuartAIService, options = { document: current, selection, knowledgeSources: sources, workspaceRoot: host().state.workspaceRoot || null };
      let result;
      if (service.messages.length) result = await service.followUp(prompt, handlers, options);
      else {
        const config = await service.ensureConfig(true);
        result = await service.send({ ...options, handlers, messages: [{ role: "system", content: global.StuartAIContext.systemPrompt(global.StuartAI.getStyle(config)) }, { role: "user", content: prompt }] });
      }
      input.value = "";
      if (state.busy && host().getDocument().documentId === current.documentId) state.requestId = result.requestId;
    } catch (error) {
      if (host().getDocument().documentId === current.documentId) { message("err", error.message || String(error)); state.busy = false; state.requestId = null; renderBusy(); }
      throw error;
    }
  }
  async function refreshVault() {
    const root = host().state.workspaceRoot, epoch = ++state.vaultEpoch;
    if (!root) { state.status = null; throw new Error("请从文件菜单打开需要检索的工作区目录"); }
    await api().rag_set_workspace(root);
    const status = await api().rag_get_status(root);
    if (epoch !== state.vaultEpoch || root !== host().state.workspaceRoot) return;
    state.status = status; $("#sc-model").value = status.selectedModelId; renderStatus();
  }
  function renderStatus() {
    const status = state.status;
    if (!status) return;
    const text = [`状态：${status.status}`, `已处理 ${status.processedFiles}/${status.totalFiles} 个文件`, `当前模型：${status.modelId || "尚未建立索引"}`, `选择模型：${status.selectedModelId}`, `${status.docCount} 个文档 · ${status.chunkCount} 个片段`, status.sourceChanged ? "资料已经变化，查询前将更新索引" : "", status.errorMessage || ""];
    for (const failure of status.failedFiles || []) text.push(`失败文件：${failure.path} · ${failure.stage} · ${failure.message}`);
    for (const exclusion of status.excludedFiles || []) text.push(`排除文件：${exclusion.path} · ${exclusion.reason}`);
    $("#sc-vault-status").textContent = text.filter(Boolean).join("\n");
    $("#sc-index-cancel").hidden = !status.jobId || !["Loading","Indexing","Scanning","Validating"].includes(status.status);
  }
  async function indexWorkspace() {
    if (state.indexing) return;
    await refreshVault(); const root = host().state.workspaceRoot;
    state.indexing = true; $("#sc-index").disabled = true; state.knowledge.clear(); renderReferences();
    try { await api().rag_sync_workspace(root); }
    finally { state.indexing = false; $("#sc-index").disabled = false; if (root === host().state.workspaceRoot) await refreshVault(); }
  }
  async function vaultSearch() {
    const query = $("#sc-vault-q").value;
    if (!query.trim()) throw new Error("请输入检索问题");
    await refreshVault(); const root = host().state.workspaceRoot, epoch = ++state.vaultEpoch;
    $("#sc-vault-list").textContent = "正在使用实际模型检索…";
    try {
      const hits = await api().rag_query(query, 20, root, $("#sc-partial").checked);
      if (epoch !== state.vaultEpoch || root !== host().state.workspaceRoot) return;
      const list = $("#sc-vault-list"); list.replaceChildren();
      if (!hits.length) { list.textContent = "没有找到相关内容"; return; }
      for (const hit of hits) {
        const card = document.createElement("article"); card.className = "sc-card";
        card.innerHTML = `<div class="sc-card-title">${escape(hit.relPath)}</div><div class="sc-card-meta">${escape(hit.pageNumber ? `第 ${hit.pageNumber} 页` : `第 ${hit.startLine}–${hit.endLine} 行`)} · ${escape(hit.headingPath)} · ${escape(hit.indexStatus)}</div><div class="sc-card-snippet">${escape(hit.content)}</div>`;
        const actions = document.createElement("div"); actions.className = "sc-detail-actions";
        const open = document.createElement("button"); open.type = "button"; open.className = "btn sm"; open.textContent = "打开原文";
        open.addEventListener("click", () => host().openKnowledgeSource(hit).catch(report));
        const attach = document.createElement("button"); attach.type = "button"; attach.className = "btn sm"; attach.textContent = "引用到问答";
        attach.addEventListener("click", () => {
          if (hit.indexStatus === "Partial" && !$("#sc-partial").checked) { report(new Error("请先确认使用 Partial 索引范围")); return; }
          if (state.knowledge.has(hit.chunkId)) { state.knowledge.delete(hit.chunkId); attach.textContent = "引用到问答"; }
          else { state.knowledge.set(hit.chunkId, hit); attach.textContent = "取消引用"; }
          renderReferences();
        });
        actions.append(open, attach); card.append(actions); list.append(card);
      }
    } catch (error) { if (epoch === state.vaultEpoch) $("#sc-vault-list").textContent = error.message || String(error); throw error; }
  }
  global.StuartCompanion = { toggle, isOpen: () => state.open, attachSelection };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureDom); else ensureDom();
})(typeof window !== "undefined" ? window : globalThis);
