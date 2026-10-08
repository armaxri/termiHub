//! Where the `termihub-plugin-runner` binary lives, and the pre-spawn integrity
//! check of the bundled one (#4202).
//!
//! **Resolution.** An installed termiHub ships the runner as a Tauri
//! `externalBin` sidecar, which the installer places next to the main
//! executable ([`default_runner_path`]). A debug build (`tauri dev`, `cargo
//! test`) uses the cargo-built runner instead: the same next-to-exe file when
//! it exists, else — for a test binary under `target/<profile>/deps/` — the one
//! in `target/<profile>/`. `$TERMIHUB_PLUGIN_RUNNER` overrides both in debug
//! builds ([`debug_runner_config_from_env`](super::debug_runner_config_from_env)).
//!
//! **Integrity** (concept failure mode "Helper binary missing or tampered").
//! Exactly like the RDP sidecar (#1762), the build embeds the SHA-256 of the
//! staged runner (`core/build.rs`, `TERMIHUB_PLUGIN_RUNNER_SHA256`, release
//! profile only). Before the host spawns the **bundled** runner it opens the
//! file once, hashes that handle and requires the embedded digest; the spawn
//! then goes through the retained handle ([`PinnedLibrary`], the pinning the
//! runner's own loader uses for plugin libraries, #2796) and the handle is
//! re-hashed once the child exists. A missing or tampered bundled runner is
//! refused with [`RUNNER_MISSING`].
//!
//! The check is skipped (spawned by path, as before) for a runner the operator
//! picked explicitly — any path other than the bundled one, i.e. the debug
//! override and tests — and when no digest was embedded (debug builds, or a
//! release built without staging the runner).

use std::path::{Path, PathBuf};

use termihub_plugin_runner::loader::{LoadError, PinnedLibrary, DIGEST_ALGORITHM};

use crate::plugin::HostError;

/// The runner binary's file name on this platform.
#[cfg(windows)]
pub const RUNNER_BIN_NAME: &str = "termihub-plugin-runner.exe";
/// The runner binary's file name on this platform.
#[cfg(not(windows))]
pub const RUNNER_BIN_NAME: &str = "termihub-plugin-runner";

/// What a user sees when the bundled runner is missing or fails its integrity
/// check: there is nothing to configure, only a broken install.
pub const RUNNER_MISSING: &str = "Plugin runner is missing — reinstall termiHub";

/// The bundled runner's SHA-256 (lowercase hex), embedded at build time by
/// `core/build.rs`. `None` when no runner was staged (debug and branch builds).
pub const EXPECTED_RUNNER_SHA256: Option<&str> = option_env!("TERMIHUB_PLUGIN_RUNNER_SHA256");

/// Where the runner lives: next to the running executable (Tauri
/// `externalBin` sidecars are installed beside the main binary), or the
/// cargo-built one in a debug build (see the module docs).
#[must_use]
pub fn default_runner_path() -> Option<PathBuf> {
    resolve_runner_path(
        std::env::current_exe().ok().as_deref(),
        cfg!(debug_assertions),
    )
}

/// Log, once at startup, where the bundled runner is expected and the digest
/// it is held to. This also keeps the embedded digest in the shipped binary in
/// every build, so `scripts/internal/verify-plugin-runner-bundle.sh` can check
/// a bundle's runner against it even while release builds never spawn one.
pub fn log_bundled_runner() {
    tracing::info!(
        path = ?bundled_runner_path(),
        sha256 = EXPECTED_RUNNER_SHA256.unwrap_or("none embedded"),
        "Bundled plugin runner"
    );
}

/// The bundled location: [`RUNNER_BIN_NAME`] next to the running executable.
fn bundled_runner_path() -> Option<PathBuf> {
    Some(
        std::env::current_exe()
            .ok()?
            .parent()?
            .join(RUNNER_BIN_NAME),
    )
}

