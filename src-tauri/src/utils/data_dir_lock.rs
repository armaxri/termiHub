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

/// Startup entry point: in portable mode, lock the data dir before any store
/// is built. Returns the held lock (keep it alive for the whole run).
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
    let data_dir = lock_target(&mode, override_set)?;
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        tracing::warn!(
            "data-dir lock: cannot create {}, not locking: {e}",
            data_dir.display()
        );
        return None;
    }
    match acquire(data_dir) {
        Ok(lock) => {
            tracing::info!(lock_file = %lock.path().display(), "Portable data directory locked");
            Some(lock)
        }
        Err(DataDirLockError::Held { data_dir }) => {
            let message = held_message(&data_dir);
            tracing::error!("{message}");
            eprintln!("{message}");
            show_error_dialog(&message);
            std::process::exit(1);
        }
        Err(e) => {
            tracing::warn!("data-dir lock: {e}; continuing without the lock");
            None
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
