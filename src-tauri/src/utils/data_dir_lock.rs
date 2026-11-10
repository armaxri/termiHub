//! Exclusive per-data-dir lock for portable mode (#3100, residual of
//! PER-005 / SM-025).
//!
//! The single-instance plugin is deliberately not used in portable mode: two
//! portable copies in *different* folders use different `data/` directories and
//! legitimately coexist, while the plugin's lock is global (keyed on the bundle
//! id). That leaves one gap — the *same* portable folder launched twice shares
//! one `data/` dir and the two copies can clobber each other's config and
//! `last_session` files.
//!
//! This module closes it with an OS advisory lock on `data/.termihub.lock`,
//! taken at startup before any store is built. Being an OS lock (`flock` on
//! unix, `LockFileEx` on Windows, via std's [`File::try_lock`]), it is scoped to
//! the one directory and **released by the OS when the holder exits or
//! crashes** — a leftover lock file on disk never blocks a later launch.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::portable::AppMode;

/// Name of the lock file created inside the portable data directory.
pub const LOCK_FILE_NAME: &str = ".termihub.lock";

/// A held data-dir lock. The lock lasts as long as this value (and, as an OS
/// lock, never past the process's life).
#[derive(Debug)]
pub struct DataDirLock {
    // Held only for its OS lock; dropping the file releases it.
    _file: File,
    path: PathBuf,
}

impl DataDirLock {
    /// Path of the lock file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Why the data-dir lock could not be taken.
#[derive(Debug, thiserror::Error)]
pub enum DataDirLockError {
    /// Another live process already holds the lock for this data dir.
    #[error("the data directory {} is in use by another termiHub instance", data_dir.display())]
    Held {
        /// The contended data directory.
        data_dir: PathBuf,
    },
    /// The lock file could not be opened or locked for another reason (for
    /// example a read-only medium).
    #[error("could not lock the data directory {}: {source}", data_dir.display())]
    Io {
        /// The data directory that was being locked.
        data_dir: PathBuf,
        /// The underlying I/O error.
        source: std::io::Error,
    },
}

/// Take the exclusive lock on `data_dir` without blocking.
///
/// Returns [`DataDirLockError::Held`] when another live process holds it, and
/// [`DataDirLockError::Io`] when the lock file cannot be opened or locked.
pub fn acquire(data_dir: &Path) -> Result<DataDirLock, DataDirLockError> {
    let path = data_dir.join(LOCK_FILE_NAME);
    let io_err = |source| DataDirLockError::Io {
        data_dir: data_dir.to_path_buf(),
        source,
    };
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(io_err)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err(DataDirLockError::Held {
                data_dir: data_dir.to_path_buf(),
            })
        }
        Err(TryLockError::Error(e)) => return Err(io_err(e)),
    }
    // Diagnostic only: record the holder's pid. The OS lock is authoritative.
    if let Err(e) = file
        .set_len(0)
        .and_then(|()| writeln!(file, "{}", std::process::id()))
    {
        tracing::debug!(
            "data-dir lock: could not record pid in {}: {e}",
            path.display()
        );
    }
    Ok(DataDirLock { _file: file, path })
}

/// The directory to lock for this launch, if any: the portable `data/` dir,
/// unless an explicit `TERMIHUB_CONFIG_DIR` override means it is not used.
/// Installed mode needs no lock here — the single-instance plugin covers it.
pub fn lock_target(mode: &AppMode, config_dir_env_override: bool) -> Option<&Path> {
    if config_dir_env_override {
        return None;
    }
    mode.data_dir()
}

/// User-facing explanation shown when the data dir is already locked.
pub fn held_message(data_dir: &Path) -> String {
    format!(
        "termiHub is already running from this folder.\n\n\
         Another termiHub window is using the portable data folder:\n{}\n\n\
         Switch to that window, or close it before starting termiHub again.",
        data_dir.display()
    )
}

/// Environment variable that suppresses the native "already running" dialog.
///
/// For headless process-level tests only (#5166): the message is still printed
/// to stderr and the process still exits with code 1, so the refusal itself is
/// unchanged — only the blocking dialog, which would hang a test with no one
/// to click OK, is skipped. Unset in every real launch.
pub const SUPPRESS_DIALOG_ENV: &str = "TERMIHUB_TEST_SUPPRESS_LOCK_DIALOG";

/// Exit code of a launch refused because its data dir is already locked.
pub const HELD_EXIT_CODE: i32 = 1;

/// What startup does after [`acquire`] failed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LockFailureAction {
    /// Another instance owns the data dir: show this message and exit. This
    /// launch must not write the shared files.
    Refuse {
        /// The user-facing explanation ([`held_message`]).
        message: String,
    },
    /// Any other failure: log it and continue unlocked (degrade, don't die).
    ContinueUnlocked,
}

/// Map a lock failure to the startup action. Only [`DataDirLockError::Held`]
/// refuses the launch; it can never fall through to "continue without the
/// lock".
pub(crate) fn on_lock_failure(err: &DataDirLockError) -> LockFailureAction {
    match err {
        DataDirLockError::Held { data_dir } => LockFailureAction::Refuse {
            message: held_message(data_dir),
        },
        DataDirLockError::Io { .. } => LockFailureAction::ContinueUnlocked,
    }
}

