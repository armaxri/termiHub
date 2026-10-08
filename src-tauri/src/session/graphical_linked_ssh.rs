//! The app's side of a direct VNC connection's linked SSH file route (#4194).
//!
//! A direct VNC connection (no SSH tunnel, no agent) may name a saved SSH
//! connection in `fileTransferVia`. Route resolution
//! ([`super::graphical_file_channel`]) asks a [`LinkedSshSource`] for it; this
//! module is that source for the running app. It looks the id up where every
//! saved-connection reference is looked up — the main store plus every enabled
//! external connection file, a unique id resolves, an ambiguous one is refused
//! (#3602) — and resolves what its connect needs without asking the user:
//!
//! - the **stored secret**, read under the connection's own credential key
//!   through the same resolver relaunched transfers use
//!   ([`unattended_settings`]), so a shared named credential (#3557) and
//!   per-file credential scopes (#3591) apply. A secret that is not stored (or
//!   a locked store) makes the link unusable with a reason and a
//!   [`LinkedSecretRequest`] (#4265): the UI asks for it with the usual
//!   password prompt when the user acts, and hands the answer back as the
//!   session's **supplied** secret, which then stands in for the missing one.
//!   Nothing here prompts, so unattended callers keep the reason;
//! - its **jump-host chain**, expanded to inline hops (#940).
//!
//! The SSH connect itself is attended: an unknown host key is put to the user
//! by the registered host-key verifier, as for any SSH connection.

use serde_json::Value;
use tauri::{AppHandle, Manager};
use termihub_core::backends::ssh::parse_ssh_settings;

use super::graphical_file_channel::{
    LinkedLookup, LinkedSecretKind, LinkedSecretRequest, LinkedSshSource, LinkedSshTarget,
};
use crate::connection::config::SavedConnection;
use crate::connection::jump_host_resolver::{match_unique, UniqueMatch};
use crate::connection::manager::ConnectionManager;
use crate::credential::{CredentialStore, CredentialType};
use crate::files::transfer::relaunch_credentials::{
    needed_secret, unattended_settings, Unresolved,
};

/// Look the saved SSH connection `connection_id` up in `connections` and
/// resolve it for connecting (see the module docs).
///
/// `supplied` is the secret the user entered for this session, used only when
/// none can be read from the store. `owner_of` names the credential owner of a connection's per-connection
/// secrets, `key_is_encrypted` tells whether a key file needs a passphrase,
/// and `resolve_jump_hosts` expands saved-connection jump-host references.
pub(crate) fn lookup_linked(
    connections: &[SavedConnection],
    connection_id: &str,
    supplied: Option<&str>,
    owner_of: impl Fn(&SavedConnection) -> String,
    creds: &dyn CredentialStore,
    key_is_encrypted: impl Fn(&str) -> bool,
    resolve_jump_hosts: impl FnOnce(&mut Value) -> Result<(), String>,
) -> LinkedLookup {
    let conn = match match_unique(connections, |c| c.id == connection_id) {
        UniqueMatch::None => return LinkedLookup::Missing,
        UniqueMatch::One(conn) if conn.config.type_id != "ssh" => return LinkedLookup::Missing,
        UniqueMatch::One(conn) => conn,
        UniqueMatch::Ambiguous(matches) => {
            return unusable(
                matches[0],
                "the linked SSH connection's id is used in several connection files; \
                 pick it again in the connection settings"
                    .to_string(),
            )
        }
    };
    let owner = owner_of(conn);
    let mut ask_again = None;
    let mut settings = match unattended_settings(conn, Some(&owner), creds, &key_is_encrypted) {
        Ok(settings) => settings,
        Err(unresolved) => {
            let Some(request) = secret_request(conn, unresolved, &key_is_encrypted) else {
                return unusable(conn, "the linked SSH connection needs a secret".to_string());
            };
            if let Some(secret) = supplied.filter(|s| !s.is_empty()) {
                let mut settings = conn.config.settings.clone();
                if let Some(obj) = settings.as_object_mut() {
                    obj.insert("password".into(), Value::String(secret.to_string()));
                }
                ask_again = Some(request);
                settings
            } else {
                let message = match unresolved {
                    Unresolved::StoreLocked => {
                        "the credential store is locked; unlock it to use the linked SSH connection"
                            .to_string()
                    }
                    Unresolved::NotStored => format!(
                        "no {} is saved for the linked SSH connection '{}'; enter it with \
                         Retry, or save it in that connection",
                        match request.kind {
                            LinkedSecretKind::Password => "password",
                            LinkedSecretKind::KeyPassphrase => "key passphrase",
                        },
                        conn.name
                    ),
                };
                let mut lookup = unusable(conn, message);
                if let LinkedLookup::Unusable { secret, .. } = &mut lookup {
                    *secret = Some(request);
                }
                return lookup;
            }
        }
    };
    if let Err(e) = resolve_jump_hosts(&mut settings) {
        return unusable(conn, e);
    }
    let config = parse_ssh_settings(&settings).expand();
    if config.host.trim().is_empty() {
        return unusable(conn, "the linked SSH connection has no host".to_string());
    }
    LinkedLookup::Found(Box::new(LinkedSshTarget {
        connection_id: conn.id.clone(),
        name: conn.name.clone(),
        config,
        ask_again,
    }))
}

