// TOOL-010: enforce the "no `.unwrap()`/`.expect()`/`panic!` in production Rust"
// policy (see `.claude/CLAUDE.md` → Rust). Denied for non-test builds; test code
// (`#[cfg(test)]` modules and `tests/` crates) is exempt via `not(test)`.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

/// Shared "desktop controls a service hosted on a remote agent" control layer:
/// the periodic agent `*.status` poller lifecycle reused by the embedded-server,
/// HTTP-monitor, and tunnel managers (DUP-020).
mod agent_service;
/// Agents authority (#2226, Phase 5 of #2139): the shared `agents`
/// projection region + `agent.*` intents modeling the agents slice
/// (the ordered agent list + per-agent sessions/definitions/folders). Drives the
/// live UI (stateless-UI inversion complete, #2283) — see [`agents_projection`].
mod agents_projection;
/// Owned background-task tracking for deterministic shutdown (ARCH-007): an
/// app-wide [`tokio_util::task::TaskTracker`] + [`tokio_util::sync::CancellationToken`]
/// held in managed state, so long-lived background tasks are cancelled and
/// awaited (bounded) at teardown instead of outliving it — see [`app_tasks`].
mod app_tasks;
mod backup;
/// Ordered application boot phases (ARCH-002 / TAURI-009): the wiring the
/// Tauri `setup()` callback runs, extracted from the former god-closure into
/// phase functions called in the identical order — see [`boot`].
mod boot;
/// Broadcast-membership authority (#2242, Phase 4 step 5b of #2139, part of
/// #2206 / #2152): the client-scoped `broadcast@<clientId>` projection region +
/// `broadcast.*` intents modeling the `appStore` broadcast-input membership slice
/// (which tabs receive mirrored input, #1955 / #1956 / #1958). Drives the live UI
/// (stateless-UI inversion complete, #2283) — the frontend renders the broadcast
/// UI from the region and routes the membership actions through the intents; the
/// former `appStore` reducers were removed — see [`broadcast_projection`].
mod broadcast_projection;
mod cli;
mod commands;
mod connection;
/// Connections-tree authority (#2225, Phase 5 of #2139/#2153): the shared
/// `connections` projection region + `connection.*` intents, wrapping the
/// existing saved-connection authority (`crate::connection`). Drives the live UI
/// (stateless-UI inversion complete, #2283) — see [`connections_projection`].
mod connections_projection;
mod credential;
mod embedded_servers;
/// File-browser view authority (#2228, Phase 5 of #2139/#2153): the
/// client-scoped `file-browser@<clientId>` region + `fileBrowser.*` intents
/// modeling the file-browser UI state (browser panes, active mode, clipboard).
/// Drives the live UI (stateless-UI inversion complete, #2283). See
/// [`file_browser_projection`].
mod file_browser_projection;
/// File-system access: local FS, session-scoped SFTP ops, and the cancellable
/// transfer subsystem (public so integration tests can drive the transfer
/// subsystem / `TransferRegistry` directly — issue #1245).
pub mod files;
/// Shadow `LayoutStore` (#2151, Phase 3 step 1 of #2139): the client-scoped
/// `layout@<clientId>` projection region + `layout.*` intents, built on the
/// ported panel-tree algebra (#2143). The remaining migration outlier —
/// registered and served but **not yet** driving the live UI (deferred reducer
/// removal tracked as #2562) — see [`layout`].
mod layout;
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
mod plugin_protocol;
/// Stateless-UI projection substrate (#2149): server-authoritative per-region
/// versioned diff channels with multi-subscriber fan-out. Public so integration
/// tests can drive the projector directly.
pub mod projection;
/// Authoritative restore-cohort state machine (#2206, Phase 4 step 5 of #2139):
/// the client-scoped `restore-cohort@<clientId>` projection region + `restore.*`
/// intents, modelling the startup restore/launch cohort aggregation (#1146 /
/// #1227) on top of the ported restore-decision engine (`termihub_core::restore_mode`,
/// #2145). The sole source of truth driving the live UI's aggregate summary toast
/// (reducer removal) — see [`restore_cohort_projection`].
mod restore_cohort_projection;
pub mod run_location;
mod session;
mod session_history;
/// Session-lifecycle authority (#2152, Phase 4 step 1 of #2139): the
/// shared `session-lifecycle` projection region + `session.*` intents, built on
/// the ported auto-reconnect engine (#2144). Drives the live UI (stateless-UI
/// inversion complete, #2283) — see [`session_projection`].
mod session_projection;
/// App-settings authority (#2227, Phase 5 of #2139/#2153): the shared
/// `settings` projection region + `settings.*` intents modeling the
/// `AppSettings` document (the persisted user-preferences slice), held as an
/// opaque JSON document. Drives the live UI (stateless-UI inversion complete,
/// #2283) — see [`settings_projection`].
mod settings_projection;
mod spawn;
/// System-monitor authority (#2224, Phase 5 of #2139): the shared
/// `system-monitors` projection region + `monitor.*` intents, built on the
/// monitoring types shared with the agent crate (`termihub_core::monitoring`).
/// Drives the live UI (stateless-UI inversion complete, #2283) — see
/// [`system_monitor_projection`].
mod system_monitor_projection;
mod terminal;
/// Transfer-queue authority (#2229, Phase 5 of #2139 / #2153): the shared
/// `transfers` projection region + `transfer.*` intents modeling the
/// Transfer Queue slice (per-transfer queue-row lifecycle + panel-minimized
/// flag). Drives the live UI (stateless-UI inversion complete, #2283). See
/// [`transfers_projection`].
mod transfers_projection;
mod tunnel;
mod utils;
/// Multi-window foundation (#1900): window creation/labelling, the
/// `session_id → owning_window` ownership map, and the tab hand-off queue.
mod window;
/// Native Windows clipboard binding for pasting remote-copied RDP clipboard files
/// into local apps with delayed rendering (`CF_HDROP`, #1814). Windows-only.
#[cfg(windows)]
mod windows_clipboard;
/// Workflow-run authority (#2243, Phase 4 step 5c of #2139, part of
/// #2206 / #2152): the client-scoped `workflow-run@<clientId>` projection region
/// + `workflow.*` intents modeling the workflow-run state machine
/// (in-flight run progress + the dismissible local-process output panel, #1852 /
/// #1865). Drives the live UI (stateless-UI inversion complete, #2283) — see
/// [`workflow_projection`].
mod workflow_projection;
mod workflows;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tracing::{info, warn};

