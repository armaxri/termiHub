use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tracing::{debug, info};
use zeroize::Zeroizing;

use crate::connection::config::{
    ConnectionFolder, ImportPreview, SavedConnection, SavedRemoteAgent,
};
use crate::connection::manager::{self, ConnectionManager};
use crate::connection::recovery::RecoveryWarning;
use crate::connection::settings::AppSettings;
use crate::credential::crypto::DecryptError;
use crate::credential::named::{transfer, NamedCredentialRegistry};
use crate::credential::{vault, CredentialManager, StorageMode};
use crate::files::bookmarks_manager::FileBookmarkManager;
use crate::utils::errors::TerminalError;

/// Map a connection-config backend failure — persistence, import/export, or
/// folder/agent CRUD (all `anyhow::Result`) — into a typed [`TerminalError`]
/// carrying the structured IPC error envelope (ARCH-006 / TAURI-008 / ERR-008
/// Phase 2). The exact `Display` text the command previously surfaced as a raw
/// `String` is preserved verbatim as the payload (the same top-level
/// `e.to_string()` these commands returned before). These are generic
/// backend-operation failures with no more specific existing variant, so they
/// map to [`TerminalError::InternalError`]; only the typed variant's classifying
/// prefix is added, matching every other retyped command and the #3168 envelope.
fn config_error(e: impl std::fmt::Display) -> TerminalError {
    TerminalError::InternalError(e.to_string())
}

/// A projection region a `ConnectionManager` mutation is re-folded into.
///
/// Every connection-config command that changes (or reloads) what the
/// [`ConnectionManager`] holds names the regions it feeds here, and the fold
/// runs through [`commit`] — the single choke point (TAURI-006, #3762). No
/// command calls a `fold_*_from_manager` directly, so a new mutation cannot
/// persist without also re-folding its authoritative region.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fold {
    /// The authoritative `connections` region (#2389/#2394/#2401): the unified
    /// main + external-file tree.
    Connections,
    /// The authoritative `agents` region's list-membership (#2403).
    Agents,
    /// The authoritative `settings` region (#2386).
    Settings,
}

impl Fold {
    /// Reflect the manager's current state for this region into its store and
    /// publish the region diff.
    fn apply<R: Runtime>(self, app: &AppHandle<R>) {
        match self {
            Fold::Connections => {
                crate::connections_projection::projection::fold_connections_from_manager(app)
            }
            Fold::Agents => crate::agents_projection::projection::fold_agents_from_manager(app),
            Fold::Settings => {
                crate::settings_projection::projection::fold_settings_from_manager(app)
            }
        }
    }
}

/// The single choke point every `ConnectionManager` mutation command goes
/// through (TAURI-006, #3762).
///
/// Runs `op` — the persisted mutation plus any same-step side effect that must
/// precede the fold (e.g. pruning a deleted connection's bookmarks) — and only
/// when it succeeds folds each region in `folds`, in the order given. A failed
/// `op` folds nothing, so a rejected mutation never republishes a region.
pub(crate) fn commit<R: Runtime, T, E>(
    app: &AppHandle<R>,
    folds: &[Fold],
    op: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let value = op()?;
    for fold in folds {
        fold.apply(app);
    }
    Ok(value)
}

/// Response containing all connections (unified), folders, and agents.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionData {
    pub connections: Vec<SavedConnection>,
    pub folders: Vec<ConnectionFolder>,
    pub agents: Vec<SavedRemoteAgent>,
    /// Errors from loading external files (file_path -> error message).
    pub external_errors: Vec<ExternalFileError>,
}

/// An error encountered when loading an external connection file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileError {
    pub file_path: String,
    pub error: String,
}

