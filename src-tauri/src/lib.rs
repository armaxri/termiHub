mod commands;
mod connection;
mod files;
mod terminal;
mod utils;

use tauri::Manager;

use connection::manager::ConnectionManager;
use files::sftp::SftpManager;
use terminal::manager::TerminalManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(TerminalManager::new())
        .manage(SftpManager::new())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use objc2_foundation::{NSString, NSUserDefaults};
                let defaults = NSUserDefaults::standardUserDefaults();
                defaults.setBool_forKey(false, &NSString::from_str("ApplePressAndHoldEnabled"));
            }

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
            commands::files::sftp_open,
            commands::files::sftp_close,
            commands::files::sftp_list_dir,
            commands::files::sftp_download,
            commands::files::sftp_upload,
            commands::files::sftp_mkdir,
            commands::files::sftp_delete,
            commands::files::sftp_rename,
            commands::files::local_list_dir,
            commands::files::local_mkdir,
            commands::files::local_delete,
            commands::files::local_rename,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
