mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::save_diagram,
            commands::load_diagram,
            commands::get_recent_files,
            commands::open_file_dialog,
            commands::save_file_dialog,
            commands::save_llm_settings,
            commands::load_llm_settings,
            commands::llm_chat,
            commands::event_log_begin_run,
            commands::event_log_append,
            commands::event_log_tail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