/// Load all saved connections, folders, and agents (unified view).
#[tauri::command]
pub fn load_connections_and_folders<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<ConnectionData, TerminalError> {
    info!("Loading connections and folders");
    // The unified main + external view (the same one reflected into the
    // `ConnectionsStore` server-side, #2394), so the command and the projection
    // region cannot drift.
    //
    // A reload re-folds both regions, agents first: the `agents` region tracks the
    // persisted list on a reload, not only the client seed (#2403), and a focus /
    // external reload (`reloadConnectionsFromBackend`) refreshes every
    // `connections` region reader — the frontend holds no connections slice to
    // re-seed (#2401).
    let view = commit(&app, &[Fold::Agents, Fold::Connections], || {
        manager.load_unified_view().map_err(config_error)
    })?;

    Ok(ConnectionData {
        connections: view.connections,
        folders: view.folders,
        agents: view.agents,
        external_errors: view
            .external_errors
            .into_iter()
            .map(|(file_path, error)| ExternalFileError { file_path, error })
            .collect(),
    })
}

/// Save (add or update) a connection, routing to the correct file based on
/// `sourceFile`. Returns the connection's **persisted** id (recomputed from
/// folder + name), so the frontend can reconcile its optimistic `conn-<ts>` id.
#[tauri::command]
pub fn save_connection<R: Runtime>(
    connection: SavedConnection,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<String, TerminalError> {
    debug!(id = %connection.id, name = %connection.name, "Saving connection");
    // The fold reflects the persisted tree — main store *and* the external-file
    // overlay (#2389/#2394) — so a save routed to an external file (`sourceFile`
    // set) updates the region via that overlay.
    commit(&app, &[Fold::Connections], || {
        manager
            .save_connection_routed(connection)
            .map_err(config_error)
    })
}

/// Delete a connection by ID, optionally from an external file.
#[tauri::command]
pub fn delete_connection<R: Runtime>(
    id: String,
    source_file: Option<String>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    info!(id, ?source_file, "Deleting connection");
    commit(&app, &[Fold::Connections], || {
        manager
            .delete_connection_routed(&id, source_file.as_deref())
            .map_err(config_error)?;
        // Drop the connection's file-browser bookmarks (#3562) here, next to the
        // delete, so every window's delete prunes them. Only after the delete is
        // durable, so a rejected delete never loses bookmarks.
        if let Some(bookmarks) = app.try_state::<FileBookmarkManager>() {
            bookmarks.prune_deleted_connection(&id);
        }
        Ok(())
    })
}

/// Move a connection between storage files (main <-> external).
#[tauri::command]
pub fn move_connection_to_file<R: Runtime>(
    connection_id: String,
    current_source: Option<String>,
    target_source: Option<String>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<SavedConnection, TerminalError> {
    info!(
        connection_id,
        ?current_source,
        ?target_source,
        "Moving connection to file"
    );
    // The fold reflects both the main store and the external-file overlay
    // (#2394), so a move into/out of the main store *and* an external↔external
    // move (the `sourceFile` changes) are reflected in the region.
    commit(&app, &[Fold::Connections], || {
        manager
            .move_connection_to_file(&connection_id, current_source.as_deref(), target_source)
            .map_err(config_error)
    })
}

/// Save an edited connection whose storage file changed: the edit is written
/// to the target file (`connection.sourceFile`) and the connection is removed
/// from `currentSource` in one step, so it ends up there exactly once (#3590).
/// Returns the connection as written to the target.
#[tauri::command]
pub fn save_connection_to_file<R: Runtime>(
    connection: SavedConnection,
    current_source: Option<String>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<SavedConnection, TerminalError> {
    info!(
        id = %connection.id,
        ?current_source,
        target_source = ?connection.source_file,
        "Saving connection to file"
    );
    commit(&app, &[Fold::Connections], || {
        manager
            .save_connection_to_file(connection, current_source.as_deref())
            .map_err(config_error)
    })
}

/// Save (add or update) a folder.
#[tauri::command]
pub fn save_folder<R: Runtime>(
    folder: ConnectionFolder,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    // Covers `addFolder` and the `toggleFolder`-persist edge (the frontend
    // persists a folder's `isExpanded` flip via `save_folder`).
    commit(&app, &[Fold::Connections], || {
        manager.save_folder(folder).map_err(config_error)
    })
}

/// Delete a folder by ID.
#[tauri::command]
pub fn delete_folder<R: Runtime>(
    id: String,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    commit(&app, &[Fold::Connections], || {
        manager.delete_folder(&id).map_err(config_error)
    })
}

/// Export all connections as a JSON string.
#[tauri::command]
pub fn export_connections(manager: State<'_, ConnectionManager>) -> Result<String, TerminalError> {
    manager.export_json().map_err(config_error)
}

/// Import connections from a JSON string. Returns the number imported.
#[tauri::command]
pub fn import_connections<R: Runtime>(
    json: String,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<usize, TerminalError> {
    commit(&app, &[Fold::Connections], || {
        manager.import_json(&json).map_err(config_error)
    })
}

/// Get the current application settings.
///
/// If `serial_port_scan_prefixes` has never been saved the field is `None` in
/// storage. We expand it to the full built-in default list before returning so
/// the frontend always receives a concrete, editable list.
#[tauri::command]
pub fn get_settings(manager: State<'_, ConnectionManager>) -> Result<AppSettings, TerminalError> {
    Ok(manager.get_settings_resolved())
}

/// Update and persist application settings.
#[tauri::command]
pub fn save_settings<R: Runtime>(
    settings: AppSettings,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    // The fold reflects the persisted `AppSettings` document into the
    // authoritative `settings` region (#2386). (`AppHandle` is Tauri-injected —
    // no JS invoke change.)
    commit(&app, &[Fold::Settings], || {
        manager.save_settings(settings).map_err(config_error)
    })
}

/// Save an external connection file to disk.
#[tauri::command]
pub fn save_external_file<R: Runtime>(
    file_path: String,
    name: String,
    folders: Vec<ConnectionFolder>,
    connections: Vec<SavedConnection>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    // The fold reflects the external-file overlay (as it is now on disk) into
    // the `connections` region when the saved file is a currently-enabled
    // external source (#2394).
    commit(&app, &[Fold::Connections], || {
        manager
            .save_external_file(&file_path, &name, folders, connections)
            .map_err(config_error)
    })
}

/// Reload external connection files and return flattened connections.
#[tauri::command]
pub fn reload_external_connections<R: Runtime>(
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<Vec<SavedConnection>, TerminalError> {
    // The external overlay just changed on disk / in the enabled set — the fold
    // reflects the unified main + external tree into the `connections` region so
    // it stays in sync with the frontend's `reloadExternalConnections` (#2394).
    commit(&app, &[Fold::Connections], || {
        let sources = manager.load_external_sources();
        let mut connections = Vec::new();
        for source in sources {
            connections.extend(source.connections);
        }
        Ok(connections)
    })
}

/// Save (add or update) a remote agent definition.
#[tauri::command]
pub fn save_remote_agent<R: Runtime>(
    agent: SavedRemoteAgent,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    // The fold reflects the persisted agent list-membership into the `agents`
    // region, so a newly-added agent's identity enters it without a client
    // `agent.add` (#2403).
    commit(&app, &[Fold::Agents], || {
        manager.save_agent(agent).map_err(config_error)
    })
}

/// Delete a remote agent definition by ID.
#[tauri::command]
pub fn delete_remote_agent<R: Runtime>(
    id: String,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    commit(&app, &[Fold::Agents], || {
        manager.delete_agent(&id).map_err(config_error)?;
        // Deleting an agent is a terminal point for its retained reattach secret
        // (#3661). The frontend only disconnects an agent it still sees as
        // connected, so a *reaped* agent's retained config would otherwise linger.
        if let Some(agents) =
            app.try_state::<Arc<dyn crate::terminal::agent_manager::AgentRpcClient>>()
        {
            agents.clear_retained_agent_config(&id);
        }
        // Drop the bookmarks of the agent's sessions, every session type (#3562).
        if let Some(bookmarks) = app.try_state::<FileBookmarkManager>() {
            bookmarks.prune_deleted_agent(&id);
        }
        Ok(())
    })
}

/// Reorder remote agents by providing a list of agent IDs in the desired order.
#[tauri::command]
pub fn reorder_remote_agents<R: Runtime>(
    agent_ids: Vec<String>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    commit(&app, &[Fold::Agents], || {
        manager.reorder_agents(&agent_ids).map_err(config_error)
    })
}

/// Reorder saved connections by providing connection IDs in the desired order.
///
/// Backs the connection-tree drag-reorder (#2594): the frontend sends the full
/// desired order of connection ids; the manager persists the new array order and
/// the fold reflects it into the authoritative `connections` region.
#[tauri::command]
pub fn reorder_connections<R: Runtime>(
    connection_ids: Vec<String>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), TerminalError> {
    commit(&app, &[Fold::Connections], || {
        manager
            .reorder_connections(&connection_ids)
            .map_err(config_error)
    })
}

/// Gate a connection export that carries credentials with the same
/// re-authentication rule as the credential-vault export and the backup's
/// credentials section ([`vault::authorize_export`]):
///
/// - master password: the store must be unlocked and `master_password` must
///   verify against it (#3598), so an unattended unlocked session cannot walk
///   off with every secret;
/// - OS keychain: the OS must verify the user first (fail closed, #3433) —
///   `master_password` is ignored;
/// - `none`: there is no credential store to read secrets from, so the export
///   is not gated.
///
/// An export without an export password carries no secret and is never gated.
fn authorize_credential_export(
    credentials: &CredentialManager,
    export_password: Option<&str>,
    master_password: Option<&str>,
) -> Result<(), vault::VaultError> {
    if export_password.is_none() || credentials.get_mode() == StorageMode::None {
        return Ok(());
    }
    vault::authorize_export(credentials, master_password)
}

/// Export connections with optional encrypted credentials.
///
/// If `export_password` is provided, credentials from the store are
/// encrypted and included in the export. If `connection_ids` is provided,
/// only those connections are exported.
///
/// Shared named credentials the exported connections / agents reference are
/// carried too (#3564): their name and kind always, their secrets only with
/// an export password (sealed like the per-connection ones). An export with
/// credentials first re-authenticates exactly like the credential-vault
/// export: `master_password` must verify in master-password mode (#3598), the
/// OS must verify the user in OS-keychain mode (#3433). A refused
/// re-authentication returns an error and exports nothing.
///
/// This is async because Argon2id key derivation is CPU-intensive and OS
/// verification waits for the user.
#[tauri::command]
pub async fn export_connections_encrypted(
    export_password: Option<String>,
    connection_ids: Option<Vec<String>>,
    master_password: Option<String>,
    manager: State<'_, ConnectionManager>,
    credentials: State<'_, Arc<CredentialManager>>,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
) -> Result<String, TerminalError> {
    let export_password = export_password.map(Zeroizing::new);
    let master_password = master_password.map(Zeroizing::new);
    let password = export_password.as_deref().map(String::as_str);
    info!("Exporting connections (encrypted={})", password.is_some());
    authorize_credential_export(
        &credentials,
        password,
        master_password.as_deref().map(String::as_str),
    )
    .map_err(config_error)?;
    let json = manager
        .export_encrypted_json(password, connection_ids.as_deref())
        .map_err(config_error)?;
    transfer::add_to_export(&json, password, &registry, &**credentials).map_err(config_error)
}

/// Preview the contents of an import file without performing the import.
#[tauri::command]
pub fn preview_import(json: String) -> Result<ImportPreview, TerminalError> {
    let mut preview = manager::preview_import_json(&json).map_err(config_error)?;
    // Sealed shared-credential secrets (#3564) need the password as well.
    preview.has_encrypted_credentials |= transfer::has_sealed_secrets(&json);
    Ok(preview)
}

/// A structured import failure surfaced to the frontend.
///
/// Serializes adjacently-tagged as `{ "kind": "wrongPassword", "message": … }`
/// or `{ "kind": "other", "message": … }`, so the import dialog offers the
/// re-promptable wrong-password affordance by branching on a stable `kind`
/// rather than substring-matching the English error text (I18N-010). The
/// `message` stays populated for display/logging in every case.
#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportError {
    /// The supplied decryption password was wrong — safe to re-prompt.
    #[error("{message}")]
    WrongPassword { message: String },
    /// Any other import failure, with a display-ready message.
    #[error("{message}")]
    Other { message: String },
}

impl ImportError {
    /// Classify an `import_encrypted_json` failure by a locale-invariant signal.
    ///
    /// Walks the error chain for a [`DecryptError::WrongPassword`] — the AEAD
    /// authentication failure raised by the decrypt path — instead of matching
    /// the English message, so classification survives a reword or localization.
    /// The original chain message is preserved for display/logging.
    fn from_import_failure(err: anyhow::Error) -> Self {
        let message = err.to_string();
        let wrong_password = err.chain().any(|cause| {
            matches!(
                cause.downcast_ref::<DecryptError>(),
                Some(DecryptError::WrongPassword)
            )
        });
        if wrong_password {
            ImportError::WrongPassword { message }
        } else {
            ImportError::Other { message }
        }
    }
}

/// Result of a connection import, including the shared named credentials it
/// carried (#3564).
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportResult {
    pub connections_imported: usize,
    pub credentials_imported: usize,
    /// Shared credentials created, or given their missing secret.
    pub shared_credentials_imported: usize,
    /// Notes for the user (a renamed or secret-less shared credential, or
    /// references dropped because credential storage is off).
    pub warnings: Vec<String>,
}

/// Import connections with optional credential decryption.
///
/// If the import file contains an `$encrypted` section and
/// `import_password` is provided, credentials are decrypted and stored.
/// Shared named credentials the file carries are recreated or mapped onto
/// existing ones first and the connections' references rewritten (see
/// [`transfer`]); if the connection import then fails, the credentials it
/// created are removed again.
///
/// A wrong decryption password surfaces as a typed
/// [`ImportError::WrongPassword`] (stable `kind`), so the frontend can offer a
/// tailored re-prompt without parsing the English message (I18N-010).
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn import_connections_with_credentials<R: Runtime>(
    json: String,
    import_password: Option<String>,
    app: AppHandle<R>,
    manager: State<'_, ConnectionManager>,
    credentials: State<'_, Arc<CredentialManager>>,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
) -> Result<ConnectionImportResult, ImportError> {
    let import_password = import_password.map(Zeroizing::new);
    let password = import_password.as_deref().map(String::as_str);
    info!(
        "Importing connections (with_credentials={})",
        password.is_some()
    );
    let mode = credentials.get_mode();
    let prepared = transfer::prepare_import(&json, password, &registry, &**credentials, &mode)
        .map_err(ImportError::from_import_failure)?;
    let result = commit(&app, &[Fold::Connections], || {
        manager
            .import_encrypted_json(&prepared.json, password)
            .map_err(|e| {
                transfer::rollback(&prepared.created, &registry, &**credentials, &mode);
                ImportError::from_import_failure(e)
            })
    })?;
    Ok(ConnectionImportResult {
        connections_imported: result.connections_imported,
        credentials_imported: result.credentials_imported,
        shared_credentials_imported: prepared.imported_count,
        warnings: prepared.warnings,
    })
}

/// Drain and return any recovery warnings collected during app startup.
///
/// Returns an empty list on subsequent calls (warnings are drained on first call).
#[tauri::command]
pub fn get_recovery_warnings(
    warnings: State<'_, Mutex<Vec<RecoveryWarning>>>,
    app: AppHandle,
) -> Vec<RecoveryWarning> {
    let mut all: Vec<RecoveryWarning> = warnings
        .lock()
        .map(|mut w| w.drain(..).collect())
        .unwrap_or_default();
    // One-time notices from scoping saved passwords per connection file (#3591),
    // which may be produced after startup (on unlock).
    if let Some(connections) = app.try_state::<ConnectionManager>() {
        all.extend(connections.take_credential_scope_notices());
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::errors::IpcErrorCode;

    #[test]
    fn keychain_export_with_credentials_requires_os_verification() {
        use crate::credential::os_auth::mock::{MockOutcome, MockVerifier};
        use crate::credential::os_auth::OsAuthError;

        let dir = tempfile::tempdir().unwrap();
        let verifier = Arc::new(MockVerifier::new([
            MockOutcome::Error(OsAuthError::Cancelled),
            MockOutcome::Success(None),
        ]));
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf())
            .with_os_auth(Box::new(verifier.clone()));

        // Without a password nothing secret is exported: no prompt.
        assert!(authorize_credential_export(&mgr, None, None).is_ok());
        assert!(verifier.calls().is_empty());
        // Cancelled → refused; verified → allowed.
        assert!(matches!(
            authorize_credential_export(&mgr, Some("export-pass"), None),
            Err(vault::VaultError::ReauthFailed { .. })
        ));
        assert!(authorize_credential_export(&mgr, Some("export-pass"), None).is_ok());
        assert_eq!(verifier.calls().len(), 2);
    }

    #[test]
    fn keychain_export_is_refused_where_os_verification_is_unavailable() {
        use crate::credential::os_auth::mock::MockVerifier;

        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf())
            .with_os_auth(Box::new(MockVerifier::unavailable()));
        assert!(matches!(
            authorize_credential_export(&mgr, Some("export-pass"), None),
            Err(vault::VaultError::ReauthUnavailable { .. })
        ));
    }

    fn mp_manager(dir: &std::path::Path) -> CredentialManager {
        let mgr = CredentialManager::new(StorageMode::MasterPassword, dir.to_path_buf());
        mgr.with_master_password_store(|s| s.setup("master-pw"))
            .unwrap()
            .unwrap();
        mgr
    }

    #[test]
    fn master_password_export_with_credentials_requires_reauth() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = mp_manager(dir.path());
        // Missing / empty / wrong master password → refused.
        for master in [None, Some(""), Some("nope")] {
            assert!(
                matches!(
                    authorize_credential_export(&mgr, Some("export-pass"), master),
                    Err(vault::VaultError::WrongMasterPassword { .. })
                ),
                "master password {master:?} must be refused"
            );
        }
        // The correct master password → allowed.
        assert!(authorize_credential_export(&mgr, Some("export-pass"), Some("master-pw")).is_ok());
    }

    #[test]
    fn master_password_export_is_refused_while_locked() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = mp_manager(dir.path());
        mgr.with_master_password_store(|s| s.lock()).unwrap();
        assert!(matches!(
            authorize_credential_export(&mgr, Some("export-pass"), Some("master-pw")),
            Err(vault::VaultError::StoreLocked { .. })
        ));
    }

    #[test]
    fn master_password_export_without_credentials_is_not_gated() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = mp_manager(dir.path());
        assert!(authorize_credential_export(&mgr, None, None).is_ok());
        mgr.with_master_password_store(|s| s.lock()).unwrap();
        assert!(authorize_credential_export(&mgr, None, None).is_ok());
    }

    #[test]
    fn master_password_export_is_not_os_gated() {
        use crate::credential::os_auth::mock::MockVerifier;

        let dir = tempfile::tempdir().unwrap();
        let verifier = Arc::new(MockVerifier::new([]));
        let mgr = mp_manager(dir.path()).with_os_auth(Box::new(verifier.clone()));
        assert!(authorize_credential_export(&mgr, Some("export-pass"), Some("master-pw")).is_ok());
        assert!(verifier.calls().is_empty());
    }

    #[test]
    fn keychain_export_ignores_a_supplied_master_password() {
        use crate::credential::os_auth::mock::{MockOutcome, MockVerifier};
        use crate::credential::os_auth::OsAuthError;

        let dir = tempfile::tempdir().unwrap();
        let verifier = Arc::new(MockVerifier::new([MockOutcome::Error(
            OsAuthError::Cancelled,
        )]));
        let mgr = CredentialManager::new(StorageMode::OsKeychain, dir.path().to_path_buf())
            .with_os_auth(Box::new(verifier.clone()));
        // A master password is no substitute for OS verification.
        assert!(matches!(
            authorize_credential_export(&mgr, Some("export-pass"), Some("anything")),
            Err(vault::VaultError::ReauthFailed { .. })
        ));
        assert_eq!(verifier.calls().len(), 1);
    }

    #[test]
    fn storage_mode_none_export_is_not_gated() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = CredentialManager::new(StorageMode::None, dir.path().to_path_buf());
        assert!(authorize_credential_export(&mgr, None, None).is_ok());
        assert!(authorize_credential_export(&mgr, Some("export-pass"), None).is_ok());
    }

    #[test]
    fn preview_flags_sealed_shared_credential_secrets() {
        let json = r#"{"version":"2","children":[],"agents":[],
            "$namedCredentialSecrets":{"version":1}}"#;
        assert!(
            preview_import(json.to_string())
                .unwrap()
                .has_encrypted_credentials
        );
        let plain = r#"{"version":"2","children":[],"agents":[]}"#;
        assert!(
            !preview_import(plain.to_string())
                .unwrap()
                .has_encrypted_credentials
        );
    }

    #[test]
    fn classifies_wrong_password_through_context_wrapping() {
        // Mirror how `import_encrypted_json` wraps the decrypt failure: a
        // `DecryptError::WrongPassword` surfaced through anyhow `.context(...)`.
        // The classifier must find the variant in the chain despite the wrapper.
        let err = anyhow::Error::new(DecryptError::WrongPassword)
            .context("Failed to decrypt credentials — wrong password?");

        assert!(matches!(
            ImportError::from_import_failure(err),
            ImportError::WrongPassword { .. }
        ));
    }

    #[test]
    fn wrong_password_serializes_to_stable_kind() {
        let value = serde_json::to_value(ImportError::WrongPassword {
            message: "irrelevant".to_string(),
        })
        .unwrap();
        assert_eq!(value["kind"], "wrongPassword");
    }

    #[test]
    fn non_decrypt_failures_classify_as_other() {
        // A structural failure with no `DecryptError` in the chain must never be
        // mistaken for a wrong password.
        let err = anyhow::anyhow!("Failed to parse import data");

        let classified = ImportError::from_import_failure(err);
        assert!(matches!(classified, ImportError::Other { .. }));

        let value = serde_json::to_value(&classified).unwrap();
        assert_eq!(value["kind"], "other");
        assert_eq!(value["message"], "Failed to parse import data");
    }

    // ── Typed error envelope (ARCH-006 / TAURI-008 / ERR-008 Phase 2) ─────────
    //
    // These guard the String → TerminalError retype of the connection-config
    // commands (save/delete/move/reorder connections & folders & agents,
    // import/export, settings). Every one funnels its `anyhow::Result` failure
    // through `config_error`, so the human message text they surfaced before
    // (the top-level `e.to_string()`) survives verbatim as the error payload —
    // only the typed variant's classifying prefix is added, matching the #3168
    // envelope and every other retyped command.

    #[test]
    fn config_error_preserves_the_message_text_and_carries_internal_code() {
        // Representative of the `.map_err(|e| e.to_string())?` these commands
        // used before: the same top-level `Display` text is the input.
        let src = anyhow::anyhow!("Failed to save connection 'prod-db'");
        let mapped = config_error(&src);

        assert!(matches!(mapped, TerminalError::InternalError(_)));
        // The exact human text the command produced before survives verbatim.
        assert!(
            mapped
                .to_string()
                .contains("Failed to save connection 'prod-db'"),
            "human message must be preserved, got {mapped}"
        );
        assert_eq!(
            mapped.to_string(),
            "Internal error: Failed to save connection 'prod-db'"
        );
        assert_eq!(mapped.code(), IpcErrorCode::InternalError);
    }

    #[test]
    fn config_error_serializes_the_structured_envelope() {
        // A folder-delete style failure: the anyhow top-level `to_string()` the
        // command surfaced as a raw `String` before the retype.
        let mapped = config_error(anyhow::anyhow!("Folder not found: f-123"));
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&mapped).expect("serialize"))
                .expect("valid JSON object");

        // The stable machine code moves to the `code` field …
        assert_eq!(value["code"], "internal_error");
        // … and the human `message` carries the preserved text (with only the
        // typed prefix), free of any `[thub-code:*]` machine marker.
        assert_eq!(value["message"], "Internal error: Folder not found: f-123");
        assert!(!value["message"]
            .as_str()
            .expect("message is a string")
            .contains("[thub-code:"));
        assert!(value["details"].is_null());
    }
}
