use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tracing::{debug, info, warn};

use crate::connection::manager::ConnectionManager;
use crate::credential::types::{build_status_info, CredentialStoreStatusInfo};
use crate::credential::{
    CredentialKey, CredentialManager, CredentialStore, CredentialType, LockedEventPayload,
    MasterPasswordStore, StorageMode, UnlockFailure,
};

/// Event emitted when the credential store is locked.
const EVENT_STORE_LOCKED: &str = "credential-store-locked";
/// Event emitted when the credential store is unlocked.
const EVENT_STORE_UNLOCKED: &str = "credential-store-unlocked";
/// Event emitted when the credential store status changes (mode switch, setup, etc.).
const EVENT_STORE_STATUS_CHANGED: &str = "credential-store-status-changed";

/// Result of switching credential stores, returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    /// Number of credentials successfully migrated.
    pub migrated_count: u32,
    /// Warnings for credentials that failed to migrate.
    pub warnings: Vec<String>,
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
fn collect_credentials_for_migration(
    manager: &CredentialManager,
    current_mode: &StorageMode,
) -> Result<Vec<(CredentialKey, String)>, String> {
    let keys_to_migrate = manager
        .list_keys()
        .map_err(|e| unreadable_source_error(current_mode, &e.to_string()))?;

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
/// Returns the count migrated and the human-readable warnings surfaced to the
/// frontend in [`SwitchResult`]. The source store is left intact on any
/// failure, so the user can recover.
fn migrate_credentials(
    manager: &CredentialManager,
    credentials_to_migrate: &[(CredentialKey, String)],
) -> (u32, Vec<String>) {
    let mut migrated_count = 0u32;
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

    (migrated_count, warnings)
}

fn emit_status_changed(app_handle: &AppHandle, manager: &CredentialManager) {
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
#[serde(rename_all = "camelCase")]
pub struct UnlockError {
    /// Human-readable failure message.
    pub message: String,
    /// `true` when the credentials file is corrupt (not a wrong password).
    pub corrupted: bool,
}

impl From<UnlockFailure> for UnlockError {
    fn from(failure: UnlockFailure) -> Self {
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

/// Delete the credentials file so a corrupt store can be set up fresh (G8).
fn reset_store_file(store: &MasterPasswordStore) -> Result<(), String> {
    store.reset().map_err(|e| e.to_string())
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

    let result = manager
        .with_master_password_store(|store| unlock_store_classified(store, &password))
        .ok_or_else(|| UnlockError {
            message: "Credential store is not in master password mode".to_string(),
            corrupted: false,
        })?;

    result?;

    manager.notify_auto_lock_unlocked();

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

    let result = manager
        .with_master_password_store(reset_store_file)
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

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

    let result = manager
        .with_master_password_store(|store| store.setup(&password).map_err(|e| e.to_string()))
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

    manager.notify_auto_lock_unlocked();

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

    let result = manager
        .with_master_password_store(|store| {
            store
                .change_password(&current_password, &new_password)
                .map_err(|e| e.to_string())
        })
        .ok_or_else(|| "Credential store is not in master password mode".to_string())?;

    result?;

    emit_status_changed(&app_handle, &manager);
    Ok(())
}

/// Switch the credential storage backend.
///
/// Optionally migrates existing credentials to the new store.
/// When switching to master password mode, a `master_password` must be provided
/// to set up the new encrypted store. The new mode is persisted to app settings
/// so it survives app restarts.
#[tauri::command]
pub async fn switch_credential_store(
    new_mode: String,
    master_password: Option<String>,
    app_handle: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<SwitchResult, String> {
    let target_mode = StorageMode::from_settings_str(Some(&new_mode));
    let current_mode = manager.get_mode();

    info!(
        from = current_mode.to_settings_str(),
        to = target_mode.to_settings_str(),
        "Switching credential store"
    );

    if current_mode == target_mode {
        return Ok(SwitchResult {
            migrated_count: 0,
            warnings: vec!["Already using this storage mode".to_string()],
        });
    }

    // Collect credentials from the current store for migration. Aborts the
    // switch (leaving the source untouched) if the source cannot be read in
    // full, so an unreadable store never silently becomes an empty new store
    // that looks like total credential loss (TAURI-011).
    let credentials_to_migrate = collect_credentials_for_migration(&manager, &current_mode)?;

    // Notify auto-lock timer when leaving master password mode
    if current_mode == StorageMode::MasterPassword {
        manager.notify_auto_lock_locked();
    }

    // Switch to the new backend
    manager
        .switch_store(target_mode.clone())
        .map_err(|e| e.to_string())?;

    // If switching to master password mode, set up the new store
    if target_mode == StorageMode::MasterPassword {
        let password = master_password
            .ok_or("Master password is required when switching to master password mode")?;

        let setup_result = manager
            .with_master_password_store(|store| {
                if store.has_credentials_file() {
                    // File exists — unlock instead of setup
                    store.unlock(&password).map_err(|e| e.to_string())
                } else {
                    store.setup(&password).map_err(|e| e.to_string())
                }
            })
            .ok_or_else(|| "Failed to access master password store after switch".to_string())?;

        setup_result?;

        // Notify auto-lock timer when entering master password mode
        manager.notify_auto_lock_unlocked();
    }

    // Migrate credentials to the new store. Each failure is logged at WARN
    // (key only, never the secret value) and an INFO summary is emitted
    // unconditionally, so a partial or total migration failure leaves a durable
    // trace instead of failing silently (OBS-007).
    let (migrated_count, warnings) = migrate_credentials(&manager, &credentials_to_migrate);

    // Persist the new mode to settings so it survives app restarts.
    let mut settings = connection_manager.get_settings();
    settings.credential_storage_mode = Some(target_mode.to_settings_str().to_string());
    if let Err(e) = connection_manager.save_settings(settings) {
        warn!(
            "Failed to persist credential storage mode to settings: {}",
            e
        );
    }

    emit_status_changed(&app_handle, &manager);
    Ok(SwitchResult {
        migrated_count,
        warnings,
    })
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
#[tauri::command]
pub fn store_credential(
    connection_id: String,
    credential_type: String,
    value: String,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = CredentialKey::new(&connection_id, cred_type);
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
#[tauri::command]
pub fn resolve_credential(
    connection_id: String,
    credential_type: String,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<Option<String>, String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = CredentialKey::new(&connection_id, cred_type);
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
#[tauri::command]
pub fn remove_credential(
    connection_id: String,
    credential_type: String,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<(), String> {
    let cred_type = parse_credential_type(&credential_type)?;
    let key = CredentialKey::new(&connection_id, cred_type);
    debug!(
        connection_id = %connection_id,
        credential_type = %credential_type,
        "Removing credential"
    );
    manager.remove(&key).map_err(|e| e.to_string())
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
        let subscriber =
            tracing_subscriber::registry().with(LogCaptureLayer::new(buffer.clone()));

        let (migrated, warnings) = tracing::subscriber::with_default(subscriber, || {
            migrate_credentials(&mgr, &creds)
        });

        // Worst case: nothing migrated, one warning surfaced to the frontend.
        assert_eq!(migrated, 0, "a locked store migrates nothing");
        assert_eq!(warnings.len(), 1, "the failed credential is surfaced");

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
            entries.iter().all(|e| !e.message.contains(MIGRATION_TEST_SECRET)),
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

        tracing::subscriber::with_default(subscriber, || {
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
        let result = collect_credentials_for_migration(&mgr, &StorageMode::MasterPassword);
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
            collect_credentials_for_migration(&mgr, &StorageMode::MasterPassword).unwrap();
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

        let collected = collect_credentials_for_migration(&mgr, &StorageMode::None).unwrap();
        assert!(
            collected.is_empty(),
            "an empty source must yield an empty migration set, not an error"
        );
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

        reset_store_file(&store).unwrap();
        assert!(!path.exists(), "reset must delete the credentials file");
    }

    /// Resetting when no file exists is a benign no-op.
    #[test]
    fn reset_store_file_no_file_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let store = MasterPasswordStore::new(dir.path().join("credentials.enc"));
        assert!(reset_store_file(&store).is_ok());
    }
}
