mod commands;
mod terminal;
mod utils;

use terminal::manager::TerminalManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(TerminalManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_terminal,
            commands::terminal::send_input,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::list_available_shells,
            commands::terminal::list_serial_ports,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