/// Pure core of [`default_runner_path`]. `dev` enables the debug-build
/// fallback from a `target/<profile>/deps/` test binary to the cargo-built
/// runner one directory up.
fn resolve_runner_path(exe: Option<&Path>, dev: bool) -> Option<PathBuf> {
    let dir = exe?.parent()?;
    let bundled = dir.join(RUNNER_BIN_NAME);
    if dev && !bundled.is_file() && dir.file_name().is_some_and(|n| n == "deps") {
        if let Some(built) = dir.parent().map(|p| p.join(RUNNER_BIN_NAME)) {
            if built.is_file() {
                return Some(built);
            }
        }
    }
    Some(bundled)
}

/// How the host treats the runner it is about to spawn.
#[derive(Debug, PartialEq, Eq)]
enum Trust {
    /// The bundled runner of an install: it must exist and hash to `expected`
    /// (lowercase hex).
    Bundled { expected: Option<String> },
    /// A runner picked explicitly (debug override, tests): spawned by path.
    Explicit,
}

/// Classify `runner` against the bundled location and the embedded digest.
fn trust_for(runner: &Path, bundled: Option<&Path>, expected: Option<&str>) -> Trust {
    if bundled != Some(runner) {
        return Trust::Explicit;
    }
    let expected = expected
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| e.len() == 64 && e.bytes().all(|b| b.is_ascii_hexdigit()));
    Trust::Bundled { expected }
}

/// The detail of a refused bundled runner: [`RUNNER_MISSING`], plus the
/// technical reason for the log.
fn refused(runner: &Path, reason: &str) -> HostError {
    HostError::RunnerUnavailable {
        path: runner.to_owned(),
        detail: format!("{RUNNER_MISSING} ({reason})"),
    }
}

/// Run the pre-spawn checks for `runner` (see the module docs).
///
/// `Ok(Some(pinned))`: spawn through [`PinnedLibrary::load_path`] and call
/// [`PinnedLibrary::confirm_after_load`] once the child exists. `Ok(None)`: no
/// digest to check against, spawn by path. `Err`: refuse to spawn.
pub(super) fn check_runner(runner: &Path) -> Result<Option<PinnedLibrary>, HostError> {
    check_runner_with(
        runner,
        bundled_runner_path().as_deref(),
        EXPECTED_RUNNER_SHA256,
    )
}

/// Pure core of [`check_runner`].
fn check_runner_with(
    runner: &Path,
    bundled: Option<&Path>,
    expected: Option<&str>,
) -> Result<Option<PinnedLibrary>, HostError> {
    let Trust::Bundled { expected } = trust_for(runner, bundled, expected) else {
        return Ok(None);
    };
    if !runner.is_file() {
        let reason = if cfg!(debug_assertions) {
            "not found; in a dev build run `cargo build -p termihub-plugin-runner`"
        } else {
            "not found next to the termiHub executable"
        };
        return Err(refused(runner, reason));
    }
    let Some(expected) = expected else {
        tracing::warn!(
            path = %runner.display(),
            "no build-time SHA-256 embedded for the plugin runner; spawning it without \
             integrity verification (dev/branch build)"
        );
        return Ok(None);
    };
    pin(runner, &format!("{DIGEST_ALGORITHM}:{expected}")).map(Some)
}

/// Open and hash `runner`, requiring `expected` (`sha256:<hex>`). On Linux the
/// pinned handle is exec'd as `/proc/self/fd/<n>`; it must not be the
/// runner's channel descriptor, which the child's `dup2` replaces before exec.
fn pin(runner: &Path, expected: &str) -> Result<PinnedLibrary, HostError> {
    let map = |e: LoadError| match e {
        LoadError::LibraryDigestMismatch {
            expected, actual, ..
        } => refused(
            runner,
            &format!("integrity check failed: expected {expected}, found {actual}"),
        ),
        other => refused(runner, &other.to_string()),
    };
    let first = PinnedLibrary::open_verified(runner, expected).map_err(map)?;
    if !occupies_channel_fd(&first) {
        return Ok(first);
    }
    // Opened while `first` holds the channel descriptor, so it gets another.
    let second = PinnedLibrary::open_verified(runner, expected).map_err(map)?;
    drop(first);
    Ok(second)
}

