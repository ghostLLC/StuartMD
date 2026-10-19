// StuartMD 原生命令接口，在 app.js 加载前注册。
(function () {
  "use strict";
  if (!window.__TAURI__ && !window.__TAURI_INTERNALS__) return;

  function invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args || {});
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    }
    return Promise.reject(new Error("tauri invoke missing"));
  }

  const api = {
    get_app_info: () => invoke("stuart_get_app_info"),
    get_settings: () => invoke("stuart_get_settings"),
    save_settings: (data) => invoke("stuart_save_settings", { data }),
    read_file: (path) => invoke("document_read", { path }),
    document_read: (path) => invoke("document_read", { path }),
    document_new: () => invoke("document_new"),
    document_release: (documentId) => invoke("document_release", { documentId }),
    document_confirm_encoding: (documentId, encoding) => invoke("document_confirm_encoding", { documentId, encoding }),
    document_encoding_preview: (documentId, encoding) => invoke("document_encoding_preview", { documentId, encoding }),
    document_target_revision: (path, documentId = null) => invoke("document_target_revision", { path, documentId }),
    save_document: (request) => invoke("save_document", { request }),
    journal_write: (snapshot) => invoke("journal_write", { snapshot }),
    journal_list: () => invoke("journal_list"),
    journal_read: (documentId) => invoke("journal_read", { documentId }),
    journal_restore: (documentId) => invoke("journal_restore", { documentId }),
    journal_discard: (documentId) => invoke("journal_discard", { documentId }),
    journal_flush: () => invoke("journal_flush"),
    save_operations_list: () => invoke("save_operations_list"),
    save_operation_read: (operationId, version, encoding = null) => invoke("save_operation_read", { operationId, version, encoding }),
    save_operation_copy: (operationId, version, targetPath) => invoke("save_operation_copy", { operationId, version, targetPath }),
    write_file: (path, content) => invoke("stuart_write_file", { path, content }),
    read_pdf: (path) => invoke("stuart_read_pdf", { path }),
    pdf_document_snapshot: (documentId) => invoke("pdf_document_snapshot", { documentId }),
    read_dir_tree: (path) => invoke("stuart_read_dir_tree", { path }),
    read_document_directory: (documentId) => invoke("stuart_read_document_directory", { documentId }),
    get_recents: () => invoke("stuart_get_recents"),
    open_path: async (path) => {
      const result = await invoke("stuart_open_path", { path });
      if (result.error || result.kind === "folder") return result;
      return invoke("document_read", { path: result.path || path });
    },
    open_in_new_window: (path) => invoke("stuart_open_in_new_window", { path }),
    open_new_window: () => invoke("stuart_open_new_window"),
    open_url: (url) => invoke("stuart_open_url", { url }),
    check_update: () => invoke("stuart_check_update"),
    list_plugins: () => invoke("stuart_list_plugins"),
    read_plugin_source: (path) => invoke("stuart_read_plugin_source", { path }),
    set_plugin_enabled: (pluginId, enabled) =>
      invoke("stuart_set_plugin_enabled", { pluginId, enabled }),
    import_wallpaper: (b64, name) => invoke("stuart_import_wallpaper_ex", { b64, name }),
    get_wallpaper: () => invoke("stuart_get_wallpaper"),
    clear_wallpaper: () => invoke("stuart_clear_wallpaper"),
    open_welcome: async () => {
      const result = await invoke("stuart_open_welcome");
      if (result.error) throw new Error(result.error);
      return { ...await invoke("document_read", { path: result.path }), welcome: true };
    },
    open_sample: async () => {
      const result = await invoke("stuart_open_sample");
      if (result.error) throw new Error(result.error);
      return invoke("document_read", { path: result.path });
    },
    file_exists: (path) => invoke("stuart_file_exists", { path }),
    resolve_asset: (base, rel) => invoke("stuart_resolve_asset", { baseFile: base, rel }),
    open_data_dir: () => invoke("stuart_open_data_dir"),
    open_plugins_dir: () => invoke("stuart_open_plugins_dir"),
    reveal_in_explorer: (path) => invoke("stuart_reveal_in_explorer", { path: path || null }),
    open_default_apps_settings: () => invoke("stuart_open_default_apps_settings"),
    get_file_association_status: () => invoke("stuart_get_file_association_status"),
    register_file_association: () => invoke("stuart_register_file_association"),
    load_annotations: (path) => invoke("stuart_load_annotations", { pdfPath: path }),
    save_annotations: (path, items, documentId) => invoke("stuart_save_annotations", { pdfPath: path, items, documentId }),
    add_annotation: (path, ann, documentId) => invoke("stuart_add_annotation", { pdfPath: path, ann, documentId }),
    delete_annotation: (path, id, documentId) => invoke("stuart_delete_annotation", { pdfPath: path, annId: id, documentId }),
    clear_annotations: (path, documentId) => invoke("stuart_clear_annotations", { pdfPath: path, documentId }),
    export_pdf_annotations: (path, items, documentId) => invoke("stuart_export_pdf_annotations", { pdfPath: path, items, documentId }),
    edit_pdf_annotations: (path, edits, documentId) => invoke("stuart_edit_pdf_annotations", { pdfPath: path, edits, documentId }),
    restore_pdf_annotations: (documentId, operationId, version) => invoke("stuart_restore_pdf_annotations", { documentId, operationId, version }),
    capture_window: () => invoke("stuart_capture_window"),
    apply_window_state: () => invoke("stuart_apply_window_state"),
    // AI / memory / tool surface (medium-term)
    get_capabilities: () => invoke("stuart_get_capabilities"),
    ai_home: () => invoke("stuart_ai_home"),
    memory_list: () => invoke("stuart_memory_list"),
    memory_get: (key) => invoke("stuart_memory_get", { key }),
    memory_set: (key, content) => invoke("stuart_memory_set", { key, content }),
    memory_delete: (key) => invoke("stuart_memory_delete", { key }),
    search_md: (root, query, limit) =>
      invoke("stuart_search_md", { root, query, limit: limit == null ? null : limit }),
    workspace_files: (root) => invoke("stuart_workspace_files", { root }),
    register_allowed_path: (path) => invoke("stuart_register_allowed_path", { path }),
    save_draft: (path, content) => invoke("stuart_save_draft", { path, content }),
    clear_draft: (path) => invoke("stuart_clear_draft", { path }),
    // AI 3.0.0
    ai_get_config: () => invoke("stuart_ai_get_config"),
    ai_discover_models: (providerId, expectedRevision) => invoke("stuart_ai_discover_models", { providerId, expectedRevision }),
    ai_verify_model: (modelConfigId, expectedRevision) => invoke("stuart_ai_verify_model", { modelConfigId, expectedRevision }),
    ai_update_config: (change, expectedRevision, confirm) => invoke("stuart_ai_update_config", { change, expectedRevision, confirm: confirm ?? null }),
    ai_set_api_key: (providerId, apiKey, expectedRevision) =>
      invoke("stuart_ai_set_api_key", { providerId, apiKey, expectedRevision }),
    ai_clear_api_key: (providerId, expectedRevision) => invoke("stuart_ai_clear_api_key", { providerId, expectedRevision }),
    ai_chat_start: (requestId, providerId, model, messages, thinking, maxOutputTokens, documentId, sessionId, contextInput) =>
      invoke("stuart_ai_request_start", {
        requestId,
        providerId: providerId || null,
        model: model || null,
        messages,
        thinking: thinking || null,
        maxOutputTokens: maxOutputTokens == null ? null : maxOutputTokens,
        documentId,
        sessionId,
        contextInput,
      }),
    ai_chat_cancel: (requestId) => invoke("stuart_ai_request_cancel", { requestId }),
    ai_chat_status: (requestId) => invoke("stuart_ai_request_status", { requestId }),
    // StuartMD RAG Knowledge Engine (M1 + M2)
    rag_set_workspace: (workspaceRoot) => invoke("stuart_rag_set_workspace", { workspaceRoot }),
    rag_query: (query, topK, workspaceRoot, acceptPartial = false) => invoke("stuart_rag_query", { request: { query, topK, vaultRoot: workspaceRoot || null, acceptPartial } }),
    rag_get_status: (workspaceRoot) => invoke("stuart_rag_get_status", { workspaceRoot: workspaceRoot || null }),
    rag_sync_workspace: (workspaceRoot) => invoke("stuart_rag_sync_workspace", { workspaceRoot: workspaceRoot || null }),
    rag_cancel_sync: (workspaceRoot, jobId) => invoke("stuart_rag_cancel_sync", { workspaceRoot: workspaceRoot || null, jobId: jobId || null }),
    pdf_context: (path, pageNumber) => invoke("stuart_pdf_context", { path, pageNumber }),
    // StuartMD Diff Gatekeeper (M4)
    companion_preview_diff: (originalPath, proposedContent, currentRev, documentId) =>
      invoke("stuart_companion_preview_diff", { originalPath, proposedContent, currentRev, documentId }),
    companion_apply_diff: (originalPath, finalContent, expectedRev, expectedHash, documentId, approvalId) =>
      invoke("stuart_companion_apply_diff", { originalPath, finalContent, expectedRev, expectedHash, documentId, approvalId }),
    companion_save_note: (originalPath, noteContent, customSuffix) =>
      invoke("stuart_companion_save_note", { originalPath, noteContent, customSuffix: customSuffix || null }),
    companion_get_target: (documentId, workspaceRoot) => invoke("stuart_companion_get_target", { documentId: documentId ?? null, workspaceRoot: workspaceRoot ?? null }),
    companion_prepare_context: intent => invoke("stuart_companion_prepare_context", { intent }),
    companion_send_question: intent => invoke("stuart_companion_send_question", { intent }),
    companion_preview_source: (target, source) => invoke("stuart_companion_preview_source", { target, source }),
    companion_get_source: (sourceId, requestId) => invoke("stuart_companion_get_source", { sourceId, requestId }),
    companion_workspace_status: workspaceRoot => invoke("stuart_companion_workspace_status", { workspaceRoot }),
    companion_learn_request: requestId => invoke("stuart_companion_learn_request", { requestId }),
    companion_get_conversation: (sessionId = null, cursor = null, target = null) => invoke("stuart_companion_get_conversation", { sessionId, cursor, target }),
    companion_save_draft: (draft, expectedDraftVersion) => invoke("stuart_companion_save_draft", { draft, expectedDraftVersion }),
    companion_list_sessions: options => invoke("stuart_companion_list_sessions", { options }),
    companion_rename_session: (sessionId, expectedSessionVersion, title) => invoke("stuart_companion_rename_session", { sessionId, expectedSessionVersion, title }),
    companion_delete_session: (sessionId, expectedSessionVersion, deleteLinkedMemories = false) => invoke("stuart_companion_delete_session", { sessionId, expectedSessionVersion, deleteLinkedMemories }),
    companion_list_memories: options => invoke("stuart_companion_list_memories", { options }),
    companion_save_memory: (recordId, expectedVersion, edit) => invoke("stuart_companion_save_memory", { recordId, expectedVersion, edit }),
    companion_delete_memory: (recordId, expectedVersion) => invoke("stuart_companion_delete_memory", { recordId, expectedVersion }),
    companion_create_memory_proposal: edit => invoke("stuart_companion_create_memory_proposal", { edit }),
    companion_list_memory_proposals: options => invoke("stuart_companion_list_memory_proposals", { options }),
    companion_update_memory_proposal: (proposalId, expectedProposalVersion, edit) => invoke("stuart_companion_update_memory_proposal", { proposalId, expectedProposalVersion, edit }),
    companion_confirm_memory: (proposalId, expectedProposalVersion, edit) => invoke("stuart_companion_confirm_memory", { proposalId, expectedProposalVersion, edit }),
    companion_get_memory_source: recordId => invoke("stuart_companion_get_memory_source", { recordId }),
    companion_get_memory_versions: recordId => invoke("stuart_companion_get_memory_versions", { recordId }),
    // StuartMD Context Pyramid & Budgeting Engine (M3)
    context_assemble: (pyramid, contextLimit, reserveOutput) =>
      invoke("stuart_context_assemble", {
        pyramid,
        contextLimit: contextLimit == null ? null : contextLimit,
        reserveOutput: reserveOutput == null ? null : reserveOutput,
      }),
    // StuartMD Organic Memory & Chat Archive (M5)
    session_create: (title, workspaceRoot, documentId, documentPath) =>
      invoke("stuart_session_create_document", { title, workspaceRoot: workspaceRoot || null, documentId: documentId || null, documentPath: documentPath || null }),
    session_list: () => invoke("stuart_session_list"),
    session_get_messages: (sessionId) => invoke("stuart_session_get_messages", { sessionId }),
    session_rebind: (sessionId, documentId) => invoke("stuart_session_rebind", { sessionId, documentId }),
    session_open_document: sessionId => invoke("stuart_session_open_document", { sessionId }),
    session_add_message: (msg) => invoke("stuart_session_add_message", { msg }),
    session_delete: (sessionId) => invoke("stuart_session_delete", { sessionId }),
    session_search: (query, limit) => invoke("stuart_session_search", { query, limit: limit || 20 }),
    organic_memory_upsert: (item) => invoke("stuart_organic_memory_upsert", { item }),
    organic_memory_list: (tier) => invoke("stuart_organic_memory_list", { tier: tier == null ? null : tier }),
    organic_memory_evolve: () => invoke("stuart_organic_memory_evolve"),
    organic_memory_search: (query, limit) => invoke("stuart_organic_memory_search", { query, limit: limit ?? 20 }),
    organic_memory_delete: (memoryId) => invoke("stuart_organic_memory_delete", { memoryId }),
    organic_memory_effective: (workspaceId, documentId) => invoke("stuart_organic_memory_effective", { workspaceId: workspaceId || null, documentId: documentId || null }),
    // Event listener helper
    listen_event: (event, handler) => {
      if (window.__TAURI__?.event?.listen) {
        return window.__TAURI__.event.listen(event, handler);
      }
      throw new Error("Tauri事件接口不可用");
    },

    open_file_dialog: async () => {
      const result = await invoke("stuart_dialog_open_file");
      if (result.error) throw new Error(result.error);
      if (result.cancelled) return null;
      if (!result.path) throw new Error("系统文件对话框没有返回文件路径");
      return api.read_file(result.path);
    },

    open_folder_dialog: async () => {
      const result = await invoke("stuart_dialog_open_folder");
      if (result.error) throw new Error(result.error);
      if (result.cancelled) return null;
      if (!result.path) throw new Error("系统目录对话框没有返回目录路径");
      return result.path;
    },

    export_html: (request) => invoke("stuart_export_html", { request }),
  };

  api.choose_save_path = async suggested => {
    const result = await invoke("stuart_dialog_save_file", { defaultName: suggested || "未命名.md" });
    if (result.error) throw new Error(result.error);
    return result.cancelled ? null : result.path;
  };

  window.pywebview = window.pywebview || {};
  window.pywebview.api = api;
  setTimeout(() => {
    window.dispatchEvent(new Event("pywebviewready"));
  }, 0);
})();
