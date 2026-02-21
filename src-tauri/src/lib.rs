mod commands;
mod connection;
mod credential;
mod files;
mod monitoring;
mod terminal;
mod tunnel;
mod utils;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tracing::info;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use connection::manager::ConnectionManager;
use connection::settings::SettingsStorage;
use credential::{CredentialManager, StorageMode};
use files::sftp::SftpManager;
use monitoring::MonitoringManager;
use terminal::agent_manager::AgentConnectionManager;
use terminal::manager::TerminalManager;
use utils::log_capture::{create_log_buffer, LogCaptureLayer};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_buffer = create_log_buffer();
    let capture_layer = LogCaptureLayer::new(log_buffer.clone());
    let app_handle_slot = capture_layer.app_handle_slot();

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(capture_layer)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(TerminalManager::new())
        .manage(SftpManager::new())
        .manage(MonitoringManager::new())
        .manage(log_buffer)
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                use objc2_foundation::{NSString, NSUserDefaults};
                let defaults = NSUserDefaults::standardUserDefaults();
                defaults.setBool_forKey(false, &NSString::from_str("ApplePressAndHoldEnabled"));
            }

            // Inject AppHandle into the log capture layer so it can emit events
            if let Ok(mut handle) = app_handle_slot.lock() {
                *handle = Some(app.handle().clone());
            }

            // Load settings to determine the credential storage mode
            let config_dir = match std::env::var("TERMIHUB_CONFIG_DIR") {
                Ok(dir) => std::path::PathBuf::from(dir),
                Err(_) => app
                    .handle()
                    .path()
                    .app_config_dir()
                    .expect("Failed to resolve app config directory"),
            };
            std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");

            let settings_storage =
                SettingsStorage::new(app.handle()).expect("Failed to initialize settings storage");
            let settings = settings_storage.load().expect("Failed to load settings");

            let storage_mode =
                StorageMode::from_settings_str(settings.credential_storage_mode.as_deref());
            info!(
                mode = storage_mode.to_settings_str(),
                "Initializing credential store"
            );

            let credential_manager = CredentialManager::new(storage_mode.clone(), config_dir);

            // If master password mode with an existing credentials file,
            // the store starts locked — emit an event so the UI can prompt
            let needs_locked_event = storage_mode == StorageMode::MasterPassword
                && credential_manager
                    .with_master_password_store(|s| s.has_credentials_file())
                    .unwrap_or(false);

            let credential_manager = Arc::new(credential_manager);
            let connection_manager = ConnectionManager::new(
                app.handle(),
                credential_manager.clone() as Arc<dyn credential::CredentialStore>,
            )
            .expect("Failed to initialize connection manager");
            app.manage(credential_manager.clone());
            app.manage(connection_manager);

            if needs_locked_event {
                let handle = app.handle().clone();
                // Emit after setup is complete so the frontend can receive it
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = handle.emit("credential-store-locked", ());
                });
            }

            let agent_manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));
            app.manage(agent_manager);

            let tunnel_manager = tunnel::tunnel_manager::TunnelManager::new(app.handle())
                .expect("Failed to initialize tunnel manager");

            // Auto-start tunnels in a background thread to avoid blocking app startup
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Wait briefly for the manager to be registered as state
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if let Some(mgr) = handle.try_state::<tunnel::tunnel_manager::TunnelManager>() {
                        mgr.start_auto_tunnels();
                    }
                });
            }

            app.manage(tunnel_manager);

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
            commands::terminal::check_docker_available,
            commands::terminal::list_docker_images,
            commands::terminal::validate_ssh_key,
            commands::connection::load_connections_and_folders,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::connection::save_folder,
            commands::connection::delete_folder,
            commands::connection::export_connections,
            commands::connection::import_connections,
            commands::connection::get_settings,
            commands::connection::save_settings,
            commands::connection::move_connection_to_file,
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
            commands::agent::shutdown_agent,
            commands::agent::get_agent_capabilities,
            commands::agent::list_agent_sessions,
            commands::agent::list_agent_definitions,
            commands::agent::save_agent_definition,
            commands::agent::delete_agent_definition,
            commands::agent::setup_remote_agent,
            commands::agent::probe_remote_agent,
            commands::agent::deploy_agent,
            commands::agent::update_agent,
            commands::logs::get_logs,
            commands::logs::clear_logs,
            commands::tunnel::get_tunnels,
            commands::tunnel::save_tunnel,
            commands::tunnel::delete_tunnel,
            commands::tunnel::get_tunnel_statuses,
            commands::tunnel::start_tunnel,
            commands::tunnel::stop_tunnel,
            commands::credential::get_credential_store_status,
            commands::credential::unlock_credential_store,
            commands::credential::lock_credential_store,
            commands::credential::setup_master_password,
            commands::credential::change_master_password,
            commands::credential::switch_credential_store,
            commands::credential::check_keychain_available,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::WindowEvent {
                event: WindowEvent::Destroyed,
                ..
            } = &event
            {
                // Gracefully stop all active tunnels on window close
                if let Some(mgr) = app_handle.try_state::<tunnel::tunnel_manager::TunnelManager>() {
                    mgr.stop_all();
                }
            }
        });
}