/// Whether `pinned` would be exec'd through the runner's channel descriptor
/// (only Linux / Android exec through a descriptor).
fn occupies_channel_fd(pinned: &PinnedLibrary) -> bool {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let channel = format!("/proc/self/fd/{}", termihub_plugin_runner::ipc::IPC_FD);
        pinned.load_path().is_ok_and(|p| p == Path::new(&channel))
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let _ = pinned;
        false
    }
}

/// Re-verify a pinned runner after its child was spawned; on `Err` the caller
/// kills the child before sending it anything. Only Unix spawns a runner yet.
#[cfg(any(unix, test))]
pub(super) fn confirm_runner(runner: &Path, pinned: &PinnedLibrary) -> Result<(), HostError> {
    pinned
        .confirm_after_load()
        .map_err(|e| refused(runner, &e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn hex_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn runner_with(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join(RUNNER_BIN_NAME);
        std::fs::write(&path, bytes).unwrap();
        (tmp, path)
    }

    fn unavailable_detail(result: Result<Option<PinnedLibrary>, HostError>) -> String {
        match result {
            Err(HostError::RunnerUnavailable { detail, .. }) => detail,
            Err(other) => panic!("expected RunnerUnavailable, got {other:?}"),
            Ok(_) => panic!("the runner was accepted"),
        }
    }

    #[test]
    fn the_bundled_runner_sits_next_to_the_executable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let exe = tmp.path().join("termihub");
        assert_eq!(
            resolve_runner_path(Some(&exe), false),
            Some(tmp.path().join(RUNNER_BIN_NAME))
        );
        assert_eq!(resolve_runner_path(None, false), None);
    }

    #[test]
    fn a_dev_test_binary_falls_back_to_the_cargo_built_runner() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deps = tmp.path().join("deps");
        std::fs::create_dir(&deps).unwrap();
        let exe = deps.join("plugin_tests-0123");
        let built = tmp.path().join(RUNNER_BIN_NAME);
        // Nothing built yet: the next-to-exe path is reported, so a spawn
        // failure names where the runner was expected.
        assert_eq!(
            resolve_runner_path(Some(&exe), true),
            Some(deps.join(RUNNER_BIN_NAME))
        );
        std::fs::write(&built, b"runner").unwrap();
        assert_eq!(resolve_runner_path(Some(&exe), true), Some(built.clone()));
        // Release builds never look outside the install directory.
        assert_eq!(
            resolve_runner_path(Some(&exe), false),
            Some(deps.join(RUNNER_BIN_NAME))
        );
        // A runner next to the executable always wins.
        std::fs::write(deps.join(RUNNER_BIN_NAME), b"next to exe").unwrap();
        assert_eq!(
            resolve_runner_path(Some(&exe), true),
            Some(deps.join(RUNNER_BIN_NAME))
        );
    }

    #[test]
    fn the_fallback_only_applies_to_a_deps_directory() {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::write(tmp.path().join(RUNNER_BIN_NAME), b"runner").unwrap();
        assert_eq!(
            resolve_runner_path(Some(&bin.join("termihub")), true),
            Some(bin.join(RUNNER_BIN_NAME))
        );
    }

    #[test]
    fn default_runner_path_resolves_from_the_current_executable() {
        let path = default_runner_path().expect("current exe has a parent");
        assert_eq!(path.file_name().unwrap(), RUNNER_BIN_NAME);
    }

    #[test]
    fn the_startup_log_names_the_bundled_runner() {
        // Must not panic without a subscriber or an embedded digest.
        log_bundled_runner();
        assert_eq!(
            bundled_runner_path().and_then(|p| p.file_name().map(ToOwned::to_owned)),
            Some(RUNNER_BIN_NAME.into())
        );
    }

    #[test]
    fn only_the_bundled_path_is_held_to_the_digest() {
        let bundled = Path::new("/opt/termihub/termihub-plugin-runner");
        let digest = "AB".repeat(32);
        assert_eq!(
            trust_for(Path::new("/dev/runner"), Some(bundled), Some(&digest)),
            Trust::Explicit
        );
        assert_eq!(
            trust_for(bundled, None, Some(&digest)),
            Trust::Explicit,
            "no executable path: nothing is the bundled runner"
        );
        assert_eq!(
            trust_for(bundled, Some(bundled), Some(&format!(" {digest}\n"))),
            Trust::Bundled {
                expected: Some("ab".repeat(32))
            }
        );
        for unusable in [None, Some(""), Some("not-hex"), Some("ab")] {
            assert_eq!(
                trust_for(bundled, Some(bundled), unusable),
                Trust::Bundled { expected: None },
                "{unusable:?}"
            );
        }
    }

    #[test]
    fn a_matching_bundled_runner_is_pinned() {
        let (_tmp, path) = runner_with(b"runner bytes");
        let pinned = check_runner_with(&path, Some(&path), Some(&hex_of(b"runner bytes")))
            .expect("accepted")
            .expect("pinned");
        assert!(pinned.confirm_after_load().is_ok());
        confirm_runner(&path, &pinned).expect("still intact");
    }

    #[test]
    fn a_tampered_bundled_runner_is_refused_with_the_reinstall_hint() {
        let (_tmp, path) = runner_with(b"tampered");
        let expected = hex_of(b"runner bytes");
        let detail = unavailable_detail(check_runner_with(&path, Some(&path), Some(&expected)));
        assert!(detail.starts_with(RUNNER_MISSING), "{detail}");
        assert!(
            detail.contains(&expected),
            "names the expected digest: {detail}"
        );
        assert!(
            detail.contains(&hex_of(b"tampered")),
            "names the actual: {detail}"
        );
    }

    #[test]
    fn a_missing_bundled_runner_is_refused_with_the_reinstall_hint() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join(RUNNER_BIN_NAME);
        // With and without an embedded digest: a broken install either way.
        for expected in [Some(hex_of(b"x")), None] {
            let detail =
                unavailable_detail(check_runner_with(&path, Some(&path), expected.as_deref()));
            assert!(detail.starts_with(RUNNER_MISSING), "{detail}");
        }
    }

    #[test]
    fn an_explicit_or_unhashed_runner_is_spawned_by_path() {
        let (_tmp, path) = runner_with(b"anything");
        let other = path.with_file_name("elsewhere");
        // An explicit runner is never held to the bundled digest, nor required
        // to exist here (the spawn reports a missing one).
        assert!(check_runner_with(&other, Some(&path), Some(&hex_of(b"x")))
            .unwrap()
            .is_none());
        // The bundled runner without an embedded digest (dev/branch build).
        assert!(check_runner_with(&path, Some(&path), None)
            .unwrap()
            .is_none());
    }

    /// An in-place rewrite after the check is caught by the post-spawn re-hash.
    #[test]
    fn a_runner_rewritten_after_its_check_is_refused() {
        let (_tmp, path) = runner_with(b"runner bytes");
        let pinned = check_runner_with(&path, Some(&path), Some(&hex_of(b"runner bytes")))
            .unwrap()
            .unwrap();
        #[cfg(windows)]
        {
            // The share-deny handle makes the rewrite itself impossible, so
            // the pinned runner is still intact.
            assert!(std::fs::write(&path, b"evil").is_err());
            confirm_runner(&path, &pinned).expect("still intact");
        }
        #[cfg(not(windows))]
        {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .unwrap()
                .write_all(b"evil")
                .unwrap();
            match confirm_runner(&path, &pinned) {
                Err(HostError::RunnerUnavailable { detail, .. }) => {
                    assert!(detail.starts_with(RUNNER_MISSING), "{detail}");
                }
                other => panic!("expected RunnerUnavailable, got {other:?}"),
            }
        }
    }
}
