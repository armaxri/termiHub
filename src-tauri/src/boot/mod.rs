//! Application boot phases (ARCH-002 / TAURI-009, Slice 1).
//!
//! The Tauri `setup()` callback in [`crate::run`] used to be a single ~1000-line
//! closure that wired every subsystem in one place. This module holds that same
//! wiring, split into ordered phase functions that `setup()` now calls in the
//! **identical order**. The extraction is a pure cut-and-move: no ordering, no
//! logic, and no error handling changed — see the ordering invariants documented
//! in `setup()`.
//!
//! Each phase takes `&tauri::App` (plus whatever earlier phases produced and
//! whatever the warnings accumulator threads through) and manages its own state
//! into the app, exactly as the inline code did.

use super::*;

pub(crate) mod builder;
pub(crate) mod logging;

pub(crate) fn init_platform_and_capture(
    app: &tauri::App,
    app_handle_slot: &std::sync::Arc<std::sync::Mutex<Option<tauri::AppHandle>>>,
) {
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
    // production windows are untouched. An operator can opt out via
    // TERMIHUB_TEST_NO_ALWAYS_ON_TOP so the window stays backgroundable
    // during a guided-manual grade (#2504).
    #[cfg(feature = "test-bridge")]
    if utils::test_bridge::is_test_bridge_enabled() {
        if utils::test_bridge::always_on_top_opt_out() {
            info!(
                "Test window always-on-top skipped by request (TERMIHUB_TEST_NO_ALWAYS_ON_TOP, #2504)"
            );
        } else if let Some(window) = app.get_webview_window("main") {
            if let Err(e) = window.set_always_on_top(true) {
                tracing::warn!("Failed to set test window always-on-top: {e}");
            } else {
                info!("Test window pinned always-on-top (anti-occlusion, #957)");
            }
        }

        // Always-on-top alone does not stop macOS from throttling the
        // WKWebView once the app is unfocused/occluded (App Nap +
        // window-occlusion detection), which stalls the frontend-driven
        // agent-reconnect logic during a headless E2E run (#2480). Hold
        // an NSProcessInfo activity assertion and turn off AppKit
        // occlusion detection so the webview's timers keep running.
        // macOS-only, test-bridge-only.
        #[cfg(target_os = "macos")]
        utils::macos_unthrottle::engage_test_bridge_unthrottle();

        // On Linux (the headless CI leg), route the WebKitGTK webview's
        // JS console output + page-load lifecycle into the captured app
        // log, so a bridge-timeout run shows whether the page's bridge
        // bootstrap failed to load, threw, or silently never dialed
        // (#2646). Linux-only + test-bridge-only; other platforms and
        // production launches compile/reach none of it.
        #[cfg(target_os = "linux")]
        if let Some(window) = app.get_webview_window("main") {
            utils::webview_console::attach_console_capture(&window);
        }
    }
}

