//! End-to-end tests of the out-of-process plugin host (#4182, plugin
//! OS-sandbox phase 1): the real `echo-backend` example plugin, installed and
//! trusted through the real manager, loaded by [`PluginHost`] **through
//! `termihub-plugin-runner`**, and driven as an ordinary connection type.
//!
//! Covers the data path (echo, settings, ABI 1.1 context), the lifecycle
//! (spawn on load, bounded stop on unload, idle reap + lazy respawn, crash →
//! sessions end → respawn), and handshake failures (missing runner, a runner
//! that exits before `Hello`, a library the runner refuses).
#![cfg(feature = "plugin")]

use std::time::Duration;

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{fixture_library, Variant};
use plugin_runner_support::{
    host_for, install_echo, install_plugin, kill_process, new_connection, process_exists,
    runner_binary, wait_until,
};

use termihub_core::connection::ConnectionType;
use termihub_core::plugin::sandbox::PluginRunnerConfig;
use termihub_core::plugin::HostError;

const WAIT: Duration = Duration::from_secs(5);

async fn read_echo(rx: &mut termihub_core::connection::OutputReceiver) -> String {
    let chunk = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("echo within the timeout")
        .expect("an output chunk");
    String::from_utf8(chunk).expect("UTF-8 echo")
}

async fn connect(
    conn: &mut Box<dyn ConnectionType>,
    prefix: &str,
) -> termihub_core::connection::OutputReceiver {
    let rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "echoPrefix": prefix }))
        .await
        .expect("the session starts in the runner");
    rx
}

#[tokio::test(flavor = "multi_thread")]
async fn echo_backend_round_trips_through_the_runner() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());
    let (host, registry) = host_for(&echo);
    let host = host.with_runner(Some(PluginRunnerConfig::new(runner_binary())));
    host.load(&echo.plugin)
        .expect("the runner loads echo-backend");
    assert!(host.is_loaded(&echo.plugin.manifest.id));

    let handle = host
        .sandboxed_plugin(&echo.plugin.manifest.id)
        .expect("loaded out of process");
    assert_eq!(handle.info().id, "echo-backend");
    let pid = handle
        .running()
        .and_then(|p| p.pid())
        .expect("a runner pid");
    assert_ne!(
        pid,
        std::process::id(),
        "the plugin runs in another process"
    );
    // ABI 1.1: the host created the plugin's data directory.
    assert!(echo
        .root
        .join(termihub_core::plugin::PLUGIN_DATA_DIR_NAME)
        .join("echo-backend")
        .is_dir());

    // Two sessions multiplexed over the one runner, each with its own config.
    let mut a = new_connection(&registry, &echo.type_id);
    let mut b = new_connection(&registry, &echo.type_id);
    let mut rx_a = connect(&mut a, "a> ").await;
    let mut rx_b = connect(&mut b, "b> ").await;
    assert!(a.is_connected() && b.is_connected());
    a.write(b"hello").unwrap();
    b.write(b"world").unwrap();
    assert_eq!(read_echo(&mut rx_a).await, "a> hello");
    assert_eq!(read_echo(&mut rx_b).await, "b> world");
    a.resize(120, 40).expect("resize is queued");
    assert_eq!(handle.running().unwrap().session_count(), 2);

    a.disconnect().await.unwrap();
    assert!(!a.is_connected());
    assert_eq!(handle.running().unwrap().session_count(), 1);
    b.write(b"still").unwrap();
    assert_eq!(read_echo(&mut rx_b).await, "b> still");

    // Unload: bounded close + Shutdown; the runner exits and the remaining
    // session ends with it.
    host.unload(&echo.plugin.manifest.id);
    assert!(
        wait_until(WAIT, || !process_exists(pid)),
        "the runner exits on unload"
    );
    assert!(!b.is_connected());
    assert!(b.write(b"gone").is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crashed_runner_ends_its_sessions_and_respawns_for_the_next() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());
    let (host, registry) = host_for(&echo);
    let host = host.with_runner(Some(PluginRunnerConfig::new(runner_binary())));
    host.load(&echo.plugin).unwrap();
    let handle = host.sandboxed_plugin(&echo.plugin.manifest.id).unwrap();

    let mut conn = new_connection(&registry, &echo.type_id);
    let mut rx = connect(&mut conn, "").await;
    conn.write(b"ping").unwrap();
    assert_eq!(read_echo(&mut rx).await, "ping");
    let pid = handle.running().unwrap().pid().unwrap();

    // The plugin process dies (segfault, OOM kill, …): the host survives, the
    // session reports not connected, and its output stream ends.
    kill_process(pid);
    assert!(wait_until(WAIT, || !conn.is_connected()));
    let ended = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("stream ends");
    assert!(ended.is_none(), "no output after the crash");

    // The next session respawns the runner (re-verifying the library).
    let mut next = new_connection(&registry, &echo.type_id);
    let mut rx_next = connect(&mut next, "").await;
    next.write(b"again").unwrap();
    assert_eq!(read_echo(&mut rx_next).await, "again");
    let new_pid = handle.running().unwrap().pid().unwrap();
    assert_ne!(new_pid, pid);
    host.unload(&echo.plugin.manifest.id);
    assert!(wait_until(WAIT, || !process_exists(new_pid)));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_runner_is_reaped_and_respawned_lazily() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());
    let (host, registry) = host_for(&echo);
    let host = host.with_runner(Some(
        PluginRunnerConfig::new(runner_binary()).with_idle_timeout(Duration::from_millis(200)),
    ));
    host.load(&echo.plugin).unwrap();
    let handle = host.sandboxed_plugin(&echo.plugin.manifest.id).unwrap();
    let pid = handle.running().unwrap().pid().unwrap();

    // No sessions: after the idle timeout the runner is shut down.
    assert!(wait_until(WAIT, || handle.running().is_none()));
    assert!(wait_until(WAIT, || !process_exists(pid)));
    // The plugin stays loaded; the next session respawns it.
    assert!(host.is_loaded(&echo.plugin.manifest.id));
    let mut conn = new_connection(&registry, &echo.type_id);
    let mut rx = connect(&mut conn, "").await;
    conn.write(b"back").unwrap();
    assert_eq!(read_echo(&mut rx).await, "back");
    // A runner with a live session is never reaped.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(conn.is_connected());
    host.unload(&echo.plugin.manifest.id);
}