use connection::manager::ConnectionManager;
use connection::recovery::RecoveryWarning;
use connection::settings::{AppSettings, SettingsStorage};
use credential::{AutoLockTimer, CredentialManager, StorageMode};
use files::transfer::TransferRegistry;
use network::NetworkManager;
use session::manager::SessionManager;
use session::registry::build_desktop_registry;
use terminal::agent_manager::{AgentConnectionManager, AgentRpcClient};
use utils::config_paths::DirOutcome;
use utils::file_log;

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
    // Remove this process's drag-out staging dirs (#3457) synchronously, so the
    // staged remote copies never outlive the app even if exit races the task below.
    if let Some(staging) = app_handle.try_state::<files::drag_out::DragOutStaging>() {
        staging.cleanup_all();
    }
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
        if let Some(mgr) = handle.try_state::<Arc<NetworkManager>>() {
            mgr.stop_all_http_monitors();
        }
        // Cancel every in-flight transfer *before* closing sessions, so no
        // half-written file keeps a dedicated channel open during teardown
        // (#1245).
        if let Some(reg) = handle.try_state::<TransferRegistry>() {
            reg.cancel_all();
        }
        // Session-scoped SSH+SFTP connections are torn down with their owning
        // sessions by `SessionManager`, so there is no standalone SFTP session
        // registry to close here since the UUID `SftpManager` was retired (#2314).

        // Deterministic owned-task shutdown (ARCH-007). After the managers above
        // have signalled their own resources to stop, cancel the app-wide token
        // and wait — bounded — for every task spawned via `AppTasks` to finish,
        // so no tracked background task outlives teardown. This teardown task is
        // itself *not* tracked (bare `async_runtime::spawn` above), so awaiting
        // the tracker cannot deadlock against the caller; the bound guarantees a
        // wedged task cannot hang exit.
        if let Some(tasks) = handle.try_state::<app_tasks::AppTasks>() {
            match tasks.shutdown(app_tasks::DEFAULT_SHUTDOWN_TIMEOUT).await {
                app_tasks::ShutdownOutcome::Completed => {
                    info!("All owned background tasks finished on teardown (ARCH-007)")
                }
                app_tasks::ShutdownOutcome::TimedOut => warn!(
                    timeout = ?app_tasks::DEFAULT_SHUTDOWN_TIMEOUT,
                    "Owned-task shutdown timed out; proceeding with exit (ARCH-007)"
                ),
            }
        }
    });
}

