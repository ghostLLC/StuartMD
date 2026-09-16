// StuartMD Tauri shell — P2 scaffold (not default product launcher)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fs_api;

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
            fs_api::stuart_check_update,
            fs_api::stuart_list_plugins,
            fs_api::stuart_read_plugin_source,
            fs_api::stuart_import_wallpaper,
            fs_api::stuart_get_wallpaper,
            fs_api::stuart_open_welcome,
            fs_api::stuart_file_exists,
        ])
        .setup(|app| {
            // Keep window title consistent with pywebview build
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("StuartMD");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running StuartMD Tauri shell");
}
