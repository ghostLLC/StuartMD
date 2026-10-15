// StuartMD 原生窗口与命令注册
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_api;
mod ai_chat;
mod ai;
mod app_runtime;
mod document;
mod fs_api;
mod win_api;
mod rag;
mod rag_ipc;
mod security;
mod context;
mod memory;

use tauri::{Emitter, Manager};

fn parse_startup_file() -> Option<String> {
    for a in std::env::args().skip(1) {
        if a.starts_with('-') {
            continue;
        }
        let p = std::path::PathBuf::from(&a);
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

fn main() {
    let startup = parse_startup_file();
    fs_api::set_startup_file(startup);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let path = args.into_iter().skip(1).find(|argument| !argument.starts_with('-')).map(|argument| {
                let path = std::path::PathBuf::from(argument);
                if path.is_absolute() { path } else { std::path::PathBuf::from(cwd).join(path) }
            }).map(|path| path.to_string_lossy().into_owned());
            app_runtime::create_document_window(app, path).expect("创建关联文档窗口失败");
        }))
        .manage(app_runtime::AppRuntime::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs_api::stuart_get_app_info,
            fs_api::document_read,
            fs_api::pdf_document_snapshot,
            fs_api::document_new,
            fs_api::document_release,
            fs_api::document_confirm_encoding,
            fs_api::document_encoding_preview,
            fs_api::document_target_revision,
            fs_api::save_document,
            fs_api::journal_write,
            fs_api::journal_list,
            fs_api::journal_read,
            fs_api::journal_restore,
            fs_api::journal_discard,
            fs_api::journal_flush,
            fs_api::journal_import_legacy,
            fs_api::save_operations_list,
            fs_api::save_operation_read,
            fs_api::save_operation_copy,
            fs_api::stuart_get_settings,
            fs_api::stuart_save_settings,
            fs_api::stuart_read_file,
            fs_api::stuart_write_file,
            fs_api::stuart_read_pdf,
            fs_api::stuart_read_pdf_binary,
            fs_api::stuart_read_dir_tree,
            fs_api::stuart_get_recents,
            fs_api::stuart_open_path,
            fs_api::stuart_open_in_new_window,
            fs_api::stuart_open_new_window,
            fs_api::stuart_open_url,
            fs_api::stuart_list_plugins,
            fs_api::stuart_read_plugin_source,
            fs_api::stuart_set_plugin_enabled,
            fs_api::stuart_import_wallpaper,
            fs_api::stuart_get_wallpaper,
            fs_api::stuart_clear_wallpaper,
            fs_api::stuart_export_html,
            fs_api::stuart_open_welcome,
            fs_api::stuart_file_exists,
            // 系统对话框选择路径后记录当前窗口的访问授权
            fs_api::stuart_register_allowed_path,
            fs_api::stuart_dialog_open_file,
            fs_api::stuart_dialog_save_file,
            fs_api::stuart_dialog_open_folder,
            fs_api::stuart_save_draft,
            fs_api::stuart_clear_draft,
            win_api::stuart_open_data_dir,
            win_api::stuart_open_sample,
            win_api::stuart_resolve_asset,
            win_api::stuart_open_plugins_dir,
            win_api::stuart_reveal_in_explorer,
            win_api::stuart_open_default_apps_settings,
            win_api::stuart_get_file_association_status,
            win_api::stuart_register_file_association,
            win_api::stuart_check_update,
            win_api::stuart_import_wallpaper_ex,
            win_api::stuart_load_annotations,
            win_api::stuart_save_annotations,
            win_api::stuart_add_annotation,
            win_api::stuart_delete_annotation,
            win_api::stuart_clear_annotations,
            win_api::stuart_export_pdf_annotations,
            win_api::stuart_edit_pdf_annotations,
            win_api::stuart_restore_pdf_annotations,
            win_api::stuart_capture_window,
            win_api::stuart_apply_window_state,
            win_api::stuart_exit_app,
            // AI 配置与本地资料
            ai_api::stuart_get_capabilities,
            ai_api::stuart_ai_home,
            ai_api::stuart_memory_list,
            ai_api::stuart_memory_get,
            ai_api::stuart_memory_set,
            ai_api::stuart_memory_delete,
            ai_api::stuart_search_md,
            ai_api::stuart_workspace_files,
            // AI 请求
            ai_chat::stuart_ai_get_config,
            ai::model_validation::stuart_ai_discover_models,
            ai::model_validation::stuart_ai_verify_model,
            ai_chat::stuart_ai_update_config,
            ai_chat::stuart_ai_set_api_key,
            ai_chat::stuart_ai_clear_api_key,
            ai::stuart_ai_request_start,
            ai::stuart_ai_request_cancel,
            ai::stuart_ai_request_status,
            ai::companion::stuart_companion_get_target,
            ai::companion::stuart_companion_prepare_context,
            ai::companion::stuart_companion_send_question,
            ai::companion::stuart_companion_preview_source,
            ai::companion::stuart_companion_get_source,
            ai::companion::stuart_companion_workspace_status,
            ai::companion::stuart_companion_learn_request,
            ai::companion::stuart_companion_delete_session,
            app_runtime::stuart_close_window,
            // 知识索引与查询
            rag_ipc::stuart_rag_set_workspace,
            rag_ipc::stuart_rag_query,
            rag_ipc::stuart_rag_get_status,
            rag_ipc::stuart_rag_sync_workspace,
            rag_ipc::stuart_rag_cancel_sync,
            rag_ipc::stuart_rag_set_model,
            rag_ipc::stuart_pdf_context,
            // 文档修改审核
            security::diff_guard::stuart_companion_preview_diff,
            security::diff_guard::stuart_companion_apply_diff,
            security::diff_guard::stuart_companion_save_note,
            // 上下文预算
            context::stuart_context_assemble,
            // 会话与记忆
            memory::stuart_session_create,
            memory::stuart_session_list,
            memory::stuart_session_get_messages,
            memory::stuart_session_add_message,
            memory::stuart_session_delete,
            memory::stuart_session_search,
            memory::stuart_organic_memory_upsert,
            memory::stuart_organic_memory_list,
            memory::stuart_organic_memory_evolve,
            memory::stuart_session_create_document,
            memory::stuart_session_rebind,
            memory::stuart_session_open_document,
            memory::stuart_organic_memory_search,
            memory::stuart_organic_memory_delete,
            memory::stuart_organic_memory_effective,
            memory::stuart_companion_get_conversation,
            memory::stuart_companion_save_draft,
            memory::stuart_companion_list_sessions,
            memory::stuart_companion_rename_session,
            memory::stuart_companion_list_memories,
            memory::stuart_companion_save_memory,
            memory::stuart_companion_delete_memory,
            memory::stuart_companion_create_memory_proposal,
            memory::stuart_companion_list_memory_proposals,
            memory::stuart_companion_update_memory_proposal,
            memory::stuart_companion_confirm_memory,
            memory::stuart_companion_get_memory_source,
            memory::stuart_companion_get_memory_versions,
        ])
        .manage(rag::RagState::new())
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    window.emit("stuart-window-close-requested", ()).expect("发送窗口关闭请求失败");
                }
                tauri::WindowEvent::Destroyed => {
                    crate::ai::cancel_window(window.label());
                    if let Some(service) = window.app_handle().try_state::<document::DocumentService>() {
                        service.release_window(window.label()).expect("保存窗口文档草稿失败");
                    }
                    window.app_handle().state::<app_runtime::AppRuntime>().remove(window.label());
                    window.app_handle().state::<rag::RagState>().window_workspaces.write().expect("窗口知识目录记录锁损坏").remove(window.label());
                }
                _ => {}
            }
        })
        .setup(|app| {
            crate::context::model_spec::initialize_resource_directory(app.path().resource_dir()?.join("tokenizers"))?;
            crate::rag::embedding::initialize_runtime(app.path().resource_dir()?.join("native"))?;
            app.state::<app_runtime::AppRuntime>().register("main", fs_api::startup_file());
            app.manage(document::DocumentService::new(fs_api::data_dir())?);
            memory::get_archive_storage()?.recover_interrupted_operations()?;
            if let Some(w) = app.get_webview_window("main") {
                w.set_title("StuartMD")?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running StuartMD");
}
