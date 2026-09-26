//! Tests for multi-platform package building (PLG-011).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::*;
use crate::plugin::{generate_keypair, library_file_name_for_triple, sign_package};

const LINUX: &str = "x86_64-unknown-linux-gnu";
const MAC: &str = "aarch64-apple-darwin";
const WINDOWS: &str = "x86_64-pc-windows-msvc";

fn native_manifest(version: &str) -> String {
    format!(
        r#"{{
            "id": "echo-backend",
            "name": "Echo",
            "version": "{version}",
            "author": "tester",
            "description": "echo",
            "license": "MIT",
            "apiVersion": "1.0",
            "platforms": ["linux", "macos", "windows"],
            "permissions": ["terminal"],
            "extensions": {{
                "terminalBackend": {{
                    "connectionType": "echo",
                    "displayName": "Echo",
                    "configSchema": {{}}
                }}
            }}
        }}"#
    )
}

/// A plugin source tree with a README and one library per triple under
/// `backend/<triple>/`, each library's bytes naming its triple.
fn fat_source(version: &str, triples: &[&str]) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(MANIFEST_FILE_NAME),
        native_manifest(version),
    )
    .unwrap();
    fs::write(dir.path().join("README.md"), b"# Echo").unwrap();
    for triple in triples {
        let lib_dir = dir.path().join("backend").join(triple);
        fs::create_dir_all(&lib_dir).unwrap();
        fs::write(
            lib_dir.join(library_file_name_for_triple("echo_backend", triple)),
            format!("lib for {triple}"),
        )
        .unwrap();
    }
    dir
}

fn pack_per_platform(triple: &str, out: &Path) -> PathBuf {
    let src = fat_source("1.0.0", &[triple]);
    let per_os = out.join(triple);
    pack_plugin(src.path(), &per_os).unwrap()
}

fn libraries_of(pkg: &Path) -> BTreeMap<String, String> {
    validate_package(pkg)
        .unwrap()
        .extensions
        .terminal_backend
        .unwrap()
        .libraries
}

#[test]
fn pack_derives_the_library_map_from_triple_directories() {
    let src = fat_source("1.0.0", &[LINUX, MAC, WINDOWS]);
    let out = TempDir::new().unwrap();
    let pkg = pack_plugin(src.path(), out.path()).unwrap();

    let libs = libraries_of(&pkg);
    assert_eq!(libs[LINUX], format!("backend/{LINUX}/libecho_backend.so"));
    assert_eq!(libs[MAC], format!("backend/{MAC}/libecho_backend.dylib"));
    assert_eq!(libs[WINDOWS], format!("backend/{WINDOWS}/echo_backend.dll"));

    let entries = package_platform_entries(&pkg).unwrap();
    assert_eq!(entries.len(), 3);
    for entry in entries {
        assert_eq!(
            entry.sha256,
            sha256_digest(format!("lib for {}", entry.triple).as_bytes())
        );
    }
}

#[test]
fn legacy_flat_backend_is_packed_without_a_library_map() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join(MANIFEST_FILE_NAME),
        native_manifest("1.0.0"),
    )
    .unwrap();
    fs::create_dir_all(dir.path().join("backend")).unwrap();
    fs::write(dir.path().join("backend/libecho_backend.so"), b"flat").unwrap();
    let out = TempDir::new().unwrap();
    let pkg = pack_plugin(dir.path(), out.path()).unwrap();
    assert!(libraries_of(&pkg).is_empty());
    assert!(package_platform_entries(&pkg).unwrap().is_empty());
}

#[test]
fn layout_errors_are_refused() {
    let out = TempDir::new().unwrap();

    let mixed = fat_source("1.0.0", &[LINUX]);
    fs::write(mixed.path().join("backend/libflat.so"), b"flat").unwrap();
    assert!(matches!(
        pack_plugin(mixed.path(), out.path()),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::MixedBackendLayout(_)
        ))
    ));

    let bad_dir = fat_source("1.0.0", &[]);
    fs::create_dir_all(bad_dir.path().join("backend/Linux")).unwrap();
    assert!(matches!(
        pack_plugin(bad_dir.path(), out.path()),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::InvalidPlatformDir(_)
        ))
    ));

    let two_libs = fat_source("1.0.0", &[LINUX]);
    fs::write(
        two_libs.path().join(format!("backend/{LINUX}/libother.so")),
        b"x",
    )
    .unwrap();
    assert!(matches!(
        pack_plugin(two_libs.path(), out.path()),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::PlatformLibraryCount { found: 2, .. }
        ))
    ));

    let wrong_ext = fat_source("1.0.0", &[]);
    let dir = wrong_ext.path().join(format!("backend/{WINDOWS}"));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("libecho_backend.so"), b"x").unwrap();
    assert!(matches!(
        pack_plugin(wrong_ext.path(), out.path()),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::PlatformLibraryCount { found: 0, .. }
        ))
    ));
}

