//! Tauri commands for the unified backup and restore (PROD-068).
//!
//! The export returns the backup file **text**; the frontend writes it to the
//! path the user picked in a save dialog. The restore takes that text back.
//! Plaintext credentials never cross the IPC boundary (they are always sealed
//! in the vault section), and every passphrase received here is zeroized once
//! used.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};
use tracing::{info, warn};
use zeroize::Zeroizing;

use crate::backup::{
    export, restore, BackupCredentialsPreview, BackupExportOptions, BackupExportResult,
    BackupHeader, BackupRestorePreview, BackupRestoreRequest, BackupRestoreResult,
    BackupSectionInfo,
};
use crate::commands::credential_vault::known_owners;
use crate::connection::manager::ConnectionManager;
use crate::credential::vault::{self, VaultError};
use crate::credential::{CredentialManager, CredentialStore};
use crate::utils::config_paths::resolve_config_dir;

fn config_dir(app: &AppHandle) -> Result<PathBuf, VaultError> {
    resolve_config_dir(Some(app)).map_err(|e| VaultError::Other {
        message: format!("Could not resolve the config directory: {e}"),
    })
}

/// List every section a backup can carry, with whether it exists here.
#[tauri::command]
pub fn list_backup_sections(app: AppHandle) -> Result<Vec<BackupSectionInfo>, VaultError> {
    Ok(export::section_infos(&config_dir(&app)?))
}

/// Create a backup and return its file text.
///
/// `passphrase` is required when the backup is encrypted or includes the
/// credential vault; it must meet the export-passphrase rules and differ from
/// the master password. Including credentials needs the same re-authentication
/// as a vault export (`master_password` in master-password mode; refused in
/// OS-keychain mode until #3433).
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn export_backup(
    options: BackupExportOptions,
    passphrase: Option<String>,
    master_password: Option<String>,
    app: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<BackupExportResult, VaultError> {
    let passphrase = passphrase.map(Zeroizing::new);
    let master_password = master_password.map(Zeroizing::new);
    let master = master_password.as_deref().map(String::as_str);
    info!(
        sections = options.sections.len(),
        credentials = options.include_credentials,
        encrypt = options.encrypt,
        "Exporting backup"
    );

    if options.encrypt || options.include_credentials {
        let pass = passphrase
            .as_deref()
            .map(String::as_str)
            .unwrap_or_default();
        vault::validate_export_passphrase(pass, master)?;
    }

    let created_at = chrono::Utc::now().to_rfc3339();
    let mut credential_count = None;
    let credentials = if options.include_credentials {
        let owner_ids: Vec<String> = known_owners(&connection_manager, &app)
            .map_err(|e| VaultError::Other {
                message: format!("Could not read the saved connections: {e}"),
            })?
            .into_keys()
            .collect();
        let pass = passphrase
            .as_deref()
            .map(String::as_str)
            .unwrap_or_default();
        let (sealed, count) =
            export::seal_credentials(&manager, master, pass, &owner_ids, created_at.clone())?;
        credential_count = Some(count);
        Some(sealed)
    } else {
        None
    };

    let built = export::build(
        &config_dir(&app)?,
        &options,
        passphrase.as_deref().map(String::as_str),
        credentials,
        created_at,
        env!("CARGO_PKG_VERSION").to_string(),
    )?;
    for warning in &built.warnings {
        warn!("backup export: {warning}");
    }
    info!(
        sections = ?built.sections,
        credentials = ?credential_count,
        "backup exported"
    );
    Ok(BackupExportResult {
        json: built.json,
        sections: built.sections,
        credential_count,
        warnings: built.warnings,
    })
}

/// Read a backup's cleartext header (no passphrase needed).
#[tauri::command]
pub fn read_backup_header(json: String) -> Result<BackupHeader, VaultError> {
    restore::header(&json)
}

/// Decrypt a backup and preview what restoring it would do. Writes nothing.
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn preview_backup_restore(
    json: String,
    passphrase: Option<String>,
    app: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<BackupRestorePreview, VaultError> {
    let passphrase = passphrase.map(Zeroizing::new);
    let opened = restore::open(&json, passphrase.as_deref().map(String::as_str))?;
    let config_dir = config_dir(&app)?;

    let mut owners = known_owners(&connection_manager, &app).unwrap_or_else(|e| {
        warn!("Could not read saved connections for the restore preview: {e}");
        Default::default()
    });
    for (id, name) in restore::backup_owner_names(&opened) {
        owners.entry(id).or_insert(name);
    }

    Ok(restore::plan(&opened, &config_dir, |vault_contents| {
        let unavailable = |reason: String| BackupCredentialsPreview {
            available: false,
            unavailable_reason: Some(reason),
            preview: None,
        };
        if let Err(e) = vault::authorize_import(&manager) {
            return unavailable(e.to_string());
        }
        match vault::plan_import(vault_contents, &**manager, &manager.get_mode(), &owners) {
            Ok(preview) => BackupCredentialsPreview {
                available: true,
                unavailable_reason: None,
                preview: Some(preview),
            },
            Err(e) => unavailable(e.to_string()),
        }
    }))
}

/// Restore the chosen parts of a backup.
///
/// All-or-nothing: the chosen stores are staged and committed together with
/// the credential import; any failure leaves everything unchanged. The staged
/// stores are applied on the next start — when `restartRequired` is set the
/// frontend restarts the app via [`restart_after_backup_restore`].
///
/// This is async because Argon2id key derivation is CPU-intensive.
#[tauri::command]
pub async fn apply_backup_restore(
    json: String,
    passphrase: Option<String>,
    request: BackupRestoreRequest,
    app: AppHandle,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<BackupRestoreResult, VaultError> {
    let passphrase = passphrase.map(Zeroizing::new);
    info!(
        sections = request.sections.len(),
        credentials = ?request.credentials,
        "Restoring backup"
    );
    let opened = restore::open(&json, passphrase.as_deref().map(String::as_str))?;
    let store: Option<&dyn CredentialStore> = if request.credentials.is_some() {
        vault::authorize_import(&manager)?;
        Some(&**manager)
    } else {
        None
    };
    restore::apply(&opened, &config_dir(&app)?, &request, store)
}

/// Restart termiHub so a staged restore is applied before any store loads.
#[tauri::command]
pub fn restart_after_backup_restore(app: AppHandle) {
    info!("Restarting to apply the backup restore");
    app.request_restart();
}
