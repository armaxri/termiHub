//! End to end on Windows (#4818): a plugin inside its Less-Privileged
//! AppContainer completes a **certificate-verified TLS handshake** with a
//! public HTTPS host, using only the host's TLS root snapshot (#4811).
//!
//! The LPAC cannot open the system trust store, so the unconfined host exports
//! the roots to a read-only snapshot and points the runner's `SSL_CERT_FILE`
//! at it. `plugin_runner_sandbox` proves the snapshot loads and every root
//! parses as a trust anchor; this test proves a real handshake verifies with
//! it. The escape-probe fixture's `tls` session probe (feature `tls-probe`)
//! opens a connection through the capability bridge (`open_connection` with
//! the `network` permission: the host dials, the socket is passed into the
//! LPAC) and runs a rustls client whose `RootCertStore` comes from
//! `rustls_native_certs::load_native_certs()` alone.
//!
//! * **Positive:** with the host's snapshot the handshake verifies.
//! * **Negative:** with the snapshot emptied, the same handshake fails with
//!   `UnknownIssuer` — so the success above came from the snapshot, not from
//!   some other root source.
//!
//! **Nightly only.** It needs a public host (`github.com:443`, or
//! `TERMIHUB_TLS_PROBE_HOST`), and per-PR CI must not depend on one, so the
//! test is `#[ignore]`d and only the plugin-sandbox nightly lane
//! (`.github/workflows/plugin-sandbox-nightly.yml`) runs it with `--ignored`.
#![cfg(all(feature = "plugin", windows))]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

mod plugin_fixture;
mod plugin_runner_support;
use plugin_fixture::{fixture_library, Variant};
use plugin_runner_support::{install_plugin, new_connection, runner_binary};

use termihub_core::connection::{ConnectionTypeRegistry, OutputReceiver};
use termihub_core::plugin::sandbox::{Isolation, PluginRunnerConfig};
use termihub_core::plugin::PluginHost;

/// A handshake with a public host, from a hosted runner: generous.
const WAIT: Duration = Duration::from_secs(30);

/// The host the probe verifies, and its port.
const DEFAULT_HOST: &str = "github.com";
const PORT: u16 = 443;

const PROBE_MANIFEST: &str = r#"{
    "id": "tls-probe",
    "name": "TLS Probe",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Verifies a public host from inside the sandbox (#4818)",
    "license": "MIT",
    "apiVersion": "1.1",
    "platforms": ["windows"],
    "permissions": ["terminal", "network"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "tls-probe",
            "displayName": "TLS Probe",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

async fn read_line(rx: &mut OutputReceiver) -> String {
    let chunk = tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("output within the timeout")
        .expect("an output chunk");
    String::from_utf8(chunk).expect("UTF-8 output")
}

/// The plugin's root snapshot: `<root>/.tls-roots/<id>/system-roots.pem`.
fn snapshot_file(root: &Path, id: &str) -> PathBuf {
    root.join(".tls-roots").join(id).join("system-roots.pem")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a public HTTPS host: plugin-sandbox nightly lane only (#4818)"]
async fn a_sandboxed_plugin_verifies_tls_with_only_the_root_snapshot() {
    let host = std::env::var("TERMIHUB_TLS_PROBE_HOST").unwrap_or_else(|_| DEFAULT_HOST.into());
    let work = tempfile::TempDir::new().unwrap();
    let lib = fixture_library(Variant::TlsProbe, work.path());
    let installed = install_plugin(work.path(), &lib, PROBE_MANIFEST);
    let id = installed.plugin.manifest.id.clone();

    // The production runner configuration: OS sandbox and resource limits on.
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let plugin_host = PluginHost::new(&installed.root, Arc::clone(&registry))
        .with_runner(PluginRunnerConfig::new(runner_binary()));
    plugin_host
        .load(&installed.plugin)
        .expect("the probe loads");
    let running = || {
        plugin_host
            .sandboxed_plugin(&id)
            .and_then(|h| h.running())
            .expect("a running runner")
    };
    let report = running().sandbox_report().clone();
    assert_eq!(report.isolation(), Isolation::Full, "{report:?}");

    let snapshot = snapshot_file(&installed.root, &id);
    let pem = std::fs::read_to_string(&snapshot).expect("the host wrote the snapshot");
    let roots = pem.matches("-----BEGIN CERTIFICATE-----").count();
    assert!(roots > 0, "an empty snapshot at {}", snapshot.display());
    println!("snapshot: {roots} roots in {}", snapshot.display());

    let settings = serde_json::json!({ "probe": "tls", "probeHost": host, "probePort": PORT });

    // --- Positive: the handshake verifies against the host's snapshot. ---
    let mut conn = new_connection(&registry, &installed.type_id);
    let mut rx = conn.subscribe_output();
    conn.connect(settings.clone())
        .await
        .expect("the session starts in the runner");
    let line = read_line(&mut rx).await;
    println!("positive ({host}:{PORT}): {line}");
    assert!(
        line.starts_with("TLS_OK:"),
        "the sandboxed plugin could not verify {host} with the root snapshot: {line}"
    );
    assert!(!line.contains("anchors=0 "), "{line}");
    assert_eq!(
        running().bridge_handles_passed(),
        1,
        "the bridged socket was handed into the LPAC, not proxied"
    );
    conn.disconnect().await.unwrap();

    // --- Negative: an empty snapshot gives no issuer to chain to. The test
    // (the unconfined host's user) empties the file the running runner's
    // `SSL_CERT_FILE` names; the plugin reloads it on the next handshake. ---
    std::fs::write(&snapshot, b"").expect("empty the snapshot");
    let mut conn = new_connection(&registry, &installed.type_id);
    let mut rx = conn.subscribe_output();
    conn.connect(settings)
        .await
        .expect("the session starts in the runner");
    let line = read_line(&mut rx).await;
    println!("negative (empty snapshot): {line}");
    assert!(
        line.starts_with("TLS_ERR:") && line.contains("UnknownIssuer"),
        "an empty snapshot must fail with UnknownIssuer: {line}"
    );
    // Same runner, still empty: no respawn re-exported the roots meanwhile.
    assert_eq!(running().bridge_handles_passed(), 2);
    assert_eq!(std::fs::read(&snapshot).unwrap(), b"");
    conn.disconnect().await.unwrap();

    plugin_host.unload(&id);
}