/// What to ask the user for when `conn`'s secret could not be resolved
/// unattended (#4265); `None` when its connect needs no secret after all.
fn secret_request(
    conn: &SavedConnection,
    unresolved: Unresolved,
    key_is_encrypted: impl Fn(&str) -> bool,
) -> Option<LinkedSecretRequest> {
    let settings = &conn.config.settings;
    let text = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let auth_method = needed_secret(&conn.config.type_id, settings, key_is_encrypted)?;
    let kind = match auth_method {
        "key" => LinkedSecretKind::KeyPassphrase,
        _ => LinkedSecretKind::Password,
    };
    Some(LinkedSecretRequest {
        connection_id: conn.id.clone(),
        source_file: conn.source_file.clone(),
        kind,
        auth_method: auth_method.to_string(),
        host: text("host"),
        username: text("username"),
        store_locked: unresolved == Unresolved::StoreLocked,
        can_save: text("credentialRef").trim().is_empty(),
        rejected: false,
    })
}

/// [`LinkedLookup::Unusable`] for `conn`, naming its host and account.
fn unusable(conn: &SavedConnection, message: String) -> LinkedLookup {
    let text = |key: &str| {
        conn.config
            .settings
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    LinkedLookup::Unusable {
        name: conn.name.clone(),
        host: text("host"),
        user: text("username"),
        message,
        secret: None,
    }
}

/// The running app as a [`LinkedSshSource`]: saved connections and the
/// credential store from its [`ConnectionManager`].
pub(crate) struct AppLinkedSsh {
    pub app: AppHandle,
}

#[async_trait::async_trait]
impl LinkedSshSource for AppLinkedSsh {
    fn lookup(&self, connection_id: &str, supplied: Option<&str>) -> LinkedLookup {
        let Some(manager) = self.app.try_state::<ConnectionManager>() else {
            return LinkedLookup::Missing;
        };
        let connections = match manager.reference_scope() {
            Ok((connections, _unavailable)) => connections,
            Err(e) => {
                tracing::warn!(error = %e, "could not load saved connections for a linked file route");
                return LinkedLookup::Missing;
            }
        };
        lookup_linked(
            &connections,
            connection_id,
            supplied,
            |c| {
                manager
                    .connection_credential_key(
                        &c.id,
                        c.source_file.as_deref(),
                        CredentialType::Password,
                    )
                    .connection_id
            },
            manager.credential_store(),
            |path| crate::utils::ssh_key_validate::is_ssh_key_encrypted(path).unwrap_or(true),
            |settings| {
                manager
                    .resolve_jump_host_refs(settings, Some(connection_id))
                    .map_err(|e| e.to_string())
            },
        )
    }
}

#[cfg(test)]
#[path = "graphical_linked_ssh_tests.rs"]
mod tests;
