(function (global) {
  "use strict";
  const api = () => global.pywebview.api, service = () => global.StuartAIService;
  const states = new WeakMap(), epochs = new WeakMap();
  const categories = [["preference", "偏好"], ["concept", "概念"], ["knowledge", "知识"], ["glossary", "术语"], ["person", "人物"], ["decision", "决定"], ["legacy", "已有记录"]];
  const scopes = { global: "全部文档", workspace: "工作区", document: "文档" }, approvals = { user: "用户确认", automatic: "自动整理", legacy: "已有记录" };
  const text = (tag, value, className) => { const item = document.createElement(tag); item.textContent = value; if (className) item.className = className; return item; };
  const button = (label, action) => global.StuartConversationView.button(label, action), target = () => service().snapshot.target;
  function select(label, choices, value) { const item = document.createElement("select"); item.setAttribute("aria-label", label); for (const [key, name] of choices) { const option = text("option", name); option.value = key; item.append(option); } item.value = value; return item; }
  function field(label, control) { const item = text("label", label, "sc-field-label"); item.append(control); return item; }
  function error(container, reason) { const item = text("div", reason.message || String(reason), "sc-error"); item.setAttribute("role", "alert"); container.append(item); }
  function ownership(item) { return [scopes[item.scope], item.workspaceKey ?? item.workspaceId, item.documentKey ?? item.documentId].filter(Boolean).join(" · "); }
  function memoryEdit(item) { return { content: item.content, category: item.category, scope: item.scope, workspaceKey: item.workspaceKey ?? item.workspaceId ?? null, documentKey: item.documentKey ?? item.documentId ?? null, preferenceKey: item.preferenceKey ?? null, pinned: !!item.pinned, sourceMessageId: item.sourceMessageId ?? null, sourceRequestId: item.sourceRequestId ?? item.requestId ?? null, sourceAnchor: item.sourceAnchor ?? null }; }
  function listOptions(current) {
    const selected = target(), options = { query: current.query, limit: 30 };
    if (current.scope !== "all") { options.scope = current.scope; if (current.scope === "document") { if (!selected?.documentKey) throw new Error("当前没有文档身份"); options.documentKey = selected.documentKey; } if (current.scope === "workspace") { if (!selected?.workspaceKey) throw new Error("当前没有工作区身份"); options.workspaceKey = selected.workspaceKey; } }
    if (current.category) options.category = current.category; return options;
  }
  async function renderMemory(container) {
    container.dataset.memoryView = "list";
    const current = states.get(container) || { scope: "all", category: "", query: "", mode: "records" }; states.set(container, current);
    const epoch = (epochs.get(container) || 0) + 1; epochs.set(container, epoch); container.replaceChildren();
    const toolbar = document.createElement("div"); toolbar.className = "sc-mem-toolbar";
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索记忆正文"; search.setAttribute("aria-label", "搜索记忆正文"); search.value = current.query;
    const mode = select("记忆列表", [["records", "有效记录"], ["proposals", "等待确认"]], current.mode), scope = select("记忆范围", [["all", "全部范围"], ["global", "全部文档"], ["workspace", "当前工作区"], ["document", "当前文档"]], current.scope), category = select("记忆类别", [["", "全部类别"], ...categories], current.category);
    const refresh = () => { current.query = search.value.trim(); current.scope = scope.value; current.category = category.value; current.mode = mode.value; return renderMemory(container); };
    search.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); refresh().catch(reason => error(container, reason)); } });
    for (const input of [mode, scope, category]) input.addEventListener("change", () => refresh().catch(reason => error(container, reason)));
    toolbar.append(search, button("搜索", refresh), mode, scope, category, button("新建记忆", () => editMemory(container, null, false))); container.append(toolbar);
    const settings = document.createElement("div"); settings.className = "sc-memory-settings"; container.append(settings); const rows = text("div", "正在读取记忆…"); container.append(rows);
    try {
      const options = listOptions(current), [config, page] = await Promise.all([global.StuartAI.ensureConfig(), current.mode === "proposals" ? api().companion_list_memory_proposals(options) : api().companion_list_memories(options)]);
      if (epochs.get(container) !== epoch) return;
      const use = document.createElement("input"); use.type = "checkbox"; use.checked = config.use_saved_memories;
      use.addEventListener("change", () => Promise.resolve().then(async () => { await global.StuartAI.ensureConfig(true); await global.StuartAI.updateConfig({ kind: "updatePreferences", preferences: { use_saved_memories: use.checked } }); }).catch(reason => { use.checked = config.use_saved_memories; error(settings, reason); }));
      const learning = select("整理新记忆", [["off", "关闭"], ["ask", "询问"], ["automatic", "自动"]], config.learning_policy);
      learning.addEventListener("change", () => Promise.resolve().then(async () => { await global.StuartAI.ensureConfig(true); await global.StuartAI.updateConfig({ kind: "updatePreferences", preferences: { learning_policy: learning.value } }); }).catch(reason => { learning.value = config.learning_policy; error(settings, reason); }));
      settings.append(field("读取已保存记忆", use), field("整理新记忆", learning)); rows.replaceChildren();
      async function appendPage(result) {
        if (epochs.get(container) !== epoch) return;
        for (const item of result.items) rows.append(memoryCard(container, item, current.mode === "proposals"));
        if (!rows.childElementCount) rows.append(text("div", current.mode === "proposals" ? "没有等待确认的内容" : "没有符合条件的记忆", "sc-empty"));
        if (result.nextCursor) { const more = button("读取更多记忆", async () => { more.disabled = true; try { const next = current.mode === "proposals" ? await api().companion_list_memory_proposals({ ...options, cursor: result.nextCursor }) : await api().companion_list_memories({ ...options, cursor: result.nextCursor }); more.remove(); await appendPage(next); } finally { more.disabled = false; } }); rows.append(more); }
      }
      await appendPage(page);
    } catch (reason) { if (epochs.get(container) === epoch) { rows.replaceChildren(); error(rows, reason); } }
  }
  function memoryCard(container, item, proposal) {
    const card = document.createElement("article"); card.className = "sc-card"; const category = categories.find(([key]) => key === item.category)?.[1] || item.category;
    card.append(text("div", `${item.preferenceKey || category}${item.pinned ? " · 已固定" : ""}`, "sc-card-title"), text("div", ownership(item), "sc-card-meta"), text("div", proposal ? `候选版本 ${item.proposalVersion} · 等待确认` : `版本 ${item.version} · ${approvals[item.approvalKind] || item.approvalKind}`, "sc-card-meta"), text("div", item.content, "sc-card-snippet"));
    const actions = document.createElement("div"); actions.className = "sc-detail-actions";
    if (proposal) {
      const edit = button("编辑及确认", () => editMemory(container, item, true)); edit.disabled = !item.sourceMessageId;
      actions.append(edit, button("删除候选", async () => { if (!await global.StuartUIConfirm("删除这条等待确认的内容？")) return; await api().companion_update_memory_proposal(item.proposalId, item.proposalVersion, { ...memoryEdit(item), status: "Discarded" }); await renderMemory(container); }));
      if (!item.sourceMessageId) card.append(text("div", "来源会话已经删除，无法确认此候选。", "sc-card-meta"));
    } else actions.append(button("编辑", () => editMemory(container, item, false)), button(item.pinned ? "取消固定" : "固定", async () => { await api().companion_save_memory(item.recordId, item.version, { ...memoryEdit(item), pinned: !item.pinned }); await renderMemory(container); }), button("来源及版本", () => showSource(container, item)), button("加入引用", () => service().addReference({ kind: "memory", inputId: `memory:${item.recordId}:${item.version}`, recordId: item.recordId, memoryId: item.memoryId, version: item.version, title: item.preferenceKey || category, excerpt: item.content })), button("删除", async () => { if (!await global.StuartUIConfirm(`删除这条记忆及其全部版本：${item.content}`)) return; await api().companion_delete_memory(item.recordId, item.version); await renderMemory(container); }));
    card.append(actions); return card;
  }
  function editMemory(container, item, proposal, returnAction = () => renderMemory(container)) {
    container.dataset.memoryView = "edit";
    epochs.set(container, (epochs.get(container) || 0) + 1); container.replaceChildren(); const captured = structuredClone(target());
    const original = item ? memoryEdit(item) : { content: "", category: "preference", scope: "global", workspaceKey: null, documentKey: null, preferenceKey: null, pinned: false, sourceMessageId: null, sourceRequestId: null, sourceAnchor: { createdBy: "manual-entry" } };
    const form = document.createElement("form"); form.className = "sc-detail";
    const key = document.createElement("input"); key.className = "sc-detail-input"; key.value = original.preferenceKey || "";
    const category = select("类别", categories, original.category), scope = select("作用范围", [["global", "全部文档"], ["workspace", "工作区"], ["document", "文档"]], original.scope);
    const content = document.createElement("textarea"); content.rows = 12; content.className = "sc-detail-edit"; content.value = original.content; content.setAttribute("aria-label", "记忆正文");
    const count = text("div", "", "sc-card-meta"), pinned = document.createElement("input"); pinned.type = "checkbox"; pinned.checked = original.pinned;
    const owner = text("div", `保存归属：${ownership(original)}`, "sc-card-meta");
    scope.addEventListener("change", () => { owner.textContent = scope.value === original.scope ? `保存归属：${ownership(original)}` : `保存归属：${[scopes[scope.value], scope.value !== "global" ? captured?.workspaceKey : "", scope.value === "document" ? captured?.documentKey : ""].filter(Boolean).join(" · ")}`; });
    const updateCount = () => { count.textContent = `正文 ${Array.from(content.value).length}/800 个字符`; }; content.addEventListener("input", updateCount); updateCount();
    form.append(text("h3", proposal ? "确认记忆候选" : item ? "编辑记忆" : "新建记忆"), field("记录名称或偏好名称", key), field("类别", category), field("作用范围", scope), owner, field("记忆正文", content), count, field("固定记录", pinned));
    const actions = document.createElement("div"); actions.className = "sc-detail-actions";
    const readEdit = () => {
      if (!content.value.trim() || Array.from(content.value).length > 800) throw new Error("记忆正文需要包含一至八百个字符");
      let workspaceKey = original.workspaceKey, documentKey = original.documentKey;
      if (scope.value !== original.scope) { if (JSON.stringify(captured) !== JSON.stringify(target())) throw new Error("编辑期间文档或工作区已经变化，请重新打开表单"); workspaceKey = scope.value === "global" ? null : captured?.workspaceKey || null; documentKey = scope.value === "document" ? captured?.documentKey || null : null; }
      if (scope.value === "workspace" && !workspaceKey || scope.value === "document" && !documentKey) throw new Error("所选范围缺少实际文档或工作区身份");
      return { ...original, content: content.value, category: category.value, scope: scope.value, workspaceKey, documentKey, preferenceKey: key.value.trim() || null, pinned: pinned.checked };
    };
    const save = button(proposal ? "确认并保存记忆" : item ? "保存新版本" : "保存记忆", async () => { save.disabled = true; try { const edit = readEdit(); if (proposal) await api().companion_confirm_memory(item.proposalId, item.proposalVersion, edit); else await api().companion_save_memory(item?.recordId || null, item?.version || 0, edit); await returnAction(); } finally { save.disabled = false; } });
    actions.append(button("返回", returnAction)); if (proposal) actions.append(button("保存候选编辑", async () => { await api().companion_update_memory_proposal(item.proposalId, item.proposalVersion, readEdit()); await returnAction(); }));
    actions.append(save); form.append(actions); form.addEventListener("submit", event => { event.preventDefault(); save.click(); }); container.append(form); content.focus();
  }
  async function showSource(container, item) {
    container.dataset.memoryView = "source";
    const epoch = (epochs.get(container) || 0) + 1; epochs.set(container, epoch); container.replaceChildren(button("返回记忆列表", () => renderMemory(container)));
    const [result, versions] = await Promise.all([api().companion_get_memory_source(item.recordId), api().companion_get_memory_versions(item.recordId)]); if (epochs.get(container) !== epoch) return;
    container.append(text("h3", "记忆来源"));
    for (const source of result.sources) {
      const card = document.createElement("article"); card.className = "sc-card";
      const manual = ["manual-entry", "manual-confirmation"].includes(source.sourceAnchor?.createdBy);
      card.append(text("div", manual ? "人工录入" : source.sourceDeleted ? "来源会话已经删除" : "已保存的原始依据", "sc-card-title"), text("div", source.excerpt, "sc-card-snippet"));
      if (source.sessionId) card.append(button("查看来源会话", () => showSession(container, source.sessionId, () => showSource(container, item))));
      const details = document.createElement("details"); details.append(text("summary", "来源详情"), text("pre", JSON.stringify(source, null, 2), "sc-detail-body")); card.append(details); container.append(card);
    }
    if (!result.sources.length) container.append(text("div", "没有保存来源摘录", "sc-empty")); container.append(text("h3", "记录版本"));
    for (const version of versions) { const card = document.createElement("article"); card.className = "sc-card"; card.append(text("div", `版本 ${version.version}${version.version === result.record.version ? " · 当前版本" : ""}`, "sc-card-title"), text("div", ownership(version), "sc-card-meta"), text("div", version.content, "sc-card-snippet")); if (version.version !== result.record.version) card.append(button("恢复此版本内容", async () => { await api().companion_save_memory(result.record.recordId, result.record.version, { ...memoryEdit(result.record), content: version.content }); await renderMemory(container); })); container.append(card); }
  }
  async function rememberMessage(message) {
    if (message.completionStatus !== "Completed") throw new Error("请选择已保存的完整回答"); const dialog = document.createElement("dialog"); dialog.className = "sc-dialog";
    const quote = document.createElement("textarea"); quote.rows = 10; quote.className = "sc-detail-edit"; quote.setAttribute("aria-label", "需要记住的原始答案段落");
    const selected = global.getSelection()?.toString(); quote.value = selected && message.content.includes(selected) ? selected : message.content;
    const count = text("div", "", "sc-card-meta"), update = () => { count.textContent = `${Array.from(quote.value).length}/800 个字符`; }; quote.addEventListener("input", update); update();
    const body = document.createElement("div"); body.append(text("h3", "记入记忆"), text("div", "保留答案中需要记住的原始段落，确认时可以编辑内容与范围。", "sc-card-meta"), quote, count);
    body.append(button("关闭", () => { dialog.close(); dialog.remove(); }), button("建立候选", async () => { const proposal = await service().rememberMessage(message.messageId, quote.value); editMemory(body, proposal, true, async () => { dialog.close(); dialog.remove(); await global.StuartCompanion.toggle(true); await global.StuartCompanion.switchTab("memory"); }); }));
    dialog.append(body); document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); quote.focus();
  }
  async function renderSessions(container) {
    container.dataset.historyView = "list";
    const current = states.get(container) || { scope: "target", query: "" }; states.set(container, current); const epoch = (epochs.get(container) || 0) + 1; epochs.set(container, epoch); container.replaceChildren();
    const toolbar = document.createElement("div"); toolbar.className = "sc-mem-toolbar"; const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索问题和答案"; search.setAttribute("aria-label", "搜索问题和答案"); search.value = current.query;
    const scope = select("会话范围", [["target", "当前目标"], ["document", "当前文档"], ["workspace", "当前工作区"], ["all", "全部会话"]], current.scope), refresh = () => { current.query = search.value.trim(); current.scope = scope.value; return renderSessions(container); };
    search.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); refresh().catch(reason => error(container, reason)); } }); scope.addEventListener("change", () => refresh().catch(reason => error(container, reason))); toolbar.append(search, button("搜索", refresh), scope); container.append(toolbar); const rows = text("div", "正在读取会话…"); container.append(rows);
    try {
      const selected = target(); if (current.scope === "document" && !selected?.documentKey || current.scope === "workspace" && !selected?.workspaceKey) throw new Error("所选范围缺少文档或工作区身份");
      const options = { filter: { scope: current.scope, documentKey: selected?.documentKey || null, workspaceKey: selected?.workspaceKey || null }, query: current.query, limit: 30 }, page = await api().companion_list_sessions(options); if (epochs.get(container) !== epoch) return; rows.replaceChildren();
      async function appendPage(result) {
        if (epochs.get(container) !== epoch) return;
        for (const item of result.items) {
          const card = document.createElement("article"); card.className = "sc-card";
          card.append(text("div", item.title, "sc-card-title"), text("div", [item.documentPath || item.documentKey || "工作区会话", item.workspaceKey || item.workspaceRoot].filter(Boolean).join(" · "), "sc-card-meta"), text("div", `${new Date(item.updatedAt).toLocaleString()} · ${item.messageCount} 条消息 · ${global.StuartConversationView.phases[item.completionStatus] || item.completionStatus || "已有会话"}`, "sc-card-meta"), text("div", item.recentQuestion || "", "sc-card-snippet"));
          const actions = document.createElement("div"); actions.className = "sc-detail-actions"; actions.append(button("查看会话", () => showSession(container, item.sessionId)), button("修改名称", () => renameSession(container, item)), button("删除", () => deleteSession(container, item))); card.append(actions); rows.append(card);
        }
        if (!rows.childElementCount) rows.append(text("div", "没有符合条件的会话", "sc-empty"));
        if (result.nextCursor) { const more = button("读取更多会话", async () => { more.disabled = true; try { const next = await api().companion_list_sessions({ ...options, cursor: result.nextCursor }); more.remove(); await appendPage(next); } finally { more.disabled = false; } }); rows.append(more); }
      }
      await appendPage(page);
    } catch (reason) { if (epochs.get(container) === epoch) { rows.replaceChildren(); error(rows, reason); } }
  }
  function renameSession(container, item) {
    const dialog = document.createElement("dialog"); dialog.className = "sc-dialog"; const input = document.createElement("input"); input.className = "sc-detail-input"; input.value = item.title;
    dialog.append(text("h3", "修改会话名称"), field("会话名称", input), button("关闭", () => { dialog.close(); dialog.remove(); }), button("保存名称", async () => { if (!input.value.trim()) throw new Error("会话名称不能为空"); await api().companion_rename_session(item.sessionId, item.sessionVersion, input.value.trim()); dialog.close(); dialog.remove(); await renderSessions(container); })); document.body.append(dialog); dialog.showModal(); input.focus();
  }
  function deleteSession(container, item) {
    const dialog = document.createElement("dialog"); dialog.className = "sc-dialog"; const linked = document.createElement("input"); linked.type = "checkbox";
    dialog.append(text("h3", "删除会话"), text("p", `删除「${item.title}」及其全部问题和答案。`), field("同时删除来自此会话的记忆", linked), button("关闭", () => { dialog.close(); dialog.remove(); }), button("确认删除", async () => { await service().deleteSession(item.sessionId, item.sessionVersion, linked.checked); dialog.close(); dialog.remove(); await renderSessions(container); })); document.body.append(dialog); dialog.showModal();
  }
  async function showSession(container, sessionId, back = () => renderSessions(container)) {
    container.dataset.historyView = "detail";
    const epoch = (epochs.get(container) || 0) + 1; epochs.set(container, epoch); container.replaceChildren(button("返回", back)); const page = await api().companion_get_conversation(sessionId, null, null); if (epochs.get(container) !== epoch) return; if (!page.session) throw new Error("会话已经删除");
    container.append(text("h3", page.session.title), text("div", [page.session.documentPath || page.session.documentKey || "工作区会话", page.session.workspaceKey].filter(Boolean).join(" · "), "sc-card-meta"), button("恢复原文并继续会话", async () => { await service().restoreSession(sessionId); await global.StuartCompanion.toggle(true); await global.StuartCompanion.switchTab("chat"); }));
    const list = document.createElement("div"); list.className = "sc-history-messages"; container.append(list);
    async function appendPage(result, older) {
      if (epochs.get(container) !== epoch) return; const fragment = document.createDocumentFragment(), pending = [];
      for (const message of result.messages.filter(item => item.role !== "system")) {
        const card = document.createElement("article"); card.className = `sc-msg sc-msg--${message.role === "assistant" ? "ai" : "user"}`; const body = document.createElement("div"); body.className = "sc-msg-body";
        card.append(text("div", [message.role === "assistant" ? "助手" : "提问", global.StuartConversationView.phases[message.completionStatus] || message.completionStatus, new Date(message.timestamp).toLocaleString()].join(" · "), "sc-card-meta"), body); fragment.append(card);
        if (message.role === "assistant") pending.push({ body, message }); else body.textContent = message.content;
      }
      if (older) list.prepend(fragment); else list.append(fragment);
      for (const { body, message } of pending) await global.StuartMessageRenderer.render(body, message, { onSource: (source, owner) => global.StuartCompanion.previewSource(source, owner).catch(reason => error(container, reason)) });
      if (!list.childElementCount) list.append(text("div", "此会话没有保存消息", "sc-empty"));
      if (result.nextCursor) { const more = button("读取后续问题", async () => { more.disabled = true; try { const next = await api().companion_get_conversation(sessionId, result.nextCursor, null); more.remove(); await appendPage(next, false); } finally { more.disabled = false; } }); list.after(more); }
    }
    await appendPage(page, false);
  }
  global.StuartMemoryUI = { renderMemory, renderSessions, rememberMessage };
})(typeof window !== "undefined" ? window : globalThis);
