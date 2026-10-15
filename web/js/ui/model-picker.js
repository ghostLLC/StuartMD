(function (global) {
  "use strict";
  let sequence = 0;
  function status(snapshot, model) {
    const connection = snapshot.ai.providers.find(item => item.id === model.provider_id);
    let reason = "";
    if (!connection) reason = "连接已经删除";
    else if (!model.enabled || !connection.enabled) reason = "已经停用";
    else if (!connection.key_set) reason = "请在连接设置中保存 API Key";
    else if (connection.type === "kimi" && /^(moonshot-v1|kimi-k2(?:\.|-|$)|kimi-latest|kimi-thinking-preview)/.test(model.model_id) && !snapshot.catalog.models.some(item => item.provider_type === "kimi" && item.model_id === model.model_id)) reason = "模型已下线，请添加当前型号";
    else if (connection.type === "custom" && !model.token_counting) reason = "请在高级设置中补充计数资料";
    const verified = model.verification;
    return { connection, reason, label: reason || (verified?.status === "Passed" ? `验证通过 · ${new Date(verified.checkedAt).toLocaleString()}` : verified?.status === "Failed" ? "验证失败，请查看详情" : "尚未验证") };
  }
  function create({ anchor, onSelect, onManage }) {
    const document = anchor.ownerDocument, id = `ai-model-picker-${++sequence}`;
    const panel = document.createElement("div"); panel.id = id; panel.className = "ai-model-picker"; panel.hidden = true; panel.setAttribute("aria-label", "选择已保存模型");
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索模型或服务商"; search.setAttribute("aria-label", "搜索已保存模型"); search.setAttribute("aria-controls", `${id}-list`);
    const list = document.createElement("div"); list.id = `${id}-list`; list.className = "ai-model-options"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "已保存模型");
    const notice = document.createElement("div"); notice.className = "ai-model-notice"; notice.setAttribute("role", "status");
    const manage = document.createElement("button"); manage.type = "button"; manage.className = "btn ai-model-manage"; manage.textContent = "管理模型与连接";
    panel.append(search, list, notice, manage); document.body.append(panel);
    anchor.setAttribute("aria-haspopup", "listbox"); anchor.setAttribute("aria-controls", id); anchor.setAttribute("aria-expanded", "false");
    let snapshot, pending = false;
    function position() {
      const rect = anchor.getBoundingClientRect(), width = Math.min(380, global.innerWidth - 24);
      panel.style.width = `${width}px`; panel.style.left = `${Math.max(12, Math.min(rect.right - width, global.innerWidth - width - 12))}px`;
      const availableBelow = global.innerHeight - rect.bottom - 16;
      panel.style.maxHeight = `${Math.max(180, Math.min(480, global.innerHeight - 24))}px`;
      panel.style.top = availableBelow >= 240 ? `${rect.bottom + 8}px` : `${Math.max(12, rect.top - Math.min(480, global.innerHeight - 24))}px`;
    }
    function close(restoreFocus = true) {
      panel.hidden = true; anchor.setAttribute("aria-expanded", "false");
      if (restoreFocus) anchor.focus();
    }
    function render() {
      if (!snapshot) return;
      const focusedId = document.activeElement?.dataset.modelId;
      list.replaceChildren(); const query = search.value.trim().toLocaleLowerCase(), { ai } = snapshot;
      const recent = ai.recent_model_ids || [];
      const models = [...ai.models].sort((a, b) => {
        const rank = model => model.id === ai.active_model_id ? -2 : recent.includes(model.id) ? recent.indexOf(model.id) : model.id === ai.default_model_id ? 99 : 100;
        return rank(a) - rank(b);
      });
      for (const model of models) {
        const details = status(snapshot, model), provider = details.connection;
        if (!`${model.display_name} ${model.model_id} ${provider?.label || ""}`.toLocaleLowerCase().includes(query)) continue;
        const option = document.createElement("button"); option.type = "button"; option.className = "ai-model-option"; option.dataset.modelId = model.id; option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(model.id === ai.active_model_id)); option.setAttribute("aria-disabled", String(!!details.reason));
        const title = document.createElement("span"); title.className = "ai-model-name"; title.textContent = model.display_name;
        const marks = [model.id === ai.active_model_id && "当前", model.id === ai.default_model_id && "默认", recent.includes(model.id) && "最近使用"].filter(Boolean);
        const meta = document.createElement("span"); meta.className = "ai-model-meta"; meta.textContent = [provider?.label, model.model_id, ...marks].filter(Boolean).join(" · ");
        const label = document.createElement("span"); label.className = "ai-model-meta"; label.textContent = details.label;
        option.append(title, meta, label);
        option.addEventListener("click", async () => {
          if (pending) return;
          if (details.reason) { notice.textContent = details.reason; return; }
          pending = true; notice.textContent = "正在选择模型…";
          try { await onSelect(model.id); notice.textContent = ""; close(); }
          catch (error) { notice.textContent = error.message || String(error); }
          finally { pending = false; }
        });
        list.append(option);
      }
      if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "ai-model-meta"; empty.textContent = ai.models.length ? "没有找到匹配的模型" : "添加模型后即可从这里直接选择"; list.append(empty); }
      if (focusedId) [...list.querySelectorAll("[data-model-id]")].find(option => option.dataset.modelId === focusedId)?.focus();
    }
    function open(value) { snapshot = value; panel.hidden = false; anchor.setAttribute("aria-expanded", "true"); document.dispatchEvent(new CustomEvent("stuart-model-picker-open", { detail: id })); position(); render(); search.focus(); }
    function refresh(value) { snapshot = value; if (!panel.hidden) render(); }
    function keys(event) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      const options = [...list.querySelectorAll("[role=option]")], current = options.indexOf(document.activeElement);
      let index;
      if (event.key === "ArrowDown") index = (current + 1) % options.length;
      else if (event.key === "ArrowUp") index = (current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length);
      else if (event.key === "Home" && current >= 0) index = 0;
      else if (event.key === "End" && current >= 0) index = options.length - 1;
      else if (event.key === "Enter" && document.activeElement === search && options.length) { event.preventDefault(); options[0].click(); return; }
      else return;
      event.preventDefault(); options[index]?.focus();
    }
    const outside = event => { if (!panel.hidden && !panel.contains(event.target) && !anchor.contains(event.target)) close(false); };
    const another = event => { if (event.detail !== id && !panel.hidden) close(false); };
    const manageClick = () => { close(false); Promise.resolve(onManage()).catch(error => { notice.textContent = error.message || String(error); }); };
    search.addEventListener("input", render); panel.addEventListener("keydown", keys); manage.addEventListener("click", manageClick);
    document.addEventListener("pointerdown", outside); document.addEventListener("stuart-model-picker-open", another); global.addEventListener("resize", position);
    return { open, refresh, close, dispose() { document.removeEventListener("pointerdown", outside); document.removeEventListener("stuart-model-picker-open", another); global.removeEventListener("resize", position); panel.remove(); anchor.removeAttribute("aria-controls"); } };
  }
  global.StuartModelPicker = { create, status };
})(typeof window !== "undefined" ? window : globalThis);
