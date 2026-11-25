//! CRUD for stored automations (#5818, slice 2).

use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use super::config::{Automation, AutomationTrigger, UnknownTrigger};
use super::storage::StoreFile;
use super::store::{AutomationStore, UnreadableAutomation};
use crate::connection::id_changes::ConnectionIdRemap;
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
        let mut warnings = result.warnings;
        warnings.extend(result.data.unreadable.iter().map(unreadable_warning));
        Ok(Self {
            store: Mutex::new(result.data),
            storage,
            recovery_warnings: Mutex::new(warnings),
        })
    }

    /// Take ownership of any recovery warnings (only the first call returns them).
    pub fn take_recovery_warnings(&self) -> Vec<RecoveryWarning> {
        self.recovery_warnings
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default()
    }

    /// Re-point the connection ids of every connection-bound trigger when
    /// saved connections' ids change (#3596). Returns whether anything changed
    /// (and was persisted). `updatedAt` is left alone: following a rename is
    /// not an edit, so the reconcile pass still sees the automation as
    /// unchanged.
    pub fn follow_connection_id_changes(
        &self,
        remap: &ConnectionIdRemap,
    ) -> Result<bool, TerminalError> {
        let mut store = self.lock()?;
        let mut next = store.clone();
        let ids = next
            .automations
            .iter_mut()
            .flat_map(|a| a.triggers.iter_mut())
            .filter_map(|t| t.connection_ids_mut().map(|ids| ids.iter_mut()))
            .flatten();
        let mut changed = remap.apply_all(ids);
        // What this build cannot read must not be left with a dangling id (#6009).
        for trigger in next.automations.iter_mut().flat_map(|a| &mut a.triggers) {
            if let AutomationTrigger::Unknown(UnknownTrigger(raw)) = trigger {
                changed |= remap_raw_connection_ids(raw.get_mut("connectionIds"), remap);
            }
        }
        for entry in &mut next.unreadable {
            let triggers = entry
                .value
                .get_mut("triggers")
                .and_then(Value::as_array_mut);
            for trigger in triggers.into_iter().flatten() {
                changed |= remap_raw_connection_ids(trigger.get_mut("connectionIds"), remap);
            }
        }
        if !changed {
            return Ok(false);
        }
        self.persist(&next)?;
        *store = next;
        Ok(true)
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
        if next.unreadable.iter().any(|u| u.id == automation.id) {
            return Err(TerminalError::AutomationError(format!(
                "The id {} belongs to an automation that this version of termiHub cannot read",
                automation.id
            )));
        }
        automation.updated_at = now.clone();
        if let Some(existing) = next.automations.iter_mut().find(|a| a.id == automation.id) {
            automation.created_at = existing.created_at.clone();
            if automation.legacy.is_none() {
                automation.legacy = existing.legacy.clone();
            }
            // Nothing in this build can remove a field it does not know, so one
            // that a caller did not send back was lost on the way (#6009).
            for (key, value) in &existing.extra {
                if !automation.extra.contains_key(key) {
                    automation.extra.insert(key.clone(), value.clone());
                }
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

/// Re-point the saved-connection ids in a raw `connectionIds` list.
fn remap_raw_connection_ids(ids: Option<&mut Value>, remap: &ConnectionIdRemap) -> bool {
    let strings = ids
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter_map(|v| match v {
            Value::String(id) => Some(id),
            _ => None,
        });
    remap.apply_all(strings)
}

/// Reports an automation that is kept but cannot be used here.
fn unreadable_warning(entry: &UnreadableAutomation) -> RecoveryWarning {
    RecoveryWarning {
        file_name: AutomationStore::FILE_NAME.to_string(),
        message: format!(
            "The automation \"{}\" cannot be read by this version of termiHub. It is kept \
             unchanged, but is not shown and does not run. It may come from a newer version.",
            entry.name()
        ),
        details: Some(entry.error.clone()),
    }
}
