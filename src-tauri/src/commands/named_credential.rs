//! Tauri commands for shared named credentials (#3557, PROD-065).
//!
//! Secrets travel **into** the backend only (create / rotate) and are
//! zeroized once stored. The single command that returns a secret,
//! [`resolve_named_credential`], serves the connect flow exactly like the
//! existing per-connection [`resolve_credential`](super::credential::resolve_credential)
//! — no new place receives a secret. There is no "reveal" command.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tracing::{debug, warn};
use zeroize::Zeroizing;

use crate::connection::manager::ConnectionManager;
use crate::credential::named::{
    find_usages, NamedCredential, NamedCredentialError, NamedCredentialKind,
    NamedCredentialRegistry, NamedCredentialUsage,
};
use crate::credential::{CredentialManager, CredentialType};

/// A named credential plus who references it, for the management UI.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NamedCredentialEntry {
    pub credential: NamedCredential,
    pub usages: Vec<NamedCredentialUsage>,
}

/// Every connection / agent that references credential `id` right now,
/// including connections from external connection files.
fn usages_of(
    connection_manager: &ConnectionManager,
    id: &str,
) -> Result<Vec<NamedCredentialUsage>, NamedCredentialError> {
    let view = connection_manager
        .load_unified_view()
        .map_err(|e| NamedCredentialError::Other {
            message: format!("Could not read the saved connections: {e}"),
        })?;
    Ok(find_usages(id, &view.connections, &view.agents))
}

/// List every named credential with its references.
#[tauri::command]
pub fn list_named_credentials(
    registry: State<'_, Arc<NamedCredentialRegistry>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<Vec<NamedCredentialEntry>, NamedCredentialError> {
    let view = connection_manager.load_unified_view().ok();
    Ok(registry
        .list()
        .into_iter()
        .map(|credential| {
            let usages = view
                .as_ref()
                .map(|v| find_usages(&credential.id, &v.connections, &v.agents))
                .unwrap_or_default();
            NamedCredentialEntry { credential, usages }
        })
        .collect())
}

/// Create a named credential holding `secret`.
#[tauri::command]
pub fn create_named_credential(
    name: String,
    kind: NamedCredentialKind,
    secret: String,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<NamedCredential, NamedCredentialError> {
    let secret = Zeroizing::new(secret);
    registry.create(&**manager, &manager.get_mode(), &name, kind, &secret)
}

/// Rename a named credential (references are by id and are unaffected).
#[tauri::command]
pub fn rename_named_credential(
    id: String,
    name: String,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
) -> Result<NamedCredential, NamedCredentialError> {
    registry.rename(&id, &name)
}

/// Replace a named credential's secret — for every connection using it.
#[tauri::command]
pub fn rotate_named_credential(
    id: String,
    secret: String,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<NamedCredential, NamedCredentialError> {
    let secret = Zeroizing::new(secret);
    registry.rotate(&**manager, &manager.get_mode(), &id, &secret)
}

/// Delete a named credential. Refused (`inUse`, listing the users) while any
/// connection or agent references it.
#[tauri::command]
pub fn delete_named_credential(
    id: String,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
    manager: State<'_, Arc<CredentialManager>>,
    connection_manager: State<'_, ConnectionManager>,
) -> Result<(), NamedCredentialError> {
    let usages = usages_of(&connection_manager, &id)?;
    registry.delete(&**manager, &manager.get_mode(), &id, usages)
}

/// Resolve a named credential's secret for a connect, or `null`.
///
/// Mirrors `resolve_credential`: an unknown id, a kind that does not match
/// `credential_type`, a missing secret or a locked / failing store all yield
/// `null` (a locked store also triggers the unlock prompt event), so the
/// connect flow falls back to prompting.
#[tauri::command]
pub fn resolve_named_credential(
    id: String,
    credential_type: String,
    registry: State<'_, Arc<NamedCredentialRegistry>>,
    manager: State<'_, Arc<CredentialManager>>,
) -> Result<Option<String>, String> {
    let credential_type = match CredentialType::from_type_str(&credential_type) {
        Some(t @ (CredentialType::Password | CredentialType::KeyPassphrase)) => t,
        _ => return Err(format!("Unsupported credential type: {credential_type}")),
    };
    debug!(id = %id, credential_type = %credential_type, "Resolving shared credential");
    match registry.resolve(&**manager, &id, &credential_type) {
        Ok(value) => Ok(value),
        Err(e) => {
            warn!(id = %id, "Failed to resolve shared credential: {e}");
            Ok(None)
        }
    }
}
