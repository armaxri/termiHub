mod commands;
mod connection;
mod terminal;
mod utils;

use tauri::Manager;

use connection::manager::ConnectionManager;
use terminal::manager::TerminalManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(TerminalManager::new())
        .setup(|app| {
            let connection_manager = ConnectionManager::new(app.handle())
                .expect("Failed to initialize connection manager");
            app.manage(connection_manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_terminal,
            commands::terminal::send_input,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::list_available_shells,
            commands::terminal::list_serial_ports,
            commands::connection::load_connections_and_folders,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::connection::save_folder,
            commands::connection::delete_folder,
            commands::connection::export_connections,
            commands::connection::import_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
