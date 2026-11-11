//! Mock-app tests for the network, session, tunnel, secondary-manager and
//! finalize boot phases (#5313), following the #5311 approach in
//! `phases_tests.rs`.
//!
//! Every phase runs on `tauri::test::mock_app()` with a managed
//! [`ConfigDirOverride`] pointing at a temp dir, so no phase can reach the real
//! data dir. The `AppHandle`-bound wiring each phase hands off (the Wry-only
//! managers, process-wide registrations, the scheduler loop) is swapped for a
//! recorder. No window is built and no keychain is read: no credential manager
//! is managed, so the embedded-server manager falls back to the null store.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::test::{mock_app, MockRuntime};
use tauri::{Listener, Manager};

use super::{
    finalize, init_network_with, init_secondary_managers_with, init_session_managers_with,
    init_tunnels_with,
};
use crate::app_tasks::AppTasks;
use crate::connection::recovery::RecoveryWarning;
use crate::network::NetworkManager;
use crate::utils::config_paths::ConfigDirOverride;

type MockApp = tauri::App<MockRuntime>;

/// A mock app whose every storage module resolves to `config_dir`.
fn app_at(config_dir: &Path) -> MockApp {
    let app = mock_app();
    app.manage(ConfigDirOverride(config_dir.to_path_buf()));
    app
}

fn file_names(warnings: &[RecoveryWarning]) -> Vec<&str> {
    warnings.iter().map(|w| w.file_name.as_str()).collect()
}

/// A config dir that can never be created: the path exists as a file.
fn blocked_config_dir(tmp: &Path) -> std::path::PathBuf {
    let blocked = tmp.join("config-is-a-file");
    std::fs::write(&blocked, b"").unwrap();
    blocked
}

// ── Network phase ───────────────────────────────────────────────────────────

fn boot_network(config_dir: &Path) -> (MockApp, Vec<RecoveryWarning>, usize) {
    let app = app_at(config_dir);
    let mut warnings = Vec::new();
    let mut attached = 0;
    init_network_with(&app, config_dir.to_path_buf(), &mut warnings, |_| {
        attached += 1;
    });
    (app, warnings, attached)
}

#[test]
fn the_network_phase_manages_the_network_manager_without_warnings() {
    let tmp = tempfile::tempdir().unwrap();

    let (app, warnings, attached) = boot_network(tmp.path());

    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(attached, 1);
    assert!(app.try_state::<Arc<NetworkManager>>().is_some());
}

#[test]
fn a_corrupt_wol_devices_file_adds_a_warning_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("wol-devices.json"), "{ not json").unwrap();

    let (app, warnings, attached) = boot_network(tmp.path());

    assert_eq!(file_names(&warnings), vec!["wol-devices.json"]);
    assert_eq!(attached, 1);
    assert!(app.try_state::<Arc<NetworkManager>>().is_some());
}

#[test]
fn a_corrupt_http_monitors_file_adds_a_warning_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("http-monitors.json"), "[[[").unwrap();

    let (app, warnings, attached) = boot_network(tmp.path());

    assert_eq!(file_names(&warnings), vec!["http-monitors.json"]);
    assert_eq!(attached, 1);
    assert!(app.try_state::<Arc<NetworkManager>>().is_some());
}

// ── Session-managers phase ──────────────────────────────────────────────────

fn boot_sessions(config_dir: &Path) -> (Vec<RecoveryWarning>, usize) {
    let app = app_at(config_dir);
    let mut warnings = Vec::new();
    let mut attached = 0;
    init_session_managers_with(&app, &mut warnings, |_| attached += 1);
    (warnings, attached)
}

#[test]
fn the_session_phase_opens_both_trust_stores_without_warnings() {
    let tmp = tempfile::tempdir().unwrap();

    let (warnings, attached) = boot_sessions(tmp.path());

    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(attached, 1);
}

#[test]
fn a_corrupt_rdp_trust_store_adds_a_warning_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("rdp_known_hosts.json"), "not json").unwrap();

    let (warnings, attached) = boot_sessions(tmp.path());

    assert_eq!(file_names(&warnings), vec!["rdp_known_hosts.json"]);
    assert_eq!(attached, 1);
}

#[test]
fn a_corrupt_ssh_trust_store_adds_a_warning_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("ssh_known_hosts.json"), "not json").unwrap();

    let (warnings, attached) = boot_sessions(tmp.path());

    assert_eq!(file_names(&warnings), vec!["ssh_known_hosts.json"]);
    assert_eq!(attached, 1);
}

#[test]
fn both_corrupt_trust_stores_warn_rdp_first() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("rdp_known_hosts.json"), "not json").unwrap();
    std::fs::write(tmp.path().join("ssh_known_hosts.json"), "not json").unwrap();

    let (warnings, attached) = boot_sessions(tmp.path());

    assert_eq!(
        file_names(&warnings),
        vec!["rdp_known_hosts.json", "ssh_known_hosts.json"]
    );
    assert_eq!(attached, 1);
}