pub(crate) fn resolve_and_manage_config_dir(
    app: &tauri::App,
    recovery_warnings: &mut Vec<crate::connection::recovery::RecoveryWarning>,
) -> std::path::PathBuf {
    // Detect portable mode before any storage initialization.
    // Priority: external TERMIHUB_CONFIG_DIR override > portable mode > OS default.
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

    // Resolve the effective config directory once, explicitly. Priority:
    //   1. an external `TERMIHUB_CONFIG_DIR` override (public knob used by
    //      the system-test harness, README, and power users);
    //   2. the portable `data/` directory when in portable mode;
    //   3. the OS per-user config directory (installed mode).
    // The resolved value is published as `ConfigDirOverride` managed state
    // below so every storage module reads it explicitly, rather than the
    // app writing the directory into its own process-global environment
    // (WA-RS-011). Each degradation to a temp dir surfaces a
    // RecoveryWarning rather than panicking (ERR-004 / TAURI-005 /
    // WA-RS-003): a read-only portable medium, a locked-down profile, a
    // full disk, or a config path that exists as a file must not kill
    // launch.
    let temp_config_fallback = std::env::temp_dir().join("termihub-config");
    let resolved_config_dir: PathBuf = if let Ok(dir) = std::env::var("TERMIHUB_CONFIG_DIR") {
        // 1. External override wins, exactly as before — portable mode
        //    never redirects when the user has set this explicitly.
        PathBuf::from(dir)
    } else if let Some(portable_dir) = app_mode.data_dir().and_then(|data_dir| {
        // 2. Portable: create the `data/` dir, degrading to a temp
        //    directory. On total failure the portable override is
        //    dropped (None) so resolution falls through to the OS
        //    default, matching the previous behavior.
        let temp_fallback = std::env::temp_dir().join("termihub-portable-data");
        let outcome = utils::config_paths::create_dir_with_fallback(data_dir, &temp_fallback);
        let (storage_dir, warning) =
            resolve_startup_dir(outcome, StartupStorage::PortableData, data_dir);
        if let Some(w) = warning {
            warn!("{} ({})", w.message, w.details.as_deref().unwrap_or(""));
            recovery_warnings.push(w);
        }
        storage_dir
    }) {
        portable_dir
    } else {
        // 3. Installed mode (or portable total-failure fallback): the
        //    OS per-user config directory via Tauri's own resolver.
        match utils::config_paths::app_config_dir(app.handle()) {
            Ok(dir) => dir,
            Err(e) => {
                warn!(
                    "could not resolve app config directory ({e}); using temporary \
                         storage at {}",
                    temp_config_fallback.display()
                );
                recovery_warnings.push(config_resolve_failure_warning(
                    &e.to_string(),
                    &temp_config_fallback,
                ));
                temp_config_fallback.clone()
            }
        }
    };

    // Store the detected app mode so commands and the frontend can query it.
    app.manage(app_mode);

    // Materialize the config dir, degrading to temp storage instead of
    // panicking if it cannot be created (ERR-004 / TAURI-005 / WA-RS-003).
    let outcome =
        utils::config_paths::create_dir_with_fallback(&resolved_config_dir, &temp_config_fallback);
    let (config_dir_opt, warning) =
        resolve_startup_dir(outcome, StartupStorage::Config, &resolved_config_dir);
    if let Some(w) = warning {
        warn!("{} ({})", w.message, w.details.as_deref().unwrap_or(""));
        recovery_warnings.push(w);
    }
    // The config dir always yields a usable path: a total failure keeps
    // the preferred directory best-effort.
    let config_dir = config_dir_opt.unwrap_or_else(|| resolved_config_dir.clone());

    // Publish the resolved directory as managed state so every storage
    // module's `resolve_config_dir(Some(handle))` reads this one explicit
    // value — the threaded replacement for the former self-mutated
    // `TERMIHUB_CONFIG_DIR` (WA-RS-011). Managed before any storage module
    // is constructed below.
    app.manage(utils::config_paths::ConfigDirOverride(config_dir.clone()));

    // Swap in a committed backup restore (PROD-068) before any store below
    // loads, so no running store ever sees its file change underneath it.
    if let Some(w) = crate::backup::pending::apply_pending_restore(&config_dir) {
        warn!("{} ({})", w.message, w.details.as_deref().unwrap_or(""));
        recovery_warnings.push(w);
    }

    config_dir
}

pub(crate) fn init_plugin_host(
    app: &tauri::App,
    config_dir: &std::path::Path,
) -> std::sync::Arc<std::sync::Mutex<termihub_core::connection::ConnectionTypeRegistry>> {
    // Plugin management layer (#1992) + native host loader (#1995): owns
    // <app-data>/plugins/, created lazily. The host loads a plugin's
    // backend dynamic library on enable and registers its connection type
    // into a shared registry; disabling/uninstalling unloads it.
    //
    // That registry is the SAME one the desktop SessionManager creates
    // sessions from (#1999): it is seeded with the built-in backends here
    // and shared (by `Arc`) with the host below, so an enabled plugin's
    // connection type is immediately creatable and appears in the
    // connection-type list the UI offers — no separate wiring per plugin.
    let plugins_root = config_dir.join("plugins");
    let connection_registry = std::sync::Arc::new(std::sync::Mutex::new(build_desktop_registry()));
    let plugin_host = std::sync::Arc::new(termihub_core::plugin::PluginHost::new(
        plugins_root.clone(),
        std::sync::Arc::clone(&connection_registry),
    ));
    app.manage(termihub_core::plugin::PluginManager::with_hook(
        plugins_root,
        std::sync::Arc::new(termihub_core::plugin::HostLifecycleHook::new(
            std::sync::Arc::clone(&plugin_host),
        )),
    ));
    app.manage(plugin_host);

    // Security: if a host upgrade made any installed plugin's API version
    // incompatible, auto-disable it so it never loads, and notify the UI
    // (concept §13, "App update changes the plugin API version →
    // incompatible plugins are auto-disabled with a notification").
    if let Some(plugin_mgr) = app.try_state::<termihub_core::plugin::PluginManager>() {
        match plugin_mgr.reconcile_compatibility() {
            Ok(disabled) if !disabled.is_empty() => {
                warn!("auto-disabled now-incompatible plugins: {disabled:?}");
                let _ = app.emit(commands::plugin::EVENT_PLUGINS_CHANGED, ());
            }
            Ok(_) => {}
            Err(e) => warn!("plugin compatibility reconciliation failed: {e}"),
        }

        // Load plugins that were already enabled in a previous session.
        // The manager's scan restores each plugin's persisted enabled
        // flag but does no loading, so without this an already-enabled
        // plugin's connection type is never registered until the user
        // toggles it off/on — a persisted connection of that type would
        // fail to resolve after a restart (#2010). This drives the same
        // host load path a fresh enable uses; a plugin that fails to load
        // surfaces as `Error` and is skipped, never aborting startup.
        match plugin_mgr.load_enabled_plugins() {
            Ok(loaded) => {
                let failed: Vec<_> = loaded
                    .iter()
                    .filter(|p| p.state == termihub_core::plugin::PluginState::Error)
                    .map(|p| p.manifest.id.clone())
                    .collect();
                if !failed.is_empty() {
                    warn!("plugins that failed to load at startup: {failed:?}");
                    let _ = app.emit(commands::plugin::EVENT_PLUGINS_CHANGED, ());
                }
            }
            Err(e) => warn!("loading already-enabled plugins at startup failed: {e}"),
        }
    }

    connection_registry
}

