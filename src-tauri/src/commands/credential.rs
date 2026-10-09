use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{debug, info, warn};

use crate::connection::manager::ConnectionManager;
use crate::connection::settings::{CredentialStorageMode, SettingsUnion};
use crate::credential::manager::PendingStoreSwitch;
use crate::credential::named::NamedCredentialRegistry;
use crate::credential::types::{build_status_info, CredentialStoreStatusInfo};
use crate::credential::{
    CredentialKey, CredentialManager, CredentialStore, CredentialType, LockedEventPayload,
    MasterPasswordStore, StorageMode, UnlockFailure,
};
use termihub_core::connection::secrets::TakenSecrets;

/// Event emitted when the credential store is locked.
const EVENT_STORE_LOCKED: &str = "credential-store-locked";
/// Event emitted when the credential store is unlocked.
pub(crate) const EVENT_STORE_UNLOCKED: &str = "credential-store-unlocked";
/// Event emitted when the credential store status changes (mode switch, setup, etc.).
const EVENT_STORE_STATUS_CHANGED: &str = "credential-store-status-changed";

/// Structured outcome of the credential migration performed by a store switch.
///
/// Computed from the real per-credential results (never by inspecting the
/// free-text `warnings`), so the frontend and any debug bundle can tell a clean
/// migration apart from a partial or total failure (#2839).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStatus {
    /// Every credential read from the source store was written to the new one
    /// (also the case when there was nothing to migrate).
    Success,
    /// Some, but not all, credentials were migrated.
    Partial,
    /// None of the credentials to migrate could be written to the new store.
    Failed,
}

impl MigrationStatus {
    /// Derive the status from how many credentials were attempted and how many
    /// were written successfully.
    fn from_counts(attempted: usize, migrated: u32) -> Self {
        let migrated = migrated as usize;
        if migrated >= attempted {
            Self::Success
        } else if migrated == 0 {
            Self::Failed
        } else {
            Self::Partial
        }
    }
}

/// Result of switching credential stores, returned to the frontend.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    /// Structured migration outcome: `success`, `partial`, or `failed`.
    pub status: MigrationStatus,
    /// Number of credentials successfully migrated.
    pub migrated_count: u32,
    /// Number of credentials that failed to migrate. They remain in the
    /// previous store, which is left intact.
    pub failed_count: u32,
    /// Warnings for credentials that failed to migrate (or, for a switch to
    /// `none`, that could not be removed).
    pub warnings: Vec<String>,
    /// Switch to `none` only: number of credentials removed from the previous
    /// store. `0` for every other target (#3323).
    pub removed_count: u32,
    /// Switch to `none` only: credentials (`connection_id:type`, never the
    /// value) that could not be removed and still remain in the previous
    /// store (#3323).
    pub remaining: Vec<String>,
    /// `true` when the switch failed completely and was rolled back: the
    /// previous store is still active (and unlocked, if it was) and the new
    /// mode was not persisted — nothing changed (#3323).
    pub rolled_back: bool,
}

impl SwitchResult {
    /// A no-op result (nothing to migrate, nothing changed on the side).
    fn unchanged(warnings: Vec<String>) -> Self {
        Self {
            status: MigrationStatus::Success,
            migrated_count: 0,
            failed_count: 0,
            warnings,
            removed_count: 0,
            remaining: Vec::new(),
            rolled_back: false,
        }
    }
}

/// Per-credential migration tally produced by [`migrate_credentials`].
#[derive(Debug)]
struct MigrationOutcome {
    migrated_count: u32,
    failed_count: u32,
    warnings: Vec<String>,
    status: MigrationStatus,
}

/// Build the user-facing error shown when the source store cannot be read in
/// full during a store switch. The switch is aborted, so the source data is
/// left untouched and the user can recover it.
fn unreadable_source_error(current_mode: &StorageMode, detail: &str) -> String {
    format!(
        "Cannot switch credential store: the current store ({}) could not be read ({detail}). \
         Your saved credentials are still intact — unlock or repair the current store, \
         then try switching again.",
        current_mode.to_settings_str()
    )
}

/// Collect every credential from the current store for migration to the new one.
///
/// This is the data-safety gate for [`switch_credential_store`] (TAURI-011). The
/// source store must be readable **in full** before the backend is switched:
///
/// - If enumerating keys (`list_keys`) fails, or reading any individual
///   credential (`get`) returns `Err` — e.g. a locked, corrupt, or transiently
///   erroring master-password store — the switch is **aborted** with a clear
///   error rather than silently proceeding to an empty new store (which would
///   look like total credential loss while the data still sits in the old store).
/// - A genuinely empty source (0 keys) yields an empty vec — a legitimate switch.
/// - A key that lists but reads back as `None` (a benign list/get race) is skipped.
/// - `probe_keys` are read in addition to the listed keys (deduplicated). The
///   OS keychain lists only the keys in its key index (#3434), so every key
///   derivable from saved state — connections, agents, embedded servers and
///   shared named credentials (#3557) — is probed explicitly (#3844). The
///   keychain's key index is seeded from them (and from recorded candidates)
///   first, so items only the index can name are listed too.
fn collect_credentials_for_migration(
    manager: &CredentialManager,
    current_mode: &StorageMode,
    probe_keys: &[CredentialKey],
) -> Result<Vec<(CredentialKey, String)>, String> {
    // On-demand seed of the OS keychain key index (#3434): record items that
    // predate the index, plus derived candidates such as agent graphical
    // secrets. It reads the keychain, so it runs here — in the user-initiated
    // switch — and never at startup. A no-op for the other stores.
    manager.seed_key_index(probe_keys);
    let mut keys_to_migrate = manager
        .list_keys()
        .map_err(|e| unreadable_source_error(current_mode, &e.to_string()))?;
    for key in probe_keys {
        if !keys_to_migrate.contains(key) {
            keys_to_migrate.push(key.clone());
        }
    }

    let mut credentials_to_migrate = Vec::new();
    for key in &keys_to_migrate {
        match manager.get(key) {
            Ok(Some(value)) => credentials_to_migrate.push((key.clone(), value)),
            Ok(None) => {
                // Key vanished between list and get — nothing to migrate for it.
            }
            Err(e) => return Err(unreadable_source_error(current_mode, &e.to_string())),
        }
    }

    Ok(credentials_to_migrate)
}

/// Migrate collected credentials into the freshly-switched store, logging the
/// outcome to the durable tracing pipeline (OBS-007).
///
/// Observability contract:
/// - **Every per-credential failure is logged at WARN** with the credential
///   *key only* (`connection_id:type`) and the error — **never the secret
///   value** — so a partial or total migration failure is reconstructable from
///   the log after the fact. The key is safe to log: it carries no secret (see
///   [`CredentialKey`]'s `Display`, which is what the rest of the credential
///   logging already emits).
/// - **The INFO summary is emitted unconditionally** (even when
///   `migrated_count == 0`, the most silent failure mode), so both success and
///   any shortfall land in the INFO+ durable file log.
///
/// Returns the migrated/failed counts, the structured [`MigrationStatus`], and
/// the human-readable warnings surfaced to the frontend in [`SwitchResult`].
/// The source store is left intact on any failure, so the user can recover.
fn migrate_credentials(
    manager: &CredentialManager,
    credentials_to_migrate: &[(CredentialKey, String)],
) -> MigrationOutcome {
    let mut migrated_count = 0u32;
    let mut failed_count = 0u32;
    let mut warnings = Vec::new();

    for (key, value) in credentials_to_migrate {
        match manager.set(key, value) {
            Ok(()) => {
                migrated_count += 1;
            }
            Err(e) => {
                // SECRET HYGIENE: log the key (connection_id:type) and error
                // only — NEVER the credential value.
                warn!(key = %key, error = %e, "credential migration failed");
                failed_count += 1;
                warnings.push(format!("Failed to migrate {}: {}", key, e));
            }
        }
    }

    // Unconditional so a fully-failed migration (migrated_count == 0) is not the
    // silent case — this lands in the INFO+ durable file log.
    info!(
        migrated_count,
        source_count = credentials_to_migrate.len(),
        warning_count = warnings.len(),
        "credential migration complete"
    );
    if !warnings.is_empty() {
        warn!(
            warning_count = warnings.len(),
            "some credentials failed to migrate to the new store; source store left intact"
        );
    }

    MigrationOutcome {
        migrated_count,
        failed_count,
        warnings,
        status: MigrationStatus::from_counts(credentials_to_migrate.len(), migrated_count),
    }
}