// ── Tunnels phase ───────────────────────────────────────────────────────────

fn boot_tunnels(config_dir: &Path) -> (Vec<RecoveryWarning>, usize) {
    let app = app_at(config_dir);
    let mut warnings = Vec::new();
    let mut attached = 0;
    init_tunnels_with(&app, &mut warnings, |loaded| {
        // The warnings were taken into the accumulator before the hand-off.
        assert!(loaded.warnings.is_empty());
        attached += 1;
    });
    (warnings, attached)
}

#[test]
fn the_tunnels_phase_loads_without_warnings() {
    let tmp = tempfile::tempdir().unwrap();

    let (warnings, attached) = boot_tunnels(tmp.path());

    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(attached, 1);
}

#[test]
fn a_corrupt_tunnels_file_adds_a_warning_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("tunnels.json"), "{ not json").unwrap();

    let (warnings, attached) = boot_tunnels(tmp.path());

    assert_eq!(file_names(&warnings), vec!["tunnels.json"]);
    assert_eq!(attached, 1);
    assert!(tmp.path().join("tunnels.json.bak").exists());
}

#[test]
fn unusable_tunnel_storage_adds_a_warning_and_no_tunnel_manager() {
    let tmp = tempfile::tempdir().unwrap();
    let blocked = blocked_config_dir(tmp.path());

    let (warnings, attached) = boot_tunnels(&blocked);

    assert_eq!(file_names(&warnings), vec!["tunnels.json"]);
    assert!(warnings[0].message.contains("Tunnels are unavailable"));
    assert_eq!(attached, 0);
}

// ── Secondary-managers phase ────────────────────────────────────────────────

/// Every store the secondary-managers phase loads with recovery, in phase order.
const SECONDARY_STORES: [&str; 11] = [
    "workspaces.json",
    "macros.json",
    "macro-runs.json",
    "session-history.json",
    "workflows.json",
    "schedules.json",
    "network-tool-history.json",
    "file-browser-bookmarks.json",
    "http-monitor-history.json",
    "runs.json",
    "embedded_servers.json",
];

fn boot_secondary(config_dir: &Path) -> (MockApp, Vec<RecoveryWarning>, usize) {
    let app = app_at(config_dir);
    let mut warnings = Vec::new();
    let mut runner_starts = 0;
    init_secondary_managers_with(&app, &mut warnings, || runner_starts += 1);
    (app, warnings, runner_starts)
}

fn assert_secondary_managed(app: &MockApp) {
    use crate::{
        embedded_servers, files, macros, network, schedules, session_history, workflows, workspace,
    };
    assert!(app
        .try_state::<workspace::manager::WorkspaceManager>()
        .is_some());
    assert!(app.try_state::<macros::manager::MacroManager>().is_some());
    assert!(app
        .try_state::<macros::history_manager::MacroRunHistoryManager>()
        .is_some());
    assert!(app
        .try_state::<session_history::manager::SessionHistoryManager>()
        .is_some());
    assert!(app
        .try_state::<workflows::manager::WorkflowManager>()
        .is_some());
    assert!(app
        .try_state::<Arc<schedules::manager::ScheduleManager>>()
        .is_some());
    assert!(app
        .try_state::<network::tool_history_manager::NetworkToolHistoryManager>()
        .is_some());
    assert!(app
        .try_state::<files::bookmarks_manager::FileBookmarkManager>()
        .is_some());
    assert!(app
        .try_state::<network::monitor_history_manager::HttpMonitorHistoryManager>()
        .is_some());
    assert!(app
        .try_state::<workflows::history_manager::WorkflowRunHistoryManager>()
        .is_some());
    assert!(app
        .try_state::<workspace::last_session::LastSessionManager>()
        .is_some());
    assert!(app
        .try_state::<embedded_servers::server_manager::EmbeddedServerManager<MockRuntime>>()
        .is_some());
}

#[test]
fn the_secondary_phase_manages_every_manager_without_warnings() {
    let tmp = tempfile::tempdir().unwrap();

    let (app, warnings, runner_starts) = boot_secondary(tmp.path());

    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(runner_starts, 1);
    assert_secondary_managed(&app);
}

#[test]
fn each_corrupt_secondary_store_adds_its_warning_and_boot_continues() {
    for store in SECONDARY_STORES {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(store), "{ not json").unwrap();

        let (app, warnings, runner_starts) = boot_secondary(tmp.path());

        assert_eq!(file_names(&warnings), vec![store], "{store}: {warnings:?}");
        assert_eq!(runner_starts, 1, "{store}");
        // Every manager still comes up, the corrupt one over salvaged data.
        assert_secondary_managed(&app);
    }
}