pub(crate) fn init_network(app: &tauri::App, config_dir: std::path::PathBuf) {
    // Construct the network manager fully-initialised, then hand it to
    // Tauri as shared managed state. Building it here (rather than in the
    // builder chain, then mutating it through a `*const → *mut` cast on the
    // shared `State` reference) removes the aliasing UB flagged by
    // TAURI-001 / ARCH-011: `init` takes `&mut self` on this still-owned
    // value, before any shared reference to it can exist.
    let mut network_manager = NetworkManager::new();
    network_manager.init(config_dir.clone(), app.handle().clone());
    // Managed behind an `Arc` so background tasks (port scan, ping,
    // traceroute) can hold an owned, lifetime-checked handle to the
    // manager instead of laundering a `State` reference through a
    // `usize` pointer (TAURI-002).
    app.manage(Arc::new(network_manager));
}

pub(crate) fn init_credentials_and_connections(
    app: &tauri::App,
    config_dir: std::path::PathBuf,
    recovery_warnings: &mut Vec<crate::connection::recovery::RecoveryWarning>,
) {
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
                message: "Could not initialize settings storage, using defaults.".to_string(),
                details: Some(e.to_string()),
            });
            AppSettings::default()
        }
    };

    let storage_mode = StorageMode::from_settings_str(settings.credential_storage_mode.as_deref());
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

    // Set up auto-lock timer for master password mode.
    //
    // Fail-safe (WA-RS-004): a thread-spawn failure must not panic. If the
    // timer thread cannot start we install no timer and force the store
    // locked. The unlock commands refuse to unlock while no timer is
    // installed (see `has_auto_lock_timer`), so credentials are never left
    // unlocked with nothing to auto-lock them after inactivity.
    let auto_lock_minutes = settings.credential_auto_lock_minutes.or(Some(15));
    match AutoLockTimer::new(
        app.handle().clone(),
        credential_manager.clone(),
        auto_lock_minutes,
    ) {
        Ok(auto_lock_timer) => {
            credential_manager.set_auto_lock_timer(auto_lock_timer);
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                "Failed to spawn auto-lock timer thread; keeping credential store \
                 locked and refusing unlock until the app is restarted"
            );
            // Belt-and-suspenders: ensure the store is locked even if a
            // credentials file existed and something had unlocked it.
            credential_manager.with_master_password_store(|s| s.lock());
        }
    }

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
}

pub(crate) fn init_session_managers(
    app: &tauri::App,
    connection_registry: std::sync::Arc<
        std::sync::Mutex<termihub_core::connection::ConnectionTypeRegistry>,
    >,
    x_server_manager: &std::sync::Arc<crate::terminal::xserver::XServerManager>,
    x_server_consent_registry: &std::sync::Arc<crate::terminal::xserver::ConnectConsentRegistry>,
) {
    let agent_manager: Arc<dyn AgentRpcClient> =
        Arc::new(AgentConnectionManager::new(app.handle().clone()));

    // Create the SessionManager over the registry shared with the plugin
    // host (built above, seeded with the built-in backends), so plugin
    // connection types are creatable and listed here (#1999).
    let session_manager = SessionManager::with_shared_registry(
        std::sync::Arc::clone(&connection_registry),
        agent_manager.clone(),
    );
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
    let ssh_host_key_verifier = std::sync::Arc::new(
        crate::session::ssh_host_key_verifier::SshHostKeyVerifier::new(
            ssh_trust_store,
            std::sync::Arc::new(app.handle().clone()),
        ),
    );
    if !termihub_core::backends::ssh::host_key::set_host_key_verifier(ssh_host_key_verifier.clone())
    {
        tracing::warn!("SSH host-key verifier was already registered");
    }
    app.manage(ssh_host_key_verifier);

    // SSH keyboard-interactive (OTP / 2FA / PAM) prompts (#3371): register the
    // desktop prompter so every SSH connect path (terminal, tunnel, SFTP, jump
    // hops, Test Connection) can ask the user through the in-app dialog.
    let ssh_ki_prompter = std::sync::Arc::new(
        crate::session::ssh_keyboard_interactive::SshKeyboardInteractivePrompter::new(
            std::sync::Arc::new(app.handle().clone()),
        ),
    );
    if !termihub_core::backends::ssh::keyboard_interactive::set_keyboard_interactive_prompter(
        ssh_ki_prompter.clone(),
    ) {
        tracing::warn!("SSH keyboard-interactive prompter was already registered");
    }
    app.manage(ssh_ki_prompter);

    // X server provisioning (#1052): register the provisioner so the SSH
    // connect path can ensure a local X server before X11 forwarding
    // starts. The manager itself (#1049) is created and managed above.
    terminal::xserver::init(
        app.handle(),
        x_server_manager.clone(),
        x_server_consent_registry.clone(),
    );
}

