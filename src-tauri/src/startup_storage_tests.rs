use super::{config_resolve_failure_warning, resolve_startup_dir, DirOutcome, StartupStorage};
use std::io::{Error, ErrorKind};
use std::path::PathBuf;

fn io_err(msg: &str) -> Error {
    Error::new(ErrorKind::PermissionDenied, msg)
}

#[test]
fn preferred_yields_the_real_path_and_no_warning() {
    let dir = PathBuf::from("/real/config");
    let (path, warning) = resolve_startup_dir(
        DirOutcome::Preferred(dir.clone()),
        StartupStorage::Config,
        &dir,
    );
    assert_eq!(path, Some(dir));
    assert!(
        warning.is_none(),
        "the happy path must not surface a warning"
    );
}

#[test]
fn fallback_yields_the_fallback_path_and_a_warning() {
    let preferred = PathBuf::from("/read-only/config");
    let fallback = PathBuf::from("/tmp/termihub-config");
    let (path, warning) = resolve_startup_dir(
        DirOutcome::Fallback {
            dir: fallback.clone(),
            error: io_err("denied"),
        },
        StartupStorage::Config,
        &preferred,
    );
    assert_eq!(path, Some(fallback));
    let w = warning.expect("a degradation must surface a warning");
    assert_eq!(w.file_name, "config directory");
    let details = w.details.expect("warning carries details");
    assert!(details.contains("read-only/config"));
    assert!(details.contains("denied"));
}

#[test]
fn config_total_failure_keeps_the_preferred_path_best_effort() {
    let preferred = PathBuf::from("/read-only/config");
    let (path, warning) = resolve_startup_dir(
        DirOutcome::Failed {
            preferred_error: io_err("denied"),
            fallback_error: io_err("also denied"),
        },
        StartupStorage::Config,
        &preferred,
    );
    assert_eq!(
        path,
        Some(preferred),
        "config keeps the preferred dir best-effort on total failure"
    );
    assert!(warning.is_some());
}

#[test]
fn portable_total_failure_drops_the_override() {
    let preferred = PathBuf::from("/usb/termiHub/data");
    let (path, warning) = resolve_startup_dir(
        DirOutcome::Failed {
            preferred_error: io_err("read-only medium"),
            fallback_error: io_err("read-only medium"),
        },
        StartupStorage::PortableData,
        &preferred,
    );
    assert_eq!(
        path, None,
        "portable total failure drops to the OS default location"
    );
    let w = warning.expect("a degradation must surface a warning");
    assert_eq!(w.file_name, "portable data directory");
}

#[test]
fn resolve_failure_produces_a_config_warning() {
    let fallback = PathBuf::from("/tmp/termihub-config");
    let w = config_resolve_failure_warning("no config dir available", &fallback);
    assert_eq!(w.file_name, "config directory");
    assert!(w.message.contains("termihub-config"));
    assert_eq!(w.details.as_deref(), Some("no config dir available"));
}
