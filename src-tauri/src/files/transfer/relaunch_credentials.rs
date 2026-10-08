//! Re-sourcing credentials for relaunched session transfers (#3876).
//!
//! A relaunched SFTP, FTP or remote-to-remote transfer ([`super::relaunch`])
//! needs an authenticated connection, and its persisted record deliberately
//! holds none (PROD-0011). Where it gets one, in order:
//!
//! 1. **The original session**, still connected — its connection is reused as
//!    before (#3199, #3206).
//! 2. **A session the user reopened for the same saved connection** — after a
//!    restart the original session id is gone, but the record keeps the id of
//!    the saved connection the session was opened for, and every session
//!    opened from a saved connection is bound to it
//!    ([`SessionManager::sessions_for_saved_connection`]).
//! 3. **The credential store**, unattended — the saved connection is looked up
//!    by that id and its password or key passphrase is read under the
//!    connection's existing store key, through the same resolver saved
//!    jump-host references use ([`resolve_credential`]), so a shared named
//!    credential (#3557) and per-file credential scopes (#3591) apply exactly
//!    as they do when connecting. SFTP then connects **unattended** (#3527):
//!    an untrusted host key or a keyboard-interactive round fails instead of
//!    prompting.
//!
//! A relaunch never prompts: a **locked** store is not unlocked, and a secret
//! that is **not stored** is not asked for. The transfer then stays **paused**
//! with the reason [`NEEDS_CREDENTIALS`]; once the user opens the connection
//! (step 2) or unlocks the store (step 3), it relaunches by itself (#3883, see
//! [`super::relaunch_auto`]) or on **Resume**. The secret lives only in the
//! in-memory connection settings of the relaunch; it is never written to the
//! transfer record.
//!
//! [`SessionManager::sessions_for_saved_connection`]: crate::session::manager::SessionManager::sessions_for_saved_connection

use std::sync::Arc;

use serde_json::Value;
use termihub_core::backends::ssh::{parse_ssh_settings, SftpFileBrowser};
use termihub_core::config::SshConfig;
use tracing::warn;

use super::relaunch_session::SessionTarget;
use crate::connection::config::SavedConnection;
use crate::connection::jump_host_resolver::resolve_credential;
use crate::credential::{CredentialStore, CredentialStoreStatus};
use crate::utils::errors::TerminalError;

/// The reason a relaunched transfer stays paused when its secret cannot be
/// re-sourced without the user.
pub(crate) const NEEDS_CREDENTIALS: &str = "Needs credentials — open the connection to resume";

/// Why a relaunch could not get a connection for its transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RelaunchBlocked {
    /// The secret cannot be resolved unattended (store locked, or nothing
    /// stored): the row stays paused with [`NEEDS_CREDENTIALS`].
    NeedsCredentials,
    /// An agent-hosted transfer's session is not live yet — typically after a
    /// restart, before the user reconnects the agent (#4114): the row stays
    /// paused with [`AGENT_SESSION_UNAVAILABLE`](super::relaunch_agent::AGENT_SESSION_UNAVAILABLE)
    /// and resumes by itself once a matching agent session opens.
    AgentSessionUnavailable,
    /// A graphical side-channel transfer's VNC session is not open (or its
    /// file channel is not ready) yet — typically after a restart, before the
    /// user reopens the connection (#4205): the row stays paused with
    /// [`GRAPHICAL_SESSION_UNAVAILABLE`](super::relaunch_graphical::GRAPHICAL_SESSION_UNAVAILABLE)
    /// and resumes by itself once a session of that connection is active.
    GraphicalSessionUnavailable,
    /// Anything else (the connection is gone, unreachable, …): the row fails
    /// with this message, and **Retry** runs the relaunch again.
    Failed(String),
}

impl RelaunchBlocked {
    /// The user-facing message for the row.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::NeedsCredentials => NEEDS_CREDENTIALS.to_string(),
            Self::AgentSessionUnavailable => {
                super::relaunch_agent::AGENT_SESSION_UNAVAILABLE.to_string()
            }
            Self::GraphicalSessionUnavailable => {
                super::relaunch_graphical::GRAPHICAL_SESSION_UNAVAILABLE.to_string()
            }
            Self::Failed(message) => message.clone(),
        }
    }
}

/// Why a saved connection's secret could not be resolved unattended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unresolved {
    /// The credential store is locked; a relaunch never unlocks it.
    StoreLocked,
    /// No secret is stored for the connection.
    NotStored,
}

/// A saved connection with the owner id its per-connection secrets are
/// stored under (scoped to its external file, #3591).
pub(crate) struct SavedSource {
    pub connection: SavedConnection,
    pub owner: Option<String>,
}

/// What a relaunch reads from the running app — abstracted so the resolution
/// order is testable with a mock credential store and fake sessions.
pub(crate) trait RelaunchSources {
    /// The executor behind the live session `session_id`.
    async fn live_target(&self, session_id: &str) -> Result<SessionTarget, TerminalError>;
    /// The live sessions opened for the saved connection `connection_id`.
    async fn sessions_for_saved_connection(&self, connection_id: &str) -> Vec<String>;
    /// The saved connection `connection_id` names.
    fn saved_connection(&self, connection_id: &str) -> Result<SavedSource, String>;
    /// The desktop credential store.
    fn credential_store(&self) -> &dyn CredentialStore;
    /// Whether the private key at `key_path` is passphrase-protected (an
    /// unreadable key counts as protected).
    fn key_is_encrypted(&self, key_path: &str) -> bool;
    /// Expand saved-connection jump-host references to inline hops (#940).
    fn resolve_jump_hosts(&self, settings: &mut Value, connection_id: &str) -> Result<(), String>;
    /// Open an SFTP connection that never prompts (#3527).
    async fn connect_sftp(&self, config: SshConfig) -> Result<Arc<SftpFileBrowser>, String>;
}

