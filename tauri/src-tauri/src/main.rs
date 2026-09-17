// StuartMD Tauri shell
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs_api;
mod win_api;

use tauri::Manager;

fn main() {
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
            fs_api::stuart_read_dir_tree,
            fs_api::stuart_open_in_new_window,
            fs_api::stuart_open_url,
            fs_api::stuart_list_plugins,
            fs_api::stuart_read_plugin_source,
            fs_api::stuart_import_wallpaper,
            fs_api::stuart_get_wallpaper,
            fs_api::stuart_open_welcome,
            fs_api::stuart_file_exists,
            win_api::stuart_open_data_dir,
            win_api::stuart_open_sample,
            win_api::stuart_resolve_asset,
            win_api::stuart_open_plugins_dir,
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
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("StuartMD");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running StuartMD");
}
