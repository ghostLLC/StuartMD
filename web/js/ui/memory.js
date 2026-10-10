(function (global) {
  "use strict";
  const api = () => global.pywebview.api;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const report = (container, error) => { container.textContent = error.message || String(error); };
  const hostDocument = () => global.StuartMD.getDocument();
  const button = (label, handler) => {
    const element = document.createElement("button");
    element.type = "button"; element.className = "btn sm"; element.textContent = label;
    element.addEventListener("click", () => Promise.resolve(handler()).catch(error => global.StuartMD.toast(error.message)));
    return element;
  };

  async function renderMemory(container, filter = "all", query = "") {
    container.textContent = "正在读取记忆…";
    try {
      const items = query ? await api().organic_memory_search(query, 100) : await api().organic_memory_list(null);
      const rows = items.filter(item => filter === "all" || (filter === "profile" ? item.category === "preference" : item.category !== "preference"));
      container.replaceChildren();
      const toolbar = document.createElement("div"); toolbar.className = "sc-mem-toolbar";
      const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索记忆正文"; search.value = query;
      search.addEventListener("keydown", event => { if (event.key === "Enter") renderMemory(container, filter, search.value.trim()); });
      toolbar.append(search, button("新建记忆", () => editMemory(container, null, filter)));
      const mode = document.createElement("select"); mode.setAttribute("aria-label", "记忆学习方式");
      for (const [value, label] of [["always", "允许学习"], ["ask", "确认后学习"], ["off", "停止读取和学习"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = label; mode.append(option);
      }
      const config = await global.StuartAI.ensureConfig(); mode.value = config.memory_mode;
      mode.addEventListener("change", async () => {
        try {
          const next = await global.StuartAI.ensureConfig(true);
          await global.StuartAI.saveAi({ ...next, memory_mode: mode.value });
          config.memory_mode = mode.value;
        } catch (error) { mode.value = config.memory_mode; global.StuartMD.toast(error.message || String(error)); }
      });
      toolbar.append(mode); container.append(toolbar);
      if (!rows.length) { const empty = document.createElement("div"); empty.className = "sc-empty"; empty.textContent = "没有符合条件的记忆"; container.append(empty); }
      for (const item of rows) {
        const card = document.createElement("article"); card.className = "sc-card";
        card.innerHTML = `<div class="sc-card-title">${escape(item.preferenceKey || item.category)}${item.pinned ? " · 已固定" : ""}</div><div class="sc-card-meta">${escape(item.scope)} · 版本 ${item.version} · ${item.confirmed ? "已经确认" : "等待确认"}${item.supersededBy ? " · 已被更新" : ""}</div><div class="sc-card-snippet">${escape(item.content)}</div>`;
        const actions = document.createElement("div"); actions.className = "sc-detail-actions";
        actions.append(button("编辑", () => editMemory(container, item, filter)), button(item.pinned ? "取消固定" : "固定", async () => {
          await api().organic_memory_upsert({ ...item, pinned: !item.pinned }); await renderMemory(container, filter, query);
        }), button("查看来源", () => showSource(container, item, () => renderMemory(container, filter, query))), button("删除", async () => {
          if (!await global.StuartUIConfirm(`删除这条记忆：${item.content}`)) return;
          await api().organic_memory_delete(item.memoryId); await renderMemory(container, filter, query);
        }));
        card.append(actions); container.append(card);
      }
    } catch (error) { report(container, error); }
  }

  function editMemory(container, item, filter) {
    const captured = hostDocument(), capturedWorkspace = global.StuartMD.state.workspaceRoot;
    container.innerHTML = `<div class="sc-detail"><div class="sc-card-title">${item ? "编辑记忆" : "新建记忆"}</div><label class="sc-field-label">偏好名称或记录名称<input id="sc-memory-key" class="sc-detail-input" value="${escape(item?.preferenceKey || "")}" /></label><label class="sc-field-label">类别<select id="sc-memory-category"><option value="preference">偏好</option><option value="decision">决定</option><option value="concept">概念</option><option value="glossary">术语</option><option value="note">备忘</option></select></label><label class="sc-field-label">作用范围<select id="sc-memory-scope"><option value="global">全部文档</option><option value="workspace">当前工作区</option><option value="document">当前文档</option></select></label><textarea id="sc-memory-content" class="sc-detail-edit is-active" rows="12">${escape(item?.content || "")}</textarea><div class="sc-card-meta">保存后确认这条记忆，后续适用请求可以使用完整内容。</div><div id="sc-memory-actions" class="sc-detail-actions"></div></div>`;
    container.querySelector("#sc-memory-category").value = item?.category || "preference";
    container.querySelector("#sc-memory-scope").value = item?.scope || "global";
    container.querySelector("#sc-memory-actions").append(button("返回", () => renderMemory(container, filter)), button("保存并确认", async () => {
      const content = container.querySelector("#sc-memory-content").value;
      if (!content.trim()) throw new Error("记忆正文不能为空");
      const current = captured, workspace = capturedWorkspace;
      const scope = container.querySelector("#sc-memory-scope").value;
      if (scope === "workspace" && !workspace) throw new Error("请先打开工作区");
      if (scope === "document" && hostDocument().documentId !== current.documentId) throw new Error("编辑记忆期间已经切换文档，请重新打开编辑表单");
      const memoryId = crypto.randomUUID(), now = Date.now();
      await api().organic_memory_upsert({ memoryId, tier: scope === "global" ? 3 : scope === "workspace" ? 1 : 2,
        category: container.querySelector("#sc-memory-category").value, content, confidence: 1, createdAt: now, lastAccessedAt: now,
        accessCount: 0, pinned: !!item?.pinned, scope, workspaceId: scope === "global" ? null : workspace || null,
        documentId: scope === "document" ? current.documentId : null,
        preferenceKey: container.querySelector("#sc-memory-key").value.trim() || item?.preferenceKey || item?.memoryId || memoryId,
        version: (item?.version || 0) + 1, sourceMessageId: item?.sourceMessageId || null,
        sourceAnchor: item?.sourceAnchor || { documentId: current.documentId, path: current.path, createdBy: "manual-confirmation" },
        confirmed: true, supersededBy: null, requestId: null });
      await renderMemory(container, filter);
    }));
  }

  async function showSource(container, item, back) {
    container.replaceChildren();
    const pre = document.createElement("pre"); pre.textContent = JSON.stringify(item.sourceAnchor, null, 2);
    container.append(pre, button("返回", back));
    if (item.sourceMessageId) {
      const sessions = await api().session_list();
      for (const session of sessions) {
        const messages = await api().session_get_messages(session.sessionId);
        const original = messages.find(message => message.messageId === item.sourceMessageId);
        if (original) { const text = document.createElement("div"); text.className = "sc-card-snippet"; text.textContent = original.content; container.prepend(text); return; }
      }
      throw new Error("来源消息已经删除");
    }
  }

  async function renderSessions(container, query = "") {
    container.textContent = "正在读取会话…";
    try {
      const sessions = await api().session_list();
      let matches = null;
      if (query) {
        const hits = await api().session_search(query, 1000);
        matches = new Set(hits.map(hit => hit.entityId));
      }
      container.replaceChildren();
      const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索会话正文"; search.value = query;
      search.addEventListener("keydown", event => { if (event.key === "Enter") renderSessions(container, search.value.trim()); });
      container.append(search);
      let shown = 0;
      for (const session of sessions) {
        const messages = await api().session_get_messages(session.sessionId);
        if (matches && !messages.some(message => matches.has(message.messageId))) continue;
        shown += 1;
        const card = document.createElement("article"); card.className = "sc-card";
        card.innerHTML = `<div class="sc-card-title">${escape(session.title)}</div><div class="sc-card-meta">${escape(new Date(session.updatedAt).toLocaleString())} · ${session.messageCount} 条消息</div><div class="sc-card-meta">${escape(session.documentPath || "未保存文档")}</div>`;
        const actions = document.createElement("div"); actions.className = "sc-detail-actions";
        actions.append(button("查看及恢复", () => restoreSession(container, session, messages)), button("删除", async () => {
          if (!await global.StuartUIConfirm(`删除会话：${session.title}`)) return;
          await api().session_delete(session.sessionId); await renderSessions(container, query);
        }));
        card.append(actions); container.append(card);
      }
      if (!shown) { const empty = document.createElement("div"); empty.className = "sc-empty"; empty.textContent = "没有符合条件的会话"; container.append(empty); }
    } catch (error) { report(container, error); }
  }

  function restoreSession(container, session, messages) {
    container.replaceChildren();
    container.append(button("返回会话列表", () => renderSessions(container)), button("继续这个会话", async () => {
      await global.StuartAIService.cancel();
      const source = await api().session_open_document(session.sessionId);
      if (source.kind === "draft") await global.StuartMD.restoreDocument(source.document);
      else await global.StuartMD.openDocumentRecord(source.document);
      const current = hostDocument();
      await global.StuartMD.setWorkspaceRoot(source.session.workspaceRoot);
      const restored = await api().session_rebind(session.sessionId, current.documentId);
      global.StuartAIService.restoreConversation(restored, messages);
      global.dispatchEvent(new CustomEvent("stuart-session-restored", { detail: { session: restored, messages } }));
      global.StuartMD.toast("会话已经恢复");
    }));
    for (const message of messages) {
      const element = document.createElement("article"); element.className = "sc-card";
      element.innerHTML = `<div class="sc-card-title">${escape(message.role)} · ${escape(message.completionStatus)}</div><div class="sc-card-snippet">${escape(message.content)}</div>`;
      container.append(element);
    }
  }

  async function openCountingSettings(providerId) {
    const config = await global.StuartAI.ensureConfig(true);
    const provider = config.providers.find(item => item.id === providerId);
    if (!provider) throw new Error("服务商配置不存在");
    const dialog = document.createElement("dialog"); dialog.className = "sc-detail";
    dialog.innerHTML = `<form method="dialog"><h3>模型计数配置</h3><div class="sc-card-meta">模型：${escape(provider.model)}。全部消息按配置计数，缺少分词资源时停止请求。</div><label class="sc-field-label">计数配置 JSON<textarea rows="15" class="sc-detail-edit is-active" spellcheck="false"></textarea></label><div class="sc-detail-actions"><button type="button" class="btn sm" data-close>关闭</button><button type="button" class="btn sm primary" data-save>验证并保存</button></div><div data-error role="status"></div></form>`;
    const defaults = await api().context_model_spec(providerId, provider.model);
    dialog.querySelector("textarea").value = JSON.stringify(provider.token_counting || defaults.configuration, null, 2);
    dialog.querySelector("[data-close]").addEventListener("click", () => { dialog.close(); dialog.remove(); });
    dialog.querySelector("[data-save]").addEventListener("click", async () => {
      try {
        const counting = JSON.parse(dialog.querySelector("textarea").value);
        await api().context_validate_model_spec({ ...provider, token_counting: counting });
        const current = await global.StuartAI.ensureConfig(true);
        current.providers = current.providers.map(item => item.id === provider.id ? { ...item, token_counting: counting } : item);
        await global.StuartAI.saveAi(current); dialog.close(); dialog.remove();
      } catch (error) { dialog.querySelector("[data-error]").textContent = error.message || String(error); }
    });
    document.body.append(dialog); dialog.showModal();
  }

  global.StuartMemoryUI = { renderMemory, renderSessions, openCountingSettings };
})(typeof window !== "undefined" ? window : globalThis);