pub(crate) fn init_tunnels(
    app: &tauri::App,
    recovery_warnings: &mut Vec<crate::connection::recovery::RecoveryWarning>,
) {
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
                if let Some(mgr) = handle.try_state::<Arc<tunnel::tunnel_manager::TunnelManager>>()
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
}

fn register_all_projection_intents(app: &tauri::App) -> crate::projection::HandlerRegistry {
    let mut registry = crate::projection::HandlerRegistry::new();
    tunnel::projection::register_tunnel_intents(&mut registry, app.handle().clone());
    // Shadow LayoutStore (#2151 step 1): client-scoped
    // `layout@<clientId>` region + `layout.*` intents on the ported
    // panel-tree algebra (#2143). Layout is the remaining migration
    // outlier: the store is managed authoritative state and serves
    // intents, but nothing in the live UI subscribes to or renders the
    // region yet — still a shadow (deferred reducer removal tracked as
    // #2562; steps 2+ cut mutations, then rendering, over to it). No
    // client region is seeded here: layout regions are client-scoped
    // and created lazily on a client's first `layout.*` intent.
    app.manage(Arc::new(layout::LayoutStore::new()));
    layout::projection::register_layout_intents(&mut registry, app.handle().clone());
    // SessionLifecycleStore (#2152 step 1): the shared
    // `session-lifecycle` region + `session.*` intents on the ported
    // auto-reconnect engine (#2144). Authoritative and driving the live
    // UI (stateless-UI inversion complete, #2283): the terminal
    // overlays render from the region and the transitions route through
    // the intents; the appStore lifecycle reducers were removed. The
    // shared region is seeded below once the store is managed.
    app.manage(Arc::new(session_projection::SessionLifecycleStore::new()));
    session_projection::projection::register_session_intents(&mut registry, app.handle().clone());
    // RestoreCohortStore (#2206, Phase 4 step 5): the client-scoped
    // `restore-cohort@<clientId>` region + `restore.*` intents
    // modelling the startup restore/launch cohort aggregation (#1146 /
    // #1227). Now the sole source of truth (reducer removal): the live
    // UI renders the aggregate summary toast from the projected
    // settlement and routes begin/settle through the intents; the
    // appStore cohort reducers were removed. No client region is seeded
    // here: like layout, restore-cohort regions are client-scoped and
    // created lazily on a client's first `restore.*` intent.
    app.manage(Arc::new(
        restore_cohort_projection::RestoreCohortStore::new(),
    ));
    restore_cohort_projection::projection::register_restore_intents(
        &mut registry,
        app.handle().clone(),
    );
    // BroadcastStore (#2242, Phase 4 step 5b, part of #2206): the
    // client-scoped `broadcast@<clientId>` region + `broadcast.*`
    // intents modeling the broadcast-input membership slice (which
    // tabs receive mirrored input, #1955 / #1956 / #1958). The live
    // UI renders the broadcast UI from the region and routes the
    // membership actions through the intents; the former appStore
    // reducers and the render/mutation-cut flags were removed
    // (stateless-UI inversion complete, #2283). No client region is
    // seeded here: like layout and
    // restore-cohort, broadcast regions are client-scoped and created
    // lazily on a client's first `broadcast.*` intent.
    app.manage(Arc::new(broadcast_projection::BroadcastStore::new()));
    broadcast_projection::projection::register_broadcast_intents(
        &mut registry,
        app.handle().clone(),
    );
    // WorkflowRunStore (#2243, Phase 4 step 5c, part of
    // #2206): the client-scoped `workflow-run@<clientId>` region +
    // `workflow.*` intents modeling the in-flight workflow-run state
    // machine (run step-progress + the dismissible local-process
    // output panel, #1852 / #1865). Authoritative and driving the live
    // UI (stateless-UI inversion complete, #2283): the Workflow
    // Manager renders from the region and the run transitions route
    // through the intents; the appStore run reducers were removed. No
    // client region is seeded here: like layout, restore-cohort, and
    // broadcast, workflow-run regions are client-scoped and created
    // lazily on a client's first `workflow.*` intent.
    app.manage(Arc::new(workflow_projection::WorkflowRunStore::new()));
    workflow_projection::projection::register_workflow_intents(&mut registry, app.handle().clone());
    // FileBrowserStore (#2228, Phase 5, part of #2153): the
    // client-scoped `file-browser@<clientId>` region +
    // `fileBrowser.*` intents modeling the file-browser UI *view*
    // state (the local/sftp/session browser panes — each cwd +
    // listing — the active `fileBrowserMode`, and the copy/cut
    // `fileClipboard`). Only the browser view: the backend
    // SFTP/session *session* model (sessions, connect status,
    // transfers) stays out of scope (#2236). Authoritative and
    // driving the live UI (stateless-UI inversion complete, #2283):
    // the browser panels render from the region and the browser
    // actions route through the intents; the appStore file-browser
    // reducers were removed. No client region is seeded here: like
    // layout, broadcast, and workflow-run, file-browser regions are
    // client-scoped and created lazily on a client's first
    // `fileBrowser.*` intent.
    app.manage(Arc::new(file_browser_projection::FileBrowserStore::new()));
    file_browser_projection::projection::register_file_browser_intents(
        &mut registry,
        app.handle().clone(),
    );
    // SystemMonitorStore (#2224, Phase 5): the shared
    // `system-monitors` region + `monitor.*` intents on the
    // monitoring types shared with the agent crate
    // (`termihub_core::monitoring`). Authoritative and driving the live
    // UI (stateless-UI inversion complete, #2283): the status bar and
    // Open Connections render from the region and the transitions route
    // through the intents; the appStore monitoring reducers were
    // removed. The shared region is seeded below once the store is
    // managed.
    app.manage(Arc::new(
        system_monitor_projection::SystemMonitorStore::new(),
    ));
    system_monitor_projection::projection::register_monitor_intents(
        &mut registry,
        app.handle().clone(),
    );
    // AgentsStore (#2226, Phase 5): the shared `agents` region
    // + `agent.*` intents modeling the agents slice (the
    // ordered agent list + per-agent sessions/definitions/folders).
    // ConnectionsStore (#2225, Phase 5): the shared
    // `connections` region + `connection.*` intents, wrapping the
    // existing saved-connection authority (`crate::connection`).
    // Both are authoritative and drive the live UI (stateless-UI
    // inversion complete, #2283): the sidebar renders from the regions
    // and the actions route through the intents; the appStore agents
    // and connections reducers were removed. The shared region is
    // seeded below once the store is managed.
    app.manage(Arc::new(agents_projection::AgentsStore::new()));
    agents_projection::projection::register_agent_intents(&mut registry, app.handle().clone());
    app.manage(Arc::new(connections_projection::ConnectionsStore::new()));
    connections_projection::projection::register_connection_intents(
        &mut registry,
        app.handle().clone(),
    );
    // SettingsStore (#2227, Phase 5): the shared `settings`
    // region + `settings.*` intents modeling the
    // `AppSettings` document (the persisted user-preferences slice),
    // held opaquely as JSON. Authoritative and driving the live UI
    // (stateless-UI inversion complete, #2283): the live UI renders
    // from the region and the settings actions route through the
    // intents; the appStore settings reducers were removed. The shared
    // region is seeded below once the store is managed.
    app.manage(Arc::new(settings_projection::SettingsStore::new()));
    settings_projection::projection::register_settings_intents(&mut registry, app.handle().clone());
    // TransferStore (#2229, Phase 5): the shared `transfers`
    // region + `transfer.*` intents modeling the Transfer
    // Queue slice (per-transfer queue-row lifecycle + the
    // panel-minimized flag), mirroring the frontend `TransferEntry`
    // folds. Authoritative and driving the live UI (stateless-UI
    // inversion complete, #2283): the Transfer Queue panel and Open
    // Connections render from the region and the actions route through
    // the intents; the appStore transfer reducers were removed. The
    // shared region is seeded below once the store is managed.
    app.manage(Arc::new(transfers_projection::TransferStore::new()));
    transfers_projection::projection::register_transfer_intents(
        &mut registry,
        app.handle().clone(),
    );
    // Test-bridge-only: add the diagnostic region's `diag.*` routes so
    // the projection-assertion harness (#2164) has a self-contained
    // region to drive. Never registered in production launches. See
    // `commands::projection_diag`.
    // Test-bridge-only (SEC-005): the diagnostic region + its routes
    // are compiled out of release builds along with the bridge.
    #[cfg(feature = "test-bridge")]
    if utils::test_bridge::is_test_bridge_enabled() {
        commands::projection_diag::register_diagnostic_routes(&mut registry);
    }

    registry
}

