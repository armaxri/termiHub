mod commands;
mod connection;
mod files;
mod monitoring;
mod terminal;
mod utils;

use std::sync::Arc;

use tauri::Manager;

use connection::manager::ConnectionManager;
use files::sftp::SftpManager;
use monitoring::MonitoringManager;
use terminal::agent_manager::AgentConnectionManager;
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
        .manage(MonitoringManager::new())
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

            let agent_manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));
            app.manage(agent_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::terminal::create_terminal,
            commands::terminal::send_input,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::list_available_shells,
            commands::terminal::get_default_shell,
            commands::terminal::list_serial_ports,
            commands::terminal::check_x11_available,
            commands::terminal::check_ssh_agent_status,
            commands::connection::load_connections_and_folders,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::connection::save_folder,
            commands::connection::delete_folder,
            commands::connection::export_connections,
            commands::connection::import_connections,
            commands::connection::get_settings,
            commands::connection::save_settings,
            commands::connection::save_external_file,
            commands::connection::reload_external_connections,
            commands::connection::save_remote_agent,
            commands::connection::delete_remote_agent,
            commands::files::sftp_open,
            commands::files::sftp_close,
            commands::files::sftp_list_dir,
            commands::files::sftp_download,
            commands::files::sftp_upload,
            commands::files::sftp_mkdir,
            commands::files::sftp_delete,
            commands::files::sftp_rename,
            commands::files::get_home_dir,
            commands::files::local_list_dir,
            commands::files::local_mkdir,
            commands::files::local_delete,
            commands::files::local_rename,
            commands::files::local_read_file,
            commands::files::local_write_file,
            commands::files::sftp_read_file_content,
            commands::files::sftp_write_file_content,
            commands::files::vscode_available,
            commands::files::vscode_open_local,
            commands::files::vscode_open_remote,
            commands::monitoring::monitoring_open,
            commands::monitoring::monitoring_close,
            commands::monitoring::monitoring_fetch_stats,
            commands::agent::connect_agent,
            commands::agent::disconnect_agent,
            commands::agent::get_agent_capabilities,
            commands::agent::list_agent_sessions,
            commands::agent::list_agent_definitions,
            commands::agent::save_agent_definition,
            commands::agent::delete_agent_definition,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
