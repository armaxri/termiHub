//! CRUD for stored automations (#5818, slice 2).

use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result};
use tauri::{AppHandle, Runtime};

use super::config::Automation;
use super::storage::StoreFile;
use super::store::AutomationStore;
use crate::connection::recovery::RecoveryWarning;
use crate::utils::errors::TerminalError;

/// Central automation manager: CRUD for stored automations, persisting
/// through `automations.json`. The boot migration
/// (`super::migrate::run_boot_migration`) runs before this loads.
pub struct AutomationManager {
    store: Mutex<AutomationStore>,
    storage: StoreFile<AutomationStore>,
    recovery_warnings: Mutex<Vec<RecoveryWarning>>,
}

impl AutomationManager {
    /// Initialize from disk, with recovery on corruption.
    pub fn new<R: Runtime>(app_handle: &AppHandle<R>) -> Result<Self> {
        let storage =
            StoreFile::new(app_handle).context("Failed to initialize automation storage")?;
        Self::with_storage(storage)
    }

    /// Initialize from a store file, with recovery on corruption.
    pub fn with_storage(storage: StoreFile<AutomationStore>) -> Result<Self> {
        let result = storage
            .load_with_recovery()
            .context("Failed to load automations")?;
        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(result.warnings),
        })
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// List all stored automations.
    pub fn list(&self) -> Result<Vec<Automation>, TerminalError> {
        Ok(self.lock()?.automations.clone())
    }

    /// Get one automation by id.
    pub fn get(&self, id: &str) -> Result<Automation, TerminalError> {
        self.lock()?
            .automations
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or_else(|| TerminalError::AutomationError(format!("Automation not found: {id}")))
    }

    /// Save (add or update) an automation, stamping timestamps.
    ///
    /// On update the original `createdAt` and the legacy provenance are kept;
    /// `updatedAt` is always set to now. Returns the stored automation.
    pub fn save(&self, mut automation: Automation) -> Result<Automation, TerminalError> {
        if automation.id.trim().is_empty() {
            return Err(TerminalError::AutomationError(
                "An automation needs an id".to_string(),
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let mut store = self.lock()?;
        let mut next = store.clone();
        automation.updated_at = now.clone();
        if let Some(existing) = next.automations.iter_mut().find(|a| a.id == automation.id) {
            automation.created_at = existing.created_at.clone();
            if automation.legacy.is_none() {
                automation.legacy = existing.legacy.clone();
            }
            *existing = automation.clone();
        } else {
            if automation.created_at.is_empty() {
                automation.created_at = now;
            }
            next.automations.push(automation.clone());
        }
        self.persist(&next)?;
        *store = next;
        Ok(automation)
    }

    /// Delete an automation by id.
    pub fn delete(&self, id: &str) -> Result<(), TerminalError> {
        let mut store = self.lock()?;
        let mut next = store.clone();
        next.automations.retain(|a| a.id != id);
        if next.automations.len() == store.automations.len() {
            return Err(TerminalError::AutomationError(format!(
                "Automation not found: {id}"
            )));
        }
        self.persist(&next)?;
        *store = next;
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, AutomationStore>, TerminalError> {
        self.store
            .lock()
            .map_err(|e| TerminalError::AutomationError(e.to_string()))
    }

    fn persist(&self, store: &AutomationStore) -> Result<(), TerminalError> {
        self.storage
            .save(store)
            .map_err(|e| TerminalError::AutomationError(e.to_string()))
    }
}