fn seed_projection_regions(
    app: &tauri::App,
    projection_state: &crate::commands::projection::ProjectionState,
) {
    if let Some(manager) = app
        .handle()
        .try_state::<Arc<tunnel::tunnel_manager::TunnelManager>>()
    {
        projection_state.projector.register_region(
            tunnel::projection::TUNNELS_REGION,
            tunnel::projection::build_tunnel_view(&manager),
        );
    }
    // Seed the shared `session-lifecycle` region with the (empty)
    // store baseline at version 0, so a subscriber attaches to a real
    // region before the first `session.*` intent (#2152).
    if let Some(store) = app
        .handle()
        .try_state::<Arc<session_projection::SessionLifecycleStore>>()
    {
        projection_state.projector.register_region(
            session_projection::projection::SESSION_LIFECYCLE_REGION,
            store.snapshot(),
        );
    }
    // Seed the shared `system-monitors` region with the (empty) store
    // baseline at version 0, so a subscriber attaches to a real region
    // before the first `monitor.*` intent (#2224).
    if let Some(store) = app
        .handle()
        .try_state::<Arc<system_monitor_projection::SystemMonitorStore>>()
    {
        projection_state.projector.register_region(
            system_monitor_projection::projection::SYSTEM_MONITORS_REGION,
            store.snapshot(),
        );
    }
    // Seed the shared `agents` region from the persisted
    // `ConnectionManager` agent list (#2403), so the store — and
    // the region a subscriber attaches to before the first `agent.*`
    // intent — reflects the real agent list-membership from startup
    // rather than an empty baseline. Seeding the persisted list here is
    // the startup counterpart to `fold_agents_from_manager`, which keeps
    // the store's list-membership in sync on every later add / delete /
    // reorder / reload (#2226). The per-agent live status stays store-
    // owned and starts disconnected.
    if let Some(store) = app
        .handle()
        .try_state::<Arc<agents_projection::AgentsStore>>()
    {
        if let Some(manager) = app.handle().try_state::<ConnectionManager>() {
            agents_projection::projection::seed_agents_from_manager(
                store.inner().as_ref(),
                manager.inner(),
            );
        }
        projection_state.projector.register_region(
            agents_projection::projection::AGENTS_REGION,
            store.snapshot(),
        );
    }
    // Seed the shared `connections` region from the persisted
    // `ConnectionManager` authority (#2389/#2394), so the store
    // — and the region a subscriber attaches to before the first
    // `connection.*` intent — reflects the real connections tree from
    // startup rather than an empty baseline. The seed uses the same
    // unified main + external-file view the frontend `appStore` holds,
    // so external-file connections are present in the region from
    // startup. The manager is the coarse authority: seeding its whole
    // snapshot here is the startup counterpart to
    // `fold_connections_from_manager`, which keeps the store in sync on
    // every later mutation (#2225).
    if let Some(store) = app
        .handle()
        .try_state::<Arc<connections_projection::ConnectionsStore>>()
    {
        if let Some(manager) = app.handle().try_state::<ConnectionManager>() {
            if let Ok(view) = manager.load_unified_view() {
                store.replace(view.folders, view.connections);
            }
        }
        projection_state.projector.register_region(
            connections_projection::projection::CONNECTIONS_REGION,
            store.snapshot(),
        );
    }
    // Seed the shared `settings` region from the persisted
    // `AppSettings` authority (#2386), so the store — and the
    // region a subscriber attaches to before the first `settings.*`
    // intent — reflects the real persisted preferences document from
    // startup rather than the default baseline. Seeding the resolved
    // document here is the startup counterpart to
    // `fold_settings_from_manager`, which keeps the store in sync on
    // every later `save_settings` (#2227).
    if let Some(store) = app
        .handle()
        .try_state::<Arc<settings_projection::SettingsStore>>()
    {
        if let Some(manager) = app.handle().try_state::<ConnectionManager>() {
            if let Ok(serde_json::Value::Object(doc)) =
                serde_json::to_value(manager.get_settings_resolved())
            {
                store.replace(doc);
            }
        }
        projection_state.projector.register_region(
            settings_projection::projection::SETTINGS_REGION,
            store.snapshot(),
        );
    }
    // Seed the shared `transfers` region (#2229). Before registering it,
    // rehydrate any transfers that a previous run persisted while still
    // in-flight (PROD-0011): they come back as *paused* rows so the Transfer
    // Queue panel shows them on startup and the user explicitly resumes them
    // (never auto-resumed). They flow through the same shared region, so no
    // frontend change is needed. On an empty/missing/corrupt store this seeds
    // nothing and the region starts empty as before.
    if let Some(store) = app
        .handle()
        .try_state::<Arc<transfers_projection::TransferStore>>()
    {
        if let Some(pm) = app
            .handle()
            .try_state::<crate::files::transfer::TransferPersistenceManager>()
        {
            seed_rehydrated_transfers(store.as_ref(), pm.load_incomplete_as_paused());
        }
        projection_state.projector.register_region(
            transfers_projection::projection::TRANSFERS_REGION,
            store.snapshot(),
        );
    }
    #[cfg(feature = "test-bridge")]
    if utils::test_bridge::is_test_bridge_enabled() {
        projection_state.projector.register_region(
            commands::projection_diag::DIAG_REGION,
            commands::projection_diag::initial_view(),
        );
    }
}

