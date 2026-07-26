//! End-to-end test of the host-mediated capability bridge (#2018, #2024).
//!
//! Where `plugin_host_roundtrip.rs` proves a plugin *loads* and echoes, this test
//! proves the host actually **enforces the plugin's declared permissions at
//! runtime** on network/filesystem access routed through the bridge — across the
//! real `dlopen` boundary, not just in-process.
//!
//! The fixture `cdylib` (`tests/fixtures/test-plugin`) grows an optional probe:
//! given a `{"probe": "network"|"readfile"|"writefile"|"appendfile"|
//! "createfile"|"statpath"|"listdir", …}` session config it calls the host bridge
//! and reports the outcome (`NETWORK_OK`/`NETWORK_DENIED`, `READ_OK:<bytes>`/
//! `READ_DENIED`, `WRITE_OK`/`WRITE_DENIED`, `STAT_FILE:<len>`/`STAT_DENIED`,
//! `LIST_OK:<names>`/`LIST_DENIED`) as its first output line. Here we build the
//! fixture, drive a [`PluginConnectionType`] with a chosen [`PermissionSet`], and
//! assert the bridge grants or denies exactly as the permissions dictate — for
//! the read/connect surface of #2018 and the write/stat/list surface of #2024.
#![cfg(feature = "plugin")]

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use termihub_core::connection::{ConnectionType, SettingsSchema};
use termihub_core::plugin::{
    load_backend_library, ConnectionPolicy, LoadedLibrary, PermissionSet, PluginPermission,
};

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
    probe_outcome_with_policy(lib, permissions, ConnectionPolicy::default(), settings).await
}

/// Like [`probe_outcome`], but with an explicit host-side [`ConnectionPolicy`] so
/// a test can exercise the per-session connection ceiling / timeout (#2028) across
/// the real ABI boundary.
async fn probe_outcome_with_policy(
    lib: &std::sync::Arc<LoadedLibrary>,
    permissions: PermissionSet,
    policy: ConnectionPolicy,
    settings: serde_json::Value,
) -> Vec<u8> {
    let mut conn = termihub_core::plugin::PluginConnectionType::new(
        std::sync::Arc::clone(lib),
        "probe".to_string(),
        "Probe".to_string(),
        SettingsSchema { groups: vec![] },
        permissions,
    )
    .with_connection_policy(policy);
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
async fn connection_limit_is_enforced_through_the_bridge() {
    // Across the real dlopen boundary: a session whose policy caps concurrent
    // mediated connections at 2 can open only 2 of 3 attempted at once; the third
    // is refused by the host (#2028).
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = load_backend_library(&build_fixture(&tmp.path().join("target")))
        .expect("fixture should load");

    // Accept (and hold) every connection the host actually opens, so the ceiling —
    // not a refused socket — is what bounds the probe.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let mut held = Vec::new();
        listener
            .set_nonblocking(false)
            .expect("blocking accept for the held connections");
        // Only the connections under the ceiling (2) are ever opened host-side.
        for _ in 0..2 {
            if let Ok((sock, _)) = listener.accept() {
                held.push(sock);
            }
        }
        held
    });

    let settings = serde_json::json!({
        "probe": "connlimit",
        "probeHost": "127.0.0.1",
        "probePort": port,
        "probeCount": 3,
    });

    let out = probe_outcome_with_policy(
        &lib,
        PermissionSet::from_parts([PluginPermission::Network], &[]),
        ConnectionPolicy::new(2, Duration::from_secs(30)),
        settings,
    )
    .await;

    // 2 allowed (under the ceiling), 1 refused (would exceed it). The probe only
    // counts a `ResourceLimit` refusal as denied, so this split also proves the
    // host reports the dedicated connection-limit status over the real ABI, not a
    // `PermissionDenied` (#2030).
    assert_eq!(
        out, b"CONNLIMIT:2:1",
        "host must cap concurrent mediated connections and report ResourceLimit"
    );

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

