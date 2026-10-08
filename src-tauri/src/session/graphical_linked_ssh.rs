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
//!   a locked store) makes the link unusable with a reason, instead of a
//!   password prompt in the middle of a remote-desktop session;
//! - its **jump-host chain**, expanded to inline hops (#940).
//!
//! The SSH connect itself is attended: an unknown host key is put to the user
//! by the registered host-key verifier, as for any SSH connection.

use serde_json::Value;
use tauri::{AppHandle, Manager};
use termihub_core::backends::ssh::parse_ssh_settings;

use super::graphical_file_channel::{LinkedLookup, LinkedSshSource, LinkedSshTarget};
use crate::connection::config::SavedConnection;
use crate::connection::jump_host_resolver::{match_unique, UniqueMatch};
use crate::connection::manager::ConnectionManager;
use crate::credential::{CredentialStore, CredentialType};
use crate::files::transfer::relaunch_credentials::{unattended_settings, Unresolved};

/// Look the saved SSH connection `connection_id` up in `connections` and
/// resolve it for connecting (see the module docs).
///
/// `owner_of` names the credential owner of a connection's per-connection
/// secrets, `key_is_encrypted` tells whether a key file needs a passphrase,
/// and `resolve_jump_hosts` expands saved-connection jump-host references.
pub(crate) fn lookup_linked(
    connections: &[SavedConnection],
    connection_id: &str,
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
    let mut settings = match unattended_settings(conn, Some(&owner), creds, key_is_encrypted) {
        Ok(settings) => settings,
        Err(Unresolved::StoreLocked) => {
            return unusable(
                conn,
                "the credential store is locked; unlock it to use the linked SSH connection"
                    .to_string(),
            )
        }
        Err(Unresolved::NotStored) => {
            return unusable(
                conn,
                format!(
                    "no password is saved for the linked SSH connection '{}'; save it in \
                     that connection",
                    conn.name
                ),
            )
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
    }))
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
    }
}

/// The running app as a [`LinkedSshSource`]: saved connections and the
/// credential store from its [`ConnectionManager`].
pub(crate) struct AppLinkedSsh {
    pub app: AppHandle,
}

#[async_trait::async_trait]
impl LinkedSshSource for AppLinkedSsh {
    fn lookup(&self, connection_id: &str) -> LinkedLookup {
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
