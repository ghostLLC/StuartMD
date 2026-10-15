(function (global) {
  "use strict";
  const phases = { PreparingSources: "准备材料", Counting: "核算容量", Summarizing: "整理已有对话", Streaming: "生成回答", Completed: "回答完成", Cancelled: "回答已停止", Failed: "回答未完成" };
  const scopeLabels = { selection: "选中内容", section: "当前章节", document: "整篇文档", workspace: "工作区资料" };
  const report = error => global.StuartMD.toast(error.message || String(error));
  function button(label, action) {
    const item = document.createElement("button"); item.type = "button"; item.className = "btn sm"; item.textContent = label;
    item.addEventListener("click", () => Promise.resolve().then(action).catch(report)); return item;
  }
  function create(options) {
    const service = global.StuartAIService, list = options.list, scroll = options.scroll || list;
    const rows = new Map(); let snapshot = null, timer = null, following = true, lastPhase = "", targetKey = "", restoreScroll = null;
    const latest = document.createElement("button"); latest.type = "button"; latest.className = "btn sm sc-latest"; latest.textContent = "查看最新回答"; latest.hidden = true;
    scroll.after(latest);
    function bottom() { scroll.scrollTop = scroll.scrollHeight; following = true; latest.hidden = true; }
    latest.addEventListener("click", bottom);
    scroll.addEventListener("scroll", () => { following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 48; });
    scroll.addEventListener("pointerdown", () => { if (global.getSelection()?.toString()) following = false; });
    const announcement = document.createElement("div"); announcement.className = "sc-sr-only"; announcement.setAttribute("aria-live", "polite"); announcement.setAttribute("role", "status"); list.before(announcement);
    const selectionChanged = () => { if (!global.getSelection()?.toString() && snapshot && !timer) timer = setTimeout(flush, 120); };
    document.addEventListener("selectionchange", selectionChanged);
    function actions(message, node) {
      node.replaceChildren();
      if (message.role !== "assistant" || !message.messageId) return;
      const state = message.completionStatus || message.status;
      const active = snapshot.activeRequest?.requestId === message.requestId;
      if (active) return;
      if (message.content) {
      node.append(button("复制", async () => { await navigator.clipboard.writeText(message.content); global.StuartMD.toast("答案已经复制"); }), button("复制纯文本", async () => {
        const body = rows.get(message.messageId).body;
        const content = [...body.childNodes].filter(item => !item.classList?.contains("sc-answer-sources")).map(item => item.innerText ?? item.textContent).join("\n");
        await navigator.clipboard.writeText(content); global.StuartMD.toast("答案纯文本已经复制");
      }), button("保存笔记", () => {
        const question = snapshot.messages.find(item => item.role === "user" && item.turnId === message.turnId)?.content || "";
        return global.StuartMD.saveCompanionNote({ question, answer: message.content, status: state, sources: global.StuartMessageRenderer.sourcesFor(message), messageId: message.messageId, requestId: message.requestId });
      }), button("重新提问", () => {
        const question = snapshot.messages.find(item => item.role === "user" && item.turnId === message.turnId)?.content;
        if (!question) throw new Error("原始问题没有保存");
        return service.sendQuestion(question, { scope: snapshot.draft?.scope || "document" });
      }));
      if (state === "Completed") node.append(button("记入记忆", () => global.StuartMemoryUI.rememberMessage(message)));
      }
      const lastTurn = snapshot.turns?.[snapshot.turns.length - 1];
      if (["Failed", "Cancelled"].includes(state) && (!lastTurn || lastTurn.turnId === message.turnId)) node.append(button("重试当前问题", () => service.retry(message.turnId)));
      const learning = snapshot.learningActions?.find(item => item.requestId === message.requestId);
      if (learning?.status === "Available") { const hint = document.createElement("div"); hint.className = "sc-card-meta"; hint.textContent = "可以选择答案段落并记入记忆，确认后保存。"; node.append(hint); }
      if (["Preparing", "Running"].includes(learning?.status)) { const hint = document.createElement("div"); hint.className = "sc-card-meta"; hint.textContent = "正在整理新记忆"; node.append(hint); }
      if (learning?.status === "Failed") { const hint = document.createElement("div"); hint.className = "sc-error"; hint.textContent = `记忆整理未完成：${learning.error}`; node.append(hint); }
      if (learning?.status === "Cancelled") { const hint = document.createElement("div"); hint.className = "sc-card-meta"; hint.textContent = "记忆整理已经停止"; node.append(hint); }
      if (learning?.status === "Completed") node.append(button("查看整理结果", async () => { await global.StuartCompanion.toggle(true); await global.StuartCompanion.switchTab("memory"); }));
    }
    function flush() {
      timer = null;
      const next = snapshot; if (!next) return;
      const key = JSON.stringify([next.target?.documentKey, next.target?.workspaceKey, next.sessionId]);
      if (key !== targetKey) { targetKey = key; rows.clear(); list.replaceChildren(); following = next.draft?.viewState?.followLatest !== false; restoreScroll = following ? null : next.draft?.viewState?.scrollTop ?? 0; }
      const selected = global.getSelection()?.toString();
      const stick = following && !selected;
      const messages = (next.messages || []).filter(item => item.role !== "system").map(item => ({ ...item }));
      const request = next.activeRequest;
      if (request) {
        const actual = messages.find(item => item.role === "assistant" && item.requestId === request.requestId);
        if (actual) actual.content = request.text || "";
        else messages.push({ role: "assistant", requestId: request.requestId, turnId: request.turnId, content: request.text || "", completionStatus: request.status, sources: request.validatedContext?.sources || [], displayKey: `request:${request.requestId}` });
      }
      const ids = new Set(messages.map(item => item.messageId || item.displayKey));
      let conflict = list.querySelector(".sc-draft-conflict");
      if (next.draftConflict) {
        if (!conflict) { conflict = document.createElement("div"); conflict.className = "sc-draft-conflict sc-error"; list.prepend(conflict); }
        conflict.replaceChildren(document.createTextNode("其他窗口已经修改草稿。当前输入已经保留。"), button("处理草稿冲突", () => global.StuartMD.resolveCompanionDraftConflict()));
      } else conflict?.remove();
      for (const message of messages) {
        const requestKey = `request:${message.requestId}`, row = rows.get(requestKey);
        if (message.role === "assistant" && message.messageId && row && !rows.has(message.messageId)) { rows.delete(requestKey); rows.set(message.messageId, row); }
      }
      for (const [id, row] of rows) if (!ids.has(id)) { row.root.remove(); rows.delete(id); }
      list.querySelector(".sc-empty")?.remove();
      if (!messages.length) { const empty = document.createElement("div"); empty.className = "sc-empty sc-guide"; empty.textContent = "选择提问范围并输入问题。知识页面可以预览资料并加入引用。"; list.append(empty); }
      for (const message of messages) {
        const id = message.messageId || message.displayKey; let row = rows.get(id);
        if (!row) {
          const root = document.createElement("article"), meta = document.createElement("div"), body = document.createElement("div"), tools = document.createElement("div");
          root.className = `sc-msg sc-msg--${message.role === "assistant" ? "ai" : "user"}`; meta.className = "sc-card-meta"; body.className = "sc-msg-body"; tools.className = "sc-detail-actions";
          root.append(meta, body, tools); list.append(root); row = { root, meta, body, tools, content: null, state: null, actionsKey: null }; rows.set(id, row);
        }
        const active = next.activeRequest?.requestId === message.requestId;
        const status = active ? next.activeRequest.phase || next.activeRequest.status : message.completionStatus || message.status;
        row.meta.textContent = [message.role === "assistant" ? "助手" : "提问", scopeLabels[message.scope], message.timestamp ? new Date(message.timestamp).toLocaleString() : "", phases[status] || status, message.model || message.sourceAnchor?.model].filter(Boolean).join(" · ");
        const failure = message.sourceAnchor?.interruptionReason || message.sourceAnchor?.error;
        if (failure) row.meta.textContent += " · " + failure;
        const selection = global.getSelection(), selectingRow = !!selection?.toString() && (row.body.contains(selection.anchorNode) || row.body.contains(selection.focusNode));
        if ((row.content !== message.content || row.state !== status) && !selectingRow) {
          row.content = message.content; row.state = status;
          if (message.role === "assistant") global.StuartMessageRenderer.render(row.body, message, { streaming: active, onSource: (source, owner) => global.StuartCompanion.previewSource(source, owner).catch(report) }).then(() => { if (stick && !global.getSelection()?.toString()) bottom(); }).catch(error => { const detail = document.createElement("div"); detail.className = "sc-error"; detail.textContent = error.message || String(error); row.body.append(detail); });
          else row.body.textContent = message.content || "";
        }
        const actionsKey = JSON.stringify([active, status, next.learningActions?.find(item => item.requestId === message.requestId), next.turns?.at(-1)?.turnId]);
        if (actionsKey !== row.actionsKey) { row.actionsKey = actionsKey; actions(message, row.tools); }
      }
      const phase = next.activeRequest?.phase || next.activeRequest?.status || "";
      if (phase !== lastPhase) { lastPhase = phase; announcement.textContent = phases[phase] || phase || "回答状态已更新"; }
      if (restoreScroll != null) { scroll.scrollTop = restoreScroll; restoreScroll = null; }
      else if (stick) bottom();
      latest.hidden = following || !messages.length;
      options.onSnapshot?.(next);
    }
    function update(next) { snapshot = next; if (!next.activeRequest) { clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 120); }
    const unsubscribe = options.subscribe === false ? null : service.on("change", update);
    if (options.subscribe !== false) update(service.snapshot);
    return { update, latestAnswer: () => [...(snapshot?.messages || [])].reverse().find(item => item.role === "assistant"), isFollowing: () => following, dispose: () => { clearTimeout(timer); unsubscribe?.(); document.removeEventListener("selectionchange", selectionChanged); latest.remove(); announcement.remove(); }, scrollToLatest: bottom };
  }
  global.StuartConversationView = { create, phases, scopeLabels, button };
})(typeof window !== "undefined" ? window : globalThis);