/// Startup entry point: in portable mode, lock the data dir before any store
/// is built and before the durable log file (which lives in `<data>/logs`)
/// opens (#5210). Returns the held lock (keep it alive for the whole run).
///
/// If another instance already holds this data dir, shows a native error
/// dialog and exits the process — this launch must not write the shared
/// files. Any other failure (detection, creating the dir, a read-only medium)
/// is logged and startup continues unlocked, matching the degrade-don't-die
/// storage policy.
pub fn lock_portable_data_dir_or_exit() -> Option<DataDirLock> {
    let mode = match super::portable::detect_app_mode() {
        Ok(mode) => mode,
        Err(e) => {
            tracing::warn!("data-dir lock: app-mode detection failed, not locking: {e}");
            return None;
        }
    };
    let override_set = std::env::var_os("TERMIHUB_CONFIG_DIR").is_some();
    let suppress_dialog = std::env::var_os(SUPPRESS_DIALOG_ENV).is_some();
    let mut dialog = |message: &str| {
        if !suppress_dialog {
            show_error_dialog(message);
        }
    };
    lock_or_exit_with(&mode, override_set, &mut dialog, std::process::exit)
}

/// The testable core of [`lock_portable_data_dir_or_exit`]: the dialog and the
/// process exit are injected so the refusal path can be exercised in-process.
///
/// On a held lock this prints the message to stderr, calls `dialog` exactly
/// once with it, then calls `exit(`[`HELD_EXIT_CODE`]`)`, which never returns.
pub(crate) fn lock_or_exit_with(
    mode: &AppMode,
    config_dir_env_override: bool,
    dialog: &mut dyn FnMut(&str),
    exit: fn(i32) -> !,
) -> Option<DataDirLock> {
    let data_dir = lock_target(mode, config_dir_env_override)?;
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        tracing::warn!(
            "data-dir lock: cannot create {}, not locking: {e}",
            data_dir.display()
        );
        return None;
    }
    let err = match acquire(data_dir) {
        Ok(lock) => {
            tracing::info!(lock_file = %lock.path().display(), "Portable data directory locked");
            return Some(lock);
        }
        Err(err) => err,
    };
    match on_lock_failure(&err) {
        LockFailureAction::Refuse { message } => {
            tracing::error!("{message}");
            eprintln!("{message}");
            dialog(&message);
            exit(HELD_EXIT_CODE)
        }
        LockFailureAction::ContinueUnlocked => {
            tracing::warn!("data-dir lock: {err}; continuing without the lock");
            None
        }
    }
}

/// User-facing explanation printed when a settings-writing CLI subcommand
/// (`install-shell-integration` / `uninstall-shell-integration`) is refused
/// because a termiHub instance already holds this portable data dir (#5245).
pub fn cli_held_message(data_dir: &Path) -> String {
    format!(
        "termiHub is running from this folder, so this command cannot change its settings.\n\n\
         The portable data folder is in use:\n{}\n\n\
         Use Settings in the running termiHub, or close it first and run the command again. \
         Nothing was changed.",
        data_dir.display()
    )
}

/// Take the portable data-dir lock for a CLI subcommand that writes the shared
/// files (#5245), without any dialog or process exit.
///
/// * Installed mode, or an explicit `TERMIHUB_CONFIG_DIR` override: no lock is
///   needed, returns `Ok(None)`.
/// * Lock free: returns the held lock; keep it alive until the write is done.
/// * Lock held by another instance: returns `Err` with [`cli_held_message`].
///   The caller must change nothing and exit non-zero.
/// * Any other failure (creating the dir, a read-only medium): logged, and
///   `Ok(None)` — the same degrade-don't-die policy as the GUI launch.
pub fn lock_for_cli_write(
    mode: &AppMode,
    config_dir_env_override: bool,
) -> Result<Option<DataDirLock>, String> {
    let Some(data_dir) = lock_target(mode, config_dir_env_override) else {
        return Ok(None);
    };
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        tracing::warn!(
            "data-dir lock: cannot create {}, not locking: {e}",
            data_dir.display()
        );
        return Ok(None);
    }
    let err = match acquire(data_dir) {
        Ok(lock) => return Ok(Some(lock)),
        Err(err) => err,
    };
    match on_lock_failure(&err) {
        LockFailureAction::Refuse { .. } => Err(cli_held_message(data_dir)),
        LockFailureAction::ContinueUnlocked => {
            tracing::warn!("data-dir lock: {err}; continuing without the lock");
            Ok(None)
        }
    }
}

/// Show a blocking native error dialog. Runs before the Tauri event loop
/// exists, so it uses `rfd` directly (already in the tree via
/// `tauri-plugin-dialog`).
fn show_error_dialog(message: &str) {
    let _ = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("termiHub is already running")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(test)]
#[path = "data_dir_lock_tests.rs"]
mod tests;