#[tokio::test]
async fn filesystem_write_is_enforced_through_the_bridge() {
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = load_backend_library(&build_fixture(&tmp.path().join("target")))
        .expect("fixture should load");

    let root = tmp.path().join("scoped");
    std::fs::create_dir_all(&root).unwrap();
    let outside = tmp.path().join("escape.txt");

    let scoped = || {
        PermissionSet::from_parts(
            [PluginPermission::Filesystem],
            &[root.to_str().unwrap().to_owned()],
        )
    };

    // In-scope create-or-truncate write is mediated and lands on disk.
    let inside = root.join("out.txt");
    let ok = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({
            "probe": "writefile",
            "probePath": inside.to_str().unwrap(),
            "probeData": "hello",
        }),
    )
    .await;
    assert_eq!(ok, b"WRITE_OK");
    assert_eq!(std::fs::read(&inside).unwrap(), b"hello");

    // In-scope append extends the same file.
    let appended = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({
            "probe": "appendfile",
            "probePath": inside.to_str().unwrap(),
            "probeData": "-more",
        }),
    )
    .await;
    assert_eq!(appended, b"WRITE_OK");
    assert_eq!(std::fs::read(&inside).unwrap(), b"hello-more");

    // Out-of-scope write is rejected end-to-end — the host never creates the file.
    let denied = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({
            "probe": "writefile",
            "probePath": outside.to_str().unwrap(),
            "probeData": "x",
        }),
    )
    .await;
    assert_eq!(denied, b"WRITE_DENIED", "out-of-scope write must be denied");
    assert!(!outside.exists(), "denied write must not create the file");

    // No `filesystem` permission → every write is refused.
    let no_perm = probe_outcome(
        &lib,
        PermissionSet::from_parts([PluginPermission::Terminal], &[]),
        serde_json::json!({
            "probe": "writefile",
            "probePath": inside.to_str().unwrap(),
            "probeData": "x",
        }),
    )
    .await;
    assert_eq!(
        no_perm, b"WRITE_DENIED",
        "no filesystem permission → denied"
    );
}

#[tokio::test]
async fn filesystem_stat_and_list_are_enforced_through_the_bridge() {
    let tmp = tempfile::TempDir::new().unwrap();
    let lib = load_backend_library(&build_fixture(&tmp.path().join("target")))
        .expect("fixture should load");

    let root = tmp.path().join("scoped");
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("data.txt");
    std::fs::write(&file, b"12345").unwrap();
    std::fs::write(root.join("other.txt"), b"y").unwrap();
    let outside = tmp.path().join("secret.txt");
    std::fs::write(&outside, b"top secret").unwrap();

    let scoped = || {
        PermissionSet::from_parts(
            [PluginPermission::Filesystem],
            &[root.to_str().unwrap().to_owned()],
        )
    };

    // In-scope stat of a file reports its length.
    let stat = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({ "probe": "statpath", "probePath": file.to_str().unwrap() }),
    )
    .await;
    assert_eq!(stat, b"STAT_FILE:5");

    // Out-of-scope stat is refused.
    let stat_denied = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({ "probe": "statpath", "probePath": outside.to_str().unwrap() }),
    )
    .await;
    assert_eq!(
        stat_denied, b"STAT_DENIED",
        "out-of-scope stat must be denied"
    );

    // In-scope directory listing returns the entry names.
    let list = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({ "probe": "listdir", "probePath": root.to_str().unwrap() }),
    )
    .await;
    assert_eq!(list, b"LIST_OK:data.txt,other.txt");

    // Out-of-scope listing is refused.
    let list_denied = probe_outcome(
        &lib,
        scoped(),
        serde_json::json!({ "probe": "listdir", "probePath": tmp.path().to_str().unwrap() }),
    )
    .await;
    assert_eq!(
        list_denied, b"LIST_DENIED",
        "out-of-scope list must be denied"
    );
}
