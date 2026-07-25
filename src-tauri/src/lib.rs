mod commands;
mod connection;
mod credential;
mod embedded_servers;
/// File-system access: local FS, SFTP sessions, and the cancellable transfer
/// subsystem (public so integration tests can drive `SftpSession` /
/// `TransferRegistry` directly — issue #1245).
pub mod files;
/// Native Linux X11 `CLIPBOARD`-selection binding for pasting remote-copied RDP
/// clipboard files into local apps with delayed rendering (`text/uri-list`) —
/// the X11 `CLIPBOARD` owner (#1815) plus the native-Wayland `wlr-data-control`
/// data source (#1847). Linux-only.
#[cfg(target_os = "linux")]
mod linux_clipboard;
/// Native macOS `NSPasteboard` binding for pasting remote-copied RDP clipboard
/// files into local apps with delayed rendering (#1804). macOS-only.
#[cfg(target_os = "macos")]
mod macos_clipboard;
/// Native macOS Services provider wiring the app-level "Open in termiHub"
/// Services-menu entry (#1409). macOS-only.
#[cfg(target_os = "macos")]
mod macos_services;
mod macros;
mod network;
mod session;
mod session_history;
mod spawn;
mod terminal;
mod tunnel;
mod utils;
/// Multi-window foundation (#1900): window creation/labelling, the
/// `session_id → owning_window` ownership map, and the tab hand-off queue.
mod window;
/// Native Windows clipboard binding for pasting remote-copied RDP clipboard files
/// into local apps with delayed rendering (`CF_HDROP`, #1814). Windows-only.
#[cfg(windows)]
mod windows_clipboard;
mod workflows;
mod workspace;

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tracing::{info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

use connection::manager::ConnectionManager;
use connection::recovery::RecoveryWarning;
use connection::settings::{AppSettings, SettingsStorage};
use credential::{AutoLockTimer, CredentialManager, StorageMode};
use files::sftp::SftpManager;
use files::transfer::TransferRegistry;
use network::NetworkManager;
use session::manager::SessionManager;
use session::registry::build_desktop_registry;
use terminal::agent_manager::{AgentConnectionManager, AgentRpcClient};
use utils::file_log;
use utils::log_capture::{create_log_buffer, default_env_filter, LogCaptureLayer};

/// Build the shared X server lifecycle manager (issue #1049).
///
/// On Windows it provides a managed VcXsrv instance; on other platforms it is a
/// report-only no-op that adopts the system's existing X server. The default
/// policy is to stop the managed server once the last X11 session closes.
///
/// The managed-server binary resolver returns the winget-installed `vcxsrv.exe`
/// at its canonical location (#1318). Adoption of an already-running X server
/// works on any platform; spawning a managed server is Windows-only (`cfg!(windows)`),
/// and if VcXsrv isn't installed the resolver surfaces a clear error pointing the
/// user at the X Servers panel to install it via winget.
///
/// The cookie provider (#1050) writes `.Xauthority` files under a temp
/// subdirectory; the files are ephemeral, regenerated per server start and
/// removed on stop.
fn build_xserver_manager() -> terminal::xserver::XServerManager {
    use terminal::xserver::auth::FileXAuthProvider;
    use terminal::xserver::manager::{CommandLauncher, TcpPortProbe};

    let auth_dir = std::env::temp_dir().join("termihub-xserver");

    terminal::xserver::XServerManager::new(
        Box::new(TcpPortProbe),
        Box::new(CommandLauncher),
        Box::new(terminal::xserver::windows::resolve_vcxsrv_path),
        Box::new(FileXAuthProvider::new(auth_dir)),
        cfg!(windows),
        true,
    )
}

/// Handle a `termiHub spawn ...` invocation detected from the raw process
/// arguments before Tauri initialises (#1364).
///
/// A `--new-window` request always launches a fresh instance; otherwise the
/// request is forwarded to an already-running instance over the per-user IPC
/// rendezvous. On a successful forward the process exits. If no instance is
/// reachable (or the endpoint cannot be resolved), the request is returned so
/// the caller can launch as the running instance and handle it in `setup()`.
fn handle_spawn_command(request: spawn::SpawnRequest) -> Option<spawn::SpawnRequest> {
    if request.new_window {
        return Some(request);
    }

    let endpoint = match spawn::SpawnEndpoint::for_current_user() {
        Ok(endpoint) => endpoint,
        Err(e) => {
            eprintln!("Could not resolve spawn endpoint: {e}");
            return Some(request);
        }
    };

    match spawn::forward_to_running_instance(&endpoint, &request) {
        Ok(_response) => std::process::exit(0),
        Err(_) => Some(request),
    }
}

/// Handle the pre-init `install-shell-integration` / `uninstall-shell-integration`
/// subcommands (#1368). Loads the persisted shell-integration settings without a
/// Tauri `AppHandle`, applies the OS context-menu (un)registration, persists the
/// updated registration facts, and exits. Never returns — the process terminates
/// with a status code reflecting success or failure.
fn handle_shell_integration_command(install: bool) -> ! {
    let result = (|| -> anyhow::Result<()> {
        let storage = connection::settings::SettingsStorage::new_standalone()?;
        let mut settings = storage.load_with_recovery()?.data;
        if install {
            spawn::registry::register(&mut settings.shell_integration)?;
        } else {
            spawn::registry::unregister(&mut settings.shell_integration)?;
        }
        storage.save(&settings)
    })();

    match result {
        Ok(()) => {
            let action = if install { "installed" } else { "removed" };
            println!("Shell integration {action}.");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("Shell integration command failed: {e:#}");
            std::process::exit(1);
        }
    }
}

/// Run app-wide teardown (tunnels, embedded/X servers, HTTP monitors,
/// transfers, SFTP) when the app is actually going away.
///
/// Spawned off the event-loop thread: calling `emit()` (or otherwise re-entering
/// Tauri) directly inside a `RunEvent` handler re-borrows a `RefCell` Tauri
/// already holds mutably and panics, so the cleanup runs on the async runtime.
///
/// Invoked when the last window closes on Windows/Linux, and on an explicit quit
/// on macOS (where last-window-close instead keeps the app alive) — see the
/// per-OS policy in [`window::should_teardown_on_last_window`] /
/// [`window::should_prevent_exit`] (#1903).
fn run_app_teardown(app_handle: &tauri::AppHandle) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(mgr) = handle.try_state::<Arc<tunnel::tunnel_manager::TunnelManager>>() {
            mgr.stop_all();
        }
        if let Some(mgr) =
            handle.try_state::<embedded_servers::server_manager::EmbeddedServerManager>()
        {
            mgr.stop_all();
        }
        // Stop the managed X server so no orphan vcxsrv.exe is left behind
        // (issue #1049). Adopted external servers are untouched.
        if let Some(mgr) = handle.try_state::<Arc<terminal::xserver::XServerManager>>() {
            mgr.stop();
        }
        // Cancel all HTTP monitor poll loops so in-flight reqwest requests are
        // aborted rather than abandoned on exit (#1147).
        if let Some(mgr) = handle.try_state::<NetworkManager>() {
            mgr.stop_all_http_monitors();
        }
        // Cancel every in-flight transfer *before* closing sessions, so no
        // half-written file keeps a dedicated channel open during teardown
        // (#1245).
        if let Some(reg) = handle.try_state::<TransferRegistry>() {
            reg.cancel_all();
        }
        // Close every open SFTP session so no SSH+SFTP connection is left
        // dangling on the server until it times out (#1244).
        if let Some(mgr) = handle.try_state::<SftpManager>() {
            mgr.close_all();
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-init CLI routing: `spawn` / `(un)install-shell-integration` must be
    // handled from the raw args before the Tauri window is created, since
    // `cli().matches()` is only available inside `setup()` (#1364). A spawn
    // request this instance must handle itself (no running instance accepted
    // the forward) is threaded into `setup()` via `pending_spawn`.
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let pending_spawn = match spawn::classify_command(&raw_args) {
        spawn::Command::Spawn(request) => handle_spawn_command(request),
        spawn::Command::InstallShellIntegration => handle_shell_integration_command(true),
        spawn::Command::UninstallShellIntegration => handle_shell_integration_command(false),
        spawn::Command::None => None,
    };

    let log_buffer = create_log_buffer();
    let capture_layer = LogCaptureLayer::new(log_buffer.clone());
    let app_handle_slot = capture_layer.app_handle_slot();

    // Durable application log (#1570). A bundled desktop app has nowhere for the
    // `fmt` layer's stdout to go and the ring buffer dies with the process, so
    // without this sink the app leaves no evidence of what it was doing. Kept
    // best-effort: an unwritable log directory must never stop the app booting,
    // so the failure is recorded and startup continues.
    let (file_layer, file_log_status) = match file_log::RotatingLogFile::with_defaults() {
        Ok(writer) => (
            Some(
                tracing_subscriber::fmt::layer()
                    // No terminal on the other end of a file: escape codes would
                    // just make it unreadable.
                    .with_ansi(false)
                    .with_writer(writer)
                    .with_filter(file_log::file_env_filter()),
            ),
            Ok(()),
        ),
        Err(e) => (None, Err(e)),
    };

    tracing_subscriber::registry()
        .with(default_env_filter())
        .with(tracing_subscriber::fmt::layer())
        .with(capture_layer)
        .with(file_layer)
        .init();

    // The first lines of every run: they mark the run boundary in an appended
    // file and record the version a later post-mortem will need.
    match (&file_log_status, file_log::log_file_path()) {
        (Ok(()), Some(path)) => info!(
            version = env!("CARGO_PKG_VERSION"),
            pid = std::process::id(),
            log_file = %path.display(),
            "termiHub starting"
        ),
        (Err(e), _) => {
            info!(
                version = env!("CARGO_PKG_VERSION"),
                pid = std::process::id(),
                "termiHub starting"
            );
            warn!("Application log file unavailable, logging to memory only: {e}");
        }
        (Ok(()), None) => unreachable!("the writer opened, so a log path resolves"),
    }

    // Shared X server manager (#1049), held as an `Arc` so the provisioner
    // (#1052) and the Tauri commands can both reference the same instance.
    let x_server_manager = Arc::new(build_xserver_manager());

    // Registry routing connect-time X server download-consent replies (#1116)
    // from the `x_server_connect_consent_reply` command back to the paused
    // connect. Shared between that command and the provisioner.
    let x_server_consent_registry = Arc::new(terminal::xserver::ConnectConsentRegistry::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_cli::init())
        .manage(SftpManager::new())
        .manage(TransferRegistry::new())
        .manage(files::watcher::FileWatchManager::new())
        .manage(NetworkManager::new())
        .manage(x_server_manager.clone())
        .manage(x_server_consent_registry.clone())
        .manage(spawn::handler::PendingSpawn::default())
        .manage(window::WindowManager::new())
        .manage(commands::connection_path::ProbeRegistry::default())
        .manage(commands::local_process::LocalProcessRegistry::default())
        .manage(crate::terminal::agent_cancel::AgentDeployCancellation::default())
        .manage(log_buffer);

    // In test mode (TERMIHUB_TEST_BRIDGE_PORT set), inject the bridge globals into
    // the webview before boot so the in-app WebSocket client connects out to the
    // runner — the cross-platform test transport (issue #801). No-op otherwise.
    if let Some(plugin) = utils::test_bridge::test_bridge_plugin() {
        info!("Test bridge WebSocket transport enabled");
        builder = builder.plugin(plugin);
    }

    builder
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                use objc2_foundation::{NSString, NSUserDefaults};
                let defaults = NSUserDefaults::standardUserDefaults();
                defaults.setBool_forKey(false, &NSString::from_str("ApplePressAndHoldEnabled"));

                // Register the native Cocoa Services provider so the app-level
                // "Open in termiHub" Services-menu entry (declared in Info.plist
                // by #1369) actually opens a session at the selected path (#1409).
                // Best-effort: a failure leaves the entry inert but never blocks
                // startup. The per-entry Automator Quick Action bundles remain
                // the primary, self-contained path.
                if let Err(e) = macos_services::register(app.handle().clone()) {
                    tracing::warn!("could not register macOS Services provider: {e}");
                }
            }

            // Inject AppHandle into the log capture layer so it can emit events
            if let Ok(mut handle) = app_handle_slot.lock() {
                *handle = Some(app.handle().clone());
            }

            // In WebSocket test-bridge mode, keep the window above other apps so
            // macOS never marks its webview as fully occluded — full occlusion
            // throttles WKWebView rendering, which hangs the harness (xterm stops
            // painting, screenshots time out) once a guided-manual test hands off
            // to an external app like VS Code (#957). Best-effort and test-only;
            // production windows are untouched.
            if utils::test_bridge::is_test_bridge_enabled() {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_always_on_top(true) {
                        tracing::warn!("Failed to set test window always-on-top: {e}");
                    } else {
                        info!("Test window pinned always-on-top (anti-occlusion, #957)");
                    }
                }
            }

            let mut recovery_warnings: Vec<RecoveryWarning> = Vec::new();

            // Detect portable mode before any storage initialization.
            // Priority: TERMIHUB_CONFIG_DIR env var > portable mode detection > OS default.
            let app_mode = match utils::portable::detect_app_mode() {
                Ok(mode) => {
                    info!(is_portable = mode.is_portable(), "App mode detected");
                    mode
                }
                Err(e) => {
                    tracing::warn!("Failed to detect app mode, defaulting to installed: {e}");
                    utils::portable::AppMode::Installed
                }
            };

            // If portable mode is active and no explicit override is set, redirect config dir
            // so all storage modules (which check TERMIHUB_CONFIG_DIR) use the portable path.
            if app_mode.is_portable() && std::env::var("TERMIHUB_CONFIG_DIR").is_err() {
                if let Some(data_dir) = app_mode.data_dir() {
                    std::fs::create_dir_all(data_dir).expect("Failed to create portable data directory");
                    // Safety: called before any threads that read env vars are spawned.
                    #[allow(unused_unsafe)]
                    unsafe {
                        std::env::set_var("TERMIHUB_CONFIG_DIR", data_dir);
                    }
                }
            }

            // Store the detected app mode so commands and the frontend can query it.
            app.manage(app_mode);

            // Load settings to determine the credential storage mode.
            // On failure, fall back to defaults so the app can still start.
            // Portable mode already exported `TERMIHUB_CONFIG_DIR` above, so the
            // shared resolver's handle branch yields the correct directory.
            let config_dir = utils::config_paths::resolve_config_dir(Some(app.handle()))
                .expect("Failed to resolve app config directory");
            std::fs::create_dir_all(&config_dir).expect("Failed to create config directory");

            // Capture path for the connections file watcher before config_dir is moved.
            let connections_file = config_dir.join("connections.json");

            // Initialise the network manager with the config dir and app handle.
            if let Some(net_mgr) = app.try_state::<NetworkManager>() {
                // SAFETY: NetworkManager is only initialised once at startup.
                let mgr_ptr = net_mgr.inner() as *const NetworkManager as *mut NetworkManager;
                unsafe { (*mgr_ptr).init(config_dir.clone(), app.handle().clone()) };
            }

            let settings = match SettingsStorage::new(app.handle()) {
                Ok(storage) => match storage.load_with_recovery() {
                    Ok(result) => {
                        recovery_warnings.extend(result.warnings);
                        result.data
                    }
                    Err(e) => {
                        tracing::error!("Failed to load settings with recovery: {e}");
                        recovery_warnings.push(RecoveryWarning {
                            file_name: "settings.json".to_string(),
                            message: "Could not load settings, using defaults.".to_string(),
                            details: Some(e.to_string()),
                        });
                        AppSettings::default()
                    }
                },
                Err(e) => {
                    tracing::error!("Failed to initialize settings storage: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "settings.json".to_string(),
                        message: "Could not initialize settings storage, using defaults."
                            .to_string(),
                        details: Some(e.to_string()),
                    });
                    AppSettings::default()
                }
            };

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
            credential_manager.set_app_handle(app.handle().clone());

            // Set up auto-lock timer for master password mode
            let auto_lock_minutes = settings.credential_auto_lock_minutes.or(Some(15));
            let auto_lock_timer = AutoLockTimer::new(
                app.handle().clone(),
                credential_manager.clone(),
                auto_lock_minutes,
            );
            credential_manager.set_auto_lock_timer(auto_lock_timer);

            // Initialize connection manager with recovery loading.
            // On failure, the app still starts but with no connections.
            match ConnectionManager::new(
                app.handle(),
                credential_manager.clone() as Arc<dyn credential::CredentialStore>,
            ) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());
                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize connection manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "connections.json".to_string(),
                        message: "Could not initialize connection storage. Connections are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }
            app.manage(credential_manager.clone());

            if needs_locked_event {
                let handle = app.handle().clone();
                // Emit after setup is complete so the frontend can receive it
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = handle.emit("credential-store-locked", ());
                });
            }

            let agent_manager: Arc<dyn AgentRpcClient> =
                Arc::new(AgentConnectionManager::new(app.handle().clone()));

            // Build the desktop ConnectionType registry and create the SessionManager.
            let registry = build_desktop_registry();
            let session_manager = SessionManager::new(registry, agent_manager.clone());
            app.manage(session_manager);
            app.manage(agent_manager);

            // Graphical (remote-desktop) session manager. Uses its own copy of
            // the same registry so it can create graphical connections by
            // type_id, independently of the terminal SessionManager. Its RDP
            // certificate trust store (#1767) is persisted in the config dir
            // (portable-aware); a failure to resolve it degrades to in-memory.
            let rdp_trust_store = std::sync::Arc::new(
                match crate::utils::config_paths::resolve_config_dir(Some(app.handle())) {
                    Ok(dir) => crate::session::rdp_trust_store::RdpTrustStore::open(dir),
                    Err(e) => {
                        tracing::warn!(error = %e, "could not resolve config dir for RDP trust store; using in-memory");
                        crate::session::rdp_trust_store::RdpTrustStore::in_memory()
                    }
                },
            );
            let graphical_manager = crate::session::graphical_manager::GraphicalSessionManager::new(
                std::sync::Arc::new(build_desktop_registry()),
                rdp_trust_store,
            );
            app.manage(graphical_manager);

            // SSH host-key verification (#1959): register the process-wide
            // verifier so the core SSH handshake stops blindly accepting host
            // keys. It persists trust-on-first-use decisions to the config dir
            // (portable-aware; in-memory on failure) and prompts the UI via the
            // app handle for unknown or changed keys.
            let ssh_trust_store = std::sync::Arc::new(
                match crate::utils::config_paths::resolve_config_dir(Some(app.handle())) {
                    Ok(dir) => crate::session::ssh_trust_store::SshTrustStore::open(dir),
                    Err(e) => {
                        tracing::warn!(error = %e, "could not resolve config dir for SSH trust store; using in-memory");
                        crate::session::ssh_trust_store::SshTrustStore::in_memory()
                    }
                },
            );
            let ssh_host_key_verifier =
                std::sync::Arc::new(crate::session::ssh_host_key_verifier::SshHostKeyVerifier::new(
                    ssh_trust_store,
                    std::sync::Arc::new(app.handle().clone()),
                ));
            if !termihub_core::backends::ssh::host_key::set_host_key_verifier(
                ssh_host_key_verifier.clone(),
            ) {
                tracing::warn!("SSH host-key verifier was already registered");
            }
            app.manage(ssh_host_key_verifier);

            // X server provisioning (#1052): register the provisioner so the SSH
            // connect path can ensure a local X server before X11 forwarding
            // starts. The manager itself (#1049) is created and managed above.
            terminal::xserver::init(
                app.handle(),
                x_server_manager.clone(),
                x_server_consent_registry.clone(),
            );

            // Initialize tunnel manager with recovery loading.
            // On failure, the app still starts but tunnels are unavailable.
            match tunnel::tunnel_manager::TunnelManager::new(app.handle()) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());

                    // Auto-start tunnels on a blocking-pool thread. The SSH
                    // handshake uses `block_in_place` internally, which needs a
                    // Tokio runtime context — a raw `std::thread` has none and
                    // would abort the process (#828).
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        if let Some(mgr) =
                            handle.try_state::<Arc<tunnel::tunnel_manager::TunnelManager>>()
                        {
                            mgr.start_auto_tunnels();
                        }
                    });

                    app.manage(Arc::new(manager));
                }
                Err(e) => {
                    tracing::error!("Failed to initialize tunnel manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "tunnels.json".to_string(),
                        message: "Could not initialize tunnel storage. Tunnels are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }

            // Initialize workspace manager with recovery loading.
            // On failure, the app still starts but workspaces are unavailable.
            match workspace::manager::WorkspaceManager::new(app.handle()) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());
                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize workspace manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "workspaces.json".to_string(),
                        message: "Could not initialize workspace storage. Workspaces are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }

            // Initialize macro manager with recovery loading.
            // On failure, the app still starts but macros are unavailable.
            match macros::manager::MacroManager::new(app.handle()) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());
                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize macro manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "macros.json".to_string(),
                        message: "Could not initialize macro storage. Macros are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }

            // Initialize the session-history manager with recovery loading.
            // On failure, the app still starts but session history is unavailable.
            match session_history::manager::SessionHistoryManager::new(app.handle()) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());
                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize session-history manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "session-history.json".to_string(),
                        message: "Could not initialize session-history storage. Recent sessions are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }

            // Initialize workflow manager with recovery loading.
            // On failure, the app still starts but workflows are unavailable.
            match workflows::manager::WorkflowManager::new(app.handle()) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());
                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize workflow manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "workflows.json".to_string(),
                        message: "Could not initialize workflow storage. Workflows are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }

            // Initialize the last-session manager. On failure the app still starts;
            // session restore is simply unavailable until the next launch.
            match workspace::last_session::LastSessionManager::new(app.handle()) {
                Ok(manager) => {
                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize last-session manager: {e}");
                }
            }

            // Initialize embedded server manager with recovery loading.
            // On failure, the app still starts but embedded servers are unavailable.
            match embedded_servers::server_manager::EmbeddedServerManager::new(app.handle()) {
                Ok(manager) => {
                    recovery_warnings.extend(manager.take_recovery_warnings());

                    // Auto-start servers in a background thread.
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        if let Some(mgr) = handle
                            .try_state::<embedded_servers::server_manager::EmbeddedServerManager>()
                        {
                            mgr.start_auto_servers();
                        }
                    });

                    app.manage(manager);
                }
                Err(e) => {
                    tracing::error!("Failed to initialize embedded server manager: {e}");
                    recovery_warnings.push(RecoveryWarning {
                        file_name: "embedded_servers.json".to_string(),
                        message: "Could not initialize embedded server storage. Services are unavailable until the app is restarted.".to_string(),
                        details: Some(e.to_string()),
                    });
                }
            }

            // Handle --list-workspaces CLI flag: print workspace list and exit
            {
                use tauri_plugin_cli::CliExt;
                if let Ok(matches) = app.cli().matches() {
                    if let Some(arg) = matches.args.get("list-workspaces") {
                        if arg.occurrences > 0 {
                            if let Some(mgr) =
                                app.try_state::<workspace::manager::WorkspaceManager>()
                            {
                                match mgr.get_workspaces() {
                                    Ok(workspaces) if workspaces.is_empty() => {
                                        println!("No workspaces configured.");
                                    }
                                    Ok(workspaces) => {
                                        for ws in &workspaces {
                                            let desc =
                                                ws.description.as_deref().unwrap_or("");
                                            println!(
                                                "{}\t{}\t{} tab(s)\t{}",
                                                ws.id,
                                                ws.name,
                                                ws.connection_count,
                                                desc
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("Error listing workspaces: {e}");
                                    }
                                }
                            } else {
                                eprintln!("Workspace manager not available.");
                            }
                            std::process::exit(0);
                        }
                    }
                }
            }

            // Start the spawn IPC rendezvous server (#1364). It accepts
            // SpawnRequests from `termiHub spawn` invocations by other processes
            // and re-emits them as a `spawn-request` event for the frontend to
            // act on (session handling itself is out of scope here). Best-effort:
            // if another instance already owns the endpoint, this instance simply
            // isn't the rendezvous and continues normally (multi-instance).
            match spawn::SpawnEndpoint::for_current_user() {
                Ok(endpoint) => {
                    let emit_handle = app.handle().clone();
                    let handler: spawn::SpawnHandler = Arc::new(move |req: spawn::SpawnRequest| {
                        // Focus the window and forward the request to the
                        // frontend (#1365 adds the focus so an external spawn
                        // raises the running instance, for every spawn kind).
                        match spawn::handler::emit_spawn_request(&emit_handle, &req) {
                            Ok(()) => spawn::SpawnResponse::accepted(),
                            Err(e) => {
                                tracing::warn!("failed to emit spawn-request event: {e}");
                                spawn::SpawnResponse::error(format!("emit failed: {e}"))
                            }
                        }
                    });
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = spawn::ipc_server::serve(&endpoint, handler).await {
                            tracing::warn!("spawn IPC server stopped: {e}");
                        }
                    });
                }
                Err(e) => tracing::warn!("could not start spawn IPC server: {e}"),
            }

            // Process a spawn request this instance launched to handle itself
            // (no running instance accepted the pre-init forward). On cold start
            // the frontend listener is not registered yet, so an event would be
            // lost — park the request and focus the window; the frontend drains
            // it via `take_pending_spawn` once its subscription is ready (#1365).
            if let Some(req) = pending_spawn {
                spawn::handler::store_pending_spawn(
                    app.handle(),
                    &app.state::<spawn::handler::PendingSpawn>(),
                    req,
                );
            }

            // Store recovery warnings so the frontend can retrieve them
            app.manage(Mutex::new(recovery_warnings));

            // Watch connections.json for changes made by other running instances.
            // Each instance polls independently; when any instance writes the file,
            // all others detect the mtime change and reload within ~1 second.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use std::time::SystemTime;
                    let mut last_mtime: Option<SystemTime> = std::fs::metadata(&connections_file)
                        .ok()
                        .and_then(|m| m.modified().ok());
                    let mut interval =
                        tokio::time::interval(std::time::Duration::from_secs(1));
                    interval
                        .set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    loop {
                        interval.tick().await;
                        let current_mtime = std::fs::metadata(&connections_file)
                            .ok()
                            .and_then(|m| m.modified().ok());
                        if current_mtime != last_mtime && current_mtime.is_some() {
                            last_mtime = current_mtime;
                            let _ = handle.emit("connections-changed", ());
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Remote-desktop (graphical) commands — protocol-blind (#1680)
            commands::remote_desktop::remote_desktop_connect,
            commands::remote_desktop::remote_desktop_resize,
            commands::remote_desktop::remote_desktop_request_full_frame,
            commands::remote_desktop::remote_desktop_send_input,
            commands::remote_desktop::remote_desktop_send_clipboard,
            commands::remote_desktop::remote_desktop_get_clipboard,
            commands::remote_desktop::remote_desktop_remote_clipboard_files,
            commands::remote_desktop::remote_desktop_bind_clipboard_files,
            commands::remote_desktop::remote_desktop_cert_decision,
            commands::remote_desktop::remote_desktop_disconnect,
            commands::remote_desktop::rdp_trust_list,
            commands::remote_desktop::rdp_trust_forget,
            // SSH host-key trust (#1959)
            commands::ssh_host_key::ssh_host_key_decision,
            commands::ssh_host_key::ssh_trust_list,
            commands::ssh_host_key::ssh_trust_forget,
            // Session commands (replaces old terminal commands)
            commands::session::create_connection,
            commands::session::cancel_connecting,
            commands::connection_path::probe_connection_path_cmd,
            commands::connection_path::cancel_connection_path_probe,
            commands::ssh_config_import::import_ssh_config_hosts,
            commands::ssh_config_import::import_ssh_config_connections,
            commands::inventory_import::import_inventory_hosts,
            commands::session::get_connection_types,
            commands::session::send_input,
            commands::session::set_session_line_ending,
            commands::session::resize_terminal,
            commands::session::close_terminal,
            commands::session::list_local_sessions,
            commands::session::list_available_shells,
            commands::session::get_default_shell,
            commands::session::list_serial_ports,
            commands::session::check_x11_available,
            commands::session::check_ssh_agent_status,
            commands::session::check_docker_available,
            commands::session::list_docker_images,
            commands::session::check_podman_available,
            commands::session::list_podman_images,
            commands::session::validate_ssh_key,
            commands::session::is_ssh_key_encrypted,
            // Session-based file browsing
            commands::session::session_list_files,
            commands::session::session_read_file,
            commands::session::session_stat,
            commands::session::session_write_file,
            commands::session::session_delete_file,
            commands::session::session_rename_file,
            commands::session::session_mkdir,
            // Session-based monitoring
            commands::session::session_get_capabilities,
            commands::session::session_monitoring_open,
            commands::session::session_monitoring_close,
            commands::session::session_monitoring_set_paused,
            commands::session::session_monitoring_set_interval,
            commands::session::session_monitoring_cancel,
            // Session output logging (#1960)
            commands::session::session_logging_start,
            commands::session::session_logging_stop,
            commands::session::session_logging_status,
            // Persistent session management
            commands::session::start_persistent_session,
            commands::session::adopt_persistent_session,
            commands::session::stop_persistent_session,
            commands::session::attach_persistent_tab,
            commands::session::detach_persistent_tab,
            commands::session::list_persistent_sessions,
            commands::session::get_agent_session_buffer,
            // Connection management
            commands::connection::load_connections_and_folders,
            commands::connection::save_connection,
            commands::connection::delete_connection,
            commands::connection::save_folder,
            commands::connection::delete_folder,
            commands::connection::export_connections,
            commands::connection::import_connections,
            commands::connection::get_settings,
            commands::connection::save_settings,
            commands::shell_integration::get_shell_integration_status,
            commands::shell_integration::install_shell_integration,
            commands::shell_integration::uninstall_shell_integration,
            commands::shell_integration::save_shell_integration_settings,
            commands::shell_integration::remember_spawn_choice,
            commands::spawn::list_spawn_options,
            commands::spawn::resolve_container_spawn,
            commands::spawn::resolve_shell_spawn,
            commands::spawn::take_pending_spawn,
            commands::connection::move_connection_to_file,
            commands::connection::save_external_file,
            commands::connection::reload_external_connections,
            commands::connection::save_remote_agent,
            commands::connection::delete_remote_agent,
            commands::connection::reorder_remote_agents,
            commands::connection::export_connections_encrypted,
            commands::connection::preview_import,
            commands::connection::import_connections_with_credentials,
            commands::connection::get_recovery_warnings,
            // SFTP (kept temporarily — will migrate to session-based file browsing)
            commands::files::sftp_open,
            commands::files::sftp_close,
            commands::files::sftp_list_dir,
            commands::files::sftp_stat,
            commands::files::sftp_realpath,
            commands::files::sftp_check_writable,
            commands::files::sftp_download,
            commands::files::sftp_upload,
            commands::files::sftp_cancel_transfer,
            // Generic transfer-queue controls (shared model; #1336)
            commands::transfer::transfer_pause,
            commands::transfer::transfer_resume,
            commands::transfer::transfer_cancel,
            commands::transfer::transfer_retry,
            commands::transfer::transfer_list,
            commands::transfer::ftp_download,
            commands::transfer::ftp_upload,
            commands::files::sftp_mkdir,
            commands::files::sftp_delete,
            commands::files::sftp_rename,
            commands::files::get_home_dir,
            commands::files::local_list_dir,
            commands::files::local_copy,
            commands::files::local_mkdir,
            commands::files::local_delete,
            commands::files::local_rename,
            commands::files::local_read_file,
            commands::files::local_write_file,
            commands::files::watch_local_file,
            commands::files::unwatch_local_file,
            commands::files::watch_local_dir,
            commands::files::unwatch_local_dir,
            commands::files::sftp_read_file_content,
            commands::files::sftp_write_file_content,
            commands::files::sftp_write_file_content_elevated,
            commands::files::sftp_has_exec_capability,
            commands::files::vscode_available,
            commands::files::vscode_open_local,
            commands::files::vscode_open_remote,
            commands::files::write_cheatsheet,
            // Agent management
            commands::agent::connect_agent,
            commands::agent::cancel_connect_agent,
            commands::agent::disconnect_agent,
            commands::agent::prune_dead_agents,
            commands::agent::shutdown_agent,
            commands::agent::get_agent_capabilities,
            commands::agent::apply_agent_settings,
            commands::agent::request_agent_deferred_update,
            commands::agent::request_agent_update,
            commands::agent::list_agent_sessions,
            commands::agent::close_agent_session,
            commands::agent::list_agent_definitions,
            commands::agent::list_agent_connections,
            commands::agent::save_agent_definition,
            commands::agent::update_agent_definition,
            commands::agent::delete_agent_definition,
            commands::agent::create_agent_folder,
            commands::agent::update_agent_folder,
            commands::agent::delete_agent_folder,
            commands::agent::detect_agent_arch,
            commands::agent::setup_remote_agent,
            commands::agent::cancel_agent_setup,
            commands::agent::probe_remote_agent,
            commands::agent::deploy_agent,
            commands::agent::update_agent,
            commands::agent::update_agent_force,
            // Logs
            commands::logs::get_logs,
            commands::logs::clear_logs,
            // Tunnels
            commands::tunnel::get_tunnels,
            commands::tunnel::save_tunnel,
            commands::tunnel::delete_tunnel,
            commands::tunnel::get_tunnel_statuses,
            commands::tunnel::start_tunnel,
            commands::tunnel::stop_tunnel,
            // Workspaces
            commands::workspace::get_workspaces,
            commands::workspace::load_workspace,
            commands::workspace::save_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::duplicate_workspace,
            commands::workspace::get_cli_workspace,
            commands::workspace::export_workspaces,
            commands::workspace::import_workspaces,
            commands::workspace::preview_import_workspaces,
            commands::workspace::save_last_session,
            commands::workspace::load_last_session,
            commands::workspace::clear_last_session,
            // Multi-window foundation (#1900)
            commands::window::open_window,
            commands::window::claim_session,
            commands::window::release_session,
            commands::window::get_session_owner,
            commands::window::list_session_owners,
            commands::window::focus_window,
            commands::window::list_windows,
            commands::window::report_window_tab_count,
            commands::window::report_window_layout,
            commands::window::collect_window_layouts,
            commands::window::take_pending_window_restore,
            commands::window::take_pending_handoffs,
            commands::window::send_handoff_to_window,
            commands::window::replay_session_scrollback,
            // Macros
            commands::macros::list_macros,
            commands::macros::get_macro,
            commands::macros::save_macro,
            commands::macros::delete_macro,
            // Session history
            commands::session_history::get_session_history,
            commands::session_history::record_session,
            commands::session_history::set_history_entry_pinned,
            commands::session_history::mark_history_entry_promoted,
            commands::session_history::remove_history_entry,
            commands::session_history::clear_session_history,
            // Workflows
            commands::workflows::list_workflows,
            commands::workflows::get_workflow,
            commands::workflows::save_workflow,
            commands::workflows::delete_workflow,
            commands::local_process::run_local_process,
            commands::local_process::cancel_local_process,
            // Network diagnostics
            commands::network::network_port_scan,
            commands::network::network_port_scan_cancel,
            commands::network::probe_target_reachable,
            commands::network::network_ping_start,
            commands::network::network_ping_stop,
            commands::network::network_ping_sweep,
            commands::network::network_ping_sweep_cancel,
            commands::network::network_dns_lookup,
            commands::network::network_open_ports,
            commands::network::network_traceroute,
            commands::network::network_traceroute_cancel,
            commands::network::network_wol_send,
            commands::network::network_wol_devices_list,
            commands::network::network_wol_device_save,
            commands::network::network_wol_device_delete,
            commands::network::network_http_monitor_start,
            commands::network::network_http_monitor_stop,
            commands::network::network_http_monitor_remove,
            commands::network::network_http_monitor_pause,
            commands::network::network_http_monitor_resume,
            commands::network::network_http_monitor_stop_all,
            commands::network::network_http_monitor_list,
            // Embedded servers
            commands::embedded_servers::list_embedded_servers,
            commands::embedded_servers::save_embedded_server,
            commands::embedded_servers::delete_embedded_server,
            commands::embedded_servers::get_embedded_server_states,
            commands::embedded_servers::start_embedded_server,
            commands::embedded_servers::stop_embedded_server,
            commands::embedded_servers::create_and_start_server,
            commands::embedded_servers::list_network_interfaces,
            // Credentials
            commands::credential::get_credential_store_status,
            commands::credential::unlock_credential_store,
            commands::credential::reset_credential_store,
            commands::credential::lock_credential_store,
            commands::credential::setup_master_password,
            commands::credential::change_master_password,
            commands::credential::switch_credential_store,
            commands::credential::store_credential,
            commands::credential::resolve_credential,
            commands::credential::remove_credential,
            commands::credential::set_auto_lock_timeout,
            // Portable mode
            commands::portable::get_app_mode,
            commands::portable::list_config_files,
            commands::portable::resolve_portable_path_cmd,
            commands::portable::export_config_to_portable,
            commands::portable::import_config_from_portable,
            // Update checker
            commands::update::get_app_info,
            commands::update::check_for_updates,
            commands::update::skip_update_version,
            commands::update::clear_skipped_version,
            commands::update::set_update_auto_check,
            commands::update::get_update_settings,
            // X server provisioning
            commands::xserver::x_server_status,
            commands::xserver::x_server_ensure,
            commands::xserver::x_server_stop,
            commands::xserver::x_server_install_dependency,
            commands::xserver::x_server_connect_consent_reply,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Shutdown breadcrumbs (#1570). The 2026-07-17 post-mortem could only
            // establish that termiHub had exited *cleanly* by reading Apple's
            // unified log — the app itself recorded nothing on the way out. These
            // three events make the clean-exit path self-evident from termiHub's
            // own log, and their *absence* before a restart is what distinguishes
            // a clean shutdown from a kill or a crash.
            match &event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { .. },
                    ..
                } => info!(window = %label, "Window close requested"),
                RunEvent::ExitRequested { .. } => info!("Exit requested, shutting down"),
                RunEvent::Exit => info!("termiHub exited cleanly"),
                _ => {}
            }

            // Per-OS quit policy (#1903). On macOS, closing the last window does
            // NOT quit the app (WKWebView convention: it stays in the Dock), so
            // an `ExitRequested` triggered by that close is prevented; an
            // explicit quit (menu Quit / `AppHandle::exit`, `code == Some`) runs
            // teardown and proceeds. Windows/Linux fall through to the default
            // (quit), tearing down when the last window is destroyed below.
            if let RunEvent::ExitRequested { code, api, .. } = &event {
                if window::should_prevent_exit(*code) {
                    info!("Last window closed; keeping app alive (macOS Dock) (#1903)");
                    api.prevent_exit();
                } else if cfg!(target_os = "macos") {
                    // Explicit quit on macOS: teardown was deferred from the
                    // last window's Destroyed, so run it now before exiting.
                    info!("Explicit quit; running app-wide teardown (#1903)");
                    run_app_teardown(app_handle);
                }
            }

            // On macOS the app can outlive its windows; a Dock-icon click with no
            // open windows must recreate one so the app is reachable again. The
            // richer restore-on-reopen behaviour is #1905; this creates a fresh
            // empty window (as a "Move to Window" / "New Window" destination).
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = &event
            {
                if app_handle.webview_windows().is_empty() {
                    info!("Reopen with no windows; recreating a window (#1903)");
                    if let Some(wm) = app_handle.try_state::<window::WindowManager>() {
                        let label = wm.next_label();
                        if let Err(e) = tauri::WebviewWindowBuilder::new(
                            app_handle,
                            &label,
                            tauri::WebviewUrl::App("index.html".into()),
                        )
                        .title("termiHub")
                        .inner_size(1280.0, 800.0)
                        .min_inner_size(800.0, 600.0)
                        .build()
                        {
                            tracing::error!("Failed to recreate window on reopen: {e}");
                        }
                    }
                }
            }

            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = &event
            {
                // Release any session ownership held by the destroyed window so the
                // `session_id → window` map never points at a window that no longer
                // exists (#1900). Cheap, synchronous, safe on the event-loop thread.
                if let Some(wm) = app_handle.try_state::<window::WindowManager>() {
                    let released = wm.release_all_for_window(label);
                    if !released.is_empty() {
                        info!(
                            window = %label,
                            count = released.len(),
                            "Released session ownership for destroyed window (#1900)"
                        );
                    }
                    // Drop the window's reported tab count (#1910) so the
                    // "Move to Window ▸" picker never lists a stale count for a
                    // window that no longer exists.
                    wm.forget_tab_count(label);
                    // Drop the window's reported layout slice (#1925) so an
                    // assembled last-session / workspace document never carries a
                    // window that no longer exists. A surviving window's next
                    // layout change re-persists without it.
                    wm.forget_layout(label);
                }

                // App-wide teardown (tunnels, embedded/X servers, transfers, SFTP)
                // must only run when the *last* window closes — i.e. the app is
                // actually going away. With multi-window (#1900) a secondary window
                // closing must not tear down resources the remaining windows still
                // use.
                let is_last_window = app_handle.webview_windows().is_empty();
                if !is_last_window {
                    info!(
                        window = %label,
                        "Secondary window destroyed; skipping app-wide teardown (#1900)"
                    );
                    // Notify the remaining windows that the window set shrank so
                    // the status-bar affordance (#1902) refreshes its count.
                    // emit() must run off the event-loop thread: calling it
                    // directly here re-enters a RefCell Tauri already holds.
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle.emit("windows-changed", ()) {
                            tracing::warn!("Failed to emit windows-changed on destroy: {e}");
                        }
                    });
                    return;
                }

                // Last window closed. Per-OS policy (#1903): Windows/Linux quit
                // now, so tear down here; macOS keeps the app alive in the Dock,
                // deferring teardown to an explicit quit (handled above in
                // `ExitRequested`) so a reopened window still has its resources.
                if window::should_teardown_on_last_window() {
                    info!(window = %label, "Last window closed; running app-wide teardown (#1903)");
                    run_app_teardown(app_handle);
                } else {
                    info!(
                        window = %label,
                        "Last window closed on macOS; app stays alive, teardown deferred (#1903)"
                    );
                }
            }
        });
}
