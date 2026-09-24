// StuartMD Tauri shell
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_api;
mod ai_chat;
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs_api::stuart_get_app_info,
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
            win_api::stuart_capture_window,
            win_api::stuart_apply_window_state,
            win_api::stuart_exit_app,
            // AI / memory / tool surface (medium-term)
            ai_api::stuart_get_capabilities,
            ai_api::stuart_ai_home,
            ai_api::stuart_memory_list,
            ai_api::stuart_memory_get,
            ai_api::stuart_memory_set,
            ai_api::stuart_memory_delete,
            ai_api::stuart_search_md,
            ai_api::stuart_workspace_files,
            // AI chat / explain (3.0.0)
            ai_chat::stuart_ai_get_config,
            ai_chat::stuart_ai_save_config,
            ai_chat::stuart_ai_set_api_key,
            ai_chat::stuart_ai_clear_api_key,
            ai_chat::stuart_ai_test_provider,
            ai_chat::stuart_ai_chat_start,
            ai_chat::stuart_ai_chat_cancel,
            // StuartMD RAG Knowledge Engine (M1 + M2)
            rag_ipc::stuart_rag_set_workspace,
            rag_ipc::stuart_rag_query,
            rag_ipc::stuart_rag_get_status,
            rag_ipc::stuart_rag_sync_workspace,
            rag_ipc::stuart_rag_cancel_sync,
            // StuartMD Diff Gatekeeper (M4)
            security::diff_guard::stuart_companion_preview_diff,
            security::diff_guard::stuart_companion_apply_diff,
            security::diff_guard::stuart_companion_save_note,
            // StuartMD Context Pyramid & Budgeting Engine (M3)
            context::stuart_context_assemble,
            // StuartMD Organic Memory & Chat Archive (M5)
            memory::stuart_session_create,
            memory::stuart_session_list,
            memory::stuart_session_get_messages,
            memory::stuart_session_add_message,
            memory::stuart_session_delete,
            memory::stuart_session_search,
            memory::stuart_organic_memory_upsert,
            memory::stuart_organic_memory_list,
            memory::stuart_organic_memory_evolve,
        ])
        .manage(rag::RagState::new())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("stuart-window-close-requested", ());
            }
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("StuartMD");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running StuartMD");
}
