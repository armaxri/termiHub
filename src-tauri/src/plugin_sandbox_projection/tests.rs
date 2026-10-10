use std::sync::{Arc, Mutex};

use serde_json::json;
use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::plugin::sandbox::PluginRunnerConfig;
use termihub_core::plugin::{
    native_library_hash, parse_manifest, InstalledPlugin, NativeTrustStore, PluginHost,
    PluginState, TrustBinding,
};

use super::*;
use crate::projection::Projector;

const MANIFEST: &str = r#"{
    "id": "acme",
    "name": "Acme",
    "version": "1.0.0",
    "author": "tester",
    "description": "sandbox projection test",
    "license": "MIT",
    "apiVersion": "1.0",
    "platforms": ["linux", "macos", "windows"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "acme",
            "displayName": "Acme",
            "configSchema": {}
        }
    }
}"#;

/// Install a trusted native plugin whose library is a dummy file (the runner
/// never gets far enough to open it).
fn trusted_plugin(root: &std::path::Path) -> InstalledPlugin {
    let backend = root.join("acme").join("backend");
    std::fs::create_dir_all(&backend).unwrap();
    let lib = format!(
        "{}acme{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    );
    std::fs::write(backend.join(lib), b"not a real library").unwrap();
    let hash = native_library_hash(root, "acme").unwrap();
    let manifest = parse_manifest(MANIFEST).unwrap();
    let mut trust = NativeTrustStore::load(root);
    trust.set_native_enabled(true).unwrap();
    trust
        .acknowledge("acme", &TrustBinding::new(hash, &manifest))
        .unwrap();
    InstalledPlugin {
        manifest,
        state: PluginState::Installed,
        error_message: None,
        invalid_manifest: false,
        installed_at: 0,
    }
}

fn registry() -> Arc<Mutex<ConnectionTypeRegistry>> {
    Arc::new(Mutex::new(ConnectionTypeRegistry::new()))
}

#[test]
fn an_idle_host_projects_no_plugins() {
    let tmp = tempfile::TempDir::new().unwrap();
    let host = PluginHost::new(tmp.path(), registry());
    assert_eq!(snapshot(&host), json!({ "plugins": {} }));
}

#[test]
fn a_refused_plugin_is_projected_with_its_badge() {
    let tmp = tempfile::TempDir::new().unwrap();
    let host = PluginHost::new(tmp.path(), registry())
        .with_runner(PluginRunnerConfig::new(tmp.path().join("missing-runner")));
    let plugin = trusted_plugin(tmp.path());
    assert!(host.load(&plugin).is_err());

    let view = snapshot(&host);
    assert_eq!(view["plugins"]["acme"]["isolation"], "runnerMissing");
    assert!(view["plugins"]["acme"]["detail"].is_string());
    assert_eq!(view["plugins"]["acme"]["denials"], json!([]));

    // Disabling the plugin clears the row's status.
    host.unload("acme");
    assert_eq!(snapshot(&host)["plugins"], json!({}));
}

#[test]
fn publishing_an_unchanged_host_emits_nothing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let host = PluginHost::new(tmp.path(), registry())
        .with_runner(PluginRunnerConfig::new(tmp.path().join("missing-runner")));
    let projector = Projector::new();
    projector.register_region(PLUGIN_SANDBOX_REGION, snapshot(&host));
    assert_eq!(
        projector.publish_with(PLUGIN_SANDBOX_REGION, || snapshot(&host)),
        None,
        "an idle host must not produce diffs"
    );

    let plugin = trusted_plugin(tmp.path());
    assert!(host.load(&plugin).is_err());
    assert_eq!(
        projector.publish_with(PLUGIN_SANDBOX_REGION, || snapshot(&host)),
        Some(1),
        "a refused load reaches subscribers as a diff"
    );
}

/// ARCH2-003 (#4373): the publisher is an `AppTasks`-owned loop. It is tracked
/// while it runs, and shutdown cancels it and waits for its thread to end, so
/// it never publishes after teardown.
#[tokio::test]
async fn shutdown_cancels_and_awaits_the_publisher() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use crate::app_tasks::{AppTasks, ShutdownOutcome, DEFAULT_SHUTDOWN_TIMEOUT};

    let tasks = AppTasks::new();
    let ticks = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&ticks);
    let thread = spawn_publisher(&tasks, Duration::from_millis(5), move || {
        counter.fetch_add(1, Ordering::SeqCst);
    })
    .unwrap();

    for _ in 0..1000 {
        if ticks.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(ticks.load(Ordering::SeqCst) > 0, "the publisher publishes");
    assert_eq!(tasks.tracker().len(), 1, "the publisher thread is tracked");

    let outcome = tasks.shutdown(DEFAULT_SHUTDOWN_TIMEOUT).await;
    assert_eq!(outcome, ShutdownOutcome::Completed);
    thread.join().unwrap();

    let after = ticks.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(
        ticks.load(Ordering::SeqCst),
        after,
        "nothing is published after shutdown"
    );
}

/// The publisher observes cancellation mid-interval: a loop sleeping for a
/// minute still lets shutdown complete well within its bound.
#[tokio::test]
async fn the_publisher_exits_promptly_mid_interval() {
    use std::time::{Duration, Instant};

    use crate::app_tasks::{AppTasks, ShutdownOutcome, DEFAULT_SHUTDOWN_TIMEOUT};

    let tasks = AppTasks::new();
    let thread = spawn_publisher(&tasks, Duration::from_secs(60), || {}).unwrap();
    // Let the thread reach its long sleep.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let started = Instant::now();
    let outcome = tasks.shutdown(DEFAULT_SHUTDOWN_TIMEOUT).await;
    assert_eq!(outcome, ShutdownOutcome::Completed);
    assert!(started.elapsed() < Duration::from_secs(2));
    thread.join().unwrap();
}
