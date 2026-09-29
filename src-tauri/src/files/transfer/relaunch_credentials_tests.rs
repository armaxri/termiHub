//! Tests for unattended credential re-sourcing of relaunched transfers (#3876).
//!
//! Every case runs against a mock credential store ([`RecordingStore`]) and a
//! fake set of live sessions, so no server or real store is involved.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use termihub_core::backends::ssh::SftpFileBrowser;
use termihub_core::config::SshConfig;

use super::*;
use crate::connection::config::SavedConnection;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::{CredentialStore, CredentialType};
use crate::files::transfer::relaunch_session::SessionTarget;
use crate::terminal::backend::ConnectionConfig;
use crate::utils::errors::TerminalError;

const PW: CredentialType = CredentialType::Password;
const KEY: CredentialType = CredentialType::KeyPassphrase;

fn saved(id: &str, type_id: &str, settings: Value) -> SavedConnection {
    SavedConnection {
        icon: None,
        id: id.to_string(),
        name: id.to_string(),
        config: ConnectionConfig {
            type_id: type_id.to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

fn ssh_password(id: &str) -> SavedConnection {
    saved(
        id,
        "ssh",
        json!({ "host": "files.internal", "username": "alice", "authMethod": "password",
                "savePassword": true }),
    )
}

fn ssh_key(id: &str) -> SavedConnection {
    saved(
        id,
        "ssh",
        json!({ "host": "files.internal", "username": "alice", "authMethod": "key",
                "keyPath": "/home/alice/.ssh/id_ed25519" }),
    )
}

#[cfg(feature = "ftp")]
fn ftp(id: &str, anonymous: bool) -> SavedConnection {
    saved(
        id,
        "ftp",
        json!({ "host": "ftp.internal", "username": "alice", "anonymous": anonymous,
                "savePassword": true }),
    )
}

/// A fake app: live sessions by id, saved-connection bindings, the saved
/// connections and a mock credential store. Records every SFTP connect.
struct FakeSources {
    live: HashMap<String, SessionTarget>,
    bindings: HashMap<String, Vec<String>>,
    connections: HashMap<String, SavedConnection>,
    store: RecordingStore,
    key_encrypted: bool,
    connects: Mutex<Vec<SshConfig>>,
    connect_error: Option<String>,
}

impl FakeSources {
    fn new(store: RecordingStore) -> Self {
        Self {
            live: HashMap::new(),
            bindings: HashMap::new(),
            connections: HashMap::new(),
            store,
            key_encrypted: false,
            connects: Mutex::new(Vec::new()),
            connect_error: None,
        }
    }

    fn with_connection(mut self, conn: SavedConnection) -> Self {
        self.connections.insert(conn.id.clone(), conn);
        self
    }

    fn with_live_sftp(mut self, session_id: &str, host: &str) -> Self {
        let config = SshConfig {
            host: host.to_string(),
            ..SshConfig::default()
        };
        self.live.insert(
            session_id.to_string(),
            SessionTarget::Sftp(Arc::new(SftpFileBrowser::new(config))),
        );
        self
    }

    fn with_binding(mut self, connection_id: &str, session_id: &str) -> Self {
        self.bindings
            .entry(connection_id.to_string())
            .or_default()
            .push(session_id.to_string());
        self
    }

    fn connects(&self) -> Vec<SshConfig> {
        self.connects.lock().unwrap().clone()
    }

    fn store_reads(&self) -> usize {
        self.store
            .calls()
            .iter()
            .filter(|c| c.starts_with("get "))
            .count()
    }
}

impl RelaunchSources for FakeSources {
    async fn live_target(&self, session_id: &str) -> Result<SessionTarget, TerminalError> {
        match self.live.get(session_id) {
            Some(SessionTarget::Sftp(browser)) => Ok(SessionTarget::Sftp(browser.clone())),
            #[cfg(feature = "ftp")]
            Some(SessionTarget::Ftp(config)) => Ok(SessionTarget::Ftp(config.clone())),
            None => Err(TerminalError::SessionNotFound(session_id.to_string())),
        }
    }

    async fn sessions_for_saved_connection(&self, connection_id: &str) -> Vec<String> {
        self.bindings
            .get(connection_id)
            .cloned()
            .unwrap_or_default()
    }

    fn saved_connection(&self, connection_id: &str) -> Result<SavedSource, String> {
        self.connections
            .get(connection_id)
            .cloned()
            .map(|connection| SavedSource {
                owner: Some(connection.id.clone()),
                connection,
            })
            .ok_or_else(|| format!("saved connection '{connection_id}' not found"))
    }

    fn credential_store(&self) -> &dyn CredentialStore {
        &self.store
    }

    fn key_is_encrypted(&self, _key_path: &str) -> bool {
        self.key_encrypted
    }

    fn resolve_jump_hosts(
        &self,
        _settings: &mut Value,
        _connection_id: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    async fn connect_sftp(&self, config: SshConfig) -> Result<Arc<SftpFileBrowser>, String> {
        self.connects.lock().unwrap().push(config.clone());
        match &self.connect_error {
            Some(e) => Err(e.clone()),
            None => Ok(Arc::new(SftpFileBrowser::new(config))),
        }
    }
}

fn locked(store: RecordingStore) -> RecordingStore {
    store
        .locked
        .store(true, std::sync::atomic::Ordering::SeqCst);
    store
}

// --- the live session is preferred ------------------------------------------

/// The original session is still connected: it is used as-is, and the
/// credential store is never read even though it holds the password.
#[tokio::test]
async fn a_live_session_is_preferred_over_the_store() {
    let src = FakeSources::new(RecordingStore::with(&[("conn-a", PW, "hunter2")]))
        .with_connection(ssh_password("conn-a"))
        .with_live_sftp("sess-old", "live.internal");

    let target = resolve_session_target(&src, "sess-old", Some("conn-a"))
        .await
        .expect("live session resolves");

    assert!(matches!(target, SessionTarget::Sftp(_)));
    assert_eq!(src.store_reads(), 0, "the store is not consulted");
    assert!(src.connects().is_empty(), "no new connection is opened");
}

/// After a restart the original session id is gone, but the user reopened the
/// same saved connection: its new live session is used, not the store.
#[tokio::test]
async fn a_reopened_session_of_the_same_connection_is_preferred_over_the_store() {
    let src = FakeSources::new(RecordingStore::with(&[("conn-a", PW, "hunter2")]))
        .with_connection(ssh_password("conn-a"))
        .with_live_sftp("sess-new", "live.internal")
        .with_binding("conn-a", "sess-new");

    let target = resolve_session_target(&src, "sess-old", Some("conn-a"))
        .await
        .expect("the reopened session resolves");

    assert!(matches!(target, SessionTarget::Sftp(_)));
    assert_eq!(src.store_reads(), 0);
    assert!(src.connects().is_empty());
}

// --- resolved from the store ------------------------------------------------

/// No live session: the SFTP password comes from the unlocked store and the
/// relaunch connects with it, so the resume goes ahead.
#[tokio::test]
async fn an_sftp_password_resolved_from_the_store_resumes() {
    let src = FakeSources::new(RecordingStore::with(&[("conn-a", PW, "hunter2")]))
        .with_connection(ssh_password("conn-a"));

    let target = resolve_session_target(&src, "sess-old", Some("conn-a"))
        .await
        .expect("resolved from the store");

    assert!(matches!(target, SessionTarget::Sftp(_)));
    let connects = src.connects();
    assert_eq!(connects.len(), 1, "one unattended connect");
    assert_eq!(connects[0].host, "files.internal");
    assert_eq!(connects[0].password.as_deref(), Some("hunter2"));
}

/// An encrypted key's passphrase is read from the store under its own type.
#[tokio::test]
async fn a_key_passphrase_resolved_from_the_store_resumes() {
    let mut src = FakeSources::new(RecordingStore::with(&[("conn-k", KEY, "open sesame")]))
        .with_connection(ssh_key("conn-k"));
    src.key_encrypted = true;

    resolve_session_target(&src, "sess-old", Some("conn-k"))
        .await
        .expect("resolved from the store");

    assert_eq!(src.connects()[0].password.as_deref(), Some("open sesame"));
}

/// An unencrypted key needs no secret at all: the relaunch connects without
/// reading the store.
#[tokio::test]
async fn an_unencrypted_key_resumes_without_a_stored_secret() {
    let src = FakeSources::new(RecordingStore::default()).with_connection(ssh_key("conn-k"));

    resolve_session_target(&src, "sess-old", Some("conn-k"))
        .await
        .expect("no secret needed");

    assert_eq!(src.store_reads(), 0);
    assert_eq!(src.connects().len(), 1);
    assert_eq!(src.connects()[0].password, None);
}

/// An FTP password resolved from the store ends up in the FTP settings the
/// relaunched transfer runs on.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn an_ftp_password_resolved_from_the_store_resumes() {
    let src = FakeSources::new(RecordingStore::with(&[("conn-f", PW, "ftp-secret")]))
        .with_connection(ftp("conn-f", false));

    let target = resolve_session_target(&src, "sess-old", Some("conn-f"))
        .await
        .expect("resolved from the store");

    match target {
        SessionTarget::Ftp(config) => {
            assert_eq!(config.host, "ftp.internal");
            assert_eq!(config.password.as_deref(), Some("ftp-secret"));
        }
        SessionTarget::Sftp(_) => panic!("expected an FTP target"),
    }
}

/// An anonymous FTP login needs no secret.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn an_anonymous_ftp_connection_resumes_without_the_store() {
    let src =
        FakeSources::new(locked(RecordingStore::default())).with_connection(ftp("conn-f", true));

    let target = resolve_session_target(&src, "sess-old", Some("conn-f"))
        .await
        .expect("anonymous needs nothing");
    assert!(matches!(target, SessionTarget::Ftp(_)));
    assert_eq!(src.store_reads(), 0);
}

// --- paused: store locked / not stored ---------------------------------------

/// A locked store is never unlocked from a background relaunch: the transfer
/// stays paused, needing credentials, and nothing connects.
#[tokio::test]
async fn a_locked_store_pauses_with_a_reason() {
    let src = FakeSources::new(locked(RecordingStore::with(&[("conn-a", PW, "hunter2")])))
        .with_connection(ssh_password("conn-a"));

    let err = resolve_session_target(&src, "sess-old", Some("conn-a"))
        .await
        .err()
        .expect("a locked store cannot resolve");

    assert_eq!(err, RelaunchBlocked::NeedsCredentials);
    assert_eq!(err.message(), NEEDS_CREDENTIALS);
    assert_eq!(src.store_reads(), 0, "a locked store is not read");
    assert!(src.connects().is_empty(), "nothing connects");
}

/// No password saved for the connection: paused, needing credentials.
#[tokio::test]
async fn a_password_that_is_not_stored_pauses_with_a_reason() {
    let src = FakeSources::new(RecordingStore::default()).with_connection(ssh_password("conn-a"));

    let err = resolve_session_target(&src, "sess-old", Some("conn-a"))
        .await
        .err()
        .expect("nothing stored");

    assert_eq!(err, RelaunchBlocked::NeedsCredentials);
    assert!(src.connects().is_empty());
}

/// An encrypted key whose passphrase is not stored: paused, needing credentials.
#[tokio::test]
async fn an_encrypted_key_without_a_stored_passphrase_pauses_with_a_reason() {
    let mut src = FakeSources::new(RecordingStore::default()).with_connection(ssh_key("conn-k"));
    src.key_encrypted = true;

    let err = resolve_session_target(&src, "sess-old", Some("conn-k"))
        .await
        .err()
        .expect("nothing stored");
    assert_eq!(err, RelaunchBlocked::NeedsCredentials);
}

/// An FTP password that is not stored: paused, needing credentials.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn an_ftp_password_that_is_not_stored_pauses_with_a_reason() {
    let src = FakeSources::new(RecordingStore::default()).with_connection(ftp("conn-f", false));

    let err = resolve_session_target(&src, "sess-old", Some("conn-f"))
        .await
        .err()
        .expect("nothing stored");
    assert_eq!(err, RelaunchBlocked::NeedsCredentials);
}

/// A record without a saved-connection reference (started before #3876, or on
/// an unsaved connection) has nothing to re-source from: it fails as before,
/// naming the unavailable session.
#[tokio::test]
async fn a_record_without_a_saved_connection_fails_as_session_unavailable() {
    let src = FakeSources::new(RecordingStore::default());

    let err = resolve_session_target(&src, "sess-old", None)
        .await
        .err()
        .expect("no reference");
    match err {
        RelaunchBlocked::Failed(message) => {
            assert!(message.contains("session unavailable"), "{message}")
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

// --- failures ----------------------------------------------------------------

/// A saved connection that no longer exists fails the row with a message.
#[tokio::test]
async fn a_deleted_saved_connection_fails_with_a_message() {
    let src = FakeSources::new(RecordingStore::default());

    let err = resolve_session_target(&src, "sess-old", Some("gone"))
        .await
        .err()
        .expect("not found");
    match err {
        RelaunchBlocked::Failed(message) => assert!(message.contains("gone"), "{message}"),
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// An unattended connect that fails (unreachable host, untrusted host key, a
/// rejected secret) fails the row with the connect error.
#[tokio::test]
async fn a_failed_unattended_connect_fails_with_the_error() {
    let mut src = FakeSources::new(RecordingStore::with(&[("conn-a", PW, "hunter2")]))
        .with_connection(ssh_password("conn-a"));
    src.connect_error = Some("host key not trusted".to_string());

    let err = resolve_session_target(&src, "sess-old", Some("conn-a"))
        .await
        .err()
        .expect("connect fails");
    match err {
        RelaunchBlocked::Failed(message) => {
            assert!(message.contains("host key not trusted"), "{message}")
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// A saved connection of a type that has no file transfer fails honestly.
#[tokio::test]
async fn a_saved_connection_without_file_transfer_fails() {
    let src = FakeSources::new(RecordingStore::default()).with_connection(saved(
        "conn-t",
        "telnet",
        json!({ "host": "h" }),
    ));

    let err = resolve_session_target(&src, "sess-old", Some("conn-t"))
        .await
        .err()
        .expect("unsupported");
    assert!(matches!(err, RelaunchBlocked::Failed(_)));
}

// --- remote-to-remote endpoints -------------------------------------------

/// Each end of a remote-to-remote copy re-sources on its own: a live source
/// and a destination resolved from the store.
#[tokio::test]
async fn a_remote_copy_endpoint_resolves_from_the_store() {
    let src = FakeSources::new(RecordingStore::with(&[("conn-dst", PW, "dst-secret")]))
        .with_connection(ssh_password("conn-dst"))
        .with_live_sftp("sess-src", "src.internal");

    resolve_sftp_endpoint(&src, "sess-src", None)
        .await
        .expect("live source");
    resolve_sftp_endpoint(&src, "sess-dst", Some("conn-dst"))
        .await
        .expect("destination from the store");
    assert_eq!(src.connects()[0].password.as_deref(), Some("dst-secret"));
}

/// An FTP connection cannot be a remote-to-remote endpoint.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn an_ftp_remote_copy_endpoint_fails() {
    let src = FakeSources::new(RecordingStore::with(&[("conn-f", PW, "ftp-secret")]))
        .with_connection(ftp("conn-f", false));

    let err = resolve_sftp_endpoint(&src, "sess-old", Some("conn-f"))
        .await
        .err()
        .expect("not SFTP");
    assert!(matches!(err, RelaunchBlocked::Failed(_)));
}

// --- the resolved secret stays out of anything persisted ---------------------

/// The unattended settings carry the secret only in memory; the saved
/// connection they were built from is left untouched.
#[test]
fn unattended_settings_leave_the_saved_connection_untouched() {
    let conn = ssh_password("conn-a");
    let store = RecordingStore::with(&[("conn-a", PW, "hunter2")]);

    let settings = unattended_settings(&conn, Some("conn-a"), &store, |_| false).unwrap();

    assert_eq!(settings["password"], "hunter2");
    assert!(conn.config.settings.get("password").is_none());
}

/// A shared named credential (#3557) is resolved instead of the
/// per-connection secret, the same way the connect flow does.
#[test]
fn unattended_settings_follow_a_named_credential() {
    let mut conn = ssh_password("conn-a");
    conn.config.settings["credentialRef"] = json!("bastion");
    let store = RecordingStore::with(&[
        ("conn-a", PW, "stale-own"),
        ("named-credential:bastion", PW, "shared"),
    ]);

    let settings = unattended_settings(&conn, Some("conn-a"), &store, |_| false).unwrap();
    assert_eq!(settings["password"], "shared");
}
