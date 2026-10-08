//! Load-gate round trip for the native plugin library loader (#1995).
//!
//! Builds the real `cdylib` fixture at `tests/fixtures/test-plugin`, then drives
//! it through the loader the sandboxed plugin runner uses
//! ([`termihub_plugin_runner::loader`]), mapping its errors as the host does: a
//! successful load with metadata, the ABI 1.x compatibility matrix across a
//! real `dlopen` (newer minor, other major, pre-freeze value, manifest mirror,
//! inconsistent reports), and missing-symbol handling. termiHub itself never
//! loads a plugin (ADR-19); this is a direct test of the gates the runner
//! applies before any plugin code runs. A full session through the host and
//! the runner is `plugin_runner_e2e.rs`.
//!
//! The fixture is compiled with `cargo build` (once per variant, shared across
//! tests, see `plugin_fixture`) and each test loads its own copy, so the test
//! genuinely exercises `dlopen`/`LoadLibrary` on whichever platform
//! it runs. The whole file is gated on the `plugin` feature (which pulls the
//! loader); without it there is nothing to test.
#![cfg(feature = "plugin")]

use std::path::Path;

mod plugin_fixture;
use plugin_fixture::{fixture_library, Variant};

use termihub_core::plugin::{
    AbiIncompatibility, AbiVersion, BackendLoadOptions, HostError, CURRENT_PLUGIN_ABI_VERSION,
};
use termihub_plugin_runner::loader::{load_plugin_library, PluginLibrary};

/// Open `lib` with the runner's loader, mapping its error as the host does.
fn load(lib: &Path, manifest_api_version: Option<&str>) -> Result<PluginLibrary, HostError> {
    load_plugin_library(
        lib,
        &BackendLoadOptions {
            manifest_api_version,
            ..BackendLoadOptions::default()
        },
    )
    .map_err(HostError::from)
}

#[test]
fn plugin_loader_round_trip() {
    let tmp = tempfile::TempDir::new().unwrap();

    // The full plugin and the init-less variant, each copied to this test's own
    // path (the shared build is never loaded directly).
    let good = fixture_library(Variant::Default, tmp.path());
    let noinit = fixture_library(Variant::NoInit, tmp.path());

    // --- 1. Successful load + metadata read from plugin_init. ---
    let lib = load(&good, None).expect("the good plugin should load");
    assert_eq!(lib.info().id, "test-echo");
    assert_eq!(lib.info().name, "Test Echo");
    assert_eq!(lib.info().version, "0.1.0");
    assert_eq!(lib.info().abi_version, CURRENT_PLUGIN_ABI_VERSION);
    drop(lib);

    // --- 2. ABI compatibility matrix, across a real dlopen. ---
    abi_matrix(&good);

    // --- 3. Missing required symbol is a clean error. ---
    match load(&noinit, None) {
        Err(HostError::MissingSymbol(name)) => assert_eq!(name, "termihub_plugin_init"),
        Err(other) => panic!("expected MissingSymbol, got {other:?}"),
        Ok(_) => panic!("expected MissingSymbol, got a successful load"),
    }
}

/// Load `lib` with `TERMIHUB_TEST_PLUGIN_ABI` (and optionally the info-ABI
/// override) set, restoring the environment afterwards.
fn load_with_abi(
    lib: &Path,
    abi: Option<&str>,
    info_abi: Option<&str>,
    manifest: Option<&str>,
) -> Result<PluginLibrary, HostError> {
    // SAFETY (env): the round trip is the only test in this binary, it runs
    // single-threaded here, and the variables are removed right after the load.
    if let Some(v) = abi {
        std::env::set_var("TERMIHUB_TEST_PLUGIN_ABI", v);
    }
    if let Some(v) = info_abi {
        std::env::set_var("TERMIHUB_TEST_PLUGIN_INFO_ABI", v);
    }
    let result = load(lib, manifest);
    std::env::remove_var("TERMIHUB_TEST_PLUGIN_ABI");
    std::env::remove_var("TERMIHUB_TEST_PLUGIN_INFO_ABI");
    result
}

/// Expect an `IncompatibleAbi` refusal and return its detail.
fn expect_incompatible(result: Result<PluginLibrary, HostError>) -> AbiIncompatibility {
    match result {
        Err(HostError::IncompatibleAbi(detail)) => detail,
        Err(other) => panic!("expected IncompatibleAbi, got {other:?}"),
        Ok(_) => panic!("expected IncompatibleAbi, got a successful load"),
    }
}

fn abi_matrix(good: &Path) {
    let host = CURRENT_PLUGIN_ABI_VERSION;

    // Same version, with a mirroring manifest: loads.
    let lib = load_with_abi(good, None, None, Some(&host.to_string()))
        .expect("same ABI with a mirroring manifest loads");
    assert_eq!(lib.info().abi_version, host);
    drop(lib);

    // Newer minor than the host: refused, "update termiHub".
    let newer = AbiVersion::new(host.major, host.minor + 1);
    let detail = expect_incompatible(load_with_abi(good, Some(&newer.to_string()), None, None));
    assert_eq!(
        detail,
        AbiIncompatibility::NewerMinor {
            plugin: newer,
            host
        }
    );
    assert!(detail.to_string().contains("update termiHub"), "{detail}");

    // Different major: refused.
    let next_major = AbiVersion::new(host.major + 1, 0);
    let detail = expect_incompatible(load_with_abi(
        good,
        Some(&next_major.to_string()),
        None,
        None,
    ));
    assert!(matches!(
        detail,
        AbiIncompatibility::UnsupportedMajor { plugin, .. } if plugin == next_major
    ));

    // A pre-freeze plugin returning the old exact-match counter (4) is major 0.
    let detail = expect_incompatible(load_with_abi(good, Some("4"), None, None));
    assert_eq!(detail.plugin(), AbiVersion::new(0, 4));

    // Manifest that does not mirror the library: refused before init.
    match load_with_abi(good, None, None, Some("1.7")) {
        Err(HostError::ManifestAbiMismatch { manifest, library }) => {
            assert_eq!(manifest, "1.7");
            assert_eq!(library, host);
        }
        Err(other) => panic!("expected ManifestAbiMismatch, got {other:?}"),
        Ok(_) => panic!("expected ManifestAbiMismatch, got a successful load"),
    }

    // Exported version and PluginInfo version disagree: refused.
    match load_with_abi(good, None, Some("0.9"), None) {
        Err(HostError::InconsistentAbi { symbol, info }) => {
            assert_eq!(symbol, host);
            assert_eq!(info, AbiVersion::new(0, 9));
        }
        Err(other) => panic!("expected InconsistentAbi, got {other:?}"),
        Ok(_) => panic!("expected InconsistentAbi, got a successful load"),
    }
}
