//! Error paths of the two load steps and the teardown contract of
//! [`PluginLibrary`] (TBE2-004 / TBE2-005, #4341).
use super::*;

use std::sync::atomic::{AtomicUsize, Ordering};

fn info() -> LoadedPluginInfo {
    LoadedPluginInfo {
        id: "probe".to_owned(),
        name: "Probe".to_owned(),
        version: "0.0.0".to_owned(),
        abi_version: CURRENT_PLUGIN_ABI_VERSION,
        toolchain: None,
    }
}

#[test]
fn a_missing_library_fails_to_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent.plugin");
    let prepared = prepare_plugin_library(&path, &BackendLoadOptions::default())
        .expect("nothing to pin without a digest");
    assert!(matches!(prepared.load(), Err(LoadError::Open { .. })));
}

#[test]
fn a_file_that_is_not_a_library_fails_to_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("garbage.plugin");
    std::fs::write(&path, b"not a shared library").unwrap();
    let err = load_plugin_library(&path, &BackendLoadOptions::default())
        .err()
        .expect("garbage never loads");
    assert!(matches!(err, LoadError::Open { .. }), "{err}");
    assert!(!err.is_incompatible());
}

#[test]
fn a_digest_mismatch_is_refused_before_anything_is_mapped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lib.plugin");
    std::fs::write(&path, b"bytes").unwrap();
    let wrong = format!("sha256:{}", "0".repeat(64));
    let options = BackendLoadOptions {
        expected_digest: Some(&wrong),
        ..BackendLoadOptions::default()
    };
    assert!(matches!(
        prepare_plugin_library(&path, &options),
        Err(LoadError::LibraryDigestMismatch { .. })
    ));
}

#[test]
fn a_digest_bound_load_of_a_missing_library_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let options = BackendLoadOptions {
        expected_digest: Some("sha256:00"),
        ..BackendLoadOptions::default()
    };
    assert!(prepare_plugin_library(&dir.path().join("absent"), &options).is_err());
}

static SHUTDOWNS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" fn count_shutdown() {
    SHUTDOWNS.fetch_add(1, Ordering::SeqCst);
}

#[test]
fn dropping_a_library_calls_plugin_shutdown_exactly_once() {
    let library = PluginLibrary::for_teardown_test(info(), count_shutdown).unwrap();
    assert_eq!(library.info().id, "probe");
    assert!(library.supports(CURRENT_PLUGIN_ABI_VERSION));
    assert_eq!(SHUTDOWNS.load(Ordering::SeqCst), 0);
    drop(library);
    assert_eq!(SHUTDOWNS.load(Ordering::SeqCst), 1);
}

/// The last field of `struct <name>` in `source`, by declaration order.
fn last_field(source: &str, name: &str) -> String {
    let start = source
        .find(&format!("struct {name} {{"))
        .unwrap_or_else(|| panic!("struct {name} not found"));
    let body = &source[start..];
    let body = &body[..body.find("\n}").expect("struct end")];
    body.lines()
        .map(|l| l.trim().trim_start_matches("pub ").trim_start())
        .filter(|l| !l.starts_with("//") && !l.starts_with('#') && !l.starts_with(')'))
        .filter_map(|l| l.split_once(':').map(|(field, _)| field.trim().to_owned()))
        .rfind(|f| f.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .expect("a field")
}

#[test]
fn the_library_mapping_is_the_last_field_so_it_unmaps_last() {
    // Rust drops fields in declaration order: `library` must come after
    // everything that points into the mapping (TBE-010 / TBE2-004).
    assert_eq!(
        last_field(include_str!("mod.rs"), "PluginLibrary"),
        "library"
    );
    // The check itself notices a reorder.
    let reordered = "struct S {\n    library: Library,\n    /// doc: x\n    info: Info,\n}";
    assert_eq!(last_field(reordered, "S"), "info");
}