#[test]
fn every_corrupt_secondary_store_warns_in_phase_order() {
    let tmp = tempfile::tempdir().unwrap();
    for store in SECONDARY_STORES {
        std::fs::write(tmp.path().join(store), "{ not json").unwrap();
    }

    let (app, warnings, runner_starts) = boot_secondary(tmp.path());

    assert_eq!(file_names(&warnings), SECONDARY_STORES.to_vec());
    assert_eq!(runner_starts, 1);
    assert_secondary_managed(&app);
}

#[test]
fn unusable_secondary_storage_warns_per_manager_and_boot_continues() {
    let tmp = tempfile::tempdir().unwrap();
    let blocked = blocked_config_dir(tmp.path());

    let (app, warnings, runner_starts) = boot_secondary(&blocked);

    // Each store reports that it is unavailable; none is managed and the
    // scheduler loop is not started without its manager.
    assert_eq!(file_names(&warnings), SECONDARY_STORES.to_vec());
    assert!(
        warnings
            .iter()
            .all(|w| w.message.starts_with("Could not initialize")),
        "{warnings:?}"
    );
    assert_eq!(runner_starts, 0);
    assert!(app
        .try_state::<crate::workspace::manager::WorkspaceManager>()
        .is_none());
    assert!(app
        .try_state::<crate::workspace::last_session::LastSessionManager>()
        .is_none());
}

// ── Finalize phase ──────────────────────────────────────────────────────────

fn warning(file_name: &str) -> RecoveryWarning {
    RecoveryWarning {
        file_name: file_name.to_string(),
        message: format!("{file_name} was recovered"),
        details: None,
    }
}

#[test]
fn finalize_manages_the_accumulated_warnings_and_watches_connections() {
    let tmp = tempfile::tempdir().unwrap();
    let connections_file = tmp.path().join("connections.json");
    let app = app_at(tmp.path());
    let tasks = AppTasks::new();
    app.manage(tasks.clone());
    let changed: Arc<Mutex<bool>> = Arc::default();
    let seen = changed.clone();
    app.listen_any("connections-changed", move |_| {
        *seen.lock().unwrap() = true;
    });

    finalize(
        &app,
        vec![warning("tunnels.json"), warning("macros.json")],
        connections_file.clone(),
    );

    let managed = app.state::<Mutex<Vec<RecoveryWarning>>>();
    assert_eq!(
        file_names(&managed.lock().unwrap()),
        vec!["tunnels.json", "macros.json"]
    );

    // Another instance writing connections.json is announced.
    // The file did not exist at `finalize`, so the watcher's baseline is
    // "absent" whenever its task first runs (#5353).
    std::fs::write(&connections_file, "{}").unwrap();
    assert!(
        wait_for(&changed, Duration::from_secs(10)),
        "no connections-changed event"
    );
    tasks.cancellation_token().cancel();
}

/// Waits up to `limit` for `flag` to become true.
fn wait_for(flag: &Mutex<bool>, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while !*flag.lock().unwrap() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let seen = *flag.lock().unwrap();
    seen
}

/// The watcher's baseline is the file as it was when `finalize` ran (#5353),
/// so an unchanged file is never announced and a later write always is,
/// regardless of when the poll task is first scheduled.
#[test]
fn finalize_watches_an_existing_connections_file_from_its_state_at_finalize() {
    let tmp = tempfile::tempdir().unwrap();
    let connections_file = tmp.path().join("connections.json");
    std::fs::write(&connections_file, "{}").unwrap();
    let app = app_at(tmp.path());
    let tasks = AppTasks::new();
    app.manage(tasks.clone());
    let changed: Arc<Mutex<bool>> = Arc::default();
    let seen = changed.clone();
    app.listen_any("connections-changed", move |_| {
        *seen.lock().unwrap() = true;
    });

    finalize(&app, Vec::new(), connections_file.clone());

    // Two poll ticks pass without a change: nothing is announced.
    assert!(
        !wait_for(&changed, Duration::from_millis(2_500)),
        "an unchanged connections.json was announced"
    );

    // Another instance rewrites it; set an mtime that is certainly newer so
    // the check does not depend on the filesystem's timestamp granularity.
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&connections_file)
        .unwrap();
    file.set_modified(std::time::SystemTime::now() + Duration::from_secs(60))
        .unwrap();
    drop(file);
    assert!(
        wait_for(&changed, Duration::from_secs(10)),
        "no connections-changed event"
    );
    tasks.cancellation_token().cancel();
}

#[test]
fn finalize_manages_an_empty_warning_list() {
    let tmp = tempfile::tempdir().unwrap();
    let app = app_at(tmp.path());
    let tasks = AppTasks::new();
    app.manage(tasks.clone());

    finalize(&app, Vec::new(), tmp.path().join("connections.json"));

    assert!(app
        .state::<Mutex<Vec<RecoveryWarning>>>()
        .lock()
        .unwrap()
        .is_empty());
    tasks.cancellation_token().cancel();
}