#[test]
fn a_declared_map_must_match_the_tree() {
    let src = fat_source("1.0.0", &[LINUX]);
    let manifest = native_manifest("1.0.0").replace(
        "\"configSchema\": {}",
        &format!(
            "\"configSchema\": {{}}, \"libraries\": {{ \"{MAC}\": \"backend/{MAC}/libecho_backend.dylib\" }}"
        ),
    );
    fs::write(src.path().join(MANIFEST_FILE_NAME), manifest).unwrap();
    let out = TempDir::new().unwrap();
    assert!(matches!(
        pack_plugin(src.path(), out.path()),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::LibraryMapMismatch { .. }
        ))
    ));
}

#[test]
fn merge_combines_per_platform_packages_and_verifies_hashes() {
    let work = TempDir::new().unwrap();
    let linux = pack_per_platform(LINUX, work.path());
    let mac = pack_per_platform(MAC, work.path());
    let windows = pack_per_platform(WINDOWS, work.path());
    // A signed input is fine: the signature is dropped (re-sign the merge).
    sign_package(&linux, &generate_keypair("tester")).unwrap();

    let out = work.path().join("fat");
    let merged = merge_packages(&[linux.clone(), mac.clone(), windows.clone()], &out).unwrap();
    assert_eq!(
        merged.file_name().unwrap().to_str().unwrap(),
        "echo-backend-1.0.0.termihub-plugin"
    );

    let mut expected: Vec<PlatformEntry> = Vec::new();
    for input in [&linux, &mac, &windows] {
        expected.extend(package_platform_entries(input).unwrap());
    }
    expected.sort_by(|a, b| a.triple.cmp(&b.triple));
    assert_eq!(package_platform_entries(&merged).unwrap(), expected);

    let names = read_entries(&merged).unwrap();
    assert!(names.contains_key("README.md"));
    assert!(!names.contains_key(SIGNATURE_FILE_NAME));
    // No staging directory is left behind.
    assert_eq!(
        fs::read_dir(&out).unwrap().count(),
        1,
        "only the merged package remains"
    );
}

#[test]
fn merge_refuses_inconsistent_inputs() {
    let work = TempDir::new().unwrap();
    let out = work.path().join("fat");
    let linux = pack_per_platform(LINUX, work.path());

    assert!(matches!(
        merge_packages(&[], &out),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::NoMergeInputs
        ))
    ));

    let dup = pack_per_platform(LINUX, &work.path().join("again"));
    assert!(matches!(
        merge_packages(&[linux.clone(), dup], &out),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::DuplicatePlatform { .. }
        ))
    ));

    let other_version =
        pack_plugin(fat_source("2.0.0", &[MAC]).path(), &work.path().join("v2")).unwrap();
    assert!(matches!(
        merge_packages(&[linux.clone(), other_version], &out),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::MergeInputMismatch { .. }
        ))
    ));

    let readme_src = fat_source("1.0.0", &[MAC]);
    fs::write(readme_src.path().join("README.md"), b"# Different").unwrap();
    let readme = pack_plugin(readme_src.path(), &work.path().join("readme")).unwrap();
    match merge_packages(&[linux.clone(), readme], &out) {
        Err(PluginPackError::MultiPlatform(MultiPlatformPackError::MergeInputMismatch {
            what,
            ..
        })) => assert_eq!(what, "README.md"),
        other => panic!("expected a README mismatch, got {other:?}"),
    }

    let legacy_src = TempDir::new().unwrap();
    fs::write(
        legacy_src.path().join(MANIFEST_FILE_NAME),
        native_manifest("1.0.0"),
    )
    .unwrap();
    fs::create_dir_all(legacy_src.path().join("backend")).unwrap();
    fs::write(legacy_src.path().join("backend/libecho_backend.so"), b"x").unwrap();
    let legacy = pack_plugin(legacy_src.path(), &work.path().join("legacy")).unwrap();
    assert!(matches!(
        merge_packages(&[linux, legacy], &out),
        Err(PluginPackError::MultiPlatform(
            MultiPlatformPackError::LegacyMergeInput(_)
        ))
    ));
}