#[test]
fn a_missing_runner_fails_the_load() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());
    let (host, _registry) = host_for(&echo);
    let missing = work.path().join("no-such-runner");
    let host = host.with_runner(Some(PluginRunnerConfig::new(&missing)));
    match host.load(&echo.plugin) {
        Err(HostError::RunnerUnavailable { path, .. }) => assert_eq!(path, missing),
        other => panic!("expected RunnerUnavailable, got {other:?}"),
    }
    assert!(!host.is_loaded(&echo.plugin.manifest.id));
}

#[test]
fn a_runner_that_exits_before_hello_fails_the_load() {
    let work = tempfile::TempDir::new().unwrap();
    let echo = install_echo(work.path());
    let (host, _registry) = host_for(&echo);
    // A program that is not the runner and exits at once: EOF before `Hello`.
    let host = host.with_runner(Some(PluginRunnerConfig::new(not_a_runner())));
    match host.load(&echo.plugin) {
        Err(HostError::RunnerProtocol(detail)) => {
            assert!(detail.contains("Hello"), "{detail}");
        }
        other => panic!("expected RunnerProtocol, got {other:?}"),
    }
}

/// A program that refuses the runner's arguments and exits at once: `true`
/// on Unix, this test binary on Windows (libtest rejects `--protocol`).
fn not_a_runner() -> std::path::PathBuf {
    if cfg!(windows) {
        std::env::current_exe().expect("the test binary")
    } else {
        std::path::PathBuf::from("/usr/bin/true")
    }
}

const FIXTURE_MANIFEST: &str = r#"{
    "id": "test-fixture",
    "name": "Test Fixture",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Fixture the runner refuses",
    "license": "MIT",
    "apiVersion": "1.1",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "fixture",
            "displayName": "Fixture",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

#[test]
fn a_library_the_runner_refuses_fails_the_load_with_the_loader_message() {
    let work = tempfile::TempDir::new().unwrap();
    // A plugin without `termihub_plugin_init`: the runner's loader refuses it
    // after the ABI gate, and its message reaches the host verbatim.
    let lib = fixture_library(Variant::NoInit, work.path());
    let plugin = install_plugin(work.path(), &lib, FIXTURE_MANIFEST);
    let (host, _registry) = host_for(&plugin);
    let host = host.with_runner(Some(PluginRunnerConfig::new(runner_binary())));
    match host.load(&plugin.plugin) {
        Err(err @ HostError::RunnerLoad { .. }) => {
            assert!(!err.is_incompatible(), "{err:?}");
            assert_eq!(
                err.to_string(),
                "plugin library is missing the required symbol `termihub_plugin_init`"
            );
        }
        other => panic!("expected RunnerLoad, got {other:?}"),
    }
    assert!(!host.is_loaded(&plugin.plugin.manifest.id));
}

#[test]
fn an_unaccepted_abi_1_0_plugin_is_refused_by_the_runner() {
    let work = tempfile::TempDir::new().unwrap();
    let lib = fixture_library(Variant::Abi10, work.path());
    let manifest = FIXTURE_MANIFEST.replace("\"apiVersion\": \"1.1\"", "\"apiVersion\": \"1.0\"");
    let plugin = install_plugin(work.path(), &lib, &manifest);
    let (host, _registry) = host_for(&plugin);
    let host = host.with_runner(Some(PluginRunnerConfig::new(runner_binary())));
    match host.load(&plugin.plugin) {
        Err(HostError::RunnerLoad { message, .. }) => {
            assert!(
                message.contains("does not record its build toolchain"),
                "{message}"
            );
        }
        other => panic!("expected RunnerLoad, got {other:?}"),
    }
}
