//! The runner's side of the OS sandbox (#4186): prepare the process for the
//! policy, then confine it with the shared [`sandbox::apply`].
//!
//! Runs on the main thread before any other thread exists and before the plugin
//! library is mapped.

use std::path::PathBuf;

use termihub_plugin_runner::ipc::{Configure, SandboxReport};
use termihub_plugin_runner::sandbox::{self, SandboxPolicy};

/// The library path to pin and `dlopen`. Under a sandbox the kernel matches
/// resolved paths, so the path is canonicalised while that is still possible;
/// otherwise (or if it cannot be resolved, which the pin then reports) it is
/// used as sent.
pub(super) fn library_path(configure: &Configure) -> PathBuf {
    let path = PathBuf::from(&configure.library_path);
    if configure.sandbox.is_none() {
        return path;
    }
    std::fs::canonicalize(&path).unwrap_or(path)
}

/// Point `HOME` and `TMPDIR` into the data folder (so a plugin's temporary
/// files land where it may write), then apply `policy` to this process.
pub(super) fn apply(policy: &SandboxPolicy) -> SandboxReport {
    if let Some(data) = &policy.data_dir {
        let tmp = std::path::Path::new(data).join("tmp");
        if std::fs::create_dir_all(&tmp).is_ok() {
            std::env::set_var("TMPDIR", &tmp);
        }
        std::env::set_var("HOME", data);
    }
    sandbox::apply(policy)
}
