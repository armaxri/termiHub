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
/// used as sent. Windows confines by ACLs and the job object, not by path
/// matching, so the path is used as sent there (`canonicalize` would turn it
/// into a `\\?\` verbatim path for `LoadLibrary`).
pub(super) fn library_path(configure: &Configure) -> PathBuf {
    let path = PathBuf::from(&configure.library_path);
    if configure.sandbox.is_none() || cfg!(windows) {
        return path;
    }
    std::fs::canonicalize(&path).unwrap_or(path)
}

/// Point `HOME` and `TMPDIR` (on Windows also `TMP`, `TEMP` and
/// `USERPROFILE`) at the data folder, so a plugin's temporary files land where
/// it may write, then apply `policy` to this process. The folder is not
/// created here: the host creates it for ABI 1.1 plugins only.
pub(super) fn apply(policy: &SandboxPolicy) -> SandboxReport {
    if let Some(data) = &policy.data_dir {
        std::env::set_var("TMPDIR", data);
        std::env::set_var("HOME", data);
        if cfg!(windows) {
            // `GetTempPath2W` reads `TMP`, then `TEMP`, then `USERPROFILE`.
            for name in ["TMP", "TEMP", "USERPROFILE"] {
                std::env::set_var(name, data);
            }
        }
    }
    sandbox::apply(policy)
}
