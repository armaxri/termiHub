//! Reading and writing `automations.json` and `automation-runs.json`
//! (#5818, slice 2).
//!
//! Both files go through the shared schema-version gate: a newer file is
//! refused and left intact, an older one migrates, a corrupt one is backed up
//! and salvaged per entry. Writes are atomic.

use std::fs;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::connection::recovery::RecoveryResult;
use crate::utils::config_paths::resolve_app_config_dir;
use crate::utils::fs::write_atomic;
use crate::utils::migrate::{guard_not_newer, load_store_with_recovery, VersionedStore};

/// One versioned JSON store file in the config directory, named by the
/// store's [`VersionedStore::STORE_NAME`].
pub struct StoreFile<T> {
    file_path: PathBuf,
    _store: PhantomData<fn() -> T>,
}

impl<T: VersionedStore + Default + Serialize> StoreFile<T> {
    /// The store file in the app's config directory (`TERMIHUB_CONFIG_DIR`
    /// overrides it), creating the directory if needed.
    pub fn new<R: Runtime>(app_handle: &AppHandle<R>) -> Result<Self> {
        let config_dir = resolve_app_config_dir(app_handle)?;
        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;
        Ok(Self::in_dir(&config_dir))
    }

    /// The store file inside `dir`.
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            file_path: dir.join(T::STORE_NAME),
            _store: PhantomData,
        }
    }

    /// The file's path.
    pub fn path(&self) -> &Path {
        &self.file_path
    }

    /// Load through the shared schema-version gate.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<T>> {
        load_store_with_recovery::<T>(&self.file_path, T::STORE_NAME)
    }

    /// Save atomically, refusing to overwrite a file from a newer schema.
    pub fn save(&self, store: &T) -> Result<()> {
        guard_not_newer(&self.file_path, T::STORE_NAME, T::CURRENT_VERSION)?;
        let data = serde_json::to_string_pretty(store)
            .with_context(|| format!("Failed to serialize {}", T::STORE_NAME))?;
        write_atomic(&self.file_path, &data)
            .with_context(|| format!("Failed to write {}", T::STORE_NAME))
    }
}