/// Resolve the executor a relaunched download/upload runs on: the live
/// session, a reopened session of its saved connection, or the saved
/// connection with its secret from the store (see the module docs).
pub(crate) async fn resolve_session_target(
    src: &impl RelaunchSources,
    session_id: &str,
    saved_connection_id: Option<&str>,
) -> Result<SessionTarget, RelaunchBlocked> {
    let live_err = match src.live_target(session_id).await {
        Ok(target) => return Ok(target),
        Err(e) => e,
    };
    let Some(connection_id) = saved_connection_id else {
        return Err(RelaunchBlocked::Failed(format!(
            "Cannot resume: session unavailable ({live_err})"
        )));
    };
    for reopened in src.sessions_for_saved_connection(connection_id).await {
        if let Ok(target) = src.live_target(&reopened).await {
            return Ok(target);
        }
    }
    saved_target(src, connection_id).await
}

/// Resolve one end of a relaunched remote-to-remote copy, which must be SFTP.
pub(crate) async fn resolve_sftp_endpoint(
    src: &impl RelaunchSources,
    session_id: &str,
    saved_connection_id: Option<&str>,
) -> Result<Arc<SftpFileBrowser>, RelaunchBlocked> {
    match resolve_session_target(src, session_id, saved_connection_id).await? {
        SessionTarget::Sftp(browser) => Ok(browser),
        #[cfg(feature = "ftp")]
        SessionTarget::Ftp(_) => Err(RelaunchBlocked::Failed(
            "Cannot resume: a remote-to-remote copy needs SFTP on both ends".to_string(),
        )),
    }
}

/// Build the executor for the saved connection `connection_id`, with its
/// secret re-sourced from the store.
async fn saved_target(
    src: &impl RelaunchSources,
    connection_id: &str,
) -> Result<SessionTarget, RelaunchBlocked> {
    let SavedSource { connection, owner } = src
        .saved_connection(connection_id)
        .map_err(|e| RelaunchBlocked::Failed(format!("Cannot resume: {e}")))?;
    let mut settings = unattended_settings(
        &connection,
        owner.as_deref(),
        src.credential_store(),
        |path| src.key_is_encrypted(path),
    )
    .map_err(|_| RelaunchBlocked::NeedsCredentials)?;
    match connection.config.type_id.as_str() {
        "ssh" => {
            src.resolve_jump_hosts(&mut settings, connection_id)
                .map_err(|e| RelaunchBlocked::Failed(format!("Cannot resume: {e}")))?;
            let config = parse_ssh_settings(&settings).expand();
            src.connect_sftp(config)
                .await
                .map(SessionTarget::Sftp)
                .map_err(|e| {
                    RelaunchBlocked::Failed(format!("Cannot resume: could not connect ({e})"))
                })
        }
        #[cfg(feature = "ftp")]
        "ftp" => serde_json::from_value::<termihub_core::config::FtpConfig>(settings)
            .map(|config| SessionTarget::Ftp(config.expand()))
            .map_err(|e| {
                RelaunchBlocked::Failed(format!("Cannot resume: invalid FTP settings ({e})"))
            }),
        other => Err(RelaunchBlocked::Failed(format!(
            "Cannot resume: '{other}' connections do not support file transfers"
        ))),
    }
}

/// The connection settings of `conn` with the secret its connect needs
/// resolved from `creds`, without prompting (#3876).
///
/// Which secret is needed follows the connect flow: SSH password auth needs
/// its password, key auth a passphrase only when the key is encrypted, agent
/// auth nothing; FTP needs its password unless it logs in anonymously. An
/// inline password is already the secret. The store is read only while it is
/// unlocked. The returned settings exist only in memory for the relaunch.
pub(crate) fn unattended_settings(
    conn: &SavedConnection,
    owner: Option<&str>,
    creds: &dyn CredentialStore,
    key_is_encrypted: impl Fn(&str) -> bool,
) -> Result<Value, Unresolved> {
    let mut settings = conn.config.settings.clone();
    let Some(auth_method) = needed_secret(&conn.config.type_id, &settings, key_is_encrypted) else {
        return Ok(settings);
    };
    if creds.status() == CredentialStoreStatus::Locked {
        return Err(Unresolved::StoreLocked);
    }
    match resolve_credential(&conn.id, owner, &settings, auth_method, creds) {
        Ok(Some(secret)) if !secret.is_empty() => {
            if let Some(obj) = settings.as_object_mut() {
                obj.insert("password".into(), Value::String(secret));
            }
            Ok(settings)
        }
        Ok(_) => Err(Unresolved::NotStored),
        Err(e) => {
            warn!(connection_id = %conn.id, error = %e, "Could not read a relaunch credential");
            Err(Unresolved::NotStored)
        }
    }
}

/// The auth method whose secret a connect of these settings needs
/// (`"password"` or `"key"`, as [`resolve_credential`] takes it), or `None`
/// when it needs none.
pub(crate) fn needed_secret(
    type_id: &str,
    settings: &Value,
    key_is_encrypted: impl Fn(&str) -> bool,
) -> Option<&'static str> {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).unwrap_or("");
    if !text("password").is_empty() {
        return None;
    }
    if type_id == "ftp" {
        let anonymous = settings.get("anonymous").and_then(Value::as_bool) == Some(true);
        return (!anonymous).then_some("password");
    }
    match text("authMethod") {
        "password" => Some("password"),
        "key" if key_is_encrypted(text("keyPath")) => Some("key"),
        _ => None,
    }
}

#[cfg(test)]
#[path = "relaunch_credentials_tests.rs"]
mod tests;
