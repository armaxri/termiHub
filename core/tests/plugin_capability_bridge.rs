//! End-to-end test of the host-mediated capability bridge (#2018).
//!
//! Where `plugin_host_roundtrip.rs` proves a plugin *loads* and echoes, this test
//! proves the host actually **enforces the plugin's declared permissions at
//! runtime** on network/filesystem access routed through the bridge — across the
//! real `dlopen` boundary, not just in-process.
//!
//! The fixture `cdylib` (`tests/fixtures/test-plugin`) grows an optional probe:
//! given a `{"probe": "network"|"readfile", …}` session config it calls the host
//! bridge and reports the outcome (`NETWORK_OK`/`NETWORK_DENIED`,
//! `READ_OK:<bytes>`/`READ_DENIED`) as its first output line. Here we build the
//! fixture, drive a [`PluginConnectionType`] with a chosen [`PermissionSet`], and
//! assert the bridge grants or denies exactly as the permissions dictate.
#![cfg(feature = "plugin")]

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use termihub_core::connection::{ConnectionType, SettingsSchema};
use termihub_core::plugin::{load_backend_library, LoadedLibrary, PermissionSet, PluginPermission};

/// Path to the fixture plugin's `Cargo.toml` (the shared echo `cdylib`).
fn fixture_manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test-plugin")
        .join("Cargo.toml")
}

/// The platform-specific file name cargo produces for the fixture `cdylib`.
fn artifact_name() -> String {
    format!(
        "{}termihub_test_plugin{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    )
}

/// Build the fixture into `target_dir`, returning the freshly-built library path.
fn build_fixture(target_dir: &Path) -> PathBuf {
    let status = Command::new(env!("CARGO"))
        .arg("build")
        .arg("--manifest-path")
        .arg(fixture_manifest())
        .arg("--target-dir")
        .arg(target_dir)
        .status()
        .expect("failed to spawn cargo to build the fixture plugin");
    assert!(status.success(), "building the fixture plugin failed");
    target_dir.join("debug").join(artifact_name())
}

/// Create a plugin session scoped to `permissions`, drive it with `settings`, and
/// return its first emitted output line (the probe result).
async fn probe_outcome(
    lib: &std::sync::Arc<LoadedLibrary>,
    permissions: PermissionSet,
    settings: serde_json::Value,
) -> Vec<u8> {
    let mut conn = termihub_core::plugin::PluginConnectionType::new(
        std::sync::Arc::clone(lib),
        "probe".to_string(),
        "Probe".to_string(),
        SettingsSchema { groups: vec![] },
        permissions,
    );
    let mut rx = conn.subscribe_output();
    conn.connect(settings)
        .await
        .expect("connect should succeed");
    let out = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("probe output should arrive within the timeout")
        .expect("output channel should yield the probe line");
    conn.disconnect().await.expect("disconnect should succeed");
    out
}

#[tokio::test]
async fn network_capability_is_enforced_through_the_bridge() {
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = load_backend_library(&build_fixture(&tmp.path().join("target")))
        .expect("fixture should load");

    // A real listener so the *granted* probe can genuinely connect.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        // Accept exactly one connection (the granted case) and read the "ping".
        if let Ok((mut sock, _)) = listener.accept() {
            let mut buf = [0u8; 4];
            let _ = sock.read_exact(&mut buf);
        }
    });

    let net_settings = serde_json::json!({
        "probe": "network",
        "probeHost": "127.0.0.1",
        "probePort": port,
    });

    // Granted `network` → the host opens the connection on the plugin's behalf.
    let granted = probe_outcome(
        &lib,
        PermissionSet::from_parts([PluginPermission::Network], &[]),
        net_settings.clone(),
    )
    .await;
    assert_eq!(granted, b"NETWORK_OK", "granted network should connect");

    // No `network` permission → the host refuses; the plugin cannot open a
    // connection via the bridge.
    let denied = probe_outcome(
        &lib,
        PermissionSet::from_parts([PluginPermission::Terminal], &[]),
        net_settings,
    )
    .await;
    assert_eq!(denied, b"NETWORK_DENIED", "network must be denied");

    let _ = server.join();
}

#[tokio::test]
async fn filesystem_capability_is_enforced_through_the_bridge() {
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = load_backend_library(&build_fixture(&tmp.path().join("target")))
        .expect("fixture should load");

    // A scoped root with an in-scope file, and a sibling secret outside it.
    let root = tmp.path().join("scoped");
    std::fs::create_dir_all(&root).unwrap();
    let inside = root.join("data.txt");
    std::fs::write(&inside, b"in-scope contents").unwrap();
    let outside = tmp.path().join("secret.txt");
    std::fs::write(&outside, b"top secret").unwrap();

    let scoped = || {
        PermissionSet::from_parts(
            [PluginPermission::Filesystem],
            &[root.to_str().unwrap().to_owned()],
        )
    };

    // In-scope read is mediated and returns the real bytes.
    let ok = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({ "probe": "readfile", "probePath": inside.to_str().unwrap() }),
    )
    .await;
    assert_eq!(ok, b"READ_OK:in-scope contents");

    // Out-of-scope read is rejected end-to-end — the host never opens the file.
    let denied = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({ "probe": "readfile", "probePath": outside.to_str().unwrap() }),
    )
    .await;
    assert_eq!(denied, b"READ_DENIED", "out-of-scope read must be denied");

    // A plugin with no `filesystem` permission is denied outright.
    let no_perm = probe_outcome(
        &lib,
        PermissionSet::from_parts([PluginPermission::Terminal], &[]),
        serde_json::json!({ "probe": "readfile", "probePath": inside.to_str().unwrap() }),
    )
    .await;
    assert_eq!(no_perm, b"READ_DENIED", "no filesystem permission → denied");
}
