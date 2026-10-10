(function (global) {
  "use strict";
  const api = () => {
    if (!global.pywebview?.api) throw new Error("文档恢复服务尚未连接");
    return global.pywebview.api;
  };
  const host = () => {
    if (!global.StuartMD) throw new Error("文档恢复界面尚未初始化");
    return global.StuartMD;
  };
  function element(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function modal(title) {
    const dialog = element("dialog", undefined, "stuart-recovery-dialog");
    dialog.setAttribute("aria-label", title);
    const header = element("header");
    header.append(element("h2", title));
    const close = element("button", "关闭");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    header.append(close);
    const body = element("div", undefined, "stuart-recovery-body");
    const error = element("p", "", "stuart-recovery-error");
    error.setAttribute("role", "alert");
    dialog.append(header, error, body);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return { dialog, body, error };
  }
  function action(container, label, operation, error) {
    const button = element("button", label);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      error.textContent = "";
      try { await operation(); }
      catch (failure) { error.textContent = String(failure?.message || failure); throw failure; }
      finally { if (button.isConnected) button.disabled = false; }
    });
    container.append(button);
    return button;
  }
  function decode(bytes, encoding) {
    return new TextDecoder(encoding.toLowerCase(), { fatal: true }).decode(new Uint8Array(bytes));
  }
  function contentColumn(container, title, value, editable = false) {
    const section = element("section", undefined, "stuart-recovery-content");
    section.append(element("h3", title));
    const content = editable ? element("textarea") : element("pre", value);
    if (editable) { content.value = value; content.setAttribute("aria-label", title); }
    section.append(content);
    container.append(section);
    return content;
  }
  function changes(container, title, before, after) {
    if (!global.StuartDiff?.diffLines) throw new Error("文档差异依赖尚未加载");
    const section = element("section", undefined, "stuart-recovery-diff");
    section.append(element("h3", title));
    const content = element("pre");
    for (const part of global.StuartDiff.diffLines(before, after)) {
      const line = element("span", part.value, part.added ? "stuart-diff-added" : part.removed ? "stuart-diff-removed" : "");
      content.append(line);
    }
    section.append(content);
    container.append(section);
  }
  async function showRecovery() {
    const [entries, operations] = await Promise.all([api().journal_list(), api().save_operations_list()]);
    const pending = operations.filter(operation => !["Saved", "Pruned"].includes(operation.stage));
    if (!entries.length && !pending.length) return;
    const view = modal("恢复未保存文档");
    view.body.append(element("p", "这里列出已经持久化的草稿。恢复后继续保留原文件；磁盘内容发生变化时会显示保存冲突。"));
    for (const entry of entries) {
      const section = element("section", undefined, "stuart-recovery-entry");
      section.append(element("h3", entry.title || "未保存文档"));
      section.append(element("p", `${entry.path || "尚未保存到原文件"} · 草稿版本 ${entry.revision} · 原文件版本 ${entry.persistedRevision} · ${new Date(entry.updatedAt).toLocaleString()}`));
      if (entry.conflict) section.append(element("p", "磁盘内容已经变化，恢复后需要检查差异。", "stuart-recovery-error"));
      if (entry.legacyFile) section.append(element("p", `旧草稿来源：${entry.legacyFile}`));
      const buttons = element("div", undefined, "stuart-recovery-actions");
      action(buttons, "查看草稿", async () => {
        const record = await api().journal_read(entry.documentId);
        const preview = modal(record.title || "草稿正文");
        contentColumn(preview.body, "已持久化正文", record.source);
      }, view.error);
      action(buttons, "恢复文档", async () => {
        const record = await api().journal_restore(entry.documentId);
        await host().restoreDocument(record);
        section.remove();
        if (!view.body.querySelector(".stuart-recovery-entry")) view.dialog.close();
      }, view.error);
      action(buttons, "丢弃草稿", async () => {
        const confirmation = modal("确认丢弃草稿");
        confirmation.body.append(element("p", `确认删除「${entry.title || "未保存文档"}」的恢复记录。`));
        action(confirmation.body, "确认丢弃", async () => {
          await api().journal_discard(entry.documentId);
          section.remove();
          confirmation.dialog.close();
          if (!view.body.querySelector(".stuart-recovery-entry")) view.dialog.close();
        }, confirmation.error);
      }, view.error);
      section.append(buttons);
      view.body.append(section);
    }
    for (const operation of pending) {
      const section = element("section", undefined, "stuart-recovery-entry");
      section.append(element("h3", "恢复保存内容"));
      section.append(element("p", `${operation.targetPath} · ${new Date(operation.createdAt).toLocaleString()}`));
      section.append(element("p", "可以检查已经持久化的内容，并将所需版本保存为独立文件。"));
      const buttons = element("div", undefined, "stuart-recovery-actions");
      for (const [version, title] of [["base", "基础内容"], ["local", "本地保存内容"], ["external", "外部修改内容"]]) {
        if (version === "external" && !operation.externalPath) continue;
        action(buttons, "查看" + title, () => showSaveVersion(operation, version, title), view.error);
      }
      section.append(buttons); view.body.append(section);
    }
  }

  async function showSaveVersion(operation, version, title) {
    const record = await api().save_operation_read(operation.operationId, version);
    const view = modal(title);
    view.body.append(element("p", operation.targetPath));
    view.body.append(element("p", `内容大小：${record.bytes.length} 字节；完整性检查已经通过。`));
    const content = contentColumn(view.body, title, record.source ?? "请保存这个版本的文件后打开阅读。");
    if (record.encodingCandidates.length) {
      const select = element("select"); select.setAttribute("aria-label", "恢复内容编码");
      for (const name of record.encodingCandidates) { const option = element("option", name.toUpperCase()); option.value = name; select.append(option); }
      view.body.append(select);
      action(view.body, "按所选编码查看", async () => {
        const preview = await api().save_operation_read(operation.operationId, version, select.value);
        content.textContent = preview.source;
      }, view.error);
    }
    action(view.body, "保存这个版本的副本", async () => {
      const name = operation.targetPath.split(/[\\/]/).pop();
      const target = await api().choose_save_path("恢复副本-" + name);
      if (!target) return;
      const result = await api().save_operation_copy(operation.operationId, version, target);
      if (result.result !== "Saved") throw new Error("恢复副本保存存在文件冲突");
      host().toast("恢复副本已经保存：" + target);
    }, view.error);
  }
  async function showConflict(documentSession, result) {
    if (!result?.conflict) throw new Error("保存冲突缺少实际内容版本");
    const conflict = result.conflict;
    const base = decode(conflict.baseBytes, documentSession.encoding);
    const local = decode(conflict.localBytes, documentSession.encoding);
    let external, externalError;
    try { external = decode(conflict.externalBytes, documentSession.encoding); }
    catch (failure) { externalError = `外部文档无法按 ${documentSession.encoding} 无损读取，请保存本地副本后重新打开并选择编码：${failure.message}`; }
    const view = modal("检查保存冲突");
    if (externalError) view.error.textContent = externalError;
    view.body.append(element("p", `${conflict.reason}。该文档的自动保存已经暂停。保存操作编号：${result.operationId}`));
    const columns = element("div", undefined, "stuart-recovery-columns");
    contentColumn(columns, "打开时的基础内容", base);
    contentColumn(columns, "本次保存的本地内容", local);
    contentColumn(columns, "实际外部内容", externalError || external);
    view.body.append(columns);
    const differences = element("div", undefined, "stuart-recovery-columns");
    changes(differences, "基础内容与本地修改", base, local);
    if (!externalError) changes(differences, "基础内容与外部修改", base, external);
    view.body.append(differences);
    const merged = contentColumn(view.body, "检查并编辑合并内容", documentSession.source, true);
    const acknowledge = element("label");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    acknowledge.append(checkbox, document.createTextNode("我已经检查当前外部内容和合并正文"));
    view.body.append(acknowledge);
    const buttons = element("div", undefined, "stuart-recovery-actions");
    action(buttons, "保存本地副本", async () => {
      const saved = await host().saveDocumentCopy(documentSession);
      if (saved?.result === "Saved") view.dialog.close();
    }, view.error);
    action(buttons, "重新读取原文件", async () => {
      await host().reloadDocument(documentSession);
      view.dialog.close();
    }, view.error);
    action(buttons, "确认合并并保存", async () => {
      if (!checkbox.checked) throw new Error("请先确认已经检查外部内容和合并正文");
      if (externalError) throw new Error(externalError);
      documentSession.updateSource(merged.value);
      const captured = documentSession.snapshot();
      const saved = await host().saveDocumentSnapshot(documentSession, captured, documentSession.path, conflict.diskRevision);
      if (saved?.result === "Saved") view.dialog.close();
    }, view.error);
    view.body.append(buttons);
  }
  async function confirmEncoding(record) {
    if (!record?.documentId || !record.encodingCandidates?.length) throw new Error("文档缺少可确认的编码候选，禁止编辑");
    const view = modal("确认文件编码");
    view.body.append(element("p", `${record.name || record.path} 的原始字节需要选择编码。只有完成严格解码确认后才能编辑和保存。`));
    const select = element("select");
    select.setAttribute("aria-label", "文件编码");
    for (const encoding of record.encodingCandidates) {
      const option = element("option", encoding.toUpperCase());
      option.value = encoding;
      select.append(option);
    }
    view.body.append(select);
    const preview = contentColumn(view.body, "严格解码预览", "");
    let candidate = null;
    action(view.body, "查看编码预览", async () => {
      candidate = await api().document_encoding_preview(record.documentId, select.value);
      preview.textContent = candidate.source;
    }, view.error);
    select.addEventListener("change", () => { candidate = null; preview.textContent = ""; });
    action(view.body, "确认编码并打开", async () => {
      if (!candidate || candidate.encoding !== select.value) throw new Error("请先查看所选编码的完整预览");
      await host().confirmDocumentEncoding(record.documentId, select.value);
      view.dialog.close();
    }, view.error);
  }
  async function showExportConflict(result) {
    if (!result?.conflict) throw new Error("导出冲突缺少实际文件版本");
    const view = modal("检查导出文件冲突");
    view.body.append(element("p", `${result.conflict.reason}。基础内容、本地导出内容和外部内容已经保留。保存操作编号：${result.operationId}`));
    const records = await api().save_operations_list();
    const operation = records.find(item => item.operationId === result.operationId);
    if (!operation) throw new Error("导出恢复记录不存在");
    for (const [version, title] of [["base", "基础内容"], ["local", "本地导出内容"], ["external", "实际外部内容"]]) {
      if (version === "external" && !operation.externalPath) continue;
      action(view.body, "查看" + title, () => showSaveVersion(operation, version, title), view.error);
    }
    const buttons = element("div", undefined, "stuart-recovery-actions");
    action(buttons, "保存本地导出副本", async () => {
      const extension = operation.targetPath.split(".").pop().toLowerCase();
      const targetPath = await api().choose_save_path(`导出副本.${extension}`);
      if (!targetPath) return;
      const saved = await api().save_operation_copy(operation.operationId, "local", targetPath);
      if (saved.result !== "Saved") throw new Error("导出副本未完成保存");
      host().toast("已保存导出副本：" + targetPath); view.dialog.close();
    }, view.error);
    view.body.append(buttons);
  }
  global.StuartRecovery = { showRecovery, showConflict, showExportConflict, confirmEncoding };
})(typeof window !== "undefined" ? window : globalThis);