/// Which startup storage location is being prepared. Selects the wording of the
/// [`RecoveryWarning`] and the degrade-on-total-failure behavior when the
/// directory cannot be created (ERR-004 / TAURI-005).
#[derive(Clone, Copy)]
enum StartupStorage {
    /// The portable `data/` directory. On total failure the override is dropped
    /// so the app falls back to the OS default config location.
    PortableData,
    /// The per-user config directory. On total failure the preferred path is
    /// kept best-effort so later storage init still has a target.
    Config,
}

impl StartupStorage {
    /// The `file_name` bucket the warning is grouped under in the UI.
    fn file_name(self) -> &'static str {
        match self {
            StartupStorage::PortableData => "portable data directory",
            StartupStorage::Config => "config directory",
        }
    }

    /// Human-readable label for the directory in warning messages.
    fn label(self) -> &'static str {
        match self {
            StartupStorage::PortableData => "portable data",
            StartupStorage::Config => "configuration",
        }
    }
}

/// Build the [`RecoveryWarning`] for a failure to even *resolve* the config
/// directory (before any creation is attempted).
///
/// Split out so the "resolve failed -> temporary fallback + warn the user" path
/// is unit-testable without a Tauri `AppHandle` (ERR-004 / TAURI-005).
fn config_resolve_failure_warning(error: &str, fallback: &Path) -> RecoveryWarning {
    RecoveryWarning {
        file_name: StartupStorage::Config.file_name().to_string(),
        message: format!(
            "Could not determine the configuration directory. Using temporary storage at {}; \
             settings and credentials may not persist across restarts.",
            fallback.display()
        ),
        details: Some(error.to_string()),
    }
}