/// Initialize the durable transfer-queue persistence (PROD-0011) and manage it.
///
/// A corrupt/newer `transfers.json` is handled by the shared recovery layer
/// (backed up + reset, or left intact for a newer version); the warning is logged
/// rather than surfaced, since this is an internal queue file, not user data. On a
/// hard init failure the app still starts — the queue is simply not durable this
/// run.
fn init_transfer_persistence(app: &tauri::App) {
    match crate::files::transfer::TransferPersistenceManager::new(app.handle()) {
        Ok(manager) => {
            for w in manager.take_recovery_warnings() {
                tracing::warn!(file = %w.file_name, details = ?w.details, "{}", w.message);
            }
            app.manage(manager);
        }
        Err(e) => {
            tracing::error!("Failed to initialize transfer-queue persistence (PROD-0011): {e}");
        }
    }
}

/// Seed rehydrated (paused) transfers from a previous run into the shared
/// `transfers` store, so the Transfer Queue panel shows them on startup
/// (PROD-0011). Each persisted incomplete transfer is rendered as a `paused` row;
/// the user explicitly resumes it (never auto-resumed). A no-op when nothing was
/// persisted.
fn seed_rehydrated_transfers(
    store: &transfers_projection::TransferStore,
    records: Vec<crate::files::transfer::PersistedTransfer>,
) {
    use crate::files::transfer::TransferDirection as EngineDirection;
    use std::collections::HashMap;
    use transfers_projection::store::{TransferDirection, TransferEntry, TransferQueueState};

    if records.is_empty() {
        return;
    }
    let mut queue: HashMap<String, TransferEntry> = HashMap::with_capacity(records.len());
    for r in records {
        let direction = match r.direction {
            EngineDirection::Download => TransferDirection::Download,
            EngineDirection::Upload => TransferDirection::Upload,
        };
        let total_bytes = (r.total > 0).then_some(r.total);
        let percent = total_bytes.map(|t| {
            ((r.transferred as f64 / t as f64) * 100.0)
                .round()
                .clamp(0.0, 100.0) as u32
        });
        let entry = TransferEntry {
            id: r.transfer_id.clone(),
            session_id: r.session_id,
            direction,
            name: r.file_name,
            path: (!r.remote_path.is_empty()).then_some(r.remote_path),
            state: TransferQueueState::Paused,
            transferred: r.transferred,
            total_bytes,
            percent,
            speed_bytes_per_sec: None,
            eta_seconds: None,
            error: None,
            attempt: None,
            max_attempts: None,
            updated_at: r.updated_at_ms,
        };
        queue.insert(r.transfer_id, entry);
    }
    // The store is empty at startup; replacing with the rehydrated set (panel not
    // minimized) makes every persisted in-flight transfer show as paused.
    store.replace(queue, false);
}