pub(crate) fn emit_status_changed(app_handle: &AppHandle, manager: &CredentialManager) {
    let info = build_status_info(manager);
    if let Err(e) = app_handle.emit(EVENT_STORE_STATUS_CHANGED, &info) {
        warn!("Failed to emit {}: {}", EVENT_STORE_STATUS_CHANGED, e);
    }
}

/// Get the current credential store status.
#[tauri::command]
pub fn get_credential_store_status(
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<CredentialStoreStatusInfo, String> {
    debug!("Getting credential store status");
    Ok(build_status_info(&manager))
}

/// Error returned to the frontend by [`unlock_credential_store`].
///
/// The `corrupted` flag (G8, #1144) lets the UnlockDialog choose the right
/// recovery: a plain retry for a wrong password vs. a "reset store" affordance
/// when the credentials file is unreadable/corrupt.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[cfg_attr(test, ts(rename = "UnlockCredentialStoreError"))]
#[serde(rename_all = "camelCase")]
pub struct UnlockError {
    /// Human-readable failure message.
    pub message: String,
    /// `true` when the credentials file is corrupt (not a wrong password).
    pub corrupted: bool,
}

impl From<UnlockFailure> for UnlockError {
    fn from(failure: UnlockFailure) -> Self {
        // Only a genuinely corrupt/too-old file gets the destructive "reset
        // store" affordance. A `NewerVersion` failure (auto-update-then-rollback,
        // PER-008) is deliberately NOT flagged corrupted: the file is intact and
        // readable by a newer build, so offering a reset would destroy recoverable
        // data — the message tells the user to update termiHub instead.
        let corrupted = matches!(failure, UnlockFailure::Corrupted(_));
        UnlockError {
            message: failure.to_string(),
            corrupted,
        }
    }
}

/// Unlock a master-password store, treating an already-unlocked store as a
/// benign no-op and classifying failures as wrong-password vs. corrupt.
///
/// - Idempotent (G6, #1144): a second racing unlock returns `Ok(())` instead of
///   a spurious "already unlocked" error.
/// - Classified (G8, #1144): a wrong password yields `corrupted: false`; an
///   unreadable/malformed file yields `corrupted: true`.
fn unlock_store_classified(store: &MasterPasswordStore, password: &str) -> Result<(), UnlockError> {
    if store.is_unlocked() {
        return Ok(());
    }
    store.unlock_classified(password).map_err(UnlockError::from)
}

/// User-facing message shown when the master-password store cannot be unlocked
/// because the auto-lock timer is unavailable (WA-RS-004).
const AUTO_LOCK_UNAVAILABLE_MSG: &str =
    "Auto-lock is unavailable, so the credential store cannot be unlocked safely. \
     Restart the application and try again.";

/// Fail-safe gate (WA-RS-004): the master-password store must not be unlocked
/// while the auto-lock timer is absent. Without a live timer nothing would lock
/// the store after inactivity, leaving credentials unlocked indefinitely — the
/// opposite of fail-safe. Returns `Err` to refuse the unlock (keeping the store
/// locked) when `timer_installed` is `false`.
pub(crate) fn auto_lock_permits_unlock(timer_installed: bool) -> Result<(), &'static str> {
    if timer_installed {
        Ok(())
    } else {
        Err(AUTO_LOCK_UNAVAILABLE_MSG)
    }
}

/// Unlock the master-password store behind the auto-lock fail-safe gate.
///
/// Refuses the unlock (leaving the store locked) when no auto-lock timer is
/// installed, otherwise performs the classified unlock and notifies the timer.
pub(crate) fn guarded_unlock(
    manager: &CredentialManager,
    password: &str,
) -> Result<(), UnlockError> {
    auto_lock_permits_unlock(manager.has_auto_lock_timer()).map_err(|message| UnlockError {
        message: message.to_string(),
        corrupted: false,
    })?;

    let result = manager
        .with_master_password_store(|store| unlock_store_classified(store, password))
        .ok_or_else(|| UnlockError {
            message: "Credential store is not in master password mode".to_string(),
            corrupted: false,
        })?;

    result?;

    manager.notify_auto_lock_unlocked();
    Ok(())
}

/// Let the embedded-server manager move passwords it holds in memory into the
/// now-usable store — finishing a plaintext migration that waited for the
/// unlock, or keeping session-only passwords once a store is enabled (#3514).
fn sync_embedded_server_secrets(app_handle: &AppHandle) {
    if let Some(servers) =
        app_handle.try_state::<crate::embedded_servers::server_manager::EmbeddedServerManager>()
    {
        servers.sync_secrets();
    }
}

/// Copy pre-#3591 external-file secrets to their file-scoped keys now that
/// the store can be read (#3591). Runs before the unlocked event, so the
/// frontend's follow-up read of the recovery warnings sees its notice.
pub(crate) fn sync_connection_credential_scopes(app_handle: &AppHandle) {
    if let Some(connections) = app_handle.try_state::<ConnectionManager>() {
        connections.migrate_credential_scopes();
    }
}

/// Resume the relaunched transfers paused because their secret could not be
/// read while the store was locked (#3883). Runs after the scope migration, so
/// the relaunch reads each secret under its current key. Never prompts.
pub(crate) fn resume_transfers_waiting_for_credentials(app_handle: &AppHandle) {
    crate::files::transfer::relaunch_auto::spawn_resume_waiting(
        app_handle,
        crate::files::transfer::relaunch_auto::WaitTrigger::StoreUnlocked,
    );
}