/// Map a directory-creation [`DirOutcome`] to the path startup should use plus an
/// optional [`RecoveryWarning`] describing any degradation.
///
/// This is what turns an unwritable config/data location into a user-visible
/// warning (surfaced via `get_recovery_warnings`) instead of only a log line,
/// while never panicking (ERR-004 / TAURI-005). `preferred` is the originally
/// intended directory — used in the warning detail and as the best-effort path
/// when even the temporary fallback cannot be created.
///
/// Returns `(None, _)` only for [`StartupStorage::PortableData`] total failure,
/// where startup drops the portable override and uses the OS default location.
fn resolve_startup_dir(
    outcome: DirOutcome,
    kind: StartupStorage,
    preferred: &Path,
) -> (Option<PathBuf>, Option<RecoveryWarning>) {
    match outcome {
        DirOutcome::Preferred(dir) => (Some(dir), None),
        DirOutcome::Fallback { dir, error } => {
            let warning = RecoveryWarning {
                file_name: kind.file_name().to_string(),
                message: format!(
                    "Could not create the {} directory. Using temporary storage at {}; data may \
                     not persist across restarts.",
                    kind.label(),
                    dir.display()
                ),
                details: Some(format!("{} ({error})", preferred.display())),
            };
            (Some(dir), Some(warning))
        }
        DirOutcome::Failed {
            preferred_error,
            fallback_error,
        } => {
            let chosen = match kind {
                StartupStorage::PortableData => None,
                StartupStorage::Config => Some(preferred.to_path_buf()),
            };
            let warning = RecoveryWarning {
                file_name: kind.file_name().to_string(),
                message: format!(
                    "Could not create the {} directory or a temporary fallback. Continuing \
                     best-effort; data may not persist across restarts.",
                    kind.label()
                ),
                details: Some(format!(
                    "{} ({preferred_error}); fallback failed ({fallback_error})",
                    preferred.display()
                )),
            };
            (chosen, Some(warning))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> anyhow::Result<()> {
    // Pre-init CLI routing: `spawn` / `(un)install-shell-integration` must be
    // handled from the raw args before the Tauri window is created, since
    // `cli().matches()` is only available inside `setup()` (#1364). A spawn
    // request this instance must handle itself (no running instance accepted
    // the forward) is threaded into `setup()` via `pending_spawn`.
    let raw_args: Vec<String> = std::env::args().skip(1).collect();

    // Top-level `--version`/`-V` and `--help`/`-h` must print and exit before
    // any window, spawn IPC, or logging setup, so they work headlessly with no
    // display (#2655). `tauri_plugin_cli`'s matches are only available inside
    // `setup()` (after the window is built), so these are routed here from the
    // raw args, ahead of the spawn/shell-integration classification below.
    if let Some(flag) = cli::classify_info_flag(&raw_args) {
        cli::handle_info_flag(flag);
    }

    let pending_spawn = match spawn::classify_command(&raw_args) {
        spawn::Command::Spawn(request) => handle_spawn_command(request),
        spawn::Command::InstallShellIntegration => handle_shell_integration_command(true),
        spawn::Command::UninstallShellIntegration => handle_shell_integration_command(false),
        spawn::Command::None => None,
    };

    // Under the headless test bridge on macOS, turn off AppKit window occlusion
    // detection *before* NSApplication launches (it reads this user default
    // while launching). Without it, macOS marks the unfocused test window
    // occluded and WebKit throttles the page's timers, stalling the
    // frontend-driven agent-reconnect engine (#2480). setup() runs too late for
    // this default, so it must happen here. macOS-only, test-bridge-only, so
    // production/default is byte-identical.
    #[cfg(all(target_os = "macos", feature = "test-bridge"))]
    if utils::test_bridge::is_test_bridge_enabled() {
        utils::macos_unthrottle::pre_launch_disable_occlusion_detection();
    }

    // Build and install the global tracing subscriber (ARCH-002 / TAURI-009,
    // Slice B). The ring buffer, durable file sink, reloadable per-layer filter,
    // and the load-bearing subscriber layer-attachment order all live in
    // `boot::logging::init_tracing` now; it returns the values threaded into the
    // builder below. The startup log lines and the panic hook stay here so they
    // still run, in order, right after the subscriber is live.
    let boot::logging::TracingInit {
        log_buffer,
        file_reload_handle,
        app_handle_slot,
        file_log_status,
    } = boot::logging::init_tracing();

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

    // Durable panic reporting (OBS-002). Installed right after the subscriber is
    // live so a crash lands in the ring buffer and the synchronous file sink
    // before the process unwinds — the highest-value post-mortem event, which
    // otherwise leaves no trace in `termihub.log`.
    utils::panic_hook::install();

    // Shared X server manager (#1049), held as an `Arc` so the provisioner
    // (#1052) and the Tauri commands can both reference the same instance.
    let x_server_manager = Arc::new(build_xserver_manager());

    // Registry routing connect-time X server download-consent replies (#1116)
    // from the `x_server_connect_consent_reply` command back to the paused
    // connect. Shared between that command and the provisioner.
    let x_server_consent_registry = Arc::new(terminal::xserver::ConnectConsentRegistry::new());

    // Assemble the Tauri builder prelude — plugins, eagerly-constructed managed
    // state, the conditional single-instance / test-bridge plugins, and the
    // plugin URI-scheme protocol (ARCH-002 / TAURI-009, Slice C). The terminal
    // `.setup(..).invoke_handler(..).build(..).run(..)` chain stays here verbatim.
    let builder = boot::builder::build(
        &x_server_manager,
        &x_server_consent_registry,
        log_buffer,
        file_reload_handle,
    );

    builder
        .setup(move |app| {
            boot::init_platform_and_capture(app, &app_handle_slot);

            let mut recovery_warnings: Vec<RecoveryWarning> = Vec::new();

            // Resolve + materialize the effective config directory, publish it as
            // managed state, and store the detected app mode (ORDER: the
            // ConfigDirOverride is managed before any storage module is built).
            let config_dir = boot::resolve_and_manage_config_dir(app, &mut recovery_warnings);

            // Build the shared connection-type registry (ORDER: before both the
            // PluginHost, built here, and the SessionManager, built below — both
            // share it by Arc).
            let connection_registry = boot::init_plugin_host(app, &config_dir);

            // Capture path for the connections file watcher before config_dir is moved.
            let connections_file = config_dir.join("connections.json");

            boot::init_network(app, config_dir.clone());

            // ORDER: the credential manager is built before the ConnectionManager,
            // which consumes it; config_dir is moved in here (its last use).
            boot::init_credentials_and_connections(app, config_dir, &mut recovery_warnings);

            boot::init_session_managers(
                app,
                connection_registry,
                &x_server_manager,
                &x_server_consent_registry,
            );

            // ORDER: the tunnel manager is managed before the projection Pass B
            // seeds the tunnels region below.
            boot::init_tunnels(app, &mut recovery_warnings);

            // ORDER: the ConnectionManager (managed above) must exist before the
            // projection Pass B seeds the agents/connections/settings regions.
            boot::init_projection(app);

            boot::init_secondary_managers(app, &mut recovery_warnings);

            boot::handle_cli_list_workspaces(app);

            boot::init_spawn_ipc(app, pending_spawn);

            // ORDER: recovery_warnings is managed last, after every push/extend
            // site above.
            boot::finalize(app, recovery_warnings, connections_file);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Remote-desktop (graphical) commands — protocol-blind (#1680)
            commands::remote_desktop::remote_desktop_connect,
            commands::remote_desktop::remote_desktop_resize,
            commands::remote_desktop::remote_desktop_request_full_frame,
            commands::remote_desktop::remote_desktop_send_input,
            commands::remote_desktop::remote_desktop_release_input,
            commands::remote_desktop::remote_desktop_send_clipboard,
            commands::remote_desktop::remote_desktop_get_clipboard,
            commands::remote_desktop::remote_desktop_remote_clipboard_files,
            commands::remote_desktop::remote_desktop_bind_clipboard_files,
            commands::remote_desktop_image::remote_desktop_clipboard_image_info,
            commands::remote_desktop_image::remote_desktop_copy_clipboard_image,
            commands::remote_desktop_image::remote_desktop_send_clipboard_image,
            commands::remote_desktop::remote_desktop_cert_decision,
            commands::remote_desktop::remote_desktop_disconnect,
            commands::remote_desktop::rdp_trust_list,
            commands::remote_desktop::rdp_trust_forget,
            // SSH host-key trust (#1959)
            commands::ssh_host_key::ssh_host_key_decision,
            commands::ssh_host_key::ssh_trust_list,
            commands::ssh_host_key::ssh_trust_forget,
            // SSH keyboard-interactive / OTP prompts (#3371)
            commands::ssh_host_key::ssh_keyboard_interactive_respond,
            // Stateless-UI projection substrate (#2149)
            commands::projection::intent_dispatch,
            commands::projection::projection_subscribe,
            commands::projection::projection_unsubscribe,
            commands::projection::projection_resync,
            // Plugin management layer (#1992)
            commands::plugin::list_plugins,
            commands::plugin::validate_plugin,
            commands::plugin::install_plugin,
            commands::plugin::uninstall_plugin,
            commands::plugin::enable_plugin,
            commands::plugin::disable_plugin,
            commands::plugin::get_plugin_settings,
            commands::plugin::update_plugin_settings,
            commands::plugin::read_plugin_file,
            // Plugin code-signing (#2036)
            commands::plugin::assess_plugin_trust,
            commands::plugin::list_trusted_publishers,
            commands::plugin::revoke_trusted_publisher,
            // Native-plugin trust gate: default-off + per-plugin ack (SEC-002/PLG-006/ARCH-008)
            commands::plugin::get_native_plugin_trust,
            commands::plugin::set_native_plugins_enabled,
            commands::plugin::acknowledge_native_plugin,
            commands::plugin::revoke_native_plugin_trust,
            // Opt-in plugin update check; downloads verify, never install (PROD-051)
            commands::plugin_update::check_plugin_updates,
            commands::plugin_update::download_plugin_update,
            // Session commands (replaces old terminal commands)
            commands::session::create_connection,
            commands::session::test_connection,
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
            commands::session::reclaim_session,
            commands::session::list_local_sessions,
            commands::session::list_available_shells,
            commands::session::get_default_shell,
            commands::session::list_serial_ports,
            commands::session::check_x11_available,
            commands::session::check_ssh_agent_status,
            commands::session::check_docker_available,
            commands::session::list_docker_images,
            commands::session::list_docker_containers,
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
            commands::session::session_set_permissions,
            commands::session::session_set_owner,
            commands::session::session_create_symlink,
            commands::session::session_copy,
            // Session-scoped SFTP advanced ops & transfers (#2312)
            commands::session::session_realpath,
            commands::session::session_check_writable,
            commands::session::session_write_file_elevated,
            commands::session::session_has_exec_capability,
            commands::session::session_download,
            commands::session::session_upload,
            commands::session::session_supports_transfer_queue,
            commands::session::session_vscode_open_remote,
            // Session-based monitoring
            commands::session::session_get_capabilities,
            commands::session::session_monitoring_open,
            commands::session::session_monitoring_close,
            commands::session::session_monitoring_set_paused,
            commands::session::session_monitoring_set_interval,
            commands::session::session_monitoring_cancel,
            // Process list + kill (PROD-0028)
            commands::session::list_processes,
            commands::session::kill_process,
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
            commands::connection::reorder_connections,
            commands::connection::export_connections_encrypted,
            commands::connection::preview_import,
            commands::connection::import_connections_with_credentials,
            commands::connection::get_recovery_warnings,
            // SFTP transfer cancellation (shared transfer-registry model; #1245).
            // The standalone UUID `sftp_*` session commands were retired in #2314;
            // SSH file browsing/transfer now goes through the `session_*` path.
            commands::files::sftp_cancel_transfer,
            // Generic transfer-queue controls (shared model; #1336)
            commands::transfer::transfer_pause,
            commands::transfer::transfer_resume,
            commands::transfer::transfer_cancel,
            commands::transfer::transfer_retry,
            commands::transfer::transfer_list,
            commands::transfer::ftp_download,
            commands::transfer::ftp_upload,
            commands::transfer::session_copy_remote,
            commands::files::get_home_dir,
            commands::files::local_list_dir,
            commands::files::drag_out_create_staging,
            commands::files::drag_out_discard_staging,
            commands::files::drag_out_start,
            commands::files::local_copy,
            commands::files::local_mkdir,
            commands::files::local_delete,
            commands::files::local_rename,
            commands::files::local_set_permissions,
            commands::files::local_set_owner,
            commands::files::local_create_symlink,
            commands::files::local_read_file,
            commands::files::local_stat,
            commands::files::local_write_file,
            commands::files::watch_local_file,
            commands::files::unwatch_local_file,
            commands::files::watch_local_dir,
            commands::files::unwatch_local_dir,
            commands::files::vscode_available,
            commands::files::vscode_open_local,
            // Agent management
            commands::agent::connect_agent,
            commands::agent::cancel_connect_agent,
            commands::agent::disconnect_agent,
            // Test-bridge-only (SEC-005): registered only when the bridge is
            // compiled in, so release builds expose no transport-sever command.
            #[cfg(feature = "test-bridge")]
            commands::agent::test_sever_agent_transport,
            commands::agent::prune_dead_agents,
            commands::agent::shutdown_agent,
            commands::agent::get_agent_capabilities,
            commands::agent::apply_agent_settings,
            commands::agent::request_agent_deferred_update,
            commands::agent::request_agent_update,
            commands::agent::list_agent_sessions,
            commands::agent::list_agent_host_sessions,
            commands::agent::take_over_agent_session,
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
            commands::logs::record_frontend_log,
            commands::logs::set_file_log_level,
            commands::logs::get_log_file_path,
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
            commands::workspace::set_active_workspace,
            commands::workspace::get_active_workspace,
            commands::workspace::get_cli_workspace,
            commands::workspace::export_workspaces,
            commands::workspace::import_workspaces,
            commands::workspace::preview_import_workspaces,
            commands::workspace::save_last_session,
            commands::workspace::load_last_session,
            commands::workspace::clear_last_session,
            // Startup session-restore decision logic, wired to core (#2200)
            commands::restore_mode::restore_resolve_mode,
            commands::restore_mode::restore_summarize_last_session,
            commands::restore_mode::restore_filter_session_by_selection,
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
            commands::workflows::list_workflow_runs,
            commands::workflows::record_workflow_run,
            commands::workflows::clear_workflow_run_history,
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
            commands::network::list_network_tool_runs,
            commands::network::record_network_tool_run,
            commands::network::delete_network_tool_run,
            commands::network::clear_network_tool_history,
            commands::network::network_http_monitor_start,
            commands::network::network_http_monitor_stop,
            commands::network::network_http_monitor_remove,
            commands::network::network_http_monitor_pause,
            commands::network::network_http_monitor_resume,
            commands::network::network_http_monitor_stop_all,
            commands::network::network_http_monitor_list,
            commands::network::set_http_monitor_run_location,
            commands::network::set_network_tool_run_location,
            // Embedded servers
            commands::embedded_servers::list_embedded_servers,
            commands::embedded_servers::save_embedded_server,
            commands::embedded_servers::delete_embedded_server,
            commands::embedded_servers::get_embedded_server_states,
            commands::embedded_servers::get_embedded_server_activity,
            commands::embedded_servers::clear_embedded_server_activity,
            commands::embedded_servers::set_embedded_server_run_location,
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
            commands::os_auth::get_os_auth_info,
            commands::os_auth::enable_biometric_unlock,
            commands::os_auth::disable_biometric_unlock,
            commands::os_auth::unlock_credential_store_biometric,
            commands::credential_vault::export_credential_vault,
            commands::credential_vault::preview_credential_vault_import,
            commands::credential_vault::import_credential_vault,
            // Unified backup and restore (PROD-068)
            commands::backup::list_backup_sections,
            commands::backup::export_backup,
            commands::backup::read_backup_header,
            commands::backup::preview_backup_restore,
            commands::backup::apply_backup_restore,
            commands::backup::restart_after_backup_restore,
            // Portable mode
            commands::portable::get_app_mode,
            commands::portable::list_config_files,
            commands::portable::resolve_portable_path_cmd,
            commands::portable::export_config_to_portable,
            commands::portable::import_config_from_portable,
            // About screen: bundled third-party license notices (PKG-009)
            commands::about::get_third_party_notices,
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
        .build({
            // `mut` is only needed for the test-bridge CSP relaxation below
            // (feature = "test-bridge"); release builds never mutate the context.
            #[cfg_attr(not(feature = "test-bridge"), allow(unused_mut))]
            let mut context = tauri::generate_context!();
            // In WebSocket test-bridge mode, widen `connect-src` so the in-app
            // bridge's `ws://127.0.0.1:<port>` client (`src/testbridge/wsClient.ts`)
            // is permitted by the built bundle's secure-origin (`tauri://localhost`)
            // CSP — otherwise WebKit rejects the socket with `SecurityError` and the
            // automated full-app system-test lane never connects (#2480).
            //
            // Test-bridge-only (SEC-005): the relaxation is compiled out of release
            // builds entirely, so no shipped binary can widen its CSP at runtime —
            // the released CSP is byte-identical to `tauri.conf.json`.
            #[cfg(feature = "test-bridge")]
            utils::test_bridge::relax_csp_if_test_bridge(
                &mut context.config_mut().app.security.csp,
            );
            context
        })
        .map_err(|e| anyhow::anyhow!("error while building tauri application: {e}"))?
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
                // Release the destroyed window's projection client identities
                // and detach their subscriptions (TAURI-012, #3444), so a later
                // window can never inherit them and dead sinks do not linger.
                if let Some(ps) = app_handle.try_state::<commands::projection::ProjectionState>() {
                    ps.release_principal(label);
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
                        // The destroyed window's sessions were just released
                        // (release_all_for_window above), so push the ownership
                        // change too (#1985) — a surviving window refreshes its
                        // mirror without waiting on a transfer-progress event.
                        if let Err(e) = handle.emit("session-ownership-changed", ()) {
                            tracing::warn!(
                                "Failed to emit session-ownership-changed on destroy: {e}"
                            );
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
    Ok(())
}

#[cfg(test)]
mod startup_storage_tests;