fn init_reconnect_driver(
    app: &tauri::App,
    projection_state: &crate::commands::projection::ProjectionState,
) {
    // Backend reconnect timer driver (#2203, Phase 4 step 2): moves
    // the frontend `setTimeout` reconnect loop server-side. Built
    // here — after the projector exists — so a fired backoff timer
    // can advance the store and fan the `session-lifecycle` diff out
    // itself. The session-lifecycle store is authoritative (#2283):
    // its `Waiting` phases arm the driver, which drives the
    // `reconnectAttempt` edge on the ported #2144 backoff schedule.
    if let Some(store) = app
        .handle()
        .try_state::<Arc<session_projection::SessionLifecycleStore>>()
    {
        let store: Arc<session_projection::SessionLifecycleStore> = (*store).clone();
        let projector = projection_state.projector.clone();
        let store_for_publish = store.clone();
        // Backend-driven reconnect redrive (#2454): on the fired
        // attempt the backend re-establishes the transport itself for
        // a resilient tab, mints a new session and publishes its id for
        // the frontend to re-attach to (#2457). Resolves managed state
        // lazily, so it can be fed back into the very driver that
        // invokes it without a cycle. No-op for a tab with no retained
        // request.
        let redrive: Arc<dyn session_projection::ReconnectRedrive> = Arc::new(
            session_projection::AppReconnectRedrive::new(app.handle().clone()),
        );
        let driver = Arc::new(
            session_projection::ReconnectTimerDriver::new(
                store,
                Arc::new(session_projection::TokioReconnectScheduler::new()),
                Arc::new(move || {
                    session_projection::projection::publish_sessions(
                        &projector,
                        &store_for_publish,
                    );
                }),
            )
            .with_redrive(redrive),
        );
        app.manage(driver);
    }
}

pub(crate) fn init_projection(app: &tauri::App) {
    // Durable transfer queue (PROD-0011): initialize persistence with recovery
    // loading and manage it *before* seeding, so the `transfers` region can be
    // rehydrated from disk below (and later registrations/progress persist). On
    // failure the app still starts; the queue simply is not durable this run.
    init_transfer_persistence(app);
    // Stateless-UI projection substrate (#2149) + SSH-tunnels pilot
    // (#2150). Built here — not in the builder chain — so the tunnel
    // manager (managed just above) can seed the `tunnels` region and
    // serve the `tunnel.*` intents. If the tunnel manager failed to
    // initialize, the region/intents degrade gracefully (intents reject
    // `unavailable`; the region stays empty).
    let registry = register_all_projection_intents(app);
    let projection_state = commands::projection::ProjectionState::with_handler(Arc::new(registry));
    seed_projection_regions(app, &projection_state);
    init_reconnect_driver(app, &projection_state);
    app.manage(projection_state);
}

