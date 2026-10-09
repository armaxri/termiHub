//! End-to-end tests of the capability bridge over plugin IPC (#4183, plugin
//! OS-sandbox phase 2): the native test-plugin fixture, installed and trusted
//! through the real manager, loaded by [`PluginHost`] **through
//! `termihub-plugin-runner`**, calls the unchanged 1.x `PluginHostBridge`; the
//! runner forwards every call to the host, which applies the plugin's declared
//! permissions, filesystem scope and connection policy.
//!
//! Covers an allowed connection to a local TCP echo server (the connected
//! socket passed to the runner — `SCM_RIGHTS` on Unix, `DuplicateHandle` on
//! Windows, #4219 — and the `StreamData` proxy fallback), a denied one, the
//! connection ceiling, filesystem allow/deny for read / write / stat / list, a
//! directory listing paged over several frames, and the host's denial events.
//!
//! Runs on every OS (#4240).
#![cfg(feature = "plugin")]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{fixture_library, Variant};
use plugin_runner_support::{host_for, install_plugin, new_connection, runner_binary, wait_until};

use termihub_core::connection::ConnectionTypeRegistry;
use termihub_core::plugin::sandbox::{DenialReason, PluginRunnerConfig, SandboxedPlugin};
use termihub_core::plugin::{HostError, PermissionError, PluginHost};

const WAIT: Duration = Duration::from_secs(10);

/// The fixture plugin, loaded out of process with the given manifest grants.
struct Loaded {
    host: PluginHost,
    registry: Arc<Mutex<ConnectionTypeRegistry>>,
    type_id: String,
    id: String,
}

impl Loaded {
    fn runner(&self) -> Arc<SandboxedPlugin> {
        self.host
            .sandboxed_plugin(&self.id)
            .and_then(|h| h.running())
            .expect("a running runner")
    }

    /// Open a session with `settings` and return its first output line (the
    /// probe result), then disconnect.
    async fn probe(&self, settings: serde_json::Value) -> String {
        self.probe_len(settings, 1).await
    }

    /// Like [`probe`](Self::probe), collecting output chunks until at least
    /// `min_len` bytes arrived (a long line may span several chunks).
    async fn probe_len(&self, settings: serde_json::Value, min_len: usize) -> String {
        let mut conn = new_connection(&self.registry, &self.type_id);
        let mut rx = conn.subscribe_output();
        conn.connect(settings)
            .await
            .expect("the session starts in the runner");
        let mut line = Vec::new();
        while line.len() < min_len {
            let chunk = tokio::time::timeout(WAIT, rx.recv())
                .await
                .expect("probe output within the timeout")
                .expect("a probe line");
            line.extend(chunk);
        }
        conn.disconnect().await.unwrap();
        String::from_utf8(line).expect("UTF-8 probe line")
    }
}

impl Drop for Loaded {
    fn drop(&mut self) {
        self.host.unload(&self.id);
    }
}

/// Install the fixture with `permissions` / `filesystem_paths` (and an
/// optional manifest `connectionPolicy`) and load it through the runner.
fn load(
    work: &Path,
    permissions: &[&str],
    filesystem_paths: &[PathBuf],
    connection_policy: Option<serde_json::Value>,
) -> Loaded {
    let lib = fixture_library(Variant::Default, work);
    let mut manifest = serde_json::json!({
        "id": "test-echo",
        "name": "Test Echo",
        "version": "0.1.0",
        "author": "termiHub tests",
        "description": "Bridge-over-IPC fixture",
        "license": "MIT",
        "apiVersion": "1.1",
        "platforms": ["windows", "linux", "macos"],
        "permissions": permissions,
        "extensions": {
            "terminalBackend": {
                "connectionType": "probe",
                "displayName": "Probe",
                "configSchema": { "type": "object", "properties": {} }
            }
        }
    });
    if !filesystem_paths.is_empty() {
        manifest["filesystemPaths"] = filesystem_paths
            .iter()
            .map(|p| p.to_str().unwrap().to_owned())
            .collect();
    }
    if let Some(policy) = connection_policy {
        manifest["connectionPolicy"] = policy;
    }
    let installed = install_plugin(work, &lib, &manifest.to_string());
    let (host, registry) = host_for(&installed);
    let host = host.with_runner(PluginRunnerConfig::new(runner_binary()));
    host.load(&installed.plugin)
        .expect("the runner loads the fixture");
    Loaded {
        host,
        registry,
        type_id: installed.type_id,
        id: installed.plugin.manifest.id,
    }
}