/// Unlock the master password credential store.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn unlock_credential_store(
    password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), UnlockError> {
    info!("Unlocking credential store");

    guarded_unlock(&manager, &password)?;

    sync_embedded_server_secrets(&app_handle);
    sync_connection_credential_scopes(&app_handle);
    resume_transfers_waiting_for_credentials(&app_handle);
    if let Err(e) = app_handle.emit(EVENT_STORE_UNLOCKED, ()) {
        warn!("Failed to emit {}: {}", EVENT_STORE_UNLOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Reset (delete) a corrupt master-password credential store so the user can
/// set it up again, instead of being stuck in a wrong-password loop (G8, #1144).
#[tauri::command]
pub async fn reset_credential_store(
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Resetting credential store");

    // Also drops a biometric-unlock enrollment bound to the deleted store.
    manager
        .reset_master_password_store()
        .map_err(|e| e.to_string())?;

    manager.notify_auto_lock_locked();
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Lock the master password credential store.
#[tauri::command]
pub fn lock_credential_store(
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Locking credential store");

    manager
        .with_master_password_store(|store| {
            store.lock();
        })
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    manager.notify_auto_lock_locked();

    // Manual lock: auto=false so the frontend does not toast (the indicator
    // already confirms the manual lock) — avoids a double-toast (G7, #1144).
    if let Err(e) = app_handle.emit(EVENT_STORE_LOCKED, LockedEventPayload { auto: false }) {
        warn!("Failed to emit {}: {}", EVENT_STORE_LOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Set up a new master password for the credential store.
///
/// This creates the initial encrypted credentials file. The store must
/// be in master password mode and not already set up.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn setup_master_password(
    password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Setting up master password");

    // Fail-safe gate (WA-RS-004): setting up a master password unlocks the store,
    // so refuse it when no auto-lock timer is installed rather than create a
    // freshly-unlocked store that nothing could auto-lock.
    auto_lock_permits_unlock(manager.has_auto_lock_timer()).map_err(|m| m.to_string())?;

    let result = manager
        .with_master_password_store(|store| store.setup(&password).map_err(|e| e.to_string()))
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

    manager.notify_auto_lock_unlocked();

    sync_embedded_server_secrets(&app_handle);
    sync_connection_credential_scopes(&app_handle);
    resume_transfers_waiting_for_credentials(&app_handle);
    if let Err(e) = app_handle.emit(EVENT_STORE_UNLOCKED, ()) {
        warn!("Failed to emit {}: {}", EVENT_STORE_UNLOCKED, e);
    }
    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Change the master password for the credential store.
///
/// Verifies the current password, then re-encrypts all credentials
/// with the new password. The store must be unlocked.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn change_master_password(
    current_password: String,
    new_password: String,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!("Changing master password");

    // Also drops a biometric-unlock enrollment bound to the old key (PROD-064).
    manager
        .change_master_password(&current_password, &new_password)
        .map_err(|e| e.to_string())?;

    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Switch the credential storage backend.
///
/// Migrates existing credentials to the new store — or, when switching to
/// `none`, removes them from the previous store. When switching to master
/// password mode, a `master_password` must be provided to set up the new
/// encrypted store. The new mode is persisted to app settings so it survives
/// app restarts. A total failure rolls the switch back (#3323); see
/// [`perform_switch`].
#[tauri::command]
pub async fn switch_credential_store(
    new_mode: String,
    master_password: Option<String>,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
    named: State<'_, Arc<NamedCredentialRegistry>>,
) -> Result<SwitchResult, String> {
    let target_mode = StorageMode::from_settings_str(Some(&new_mode));
    let current_mode = manager.get_mode();

    info!(
        from = current_mode.to_settings_str(),
        to = target_mode.to_settings_str(),
        "Switching credential store"
    );

    if current_mode == target_mode {
        return Ok(SwitchResult::unchanged(vec![
            "Already using this storage mode".to_string(),
        ]));
    }

    // Collect credentials from the current store for migration. Aborts the
    // switch (leaving the source untouched) if the source cannot be read in
    // full, so an unreadable store never silently becomes an empty new store
    // that looks like total credential loss (TAURI-011).
    //
    // The OS keychain lists its keys from termiHub's key index; every key
    // derivable from saved connections, agents, embedded servers and shared
    // named credentials is probed on top, so per-connection secrets are moved
    // (or removed, for `none`) even if they predate the index (#3844).
    let mut probe_keys = crate::commands::credential_vault::derivable_credential_keys(
        &connection_manager,
        &app_handle,
    )
    .map_err(|e| unreadable_source_error(&current_mode, &e))?;
    probe_keys.extend(named.secret_keys());
    let credentials_to_migrate =
        collect_credentials_for_migration(&manager, &current_mode, &probe_keys)?;

    let result = perform_switch(
        &manager,
        target_mode.clone(),
        master_password,
        &credentials_to_migrate,
        migrate_credentials,
        |mode| {
            // Persist the new mode to settings so it survives app restarts.
            let mut settings = connection_manager.get_settings();
            settings.credential_storage_mode = CredentialStorageMode::parse(mode.to_settings_str());
            if let Err(e) = connection_manager.save_settings(settings) {
                warn!(
                    "Failed to persist credential storage mode to settings: {}",
                    e
                );
            }
        },
    );

    if matches!(
        result,
        Ok(SwitchResult {
            rolled_back: false,
            ..
        })
    ) {
        sync_embedded_server_secrets(&app_handle);
        sync_connection_credential_scopes(&app_handle);
    }
    emit_status_changed(&app_handle, &manager);
    result
}

/// Remove the collected credentials from the previous store after a switch to
/// `none`, so the secrets the user chose to discard do not linger on disk
/// (#3323). Every failure is logged at WARN with the key only — never the
/// value — and reported back as a remaining entry.
fn clear_previous_store(
    pending: &PendingStoreSwitch,
    credentials: &[(CredentialKey, String)],
) -> SwitchResult {
    let mut removed_count = 0u32;
    let mut remaining = Vec::new();
    let mut warnings = Vec::new();

    for (key, _) in credentials {
        match pending.remove_from_previous(key) {
            Ok(()) => removed_count += 1,
            Err(e) => {
                // SECRET HYGIENE: key (connection_id:type) and error only.
                warn!(key = %key, error = %e, "failed to remove credential from previous store");
                remaining.push(key.to_string());
                warnings.push(format!("Failed to remove {}: {}", key, e));
            }
        }
    }

    info!(
        removed_count,
        source_count = credentials.len(),
        remaining_count = remaining.len(),
        "credential removal for switch to none complete"
    );

    SwitchResult {
        status: MigrationStatus::from_counts(credentials.len(), removed_count),
        migrated_count: 0,
        failed_count: remaining.len() as u32,
        warnings,
        removed_count,
        remaining,
        rolled_back: false,
    }
}

/// Core of [`switch_credential_store`], free of Tauri state so it can be
/// tested directly. `current mode != target_mode` is assumed.
///
/// The switch is transactional (#3323):
/// - The new backend is installed with [`CredentialManager::begin_switch`],
///   which keeps the previous store alive — still unlocked — until the outcome
///   is known.
/// - Switching to `none` removes the credentials from the previous store
///   (the confirm dialog promises they are deleted); any other target gets
///   the credentials migrated into it via `migrate`.
/// - A **total failure** (credentials to move, none written/removed) or a
///   failure to set up the new master-password store **rolls back**: the
///   previous store is reinstalled unlocked (no re-unlock prompt), a freshly
///   created master-password file is deleted again, and `persist` is not
///   called, so the new mode is not saved.
/// - Otherwise (success or partial) the switch is committed — the previous
///   master-password store is locked — and `persist` saves the new mode.
fn perform_switch<M, P>(
    manager: &CredentialManager,
    target_mode: StorageMode,
    master_password: Option<String>,
    credentials: &[(CredentialKey, String)],
    migrate: M,
    persist: P,
) -> Result<SwitchResult, String>
where
    M: FnOnce(&CredentialManager, &[(CredentialKey, String)]) -> MigrationOutcome,
    P: FnOnce(&StorageMode),
{
    let password = if target_mode == StorageMode::MasterPassword {
        Some(
            master_password
                .ok_or("Master password is required when switching to master password mode")?,
        )
    } else {
        None
    };

    let pending = manager.begin_switch(target_mode.clone());
    let leaving_master_password = pending.previous_mode() == StorageMode::MasterPassword;

    // Set up (or unlock an existing) master-password target store.
    let mut created_new_file = false;
    if let Some(password) = password {
        let setup_result = manager
            .with_master_password_store(|store| {
                if store.has_credentials_file() {
                    // File exists — unlock instead of setup
                    store.unlock(&password).map_err(|e| e.to_string())
                } else {
                    created_new_file = true;
                    store.setup(&password).map_err(|e| e.to_string())
                }
            })
            .ok_or_else(|| "Failed to access master password store after switch".to_string());

        match setup_result {
            Ok(Ok(())) => {
                // Notify auto-lock timer when entering master password mode
                manager.notify_auto_lock_unlocked();
            }
            Ok(Err(e)) | Err(e) => {
                roll_back(manager, pending, &target_mode, created_new_file);
                return Err(e);
            }
        }
    }

    // Move the credentials: migrate them into the new store, or — for `none`,
    // whose NullStore would silently "accept" them — remove them from the
    // previous store. Each failure is logged at WARN (key only, never the
    // secret value) and an INFO summary is emitted unconditionally (OBS-007).
    let result = if target_mode == StorageMode::None {
        clear_previous_store(&pending, credentials)
    } else {
        let outcome = migrate(manager, credentials);
        SwitchResult {
            status: outcome.status,
            migrated_count: outcome.migrated_count,
            failed_count: outcome.failed_count,
            warnings: outcome.warnings,
            removed_count: 0,
            remaining: Vec::new(),
            rolled_back: false,
        }
    };

    if result.status == MigrationStatus::Failed {
        warn!(
            from = pending.previous_mode().to_settings_str(),
            to = target_mode.to_settings_str(),
            "credential store switch failed completely; rolling back to the previous store"
        );
        roll_back(manager, pending, &target_mode, created_new_file);
        return Ok(SwitchResult {
            rolled_back: true,
            ..result
        });
    }

    manager.commit_switch(pending);
    if leaving_master_password {
        manager.notify_auto_lock_locked();
    }
    persist(&target_mode);
    Ok(result)
}

/// Undo a switch started by [`perform_switch`]: delete a master-password file
/// that this switch created (it holds nothing the user had before), then
/// reinstall the previous store exactly as it was.
fn roll_back(
    manager: &CredentialManager,
    pending: PendingStoreSwitch,
    target_mode: &StorageMode,
    created_new_file: bool,
) {
    if *target_mode == StorageMode::MasterPassword {
        if created_new_file {
            if let Some(Err(e)) = manager.with_master_password_store(|store| store.reset()) {
                warn!(error = %e, "failed to delete the master-password file created by a rolled-back switch");
            }
        }
        manager.notify_auto_lock_locked();
    }
    let previous_unlocked = pending.previous_is_unlocked();
    let previous_mode = pending.previous_mode();
    manager.rollback_switch(pending);
    if previous_mode == StorageMode::MasterPassword {
        if previous_unlocked {
            manager.notify_auto_lock_unlocked();
        } else {
            // Not reachable today (a locked source aborts the switch before it
            // starts); if it ever is, the UI's unlock flow handles the store.
            warn!("previous master-password store is locked after rollback; unlock required");
        }
    }
}

/// Update the auto-lock timeout for the master password credential store.
///
/// Pass `None` or `Some(0)` to disable auto-lock.
#[tauri::command]
pub fn set_auto_lock_timeout(
    minutes: Option<u32>,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    info!(minutes = ?minutes, "Setting auto-lock timeout");
    manager.set_auto_lock_timeout(minutes);
    Ok(())
}

/// Parse a credential type string from the frontend into a `CredentialType`.
fn parse_credential_type(s: &str) -> Result<CredentialType, String> {
    match s {
        "password" => Ok(CredentialType::Password),
        "key_passphrase" => Ok(CredentialType::KeyPassphrase),
        "sudo_password" => Ok(CredentialType::SudoPassword),
        _ => Err(format!("Unknown credential type: {s}")),
    }
}

/// Store a credential for a connection.
///
/// Used to persist a password or passphrase that was entered via the
/// password prompt, so it can be retrieved automatically on the next
/// connection attempt (when `savePassword` is enabled on the connection).
///
/// `source_file` is the external connection file the connection is stored in
/// (`None` for the main store): secrets are scoped by file (#3591).
#[tauri::command]
pub fn store_credential(
    connection_id: String,
    credential_type: String,
    value: String,
    source_file: Option<String>,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = connection_manager.connection_credential_key(
        &connection_id,
        source_file.as_deref(),
        cred_type,
    );
    debug!(
        connection_id = %connection_id,
        credential_type = %credential_type,
        "Storing credential"
    );
    manager.set(&key, &value).map_err(|e| e.to_string())
}

/// Resolve a stored credential for a connection.
///
/// Returns the stored password/passphrase, or `null` if none is found.
/// Gracefully returns `None` when the store is locked or unavailable.
/// `source_file` scopes the lookup as in [`store_credential`].
#[tauri::command]
pub fn resolve_credential(
    connection_id: String,
    credential_type: String,
    source_file: Option<String>,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<Option<String>, String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = connection_manager.connection_credential_key(
        &connection_id,
        source_file.as_deref(),
        cred_type,
    );
    debug!(
        connection_id = %connection_id,
        credential_type = %credential_type,
        "Resolving credential"
    );
    match manager.get(&key) {
        Ok(value) => Ok(value),
        Err(e) => {
            warn!("Failed to resolve credential for {}: {}", connection_id, e);
            Ok(None)
        }
    }
}

/// Remove a stored credential for a connection.
///
/// Used to clear stale credentials after an authentication failure.
/// `source_file` scopes the key as in [`store_credential`].
#[tauri::command]
pub fn remove_credential(
    connection_id: String,
    credential_type: String,
    source_file: Option<String>,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = connection_manager.connection_credential_key(
        &connection_id,
        source_file.as_deref(),
        cred_type,
    );
    debug!(
        connection_id = %connection_id,
        credential_type = %credential_type,
        "Removing credential"
    );
    manager.remove(&key).map_err(|e| e.to_string())
}

/// Resolve the schema secrets other than `password` stored for a saved
/// connection — e.g. a VNC SSH-tunnel password or an inline jump-host hop's
/// password (#4289) — for the connect flow to splice into its in-memory config
/// and to prompt for what is missing (#4429).
///
/// Returns `null` when the store cannot be read (locked or unavailable); the
/// caller unlocks first. Secrets are never logged.
#[tauri::command]
pub fn resolve_field_secrets(
    connection_id: String,
    source_file: Option<String>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<Option<TakenSecrets>, String> {
    debug!(connection_id = %connection_id, "Resolving stored field secrets");
    match connection_manager.stored_field_secrets(&connection_id, source_file.as_deref()) {
        Ok(secrets) => Ok(Some(secrets)),
        Err(e) => {
            warn!(
                "Failed to resolve field secrets for {}: {}",
                connection_id, e
            );
            Ok(None)
        }
    }
}

/// Store field secrets entered in the connect prompt with its Save box
/// checked, merged over the ones already stored for the connection (#4429).
#[tauri::command]
pub fn store_field_secrets(
    connection_id: String,
    source_file: Option<String>,
    secrets: TakenSecrets,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<(), String> {
    debug!(connection_id = %connection_id, "Storing field secrets");
    connection_manager
        .save_field_secrets(&connection_id, source_file.as_deref(), secrets)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential::{CredentialStore, CredentialType, MasterPasswordStore};

    // --- OBS-007: credential-migration failures must leave a durable trace. ---

    /// A sentinel secret used only in the migration-logging tests. It must NEVER
    /// appear in any emitted log line — see the assertions below.
    const MIGRATION_TEST_SECRET: &str = "s3nsitive-passphrase-value-do-not-log";

    /// Build a locked master-password manager whose `set` fails for every key,
    /// so `migrate_credentials` takes the failure path for all inputs.
    fn locked_manager(dir: &std::path::Path) -> CredentialManager {
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();
        // Lock the store: subsequent `set` calls return Err (store is locked).
        mgr.with_master_password_store(|s| s.lock()).unwrap();
        mgr
    }

    /// OBS-007: every per-credential migration failure must be logged at WARN,
    /// and the INFO summary must be emitted UNCONDITIONALLY — even in the worst,
    /// most-silent case where every credential fails (`migrated_count == 0`).
    ///
    /// Uses the app's own log-capture layer (the LogViewer pipeline).
    #[test]
    fn migration_failures_emit_warn_and_unconditional_info() {
        use crate::utils::log_capture::{create_log_buffer, LogCaptureLayer};
        use tracing_subscriber::layer::SubscriberExt;

        let dir = tempfile::tempdir().unwrap();
        let mgr = locked_manager(dir.path());
        let creds = vec![(
            CredentialKey::new("conn-1", CredentialType::Password),
            MIGRATION_TEST_SECRET.to_string(),
        )];

        let buffer = create_log_buffer();
        let subscriber = tracing_subscriber::registry().with(LogCaptureLayer::new(buffer.clone()));

        let outcome =
            crate::utils::log_capture::test_support::with_scoped_subscriber(subscriber, || {
                migrate_credentials(&mgr, &creds)
            });

        // Worst case: nothing migrated, one warning surfaced to the frontend.
        assert_eq!(outcome.migrated_count, 0, "a locked store migrates nothing");
        assert_eq!(
            outcome.warnings.len(),
            1,
            "the failed credential is surfaced"
        );

        let entries = buffer.lock().unwrap().get_recent(50);

        assert!(
            entries
                .iter()
                .any(|e| e.level == "WARN" && e.message.contains("credential migration failed")),
            "each migration failure must be logged at WARN, got: {entries:?}"
        );
        assert!(
            entries
                .iter()
                .any(|e| e.level == "INFO" && e.message.contains("credential migration complete")),
            "the INFO summary must be emitted even when migrated_count == 0, got: {entries:?}"
        );
        // SECRET HYGIENE: no captured log line may contain the credential value.
        assert!(
            entries
                .iter()
                .all(|e| !e.message.contains(MIGRATION_TEST_SECRET)),
            "a credential value must NEVER be logged, got: {entries:?}"
        );
    }

    /// OBS-007 secret hygiene, checked against the durable file-log format: the
    /// per-failure WARN must carry the credential *key* (`connection_id:type`)
    /// so a failure is reconstructable, while the secret *value* must never be
    /// formatted into any log line. This mirrors what the INFO+ file log writes
    /// (the `fmt` layer renders all structured fields, unlike the LogViewer
    /// capture, which keeps only the message).
    #[test]
    fn migration_failure_logs_key_never_value() {
        use std::io::Write;
        use std::sync::{Arc, Mutex};

        #[derive(Clone)]
        struct VecWriter(Arc<Mutex<Vec<u8>>>);
        impl Write for VecWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for VecWriter {
            type Writer = VecWriter;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let mgr = locked_manager(dir.path());
        let creds = vec![(
            CredentialKey::new("conn-1", CredentialType::Password),
            MIGRATION_TEST_SECRET.to_string(),
        )];

        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(VecWriter(buf.clone()))
            .with_ansi(false)
            .with_max_level(tracing::Level::TRACE)
            .finish();

        crate::utils::log_capture::test_support::with_scoped_subscriber(subscriber, || {
            migrate_credentials(&mgr, &creds);
        });

        let logged = String::from_utf8(buf.lock().unwrap().clone()).unwrap();

        assert!(
            logged.contains("credential migration failed"),
            "per-failure WARN must be emitted, got: {logged}"
        );
        // The key (connection_id:type) identifies the failure without leaking a
        // secret — it must be present so the failure is reconstructable.
        assert!(
            logged.contains("conn-1:password"),
            "the WARN must log the credential key, got: {logged}"
        );
        // The secret value must NEVER be formatted into the durable log.
        assert!(
            !logged.contains(MIGRATION_TEST_SECRET),
            "a credential value must NEVER reach the log, got: {logged}"
        );
    }

    // --- TAURI-011: switch must abort (not silently switch to empty) when the
    // source store is unreadable, but succeed for a readable source. ---

    /// A locked master-password source must ABORT the migration collection with
    /// an error instead of yielding an empty credential set — otherwise the
    /// switch would "succeed" with 0 credentials while the data still exists,
    /// which looks like total credential loss. This is the regression guard for
    /// the old `list_keys().unwrap_or_default()` / `if let Ok(Some(..))` behavior.
    #[test]
    fn collect_migration_aborts_when_source_locked() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());

        // Set up and store a credential, then lock the store.
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();
        let key = CredentialKey::new("conn-1", CredentialType::Password);
        mgr.set(&key, "my-secret").unwrap();
        mgr.with_master_password_store(|s| s.lock()).unwrap();

        // Locked source: collection must error, NOT return an empty vec.
        let result = collect_credentials_for_migration(&mgr, &StorageMode::MasterPassword, &[]);
        assert!(
            result.is_err(),
            "a locked/unreadable source must abort migration, got {result:?}"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("could not be read") && msg.contains("still intact"),
            "abort error should be actionable, got: {msg}"
        );

        // The source is untouched: unlocking recovers the credential.
        mgr.with_master_password_store(|s| s.unlock("test-pw"))
            .unwrap()
            .unwrap();
        assert_eq!(mgr.get(&key).unwrap(), Some("my-secret".to_string()));
    }

    /// A readable master-password source returns every credential so the switch
    /// can migrate them and report the count.
    #[test]
    fn collect_migration_succeeds_for_readable_source() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();

        let pw = CredentialKey::new("conn-1", CredentialType::Password);
        let kp = CredentialKey::new("conn-2", CredentialType::KeyPassphrase);
        mgr.set(&pw, "secret-1").unwrap();
        mgr.set(&kp, "secret-2").unwrap();

        let collected =
            collect_credentials_for_migration(&mgr, &StorageMode::MasterPassword, &[]).unwrap();
        assert_eq!(collected.len(), 2, "both credentials must be collected");
        assert!(collected.iter().any(|(k, v)| *k == pw && v == "secret-1"));
        assert!(collected.iter().any(|(k, v)| *k == kp && v == "secret-2"));
    }

    /// A genuinely empty source (0 credentials) is a legitimate switch: it must
    /// succeed with an empty set, NOT be treated as unreadable.
    #[test]
    fn collect_migration_empty_source_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());

        let collected = collect_credentials_for_migration(&mgr, &StorageMode::None, &[]).unwrap();
        assert!(
            collected.is_empty(),
            "an empty source must yield an empty migration set, not an error"
        );
    }

    /// #3557: the OS keychain cannot enumerate its items, so shared named
    /// credentials are probed by key and migrate keychain -> master password
    /// (and back) with the storage mode.
    #[test]
    fn named_credentials_migrate_between_keychain_and_master_password() {
        use crate::credential::named::{NamedCredentialKind, NamedCredentialRegistry};
        let _mock = crate::credential::os_keychain::test_support::install_mock();
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf());
        let (registry, _) = NamedCredentialRegistry::load(dir.path());
        let cred = registry
            .create(
                &mgr,
                &StorageMode::OsKeychain,
                "Bastion",
                NamedCredentialKind::Password,
                "shared-secret",
            )
            .unwrap();

        // The keychain lists it from its key index even without probing (#3434).
        let unprobed =
            collect_credentials_for_migration(&mgr, &StorageMode::OsKeychain, &[]).unwrap();
        assert_eq!(unprobed.len(), 1);

        let collected = collect_credentials_for_migration(
            &mgr,
            &StorageMode::OsKeychain,
            &registry.secret_keys(),
        )
        .unwrap();
        assert_eq!(collected.len(), 1);

        mgr.switch_store(StorageMode::MasterPassword).unwrap();
        mgr.with_master_password_store(|s| s.setup("master-pw"))
            .unwrap()
            .unwrap();
        let outcome = migrate_credentials(&mgr, &collected);
        assert_eq!(outcome.status, MigrationStatus::Success);
        assert_eq!(
            registry
                .resolve(&mgr, &cred.id, &CredentialType::Password)
                .unwrap(),
            Some("shared-secret".to_string())
        );

        // And back: master password lists it; probing must not duplicate it.
        let back = collect_credentials_for_migration(
            &mgr,
            &StorageMode::MasterPassword,
            &registry.secret_keys(),
        )
        .unwrap();
        assert_eq!(back.len(), 1);
    }

    #[test]
    fn parse_credential_type_password() {
        assert_eq!(
            parse_credential_type("password").unwrap(),
            CredentialType::Password
        );
    }

    #[test]
    fn parse_credential_type_key_passphrase() {
        assert_eq!(
            parse_credential_type("key_passphrase").unwrap(),
            CredentialType::KeyPassphrase
        );
    }

    #[test]
    fn parse_credential_type_sudo_password() {
        assert_eq!(
            parse_credential_type("sudo_password").unwrap(),
            CredentialType::SudoPassword
        );
    }

    #[test]
    fn parse_credential_type_unknown() {
        let err = parse_credential_type("invalid").unwrap_err();
        assert!(err.contains("Unknown credential type"));
    }

    #[test]
    fn auto_lock_permits_unlock_gate() {
        // WA-RS-004: the gate refuses an unlock when no auto-lock timer is
        // installed (thread-spawn failure) and permits it when one is present.
        assert!(auto_lock_permits_unlock(true).is_ok());
        assert!(auto_lock_permits_unlock(false).is_err());
    }

    #[test]
    fn guarded_unlock_refused_when_no_auto_lock_timer_keeps_store_locked() {
        // WA-RS-004 regression: with no auto-lock timer installed (mirroring a
        // startup thread-spawn failure) the unlock MUST be refused and the store
        // MUST remain locked — never unlocked with no mechanism to auto-lock it.
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());
        mgr.with_master_password_store(|s| s.setup("pw"))
            .unwrap()
            .unwrap();
        // Lock the store so we can attempt a real unlock through the gate.
        mgr.with_master_password_store(|s| s.lock()).unwrap();
        assert!(!mgr.with_master_password_store(|s| s.is_unlocked()).unwrap());

        let result = guarded_unlock(&mgr, "pw");
        assert!(result.is_err(), "unlock must be refused without a timer");
        assert!(
            !mgr.with_master_password_store(|s| s.is_unlocked()).unwrap(),
            "store must remain locked after a refused unlock"
        );
    }

    /// Regression test for #1144 (G6): unlocking an already-unlocked store
    /// must be a benign no-op (`Ok`), not an error, so racing connect flows
    /// don't surface a spurious "already unlocked" failure.
    #[test]
    fn unlock_store_idempotent_when_already_unlocked_returns_ok() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        store.setup("test-password").unwrap();
        assert!(store.is_unlocked());

        // Second unlock on the already-unlocked store must succeed idempotently.
        let result = unlock_store_classified(&store, "test-password");
        assert!(
            result.is_ok(),
            "unlocking an already-unlocked store should be Ok, got {result:?}"
        );
        assert!(store.is_unlocked());
    }

    /// A wrong password on a locked store must still fail (behavior unchanged).
    #[test]
    fn unlock_store_idempotent_wrong_password_still_errors() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        store.setup("correct").unwrap();
        store.lock();
        assert!(!store.is_unlocked());

        let result = unlock_store_classified(&store, "wrong");
        assert!(result.is_err());
        assert!(!store.is_unlocked());
    }

    /// A locked store with the correct password unlocks (benign happy path).
    #[test]
    fn unlock_store_idempotent_correct_password_unlocks() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        store.setup("correct").unwrap();
        store.lock();
        assert!(!store.is_unlocked());

        let result = unlock_store_classified(&store, "correct");
        assert!(result.is_ok());
        assert!(store.is_unlocked());
    }

    // --- G8 (#1144): wrong password vs corrupt-file unlock classification ---

    /// A wrong password maps to a non-corruption `UnlockError` so the UI shows
    /// the retry (wrong password) affordance, not the reset-store one.
    #[test]
    fn unlock_store_classified_wrong_password_is_not_corrupted() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        store.setup("correct").unwrap();
        store.lock();

        let err = unlock_store_classified(&store, "wrong").unwrap_err();
        assert!(!err.corrupted, "wrong password must not be flagged corrupt");
    }

    /// A corrupt credentials file maps to a corruption `UnlockError` so the UI
    /// offers the reset-store affordance instead of an endless wrong-pw loop.
    #[test]
    fn unlock_store_classified_corrupt_file_is_corrupted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.enc");
        std::fs::write(&path, b"not a valid envelope").unwrap();
        let store = MasterPasswordStore::new(path);

        let err = unlock_store_classified(&store, "any").unwrap_err();
        assert!(err.corrupted, "corrupt file must be flagged corrupt");
    }

    /// An already-unlocked store stays idempotent under the classified path.
    #[test]
    fn unlock_store_classified_already_unlocked_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        store.setup("pw").unwrap();
        assert!(store.is_unlocked());

        assert!(unlock_store_classified(&store, "pw").is_ok());
    }

    /// Resetting a corrupt store deletes the credentials file so the user can
    /// start over (Unavailable → setup), rather than being stuck on unlock.
    #[test]
    fn reset_store_file_deletes_credentials_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("credentials.enc");
        std::fs::write(&path, b"corrupt").unwrap();
        let store = MasterPasswordStore::new(path.clone());
        assert!(path.exists());

        store.reset().unwrap();
        assert!(!path.exists(), "reset must delete the credentials file");
    }

    /// Resetting when no file exists is a benign no-op.
    #[test]
    fn reset_store_file_no_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        assert!(store.reset().is_ok());
    }

    // --- #2839: structured migration status. ---

    fn cred(id: &str) -> (CredentialKey, String) {
        (
            CredentialKey::new(id, CredentialType::Password),
            MIGRATION_TEST_SECRET.to_string(),
        )
    }

    #[test]
    fn migration_status_success_when_everything_migrated() {
        assert_eq!(MigrationStatus::from_counts(3, 3), MigrationStatus::Success);
    }

    #[test]
    fn migration_status_success_when_nothing_to_migrate() {
        assert_eq!(MigrationStatus::from_counts(0, 0), MigrationStatus::Success);
    }

    #[test]
    fn migration_status_partial_when_some_failed() {
        assert_eq!(MigrationStatus::from_counts(3, 1), MigrationStatus::Partial);
        assert_eq!(MigrationStatus::from_counts(3, 2), MigrationStatus::Partial);
    }

    #[test]
    fn migration_status_failed_when_none_migrated() {
        assert_eq!(MigrationStatus::from_counts(2, 0), MigrationStatus::Failed);
    }

    #[test]
    fn migrate_into_writable_store_reports_success() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.path().to_path_buf());
        mgr.with_master_password_store(|s| s.setup("test-pw"))
            .unwrap()
            .unwrap();

        let outcome = migrate_credentials(&mgr, &[cred("a"), cred("b")]);

        assert_eq!(outcome.status, MigrationStatus::Success);
        assert_eq!(outcome.migrated_count, 2);
        assert_eq!(outcome.failed_count, 0);
        assert!(outcome.warnings.is_empty());
    }

    #[test]
    fn migrate_into_locked_store_reports_failed() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = locked_manager(dir.path());

        let outcome = migrate_credentials(&mgr, &[cred("a"), cred("b")]);

        assert_eq!(outcome.status, MigrationStatus::Failed);
        assert_eq!(outcome.migrated_count, 0);
        assert_eq!(outcome.failed_count, 2);
        assert_eq!(outcome.warnings.len(), 2);
    }

    #[test]
    fn switch_result_serializes_status_for_the_frontend() {
        let result = SwitchResult {
            status: MigrationStatus::Partial,
            migrated_count: 1,
            failed_count: 1,
            warnings: vec!["Failed to migrate x".to_string()],
            removed_count: 2,
            remaining: vec!["conn:password".to_string()],
            rolled_back: false,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["status"], "partial");
        assert_eq!(json["migratedCount"], 1);
        assert_eq!(json["failedCount"], 1);
        assert_eq!(json["removedCount"], 2);
        assert_eq!(json["remaining"][0], "conn:password");
        assert_eq!(json["rolledBack"], false);
        assert_eq!(
            serde_json::to_value(MigrationStatus::Success).unwrap(),
            "success"
        );
        assert_eq!(
            serde_json::to_value(MigrationStatus::Failed).unwrap(),
            "failed"
        );
    }

    // --- #3323: transactional switch (rollback on total failure) and `none`. ---

    /// An unlocked master-password manager holding `ids` as password entries.
    fn master_password_source(dir: &std::path::Path, ids: &[&str]) -> CredentialManager {
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
        mgr.with_master_password_store(|s| s.setup("source-pw"))
            .unwrap()
            .unwrap();
        for (key, value) in ids.iter().map(|id| cred(id)) {
            mgr.set(&key, &value).unwrap();
        }
        mgr
    }

    fn collect(mgr: &CredentialManager) -> Vec<(CredentialKey, String)> {
        collect_credentials_for_migration(mgr, &mgr.get_mode(), &[]).unwrap()
    }

    /// A `migrate` stand-in whose writes fail for every key in `failing`.
    fn failing_migration(
        failing: &'static [&'static str],
    ) -> impl FnOnce(&CredentialManager, &[(CredentialKey, String)]) -> MigrationOutcome {
        move |mgr, creds| {
            let mut migrated_count = 0u32;
            let mut warnings = Vec::new();
            for (key, value) in creds {
                if failing.contains(&key.connection_id.as_str()) {
                    warnings.push(format!("Failed to migrate {key}: denied"));
                } else {
                    mgr.set(key, value).unwrap();
                    migrated_count += 1;
                }
            }
            MigrationOutcome {
                migrated_count,
                failed_count: warnings.len() as u32,
                status: MigrationStatus::from_counts(creds.len(), migrated_count),
                warnings,
            }
        }
    }

    #[test]
    fn total_failure_rolls_back_to_the_unlocked_previous_store() {
        let _mock = crate::credential::os_keychain::test_support::install_mock();
        let dir = tempfile::tempdir().unwrap();
        let mgr = master_password_source(dir.path(), &["a", "b"]);
        let creds = collect(&mgr);
        let mut persisted = None;

        let result = perform_switch(
            &mgr,
            StorageMode::OsKeychain,
            None,
            &creds,
            failing_migration(&["a", "b"]),
            |mode| persisted = Some(mode.clone()),
        )
        .unwrap();

        assert_eq!(result.status, MigrationStatus::Failed);
        assert!(result.rolled_back);
        assert_eq!(result.failed_count, 2);
        // Old mode active, settings unchanged, old store still unlocked + usable.
        assert_eq!(mgr.get_mode(), StorageMode::MasterPassword);
        assert!(
            persisted.is_none(),
            "a rolled-back mode must not be persisted"
        );
        assert_eq!(
            mgr.status(),
            crate::credential::CredentialStoreStatus::Unlocked
        );
        assert_eq!(
            mgr.get(&cred("a").0).unwrap(),
            Some(MIGRATION_TEST_SECRET.to_string())
        );
        let extra = CredentialKey::new("after-rollback", CredentialType::Password);
        mgr.set(&extra, "still-writable").unwrap();
    }

    #[test]
    fn partial_failure_switches_and_reports_truthfully() {
        let _mock = crate::credential::os_keychain::test_support::install_mock();
        let dir = tempfile::tempdir().unwrap();
        let mgr = master_password_source(dir.path(), &["p-ok", "p-bad"]);
        let creds = collect(&mgr);
        let mut persisted = None;

        let result = perform_switch(
            &mgr,
            StorageMode::OsKeychain,
            None,
            &creds,
            failing_migration(&["p-bad"]),
            |mode| persisted = Some(mode.clone()),
        )
        .unwrap();

        assert_eq!(result.status, MigrationStatus::Partial);
        assert!(!result.rolled_back);
        assert_eq!(result.migrated_count, 1);
        assert_eq!(result.failed_count, 1);
        assert_eq!(result.removed_count, 0);
        assert_eq!(mgr.get_mode(), StorageMode::OsKeychain);
        assert_eq!(persisted, Some(StorageMode::OsKeychain));
    }

    /// Keys of every namespace stored in the OS keychain for the #3844 tests:
    /// per-connection (all types), a file-scoped connection, a host-label
    /// sudo password, an agent graphical secret and a shared named credential.
    fn keychain_source_keys() -> Vec<CredentialKey> {
        vec![
            CredentialKey::new("conn-1", CredentialType::Password),
            CredentialKey::new("conn-1", CredentialType::KeyPassphrase),
            CredentialKey::new("conn-1", CredentialType::SudoPassword),
            CredentialKey::new("conn-2@file-7", CredentialType::Password),
            CredentialKey::new("db.example.com", CredentialType::SudoPassword),
            CredentialKey::new("agent-graphical:agent-1:vnc-1", CredentialType::Password),
            CredentialKey::new("named-credential:bastion", CredentialType::Password),
        ]
    }

    fn keychain_source(dir: &std::path::Path) -> CredentialManager {
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.to_path_buf());
        for (i, key) in keychain_source_keys().iter().enumerate() {
            mgr.set(key, &format!("keychain-secret-{i}")).unwrap();
        }
        mgr
    }

    fn keychain_index_text(dir: &std::path::Path) -> String {
        std::fs::read_to_string(dir.join(crate::credential::keychain_index::FILE_NAME)).unwrap()
    }

    #[test]
    fn switching_keychain_to_none_removes_every_indexed_key() {
        // #3844: per-connection and graphical secrets were never collected
        // from the OS keychain, so a switch to `none` left them behind.
        let _mock = crate::credential::os_keychain::test_support::install_mock();
        let dir = tempfile::tempdir().unwrap();
        let mgr = keychain_source(dir.path());

        let creds = collect_credentials_for_migration(&mgr, &StorageMode::OsKeychain, &[]).unwrap();
        let mut collected: Vec<String> = creds.iter().map(|(k, _)| k.to_string()).collect();
        collected.sort();
        let mut expected: Vec<String> = keychain_source_keys()
            .iter()
            .map(|k| k.to_string())
            .collect();
        expected.sort();
        assert_eq!(collected, expected);

        let result = perform_switch(
            &mgr,
            StorageMode::None,
            None,
            &creds,
            |_, _| panic!("switching to none must not 'migrate' into the NullStore"),
            |_| {},
        )
        .unwrap();

        assert_eq!(result.status, MigrationStatus::Success);
        assert_eq!(result.removed_count as usize, expected.len());
        assert!(result.remaining.is_empty());
        // Keys leave the index only after their keychain delete succeeded.
        let index = keychain_index_text(dir.path());
        for key in &expected {
            assert!(!index.contains(key.as_str()), "{key} still indexed");
        }
    }

    #[test]
    fn switching_keychain_to_none_seeds_and_removes_unindexed_items() {
        // The switch triggers the on-demand seed: per-connection items that
        // predate the index are found via the derived probe keys, and a
        // graphical secret via the candidate recorded when its agent was
        // listed — so none is left behind in the keychain.
        let _mock = crate::credential::os_keychain::test_support::install_mock();
        let dir = tempfile::tempdir().unwrap();
        let mgr = keychain_source(dir.path());
        mgr.forget_keychain_index_for_test();
        let graphical =
            CredentialKey::new("agent-graphical:agent-1:vnc-1", CredentialType::Password);
        mgr.note_key_candidates(std::slice::from_ref(&graphical));

        let probe = crate::commands::credential_vault::keys_for_owners(&["conn-1".to_string()]);
        let creds =
            collect_credentials_for_migration(&mgr, &StorageMode::OsKeychain, &probe).unwrap();
        let mut collected: Vec<String> = creds.iter().map(|(k, _)| k.to_string()).collect();
        collected.sort();
        assert_eq!(
            collected,
            vec![
                graphical.to_string(),
                "conn-1:key_passphrase".to_string(),
                "conn-1:password".to_string(),
                "conn-1:sudo_password".to_string(),
            ]
        );

        let pending = mgr.begin_switch(StorageMode::None);
        let result = clear_previous_store(&pending, &creds);
        mgr.rollback_switch(pending);
        assert!(result.remaining.is_empty());
        assert_eq!(mgr.get(&graphical).unwrap(), None);
        for t in CredentialType::ALL {
            assert_eq!(mgr.get(&CredentialKey::new("conn-1", t)).unwrap(), None);
        }
    }

    #[test]
    fn clearing_the_keychain_source_deletes_the_items() {
        let _mock = crate::credential::os_keychain::test_support::install_mock();
        let dir = tempfile::tempdir().unwrap();
        let mgr = keychain_source(dir.path());
        let creds = collect_credentials_for_migration(&mgr, &StorageMode::OsKeychain, &[]).unwrap();

        let pending = mgr.begin_switch(StorageMode::None);
        let result = clear_previous_store(&pending, &creds);
        mgr.rollback_switch(pending);

        assert!(result.remaining.is_empty());
        for key in keychain_source_keys() {
            assert_eq!(mgr.get(&key).unwrap(), None, "{key} left in the keychain");
        }
        assert!(mgr.list_keys().unwrap().is_empty());
    }

    #[test]
    fn switching_to_none_removes_the_credentials_from_the_source() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = master_password_source(dir.path(), &["n1", "n2", "n3"]);
        let creds = collect(&mgr);
        let mut persisted = None;

        let result = perform_switch(
            &mgr,
            StorageMode::None,
            None,
            &creds,
            |_, _| panic!("switching to none must not 'migrate' into the NullStore"),
            |mode| persisted = Some(mode.clone()),
        )
        .unwrap();

        assert_eq!(result.status, MigrationStatus::Success);
        assert_eq!(result.removed_count, 3);
        assert_eq!(result.migrated_count, 0);
        assert!(result.remaining.is_empty());
        assert_eq!(mgr.get_mode(), StorageMode::None);
        assert_eq!(persisted, Some(StorageMode::None));

        // The on-disk source store is empty: re-open and unlock it.
        let reopened = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        reopened.unlock("source-pw").unwrap();
        assert!(reopened.list_keys().unwrap().is_empty());
        let raw = std::fs::read(dir.path().join("credentials.enc")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(MIGRATION_TEST_SECRET));
    }

    #[test]
    fn switching_to_none_reports_entries_that_could_not_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = master_password_source(dir.path(), &["r1"]);
        let mut creds = collect(&mgr);
        // r2 is not in the store, so removing it is a no-op success (no disk
        // write); r1 must be written back to disk, which fails because the
        // credentials file has been replaced by a directory.
        creds.push(cred("r2"));
        let blocked = dir.path().join("credentials.enc");
        std::fs::remove_file(&blocked).unwrap();
        std::fs::create_dir(&blocked).unwrap();

        let result = perform_switch(
            &mgr,
            StorageMode::None,
            None,
            &creds,
            |_, _| unreachable!(),
            |_| {},
        )
        .unwrap();

        assert_eq!(result.status, MigrationStatus::Partial);
        assert_eq!(result.removed_count, 1);
        assert_eq!(result.remaining, vec![cred("r1").0.to_string()]);
        assert_eq!(result.failed_count, 1);
        assert!(result.warnings[0].contains("Failed to remove"));
        assert!(!result.warnings[0].contains(MIGRATION_TEST_SECRET));
        assert_eq!(mgr.get_mode(), StorageMode::None);
    }

    #[test]
    fn switching_to_none_rolls_back_when_nothing_could_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = master_password_source(dir.path(), &["x1"]);
        let creds = collect(&mgr);
        let blocked = dir.path().join("credentials.enc");
        std::fs::remove_file(&blocked).unwrap();
        std::fs::create_dir(&blocked).unwrap();
        let mut persisted = false;

        let result = perform_switch(
            &mgr,
            StorageMode::None,
            None,
            &creds,
            |_, _| unreachable!(),
            |_| persisted = true,
        )
        .unwrap();

        assert_eq!(result.status, MigrationStatus::Failed);
        assert!(result.rolled_back);
        assert_eq!(result.remaining.len(), 1);
        assert!(!persisted);
        assert_eq!(mgr.get_mode(), StorageMode::MasterPassword);
        assert_eq!(
            mgr.status(),
            crate::credential::CredentialStoreStatus::Unlocked
        );
        // The entry that could not be removed from disk is still readable.
        assert_eq!(
            mgr.get(&cred("x1").0).unwrap(),
            Some(MIGRATION_TEST_SECRET.to_string())
        );
    }

    #[test]
    fn master_password_setup_failure_rolls_back() {
        // Existing credentials.enc with a different password → unlock fails.
        let file_dir = tempfile::tempdir().unwrap();
        let existing = MasterPasswordStore::new(file_dir.path().join("credentials.enc"));
        existing.setup("other-pw").unwrap();
        drop(existing);
        let mgr = CredentialManager::new(StorageMode::None, file_dir.path().to_path_buf());
        let mut persisted = false;

        let err = perform_switch(
            &mgr,
            StorageMode::MasterPassword,
            Some("wrong-pw".to_string()),
            &[],
            |_, _| unreachable!(),
            |_| persisted = true,
        )
        .unwrap_err();

        assert!(!err.is_empty());
        assert!(!persisted);
        assert_eq!(mgr.get_mode(), StorageMode::None);
        // The pre-existing file is never deleted by a rollback.
        assert!(file_dir.path().join("credentials.enc").exists());
    }

    #[test]
    fn rollback_deletes_a_master_password_file_it_created() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        let creds = vec![cred("m1")];

        let result = perform_switch(
            &mgr,
            StorageMode::MasterPassword,
            Some("new-pw-123".to_string()),
            &creds,
            failing_migration(&["m1"]),
            |_| panic!("must not persist"),
        )
        .unwrap();

        assert!(result.rolled_back);
        assert_eq!(mgr.get_mode(), StorageMode::None);
        assert!(!dir.path().join("credentials.enc").exists());
    }
}
