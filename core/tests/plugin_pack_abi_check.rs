//! The packer refuses a native plugin whose manifest `apiVersion` disagrees with
//! the ABI its library exports (#3372).
//!
//! Uses the real `tests/fixtures/test-plugin` cdylib (built once per variant by
//! [`plugin_fixture`]), so this also proves the ABI marker survives the real
//! linker on every CI platform. The library is only **read**, never loaded.
#![cfg(feature = "plugin")]

use std::path::{Path, PathBuf};
use std::process::Command;

mod plugin_fixture;
use plugin_fixture::{fixture_library, Variant};

use termihub_core::plugin::{pack_plugin_with_report, PluginPackError};
use termihub_plugin_api::AbiVersion;

/// A native-plugin manifest declaring `api_version`.
fn manifest(api_version: &str) -> String {
    format!(
        r#"{{
    "id": "abi-check",
    "name": "ABI Check",
    "version": "0.1.0",
    "author": "termiHub tests",
    "description": "Native fixture for the packer ABI check",
    "license": "MIT",
    "apiVersion": "{api_version}",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal"],
    "extensions": {{
        "terminalBackend": {{
            "connectionType": "abi-check",
            "displayName": "ABI Check",
            "configSchema": {{ "type": "object", "properties": {{}} }}
        }}
    }}
}}"#
    )
}

/// Stage a legacy single-platform source tree: `variant`'s library flat in
/// `backend/` plus a manifest declaring `api_version`.
fn stage(work: &Path, variant: Variant, api_version: &str) -> PathBuf {
    let lib = fixture_library(variant, work);
    let src = work.join("src");
    std::fs::create_dir_all(src.join("backend")).unwrap();
    std::fs::copy(&lib, src.join("backend").join(lib.file_name().unwrap())).unwrap();
    std::fs::write(src.join("manifest.json"), manifest(api_version)).unwrap();
    src
}

#[test]
fn mismatched_manifest_api_version_is_refused() {
    let work = tempfile::TempDir::new().unwrap();
    // The default fixture exports ABI 1.1; the manifest claims 1.0.
    let src = stage(work.path(), Variant::Default, "1.0");
    let out = work.path().join("dist");

    let err = pack_plugin_with_report(&src, &out).unwrap_err();
    match &err {
        PluginPackError::LibraryAbiMismatch {
            manifest,
            library_abi,
            library,
        } => {
            assert_eq!(manifest, "1.0");
            assert_eq!(*library_abi, AbiVersion::new(1, 1));
            assert!(library.starts_with("backend/"), "{library}");
        }
        other => panic!("expected LibraryAbiMismatch, got {other:?}"),
    }
    let message = err.to_string();
    assert!(
        message.contains("1.0") && message.contains("1.1"),
        "{message}"
    );
    // Nothing is written for a refused package.
    assert!(!out.exists() || std::fs::read_dir(&out).unwrap().next().is_none());
}

#[test]
fn matching_manifest_api_version_packs_without_warnings() {
    let work = tempfile::TempDir::new().unwrap();
    let src = stage(work.path(), Variant::Default, "1.1");

    let packed = pack_plugin_with_report(&src, &work.path().join("dist")).unwrap();
    assert!(packed.path.is_file());
    assert!(packed.warnings.is_empty(), "{:?}", packed.warnings);
}

#[test]
fn an_older_minor_plugin_matches_its_own_marker() {
    let work = tempfile::TempDir::new().unwrap();
    // The ABI 1.0 fixture variant embeds a 1.0 marker.
    let src = stage(work.path(), Variant::Abi10, "1.0");
    let packed = pack_plugin_with_report(&src, &work.path().join("dist")).unwrap();
    assert!(packed.warnings.is_empty(), "{:?}", packed.warnings);

    let work = tempfile::TempDir::new().unwrap();
    let src = stage(work.path(), Variant::Abi10, "1.1");
    assert!(matches!(
        pack_plugin_with_report(&src, &work.path().join("dist")),
        Err(PluginPackError::LibraryAbiMismatch { .. })
    ));
}

/// The CLI the `scripts/package-plugin.{sh,cmd}` wrappers call.
fn run_packer(src: &Path, out: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_termihub-plugin-pack"))
        .arg("--source")
        .arg(src)
        .arg("--out")
        .arg(out)
        .output()
        .expect("run termihub-plugin-pack")
}

#[test]
fn cli_fails_on_a_mismatch_naming_both_versions() {
    let work = tempfile::TempDir::new().unwrap();
    let src = stage(work.path(), Variant::Default, "1.0");
    let output = run_packer(&src, &work.path().join("dist"));

    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stdout.contains("Created"), "{stdout}");
    assert!(
        stderr.contains("\"1.0\"") && stderr.contains("ABI 1.1"),
        "{stderr}"
    );
}

#[test]
fn cli_warns_but_packs_a_library_without_a_marker() {
    let work = tempfile::TempDir::new().unwrap();
    let src = work.path().join("src");
    std::fs::create_dir_all(src.join("backend")).unwrap();
    // A library the packer cannot read an ABI from (e.g. a hand-written
    // `termihub_plugin_abi_version` without the marker).
    std::fs::write(src.join("backend/libunmarked.so"), b"\x7fELF no marker").unwrap();
    std::fs::write(src.join("manifest.json"), manifest("1.1")).unwrap();

    let output = run_packer(&src, &work.path().join("dist"));
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stdout.contains("Created"), "{stdout}");
    assert!(
        stderr.contains("warning:") && stderr.contains("backend/libunmarked.so"),
        "{stderr}"
    );
}