pub(crate) fn init_secondary_managers(
    app: &tauri::App,
    recovery_warnings: &mut Vec<crate::connection::recovery::RecoveryWarning>,
) {
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

    // Initialize the schedule manager (PROD-043) and start the scheduler loop.
    // On failure, the app still starts but scheduled runs are unavailable.
    match schedules::manager::ScheduleManager::new(app.handle()) {
        Ok(manager) => {
            recovery_warnings.extend(manager.take_recovery_warnings());
            app.manage(Arc::new(manager));
            schedules::runner::start(app.handle());
        }
        Err(e) => {
            tracing::error!("Failed to initialize schedule manager: {e}");
            recovery_warnings.push(RecoveryWarning {
                file_name: "schedules.json".to_string(),
                message: "Could not initialize schedule storage. Scheduled runs are unavailable until the app is restarted.".to_string(),
                details: Some(e.to_string()),
            });
        }
    }

    // Initialize the network-tool run-history manager (PROD-032). On failure
    // the app still starts; recording from the tool panels is fire-and-forget
    // and the history view shows an error instead of past runs.
    match network::tool_history_manager::NetworkToolHistoryManager::new(app.handle()) {
        Ok(manager) => {
            recovery_warnings.extend(manager.take_recovery_warnings());
            app.manage(manager);
        }
        Err(e) => {
            tracing::error!("Failed to initialize network tool history manager: {e}");
            recovery_warnings.push(RecoveryWarning {
                file_name: "network-tool-history.json".to_string(),
                message: "Could not initialize network tool history storage. Tool run history is unavailable until the app is restarted.".to_string(),
                details: Some(e.to_string()),
            });
        }
    }

    // Initialize the workflow run-history manager with recovery loading
    // (PROD-0046). On failure, the app still starts but run history is
    // unavailable (recording is fire-and-forget on the frontend regardless).
    match workflows::history_manager::WorkflowRunHistoryManager::new(app.handle()) {
        Ok(manager) => {
            recovery_warnings.extend(manager.take_recovery_warnings());
            app.manage(manager);
        }
        Err(e) => {
            tracing::error!("Failed to initialize workflow run-history manager: {e}");
            recovery_warnings.push(RecoveryWarning {
                file_name: "runs.json".to_string(),
                message: "Could not initialize workflow run-history storage. Run history is unavailable until the app is restarted.".to_string(),
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
                if let Some(mgr) =
                    handle.try_state::<embedded_servers::server_manager::EmbeddedServerManager>()
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
}

pub(crate) fn handle_cli_list_workspaces(app: &tauri::App) {
    // Handle --list-workspaces CLI flag: print workspace list and exit
    {
        use tauri_plugin_cli::CliExt;
        if let Ok(matches) = app.cli().matches() {
            if let Some(arg) = matches.args.get("list-workspaces") {
                if arg.occurrences > 0 {
                    if let Some(mgr) = app.try_state::<workspace::manager::WorkspaceManager>() {
                        match mgr.get_workspaces() {
                            Ok(workspaces) if workspaces.is_empty() => {
                                println!("No workspaces configured.");
                            }
                            Ok(workspaces) => {
                                for ws in &workspaces {
                                    let desc = ws.description.as_deref().unwrap_or("");
                                    println!(
                                        "{}\t{}\t{} tab(s)\t{}",
                                        ws.id, ws.name, ws.connection_count, desc
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
}

pub(crate) fn init_spawn_ipc(app: &tauri::App, pending_spawn: Option<crate::spawn::SpawnRequest>) {
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
            // App-lifetime accept loop: owned by `AppTasks` (ARCH-007) so
            // teardown cancels the token (breaking the accept) and awaits
            // it, rather than leaving the IPC server accepting on exit.
            let tasks = app.state::<app_tasks::AppTasks>();
            let cancel = tasks.cancellation_token();
            tasks.spawn(async move {
                tokio::select! {
                    res = spawn::ipc_server::serve(&endpoint, handler) => {
                        if let Err(e) = res {
                            tracing::warn!("spawn IPC server stopped: {e}");
                        }
                    }
                    _ = cancel.cancelled() => {
                        tracing::info!("spawn IPC server cancelled on shutdown (ARCH-007)");
                    }
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
}

pub(crate) fn finalize(
    app: &tauri::App,
    recovery_warnings: Vec<crate::connection::recovery::RecoveryWarning>,
    connections_file: std::path::PathBuf,
) {
    // Store recovery warnings so the frontend can retrieve them
    app.manage(Mutex::new(recovery_warnings));

    // Watch connections.json for changes made by other running instances.
    // Each instance polls independently; when any instance writes the file,
    // all others detect the mtime change and reload within ~1 second.
    {
        let handle = app.handle().clone();
        // App-lifetime poll loop: owned by `AppTasks` (ARCH-007) so the
        // 1s watcher stops at teardown (via the cancellation token)
        // instead of polling on past shutdown.
        let tasks = app.state::<app_tasks::AppTasks>();
        let cancel = tasks.cancellation_token();
        tasks.spawn(async move {
            use std::time::SystemTime;
            let mut last_mtime: Option<SystemTime> = std::fs::metadata(&connections_file)
                .ok()
                .and_then(|m| m.modified().ok());
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = cancel.cancelled() => {
                        tracing::info!(
                            "connections.json watcher cancelled on shutdown (ARCH-007)"
                        );
                        break;
                    }
                }
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
}
