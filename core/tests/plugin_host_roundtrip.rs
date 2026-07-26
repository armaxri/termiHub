//! End-to-end round-trip test for the native plugin host loader (#1995).
//!
//! Builds the real `cdylib` fixture at `tests/fixtures/test-plugin`, then drives
//! it through the public host API: a successful load with metadata, a full
//! [`ConnectionType`] session that echoes input back through the output channel,
//! an incompatible-ABI rejection, and missing-symbol handling.
//!
//! The fixture is compiled with `cargo build` into a throwaway target directory,
//! so the test genuinely exercises `dlopen`/`LoadLibrary` on whichever platform
//! it runs. The whole file is gated on the `plugin` feature (which pulls the host
//! loader); without it there is nothing to test.
#![cfg(feature = "plugin")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use termihub_core::connection::ConnectionType;
use termihub_core::plugin::{load_backend_library, HostError, PluginConnectionType};

/// Path to the fixture plugin's `Cargo.toml`.
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

/// Build the fixture into `target_dir`. With `default_features == false` the
/// `termihub_plugin_init` symbol is omitted (for the missing-symbol scenario).
/// Returns the path to the freshly-built library.
fn build_fixture(target_dir: &Path, default_features: bool) -> PathBuf {
    let mut cmd = Command::new(env!("CARGO"));
    cmd.arg("build")
        .arg("--manifest-path")
        .arg(fixture_manifest())
        .arg("--target-dir")
        .arg(target_dir);
    if !default_features {
        cmd.arg("--no-default-features");
    }
    let status = cmd
        .status()
        .expect("failed to spawn cargo to build the fixture plugin");
    assert!(
        status.success(),
        "building the fixture plugin failed (features default={default_features})"
    );
    target_dir.join("debug").join(artifact_name())
}

#[tokio::test]
async fn plugin_host_round_trip() {
    let tmp = tempfile::TempDir::new().unwrap();
    let target_dir = tmp.path().join("target");

    // Build the full plugin, then the init-less variant into the SAME target dir
    // (only the fixture crate itself recompiles). Copy each artifact aside since
    // the two builds share one output filename.
    let built = build_fixture(&target_dir, true);
    let good = tmp.path().join(format!("good-{}", artifact_name()));
    std::fs::copy(&built, &good).expect("copy good artifact");

    let built = build_fixture(&target_dir, false);
    let noinit = tmp.path().join(format!("noinit-{}", artifact_name()));
    std::fs::copy(&built, &noinit).expect("copy init-less artifact");

    // --- 1. Successful load + metadata read from plugin_init. ---
    let lib = load_backend_library(&good).expect("the good plugin should load");
    assert_eq!(lib.info().id, "test-echo");
    assert_eq!(lib.info().name, "Test Echo");
    assert_eq!(lib.info().version, "0.1.0");
    assert_eq!(lib.info().api_version, 2);

    // --- 2. Full ConnectionType round trip: written input echoes to output. ---
    let mut conn = PluginConnectionType::new(
        std::sync::Arc::clone(&lib),
        "test-echo".to_string(),
        "Test Echo".to_string(),
        termihub_core::connection::SettingsSchema { groups: vec![] },
        termihub_core::plugin::PermissionSet::from_parts(
            [termihub_core::plugin::PluginPermission::Terminal],
            &[],
        ),
    );
    let mut rx = conn.subscribe_output();
    conn.connect(serde_json::json!({ "foo": "bar" }))
        .await
        .expect("connect should succeed");
    assert!(conn.is_connected());

    conn.write(b"hello plugin").expect("write should succeed");
    let out = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("echoed output should arrive within the timeout")
        .expect("output channel should yield a chunk");
    assert_eq!(out, b"hello plugin");

    conn.disconnect().await.expect("disconnect should succeed");
    assert!(!conn.is_connected());

    // --- 3. Incompatible ABI is rejected without loading, never a crash. ---
    // SAFETY (env): single-threaded within this test; no other code reads the
    // variable, and it is removed immediately after the load.
    std::env::set_var("TERMIHUB_TEST_PLUGIN_ABI", "99");
    let result = load_backend_library(&good);
    std::env::remove_var("TERMIHUB_TEST_PLUGIN_ABI");
    match result {
        Err(HostError::IncompatibleAbi { expected, found }) => {
            assert_eq!(expected, 2);
            assert_eq!(found, 99);
        }
        Err(other) => panic!("expected IncompatibleAbi, got {other:?}"),
        Ok(_) => panic!("expected IncompatibleAbi, got a successful load"),
    }

    // --- 4. Missing required symbol is a clean error. ---
    match load_backend_library(&noinit) {
        Err(HostError::MissingSymbol(name)) => assert_eq!(name, "termihub_plugin_init"),
        Err(other) => panic!("expected MissingSymbol, got {other:?}"),
        Ok(_) => panic!("expected MissingSymbol, got a successful load"),
    }
}
