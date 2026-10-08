//! Shared builder for the native test-plugin fixture (`tests/fixtures/test-plugin`).
//!
//! Every plugin integration test needs the fixture `cdylib`. Building it into a
//! fresh throwaway target directory per test cold-compiled the fixture and all of
//! its dependencies about 15 times per `cargo test` run (#3918). Instead, each
//! [`Variant`] is built into one shared target directory under cargo's
//! per-package integration-test scratch dir (`CARGO_TARGET_TMPDIR`):
//!
//! * within one test binary the build runs at most once per variant (a
//!   [`OnceLock`] per variant), and
//! * across test binaries a second `cargo build` of an unchanged variant is a
//!   no-op, and cargo's build-directory lock serialises concurrent builds.
//!
//! Variants get separate target directories because they all produce the same
//! output file name; sharing one directory would let one variant's build
//! overwrite another's artifact between build and copy.
//!
//! **Tests never load the shared artifact.** [`fixture_library`] copies it to a
//! fresh path under the calling test's own temporary directory, and the test
//! loads that copy. Each test therefore `dlopen`s / `LoadLibrary`s an
//! independent file, so no plugin statics are shared between tests (the loader
//! keys loaded images by path/inode), and on Windows the loaded DLL never locks
//! the shared artifact against a later rebuild.
#![allow(
    dead_code,
    reason = "shared test-support module: each test binary uses a different subset"
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// A feature configuration of the fixture plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// Default features: exports every ABI 1.1 symbol.
    Default,
    /// `--no-default-features`: omits `termihub_plugin_init` (missing-symbol tests).
    NoInit,
    /// `--features abi-1-0`: a faithful ABI 1.0 plugin.
    Abi10,
    /// `--features crash-commands`: misbehaves on command (#4184 isolation).
    Crash,
}

impl Variant {
    /// Stable short name, used for the shared target dir and the per-test copy.
    fn tag(self) -> &'static str {
        match self {
            Variant::Default => "default",
            Variant::NoInit => "no-init",
            Variant::Abi10 => "abi-1-0",
            Variant::Crash => "crash",
        }
    }

    fn index(self) -> usize {
        match self {
            Variant::Default => 0,
            Variant::NoInit => 1,
            Variant::Abi10 => 2,
            Variant::Crash => 3,
        }
    }

    fn cargo_feature_args(self) -> &'static [&'static str] {
        match self {
            Variant::Default => &[],
            Variant::NoInit => &["--no-default-features"],
            Variant::Abi10 => &["--features", "abi-1-0"],
            Variant::Crash => &["--features", "crash-commands"],
        }
    }
}

/// Path to the fixture plugin's `Cargo.toml`.
pub fn fixture_manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test-plugin")
        .join("Cargo.toml")
}

/// The platform-specific file name cargo produces for the fixture `cdylib`.
pub fn artifact_name() -> String {
    format!(
        "{}termihub_test_plugin{}",
        std::env::consts::DLL_PREFIX,
        std::env::consts::DLL_SUFFIX
    )
}

/// The shared target directory for `variant`.
fn shared_target_dir(variant: Variant) -> PathBuf {
    Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("test-plugin-{}", variant.tag()))
}

/// Build `variant` into its shared target directory (once per test binary) and
/// return the path of the shared artifact. Callers must copy it, never load it.
fn shared_artifact(variant: Variant) -> &'static Path {
    static BUILT: [OnceLock<PathBuf>; 4] = [
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
        OnceLock::new(),
    ];
    BUILT[variant.index()].get_or_init(|| {
        let target_dir = shared_target_dir(variant);
        let status = Command::new(env!("CARGO"))
            .arg("build")
            .arg("--manifest-path")
            .arg(fixture_manifest())
            .arg("--target-dir")
            .arg(&target_dir)
            .args(variant.cargo_feature_args())
            .status()
            .expect("failed to spawn cargo to build the fixture plugin");
        assert!(
            status.success(),
            "building the fixture plugin failed (variant {variant:?})"
        );
        target_dir.join("debug").join(artifact_name())
    })
}

/// Build `variant` if needed and copy it to a fresh, test-private path,
/// `<work>/fixture-<variant>/<artifact name>`, which the test then loads.
///
/// `work` must be the calling test's own temporary directory. The copy keeps the
/// real artifact file name, so it can be installed or packaged as-is. Calling
/// this twice for the same variant and `work` is a bug (the copy would not be
/// independent), so it panics if the destination already exists.
pub fn fixture_library(variant: Variant, work: &Path) -> PathBuf {
    let src = shared_artifact(variant);
    let dir = work.join(format!("fixture-{}", variant.tag()));
    let dest = dir.join(artifact_name());
    assert!(
        !dest.exists(),
        "{} already exists: each test must load its own fixture copy",
        dest.display()
    );
    std::fs::create_dir_all(&dir).expect("create the fixture copy dir");
    // A concurrent `cargo build` of this variant from another process may
    // briefly re-link the shared artifact; retry the copy rather than flake.
    let mut attempt = 0;
    loop {
        match std::fs::copy(src, &dest) {
            Ok(_) => break,
            Err(e) if attempt < 10 => {
                attempt += 1;
                eprintln!("copying the fixture plugin failed ({e}); retrying");
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => panic!("copy the fixture plugin {} failed: {e}", src.display()),
        }
    }
    dest
}
