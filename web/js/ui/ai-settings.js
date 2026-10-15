(function (global) {
  "use strict";
  const labels = { off: "关闭思考", on: "开启思考", low: "较低强度", high: "较高强度", max: "最高强度" };
  const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
  function input(type, value = "") { const control = document.createElement("input"); control.type = type; control.value = value; return control; }
  function select(choices, value) { const control = document.createElement("select"); for (const [id, label] of choices) { const option = text("option", label); option.value = id; control.append(option); } control.value = value; return control; }
  function field(label, control) { const wrapper = text("label", label, "ai-field"); wrapper.append(control); return wrapper; }
  function button(label, action, primary = false) { const control = text("button", label, primary ? "btn primary" : "btn"); control.type = "button"; control.addEventListener("click", async () => { if (control.disabled) return; control.disabled = true; try { await action(); } catch (error) { const owner = control.closest(".ai-editor, .ai-preferences, .ai-settings"); owner?.querySelector("[data-error]")?.replaceChildren(text("span", error.message || String(error))); } finally { control.disabled = false; } }); return control; }
  function countingFields(initial) {
    const box = document.createElement("details"); box.className = "ai-advanced"; box.append(text("summary", "高级计数配置"));
    const enabled = input("checkbox"); enabled.checked = !!initial; box.append(field("使用自定义计数资料", enabled));
    const controls = {}, group = document.createElement("div"); group.className = "ai-form-grid";
    const method = select([["local-tokenizer", "本地 tokenizer 与消息模板"], ["kimi-estimate", "Kimi 官方估算接口"], ["qwen-provider", "千问官方计数接口"], ["glm-provider", "智谱官方计数接口"]], initial?.method || "local-tokenizer"); controls.method = method; group.append(field("计数方式", method));
    const names = { context_window: "上下文容量", max_output_tokens: "模型输出上限", protocol_reserve: "协议预留 Token", estimate_safety_ratio: "额外预留比例（0 至 1）", endpoint: "官方计数地址", tokenizer_artifact: "tokenizer 文件路径", tokenizer_hash: "tokenizer SHA-256", chat_template: "消息模板文件路径", chat_template_hash: "消息模板 SHA-256", bos_token: "开始标记", eos_token: "结束标记" };
    for (const [name, label] of Object.entries(names)) {
      const numeric = ["context_window", "max_output_tokens", "protocol_reserve", "estimate_safety_ratio"].includes(name), control = input(numeric ? "number" : "text", initial?.[name] ?? (name === "protocol_reserve" ? 256 : name === "estimate_safety_ratio" ? 0.1 : ""));
      if (numeric) { control.min = "0"; control.step = name === "estimate_safety_ratio" ? "0.01" : "1"; }
      controls[name] = control; group.append(field(label, control));
    }
    const update = () => { group.hidden = !enabled.checked; for (const [name, control] of Object.entries(controls)) if (["endpoint", "tokenizer_artifact", "tokenizer_hash", "chat_template", "chat_template_hash", "bos_token", "eos_token"].includes(name)) control.closest("label").hidden = method.value === "local-tokenizer" ? name === "endpoint" : name !== "endpoint"; };
    enabled.addEventListener("change", update); method.addEventListener("change", update); box.append(group); update();
    return { box, read() {
      if (!enabled.checked) return null;
      const result = {};
      for (const [name, control] of Object.entries(controls)) {
        if (control.closest("label").hidden) continue;
        if (control.type === "number") { if (control.value === "" || !Number.isFinite(Number(control.value))) throw new Error(`请填写${names[name]}`); result[name] = Number(control.value); }
        else { result[name] = control.value.trim(); if (!result[name] && !["bos_token", "eos_token"].includes(name)) throw new Error(`请填写${names[name] || "计数方式"}`); }
      }
      if (result.context_window <= 0 || result.max_output_tokens <= 0 || result.max_output_tokens > result.context_window || result.protocol_reserve >= result.context_window || result.estimate_safety_ratio < 0 || result.estimate_safety_ratio > 1) throw new Error("计数容量及预留比例无效");
      return result;
    } };
  }
  function requestFields(initial = {}) {
    const box = document.createElement("details"); box.className = "ai-advanced"; box.append(text("summary", "高级请求参数"));
    const output = select([["max_tokens", "max_tokens"], ["max_completion_tokens", "max_completion_tokens"]], initial.output_parameter || "max_tokens");
    const thinking = select([["none", "使用服务默认参数"], ["thinking", "thinking.type"], ["enable_thinking", "enable_thinking"], ["reasoning_effort", "reasoning_effort"]], initial.thinking_parameter || "none");
    const json = input("checkbox"), reasoning = input("checkbox"); json.checked = initial.json_output !== false; reasoning.checked = !!initial.preserve_reasoning;
    box.append(field("输出上限参数", output), field("思考参数", thinking), field("支持 JSON 输出", json), field("多轮传递完整思考内容", reasoning));
    return { box, read: () => ({ ...initial, output_parameter: output.value, thinking_parameter: thinking.value, json_output: json.checked, preserve_reasoning: reasoning.checked }) };
  }
  function mount(container, initialSnapshot) {
    let snapshot = initialSnapshot, editor = null, preferencesDraft = null;
    container.classList.add("ai-settings"); container.replaceChildren();
    const heading = document.createElement("div"); heading.className = "ai-section-heading";
    heading.append(text("h3", "已保存模型"), button("添加模型", () => openAdd(), true));
    const search = input("search"); search.placeholder = "搜索模型或服务商"; search.setAttribute("aria-label", "搜索模型或服务商");
    const notice = text("div", "", "ai-model-notice"); notice.dataset.error = ""; notice.setAttribute("role", "status");
    const models = document.createElement("div"); models.id = "ai-saved-models";
    const editorHost = document.createElement("div"); editorHost.className = "ai-editor-host";
    const connections = document.createElement("div"); connections.id = "ai-connections";
    const preferences = document.createElement("div"); preferences.className = "ai-preferences";
    container.append(heading, text("p", "添加一次连接，即可保存多个模型。日常从顶部或伴读的模型列表直接选择。", "hint small"), search, notice, models, editorHost, text("h3", "服务商连接"), connections, text("h3", "对话偏好"), preferences);
    const client = () => global.StuartAI;
    async function change(value, confirm = false) { const result = await client().updateConfig(value, snapshot.settingsRevision, confirm); refresh(result); return result; }
    async function discardEditor() {
      if (editor?.dirty && !await global.StuartUIConfirm("当前表单包含未保存的输入，确认丢弃这些输入吗？")) return false;
      closeEditor(); return true;
    }
    function closeEditor() { editorHost.querySelectorAll('input[type="password"]').forEach(control => { control.value = ""; }); editor = null; editorHost.replaceChildren(); }
    function editorForm(title, kind, id) {
      const form = document.createElement("form"); form.className = "ai-editor"; form.dataset.kind = kind;
      const error = text("div", "", "ai-model-notice"); error.dataset.error = ""; error.setAttribute("role", "status");
      const reload = button("重新加载此表单", async () => { if (!await discardEditor()) return; if (kind === "model") await openModel(id); else if (kind === "connection") await openConnection(id); else await openAdd(); }); reload.hidden = true;
      form.append(text("h4", title), error, reload); editorHost.replaceChildren(form);
      editor = { kind, id, revision: snapshot.settingsRevision, dirty: false, form, reload, error };
      form.addEventListener("input", event => { if (!event.target.dataset.changesProvider) editor.dirty = true; });
      form.addEventListener("submit", event => { event.preventDefault(); form.querySelector('[data-save="true"]').click(); });
      return form;
    }
    function saveButton(form, action) {
      const save = button("保存", async () => { try { await action(); closeEditor(); notice.textContent = "设置已经保存"; } catch (error) { if (String(error.message || error).includes("SettingsVersionConflict")) editor.reload.hidden = false; throw error; } }, true); save.dataset.save = "true";
      const actions = document.createElement("div"); actions.className = "ai-row-actions"; actions.append(button("取消", () => discardEditor()), save); form.append(actions);
      return save;
    }
    function capability(model) { const connection = snapshot.ai.providers.find(p => p.id === model.provider_id); return snapshot.catalog.models.find(m => m.provider_type === connection?.type && m.regions.includes(connection.region) && m.model_id === model.model_id); }
    async function openModel(id) {
      if (!await discardEditor()) return;
      const model = snapshot.ai.models.find(m => m.id === id); if (!model) throw new Error("模型已经删除，请从列表重新选择");
      const form = editorForm("编辑模型", "model", id), original = structuredClone(model), cap = capability(model);
      const name = input("text", model.display_name), apiName = input("text", model.model_id), output = input("number", model.max_output_tokens);
      name.required = true; apiName.required = true; output.min = "1"; output.step = "1"; if (cap) { apiName.readOnly = true; output.max = String(cap.output_limit); }
      const choices = cap ? [...(cap.thinking === "optional" ? ["off"] : []), ...(cap.efforts.length ? cap.efforts : ["on"])] : ["off", "on", "low", "high", "max"];
      const thinking = select(choices.map(value => [value, labels[value]]), model.thinking);
      const counting = countingFields(model.token_counting), request = requestFields(model.overrides);
      form.append(field("显示名称", name), field("API 型号", apiName), field("思考方式", thinking), field("输出预算 Token", output), text("p", cap ? `上下文 ${cap.context_window.toLocaleString()} Token · 输出上限 ${cap.output_limit.toLocaleString()} Token` : "此型号的容量与参数使用保存的高级配置。", "hint small"), counting.box);
      if (!cap) form.append(request.box);
      saveButton(form, async () => { if (!form.reportValidity()) throw new Error("请检查模型字段"); await client().updateConfig({ kind: "editModel", model: { ...original, display_name: name.value.trim(), model_id: apiName.value.trim(), thinking: thinking.value, max_output_tokens: Number(output.value), token_counting: counting.read(), overrides: cap ? original.overrides : request.read() } }, editor.revision); });
      name.focus();
    }
    async function openConnection(id) {
      if (!await discardEditor()) return;
      const provider = snapshot.ai.providers.find(p => p.id === id); if (!provider) throw new Error("连接已经删除");
      const form = editorForm("编辑服务商连接", "connection", id), name = input("text", provider.label), base = input("url", provider.base_url), key = input("password"), enabled = input("checkbox"); enabled.checked = provider.enabled;
      base.readOnly = provider.type !== "custom"; key.autocomplete = "new-password"; key.placeholder = provider.key_set ? "已保存；留空继续使用" : "请输入 API Key";
      form.append(field("启用连接", enabled), field("连接名称", name), field("服务地址", base), field("API Key", key), text("p", "密钥由当前 Windows 用户加密保存，同一连接的全部模型共用。", "hint small"));
      saveButton(form, () => client().updateConfig({ kind: "saveProviderModels", connection: { id, provider_type: provider.type, region: provider.region, label: name.value.trim(), base_url: base.value.trim(), enabled: enabled.checked }, models: [], api_key: key.value || null }, editor.revision)); name.focus();
    }
    async function openAdd() {
      if (!await discardEditor()) return;
      const form = editorForm("添加模型", "add", null), types = [...new Map(snapshot.catalog.providers.map(p => [p.type, p.label]))], provider = select([...types, ["custom", "自定义 OpenAI 兼容服务"]], types[0][0]);
      provider.dataset.changesProvider = "true";
      const region = select([], ""), area = document.createElement("div"); region.dataset.changesProvider = "true";
      form.append(field("服务商", provider), field("服务区域", region), area);
      let selectedProvider = provider.value, selectedRegion = "";
      function fillRegions() { region.replaceChildren(); for (const item of snapshot.catalog.providers.filter(p => p.type === provider.value)) { const option = text("option", item.region_label); option.value = item.region; region.append(option); } if (provider.value === "custom") { const option = text("option", "自定义"); option.value = "custom"; region.append(option); } selectedRegion = region.value; }
      function renderArea() {
        area.replaceChildren(); form.querySelector(".ai-row-actions")?.remove();
        const existing = snapshot.ai.providers.find(p => p.type === provider.value && p.region === region.value), key = input("password"); key.autocomplete = "new-password"; key.placeholder = existing?.key_set ? "已保存；留空继续使用" : "请输入 API Key";
        const providerSpec = snapshot.catalog.providers.find(p => p.type === provider.value && p.region === region.value), name = input("text", existing?.label || providerSpec?.label || "自定义服务"), base = input("url", existing?.base_url || ""), customName = input("text"), advanced = countingFields(null), request = requestFields();
        area.append(field("API Key", key), text("p", existing?.key_set ? "使用此连接已经保存的密钥，所选模型将共用此连接。" : "填写一次密钥后，可以同时添加多个模型。", "hint small"));
        const selected = new Set(), rows = document.createElement("div"); rows.className = "ai-catalog-options";
        if (provider.value === "custom") { area.append(field("连接名称", name), field("API 地址", base), field("API 型号", customName), advanced.box, request.box); }
        else {
          const query = input("search"); query.placeholder = "搜索此服务商的模型"; query.setAttribute("aria-label", "搜索可添加模型"); area.append(query, rows);
          const available = snapshot.catalog.models.filter(m => m.provider_type === provider.value && m.regions.includes(region.value));
          for (const model of available) {
            const check = input("checkbox"), row = document.createElement("label"); row.className = "ai-catalog-option"; row.dataset.search = `${model.display_name} ${model.model_id}`.toLowerCase();
            check.value = model.model_id; check.addEventListener("change", () => { if (check.checked) selected.add(model.model_id); else selected.delete(model.model_id); });
            const detail = document.createElement("div"); detail.append(text("strong", model.display_name), text("div", `${model.model_id} · 上下文 ${model.context_window.toLocaleString()} Token${existing && snapshot.ai.models.some(m => m.provider_id === existing.id && m.model_id === model.model_id) ? " · 已保存" : ""}`, "ai-model-meta"), text("div", `${model.description} · ${model.thinking === "always" ? "始终思考" : "支持切换思考"}`, "ai-model-meta")); row.append(check, detail); rows.append(row);
          }
          query.addEventListener("input", () => { for (const row of rows.children) row.hidden = !row.dataset.search.includes(query.value.trim().toLowerCase()); });
          area.append(text("p", `官方目录 · ${snapshot.catalog.verified_at} 核对。模型是否可调用取决于账号权限与实际验证。`, "hint small"));
          if (existing?.discovered) for (const model of existing.discovered.models.filter(model => !available.some(item => item.model_id === model.modelId))) rows.append(text("div", `${model.modelId} · ${model.configurationStatus}`, "ai-model-meta"));
        }
        saveButton(form, async () => {
          let entries;
          if (provider.value === "custom") { if (!customName.value.trim()) throw new Error("请填写 API 型号"); const counting = advanced.read(); if (!counting) throw new Error("自定义模型需要填写高级计数资料"); entries = [{ model_id: customName.value.trim(), token_counting: counting, overrides: request.read() }]; }
          else { if (!selected.size) throw new Error("请勾选需要保存的模型"); entries = [...selected].map(model_id => ({ model_id })); }
          const result = await client().updateConfig({ kind: "saveProviderModels", connection: { id: existing?.id || null, provider_type: provider.value, region: region.value, label: provider.value === "custom" ? name.value.trim() : providerSpec.label, base_url: provider.value === "custom" ? base.value.trim() : null }, models: entries, api_key: key.value || null }, editor.revision);
          key.value = ""; const first = result.ai.models.find(m => entries.some(entry => entry.model_id === m.model_id) && result.ai.providers.find(p => p.id === m.provider_id)?.type === provider.value); models.querySelector(`[data-model-id="${first?.id}"]`)?.focus();
        });
      }
      async function providerChanged(event) {
        if (editor.dirty && !await global.StuartUIConfirm("切换服务商或区域会丢弃当前添加表单中的输入，确认继续吗？")) { provider.value = selectedProvider; region.value = selectedRegion; return; }
        if (event.target === provider) fillRegions();
        selectedProvider = provider.value; selectedRegion = region.value; editor.dirty = false; renderArea();
      }
      provider.addEventListener("change", event => providerChanged(event).catch(error => { editor.error.textContent = error.message || String(error); })); region.addEventListener("change", event => providerChanged(event).catch(error => { editor.error.textContent = error.message || String(error); }));
      fillRegions(); renderArea(); provider.focus();
    }
    function renderLists() {
      const focused = document.activeElement?.dataset.actionId, query = search.value.trim().toLocaleLowerCase(); models.replaceChildren(); connections.replaceChildren();
      for (const model of snapshot.ai.models) {
        const info = global.StuartModelPicker.status(snapshot, model), connection = info.connection;
        if (!`${model.display_name} ${model.model_id} ${connection?.label}`.toLocaleLowerCase().includes(query)) continue;
        const row = document.createElement("div"); row.className = "ai-saved-row"; row.dataset.modelId = model.id; row.tabIndex = -1;
        const detail = document.createElement("div"); detail.className = "ai-row-detail";
        const marks = [model.id === snapshot.ai.active_model_id && "当前选择", model.id === snapshot.ai.default_model_id && "默认模型"].filter(Boolean);
        detail.append(text("strong", model.display_name), text("div", [connection?.label, connection?.region, model.model_id, ...marks].filter(Boolean).join(" · "), "ai-model-meta"), text("div", info.label, "ai-model-meta"));
        const actions = document.createElement("div"); actions.className = "ai-row-actions";
        const choose = button(model.id === snapshot.ai.active_model_id ? "当前选择" : "选择", () => change({ kind: "selectModel", model_id: model.id })); choose.disabled = !!info.reason || model.id === snapshot.ai.active_model_id;
        const verify = button("验证回答", async () => { notice.textContent = "正在发送公开测试消息并核验计数、正文及用量…"; const result = await global.pywebview.api.ai_verify_model(model.id, snapshot.settingsRevision); await client().ensureConfig(true); notice.textContent = result.status === "Passed" ? "模型回答验证通过" : result.stages.filter(stage => stage.status === "Failed").map(stage => stage.error).join("；"); }); verify.disabled = !!info.reason;
        actions.append(choose, button("编辑", () => openModel(model.id)), button("设为默认", () => change({ kind: "setDefaultModel", model_id: model.id })), verify, button(model.enabled ? "停用" : "启用", () => change({ kind: "setModelEnabled", model_id: model.id, enabled: !model.enabled })), button("删除", async () => { if (await global.StuartUIConfirm(`确认删除模型「${model.display_name}」吗？已有会话与服务商连接将继续保留。`)) await change({ kind: "deleteModel", model_id: model.id }); }));
        [...actions.children].forEach((control, index) => { control.dataset.actionId = `${model.id}-${index}`; });
        row.append(detail, actions); if (model.verification) { const history = document.createElement("details"); history.append(text("summary", "验证详情"), text("div", `测试消息发送时间：${new Date(model.verification.checkedAt).toLocaleString()}`, "ai-model-meta")); for (const stage of model.verification.stages) history.append(text("p", `${stage.stage} · ${stage.status}${stage.error ? ` · ${stage.error}` : ""}`, "ai-model-meta")); row.append(history); } models.append(row);
      }
      if (!models.childElementCount) models.append(text("p", snapshot.ai.models.length ? "没有匹配的模型" : "尚未添加模型。选择服务商并填写 API Key，即可一次添加多个模型。", "ai-model-meta"));
      for (const connection of snapshot.ai.providers) {
        const associated = snapshot.ai.models.filter(m => m.provider_id === connection.id), row = document.createElement("div"); row.className = "ai-saved-row";
        const detail = document.createElement("div"); detail.className = "ai-row-detail"; detail.append(text("strong", connection.label), text("div", `${connection.region} · ${associated.length} 个模型 · ${connection.key_set ? "密钥已保存" : "尚未保存密钥"}`, "ai-model-meta"), text("div", connection.base_url, "ai-model-meta"));
        const actions = document.createElement("div"); actions.className = "ai-row-actions";
        actions.append(button("编辑连接", () => openConnection(connection.id)), button("清除密钥", async () => { if (await global.StuartUIConfirm(`确认清除「${connection.label}」的密钥吗？${associated.length} 个模型需要重新配置密钥。`)) { await client().clearApiKey(connection.id, snapshot.settingsRevision); } }), button("删除连接", async () => { if (await global.StuartUIConfirm(`删除「${connection.label}」将清除密钥并删除以下模型：${associated.map(m => m.display_name).join("、") || "没有关联模型"}。确认删除吗？`)) await change({ kind: "deleteProvider", provider_id: connection.id }, true); }));
        const spec = snapshot.catalog.providers.find(p => p.type === connection.type && p.region === connection.region);
        if (spec?.discovery || connection.type === "custom") actions.append(button("获取模型目录", async () => { notice.textContent = "正在获取目录…"; const result = await global.pywebview.api.ai_discover_models(connection.id, snapshot.settingsRevision); await client().ensureConfig(true); notice.textContent = `目录获取完成，共 ${result.models.length} 个名称；模型回答请分别验证。`; }));
        if (connection.discovered) detail.append(text("div", `在线目录 · ${new Date(connection.discovered.fetchedAt).toLocaleString()} · ${connection.discovered.source}`, "ai-model-meta"));
        row.append(detail, actions); connections.append(row);
      }
      if (!connections.childElementCount) connections.append(text("p", "添加模型时会同时保存服务商连接。", "ai-model-meta"));
      if (focused) [...models.querySelectorAll("[data-action-id]")].find(control => control.dataset.actionId === focused)?.focus();
    }
    function renderPreferences() {
      if (preferencesDraft?.dirty) return;
      preferences.replaceChildren(); const config = snapshot.ai, original = structuredClone(config.style), revision = snapshot.settingsRevision;
      const enabled = input("checkbox"), memories = input("checkbox"); enabled.checked = config.enabled; memories.checked = config.use_saved_memories;
      const shortcut = input("text", config.explain_shortcut); shortcut.id = "ai-shortcut-input";
      const scope = select([["selection", "选中内容"], ["section", "当前章节"], ["document", "整篇文档"], ["workspace", "工作区资料"]], config.context_scope), learning = select([["off", "关闭"], ["ask", "询问"], ["automatic", "自动整理"]], config.learning_policy);
      const length = select([["brief", "简短"], ["normal", "适中"], ["detailed", "详细"]], original.length), tone = select([["neutral", "中性"], ["friendly", "亲切"], ["professional", "专业"], ["academic", "学术"]], original.tone), custom = document.createElement("textarea"), hint = document.createElement("textarea"); custom.rows = 3; custom.value = original.custom; hint.rows = 2; hint.value = original.length_hint;
      const error = text("div", "", "ai-model-notice"); error.dataset.error = ""; error.setAttribute("role", "status");
      const reload = button("重新加载对话偏好", async () => { if (preferencesDraft.dirty && !await global.StuartUIConfirm("确认丢弃未保存的对话偏好吗？")) return; preferencesDraft = null; renderPreferences(); }); reload.hidden = true;
      preferencesDraft = { dirty: false, revision, error, reload };
      const shortcutField = field("问答快捷键", shortcut); shortcutField.append(button("录入快捷键", () => { global.StuartAIUI.uiState.recordingShortcut = true; shortcut.focus(); shortcut.placeholder = "请按下快捷键，Escape 取消"; }));
      preferences.append(field("启用 AI", enabled), shortcutField, field("默认材料范围", scope), field("使用已有记忆", memories), field("整理新记忆", learning), field("回答长度", length), field("回答语气", tone), field("风格说明", custom), field("长度提示", hint), error, reload, button("保存对话偏好", async () => {
        try { global.StuartAIUI.validateShortcut(shortcut.value.trim()); await client().updateConfig({ kind: "updatePreferences", preferences: { enabled: enabled.checked, explain_shortcut: shortcut.value.trim(), context_scope: scope.value, use_saved_memories: memories.checked, learning_policy: learning.value, style: { ...original, length: length.value, tone: tone.value, custom: custom.value, length_hint: hint.value } } }, revision); preferencesDraft = null; renderPreferences(); }
        catch (reason) { if (String(reason.message || reason).includes("SettingsVersionConflict")) reload.hidden = false; throw reason; }
      }, true));
      for (const control of preferences.querySelectorAll("input,select,textarea")) control.addEventListener("input", () => { preferencesDraft.dirty = true; });
    }
    function refresh(value) {
      const changed = snapshot?.settingsRevision !== value.settingsRevision; snapshot = value; renderLists(); renderPreferences();
      if (changed && editor) { editor.reload.hidden = false; editor.error.textContent = "已保存配置已经更新，当前输入保持保留。保存时将检查编辑开始时的版本。"; }
      if (changed && preferencesDraft?.dirty) { preferencesDraft.reload.hidden = false; preferencesDraft.error.textContent = "配置已经更新，当前偏好输入保持保留。"; }
    }
    search.addEventListener("input", renderLists); refresh(initialSnapshot);
    return { refresh, openAdd, openModel, openConnection, get editing() { return editor && { kind: editor.kind, id: editor.id, revision: editor.revision, dirty: editor.dirty }; }, dispose: closeEditor };
  }
  global.StuartAISettings = { mount };
})(typeof window !== "undefined" ? window : globalThis);