/// A manifest `connectionPolicy` opting in to local-network targets, so the
/// loopback echo server is reachable (SEC2-005).
fn local_network() -> Option<serde_json::Value> {
    Some(serde_json::json!({ "allowLocalNetwork": true }))
}

/// A local TCP echo server; returns its port and a counter of accepted
/// connections.
fn echo_server() -> (u16, Arc<Mutex<usize>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&accepted);
    std::thread::spawn(move || {
        for mut sock in listener.incoming().flatten() {
            *counter.lock().unwrap() += 1;
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                while let Ok(n) = sock.read(&mut buf) {
                    if n == 0 || sock.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            });
        }
    });
    (port, accepted)
}

fn netecho(port: u16) -> serde_json::Value {
    serde_json::json!({ "probe": "netecho", "probeHost": "127.0.0.1", "probePort": port })
}

/// The socket itself reaches the runner on every OS (Windows: duplicated in,
/// driven without Winsock, #4219).
#[tokio::test(flavor = "multi_thread")]
async fn an_allowed_connection_reaches_the_peer_through_a_passed_socket() {
    let work = tempfile::TempDir::new().unwrap();
    let plugin = load(work.path(), &["terminal", "network"], &[], local_network());
    let (port, accepted) = echo_server();

    assert_eq!(plugin.probe(netecho(port)).await, "NETECHO:ping");
    assert_eq!(*accepted.lock().unwrap(), 1, "the host connected once");
    let runner = plugin.runner();
    assert_eq!(runner.bridge_handles_passed(), 1, "passed, not proxied");
    // The plugin dropped its stream: the runner released the host's slot.
    assert!(wait_until(WAIT, || runner.bridge_connections() == 0));
    assert!(runner.bridge_denials().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stream_proxy_fallback_carries_the_same_connection() {
    let work = tempfile::TempDir::new().unwrap();
    let plugin = load(work.path(), &["terminal", "network"], &[], local_network());
    let (port, _accepted) = echo_server();
    let runner = plugin.runner();
    runner.force_stream_proxy(true);

    assert_eq!(plugin.probe(netecho(port)).await, "NETECHO:ping");
    assert_eq!(runner.bridge_handles_passed(), 0, "proxied, not passed");
    assert!(wait_until(WAIT, || runner.bridge_connections() == 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_without_the_network_permission_is_denied() {
    let work = tempfile::TempDir::new().unwrap();
    let plugin = load(work.path(), &["terminal"], &[], None);
    let (port, accepted) = echo_server();

    assert_eq!(plugin.probe(netecho(port)).await, "NETWORK_DENIED");
    assert_eq!(*accepted.lock().unwrap(), 0, "the host never connected");
    let denials = plugin.runner().bridge_denials();
    assert_eq!(denials.len(), 1);
    assert_eq!(denials[0].plugin_id, "test-echo");
    assert_eq!(denials[0].operation, "open_connection");
    assert_eq!(denials[0].target, format!("127.0.0.1:{port}"));
    assert_eq!(denials[0].reason, DenialReason::Permission);
}

/// SEC2-005: `network` alone does not reach loopback — without the manifest's
/// `allowLocalNetwork` opt-in the host refuses the dial-out as a permission
/// denial and never connects.
#[tokio::test(flavor = "multi_thread")]
async fn a_loopback_connection_without_the_local_network_opt_in_is_denied() {
    let work = tempfile::TempDir::new().unwrap();
    let plugin = load(work.path(), &["terminal", "network"], &[], None);
    let (port, accepted) = echo_server();

    assert_eq!(plugin.probe(netecho(port)).await, "NETWORK_DENIED");
    assert_eq!(*accepted.lock().unwrap(), 0, "the host never connected");
    let denials = plugin.runner().bridge_denials();
    assert_eq!(denials.len(), 1);
    assert_eq!(denials[0].reason, DenialReason::Permission);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_manifest_connection_ceiling_is_enforced_out_of_process() {
    let work = tempfile::TempDir::new().unwrap();
    let plugin = load(
        work.path(),
        &["terminal", "network"],
        &[],
        Some(serde_json::json!({ "maxConnections": 2, "allowLocalNetwork": true })),
    );
    let (port, _accepted) = echo_server();
    let line = plugin
        .probe(serde_json::json!({
            "probe": "connlimit",
            "probeHost": "127.0.0.1",
            "probePort": port,
            "probeCount": 3,
        }))
        .await;
    assert_eq!(line, "CONNLIMIT:2:1");
    let denials = plugin.runner().bridge_denials();
    assert_eq!(denials.len(), 1);
    assert_eq!(denials[0].reason, DenialReason::ResourceLimit);
}

#[tokio::test(flavor = "multi_thread")]
async fn filesystem_access_is_confined_to_the_declared_paths() {
    let work = tempfile::TempDir::new().unwrap();
    // Outside `work`, which holds the plugins root and so counts as termiHub's
    // config folder: a declared root may not overlap it (#4293).
    let outside = tempfile::TempDir::new().unwrap();
    let scoped = outside.path().join("scoped");
    std::fs::create_dir_all(&scoped).unwrap();
    std::fs::write(scoped.join("data.txt"), b"in-scope contents").unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, b"top secret").unwrap();
    let plugin = load(
        work.path(),
        &["terminal", "filesystem"],
        std::slice::from_ref(&scoped),
        None,
    );
    let path = |p: &Path| p.to_str().unwrap().to_owned();
    let probe = |kind: &str, p: &Path| serde_json::json!({ "probe": kind, "probePath": path(p) });

    assert_eq!(
        plugin
            .probe(probe("readfile", &scoped.join("data.txt")))
            .await,
        "READ_OK:in-scope contents"
    );
    assert_eq!(
        plugin.probe(probe("readfile", &secret)).await,
        "READ_DENIED"
    );
    let traversal = scoped.join("..").join("secret.txt");
    assert_eq!(
        plugin.probe(probe("readfile", &traversal)).await,
        "READ_DENIED"
    );

    let written = scoped.join("out.txt");
    let write = |p: &Path| serde_json::json!({ "probe": "writefile", "probePath": path(p), "probeData": "hello" });
    assert_eq!(plugin.probe(write(&written)).await, "WRITE_OK");
    assert_eq!(std::fs::read(&written).unwrap(), b"hello");
    let escape = outside.path().join("escape.txt");
    assert_eq!(plugin.probe(write(&escape)).await, "WRITE_DENIED");
    assert!(!escape.exists(), "nothing was written outside the scope");

    assert_eq!(
        plugin
            .probe(probe("statpath", &scoped.join("data.txt")))
            .await,
        "STAT_FILE:17"
    );
    assert_eq!(
        plugin.probe(probe("statpath", &secret)).await,
        "STAT_DENIED"
    );
    assert_eq!(
        plugin.probe(probe("listdir", &scoped)).await,
        "LIST_OK:data.txt,out.txt"
    );
    assert_eq!(
        plugin.probe(probe("listdir", outside.path())).await,
        "LIST_DENIED"
    );

    let denials = plugin.runner().bridge_denials();
    let ops: Vec<&str> = denials.iter().map(|d| d.operation).collect();
    assert_eq!(
        ops,
        [
            "read_file",
            "read_file",
            "write_file",
            "stat_path",
            "list_dir"
        ]
    );
    assert!(denials.iter().all(|d| d.reason == DenialReason::Permission));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_larger_than_one_frame_round_trips_through_the_bridge() {
    let work = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    let scoped = outside.path().join("scoped");
    std::fs::create_dir_all(&scoped).unwrap();
    let plugin = load(
        work.path(),
        &["terminal", "filesystem"],
        std::slice::from_ref(&scoped),
        None,
    );
    // More than one bridge chunk (512 KiB), written then read back by the
    // plugin; still small enough for the session config to fit one frame.
    let data = "0123456789abcdef".repeat(38 * 1024);
    let target = scoped.join("big.txt");
    let written = plugin
        .probe(serde_json::json!({
            "probe": "writefile",
            "probePath": target.to_str().unwrap(),
            "probeData": data,
        }))
        .await;
    assert_eq!(written, "WRITE_OK");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), data);
    let expected = format!("READ_OK:{data}");
    let read = plugin
        .probe_len(
            serde_json::json!({ "probe": "readfile", "probePath": target.to_str().unwrap() }),
            expected.len(),
        )
        .await;
    assert!(read == expected, "read back {} bytes", read.len());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_directory_larger_than_one_frame_lists_every_entry() {
    let work = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    let scoped = outside.path().join("scoped");
    std::fs::create_dir_all(&scoped).unwrap();
    // 50k names of 24 bytes: ~1.5 MiB charged, several `list_dir` pages
    // (#4220).
    let mut names: Vec<String> = (0..50_000).map(|i| format!("entry-{i:018}")).collect();
    for name in &names {
        std::fs::File::create(scoped.join(name)).unwrap();
    }
    let plugin = load(
        work.path(),
        &["terminal", "filesystem"],
        std::slice::from_ref(&scoped),
        None,
    );
    names.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in names.iter().flat_map(|e| e.bytes().chain(*b"\n")) {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
    let summary = plugin
        .probe(serde_json::json!({
            "probe": "listdirsummary",
            "probePath": scoped.to_str().unwrap(),
        }))
        .await;
    assert_eq!(summary, format!("LIST_SUMMARY:50000:{hash:016x}"));
    // Paging is not a refusal.
    assert!(plugin.runner().bridge_denials().is_empty());
}

/// Escape probe for PLG2-001 / SEC2-001: a manifest whose `filesystemPaths`
/// reached the loader unvalidated (a pre-fix install, a hand-edited plugin
/// folder) with an empty, `.` or relative root must not load. Before the fix
/// such a root normalised to the empty path, which `Path::starts_with` treats
/// as containing every path, so the plugin could read any file on the disk
/// through the bridge.
#[tokio::test(flavor = "multi_thread")]
async fn an_empty_dot_or_relative_root_never_opens_the_disk() {
    let work = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    let scoped = outside.path().join("scoped");
    std::fs::create_dir_all(&scoped).unwrap();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, b"top secret").unwrap();

    let lib = fixture_library(Variant::Default, work.path());
    let manifest = serde_json::json!({
        "id": "test-echo",
        "name": "Test Echo",
        "version": "0.1.0",
        "author": "termiHub tests",
        "description": "Bridge-over-IPC fixture",
        "license": "MIT",
        "apiVersion": "1.1",
        "platforms": ["windows", "linux", "macos"],
        "permissions": ["terminal", "filesystem"],
        "filesystemPaths": [scoped.to_str().unwrap()],
        "extensions": {
            "terminalBackend": {
                "connectionType": "probe",
                "displayName": "Probe",
                "configSchema": { "type": "object", "properties": {} }
            }
        }
    });
    let installed = install_plugin(work.path(), &lib, &manifest.to_string());

    for root in ["", ".", "./", "relative"] {
        let mut tampered = installed.plugin.clone();
        tampered.manifest.filesystem_paths = vec![root.to_owned()];
        let (host, registry) = host_for(&installed);
        let host = host.with_runner(PluginRunnerConfig::new(runner_binary()));
        if let Err(err) = host.load(&tampered) {
            assert!(
                matches!(
                    err,
                    HostError::Permission(PermissionError::InvalidFilesystemPath { .. })
                ),
                "root {root:?}: {err:?}"
            );
            assert!(!host.is_loaded(&tampered.manifest.id));
            continue;
        }
        let loaded = Loaded {
            host,
            registry,
            type_id: installed.type_id.clone(),
            id: tampered.manifest.id.clone(),
        };
        let line = loaded
            .probe(
                serde_json::json!({ "probe": "readfile", "probePath": secret.to_str().unwrap() }),
            )
            .await;
        panic!("root {root:?} loaded and the plugin read outside its scope: {line}");
    }
}
