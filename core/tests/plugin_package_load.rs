//! Package-then-load round trip for native plugins (PLG-011).
//!
//! Drives the whole distribution path a user's plugin takes, with the real
//! host on whichever OS the test runs: a `.termihub-plugin` package is
//! **installed** through [`PluginManager`] (validation, host-platform check,
//! extraction), the native-plugin trust gate is satisfied by acknowledging the
//! hash [`native_library_hash`] reports for the *selected* library, then
//! [`PluginHost`] `dlopen`s it and a session echoes input back.
//!
//! Two sources for the package:
//!
//! * `TERMIHUB_PLUGIN_PACKAGE` set (the per-OS CI job) — the package produced by
//!   `scripts/package-plugin.sh examples/plugins/echo-backend --target host`,
//!   i.e. the real packer output for the example plugin.
//! * unset (a plain `cargo test`) — the `tests/fixtures/test-plugin` cdylib is
//!   built on demand and packed by [`pack_plugin`] as a **multi-platform**
//!   package carrying this host's library plus a decoy for a foreign triple,
//!   proving the host selects its own entry end to end.
#![cfg(feature = "plugin")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_core::connection::{plugin_type_id, ConnectionTypeRegistry};
use termihub_core::plugin::{
    host_target_triple, native_library_hash, pack_plugin, package_platform_entries,
    NativeTrustStore, PluginHost, PluginManager,
};

/// A target triple no test host is, used for the decoy platform entry.
const FOREIGN_TRIPLE: &str = "riscv64gc-unknown-none-elf";

const FIXTURE_MANIFEST: &str = r#"{
    "id": "test-echo",
    "name": "Test Echo",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Native echo fixture packaged for the package-then-load test",
    "license": "MIT",
    "apiVersion": "1.0",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal"],
    "extensions": {
        "terminalBackend": {
            "connectionType": "echo",
            "displayName": "Test Echo",
            "configSchema": { "type": "object", "properties": {} }
        }
    }
}"#;

/// Build the fixture cdylib into `target_dir` and return the library path.
fn build_fixture(target_dir: &Path) -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test-plugin")
        .join("Cargo.toml");
    let status = Command::new(env!("CARGO"))
        .arg("build")
        .arg("--manifest-path")
        .arg(manifest)
        .arg("--target-dir")
        .arg(target_dir)
        .status()
        .expect("failed to spawn cargo to build the fixture plugin");
    assert!(status.success(), "building the fixture plugin failed");
    target_dir.join("debug").join(format!(
        "{}termihub_test_plugin{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    ))
}

/// Pack the fixture as a multi-platform package: this host's library under
/// `backend/<host-triple>/` plus a decoy under `backend/<foreign-triple>/`.
fn fixture_package(work: &Path) -> PathBuf {
    let lib = build_fixture(&work.join("target"));
    let src = work.join("src");
    let host = host_target_triple();
    let host_dir = src.join("backend").join(host);
    std::fs::create_dir_all(&host_dir).unwrap();
    std::fs::copy(&lib, host_dir.join(lib.file_name().unwrap())).unwrap();
    let foreign_dir = src.join("backend").join(FOREIGN_TRIPLE);
    std::fs::create_dir_all(&foreign_dir).unwrap();
    std::fs::write(foreign_dir.join("libdecoy.so"), b"not this platform").unwrap();
    std::fs::write(src.join("manifest.json"), FIXTURE_MANIFEST).unwrap();

    let pkg = pack_plugin(&src, &work.join("dist")).expect("packing the fixture succeeds");
    let triples: Vec<String> = package_platform_entries(&pkg)
        .unwrap()
        .into_iter()
        .map(|e| e.triple)
        .collect();
    assert!(triples.iter().any(|t| t == host), "{triples:?}");
    assert!(triples.iter().any(|t| t == FOREIGN_TRIPLE), "{triples:?}");
    pkg
}

#[tokio::test]
async fn packaged_native_plugin_installs_and_loads_on_this_host() {
    let work = tempfile::TempDir::new().unwrap();
    let package = match std::env::var_os("TERMIHUB_PLUGIN_PACKAGE") {
        Some(p) => PathBuf::from(p),
        None => fixture_package(work.path()),
    };
    println!(
        "host triple {}; package {}",
        host_target_triple(),
        package.display()
    );

    // Install through the real manager (unsigned package → accept the risk).
    let root = work.path().join("plugins");
    let manager = PluginManager::new(&root);
    let installed = manager
        .install(&package, true, false)
        .expect("the package installs on this platform");
    let id = installed.manifest.id.clone();
    let backend = installed
        .manifest
        .extensions
        .terminal_backend
        .clone()
        .expect("a native plugin declares a terminal backend");

    // Satisfy the native trust gate with the hash of the SELECTED library.
    let hash = native_library_hash(&root, &id).expect("the host's library resolves");
    if let Some(expected) = std::env::var_os("TERMIHUB_PLUGIN_LIBRARY_SHA256") {
        assert_eq!(
            hash.trim_start_matches("sha256:"),
            expected.to_string_lossy().trim(),
            "the selected library must be the one the packer staged for this host"
        );
    }
    let mut trust = NativeTrustStore::load(&root);
    trust.set_native_enabled(true).unwrap();
    trust.acknowledge(&id, hash).unwrap();

    // Load through the real host and run a session.
    let registry = Arc::new(Mutex::new(ConnectionTypeRegistry::new()));
    let host = PluginHost::new(&root, Arc::clone(&registry));
    host.load(&installed)
        .expect("the host loads the packaged plugin");
    assert!(host.is_loaded(&id));

    let type_id = plugin_type_id(&id, &backend.connection_type);
    let mut conn = registry
        .lock()
        .unwrap()
        .create(&type_id)
        .expect("the plugin's connection type is registered");
    let mut rx = conn.subscribe_output();
    conn.connect(serde_json::json!({}))
        .await
        .expect("connect succeeds");
    conn.write(b"hello packaged plugin")
        .expect("write succeeds");

    let mut echoed = Vec::new();
    while !String::from_utf8_lossy(&echoed).contains("hello packaged plugin") {
        let chunk = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("echoed output arrives within the timeout")
            .expect("output channel yields a chunk");
        echoed.extend_from_slice(&chunk);
    }
    conn.disconnect().await.expect("disconnect succeeds");
    drop(conn);
    host.unload(&id);
}
