//! Tests for the app side of relaunching a session transfer after a restart
//! (#5161, COV-003).
//!
//! [`super::relaunch_credentials`] tests the resolution *order* against a
//! fully fake [`RelaunchSources`]. These tests drive the real [`AppSources`]
//! instead — a real [`SessionManager`] (no live sessions, or ones that are not
//! connected, exactly as after a restart) and a real [`ConnectionManager`]
//! over a temp dir with an in-memory credential store — and the real
//! executors behind [`run_session_target`], against the embedded FTP server
//! on loopback. Every case asserts the data-safety invariant of a relaunch: it
//! never resumes into, truncates or overwrites a file it cannot vouch for, and
//! a relaunch that cannot get a connection fails closed (paused or failed)
//! without prompting and without touching the transfer's files.

// The executor fixtures serve the FTP cases; a build without `ftp` keeps them unused.
#![cfg_attr(not(feature = "ftp"), allow(dead_code, unused_imports))]

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use termihub_core::config::SshConfig;
use termihub_core::embedded_servers::config::{EmbeddedServerConfig, FtpAuth, ServerType};
use termihub_core::embedded_servers::service::EmbeddedServerService;

use super::*;
use crate::connection::config::SavedConnection;
use crate::connection::recording_credential_store::RecordingStore;
use crate::credential::{CredentialStoreStatus, CredentialType};
use crate::files::transfer::persist::PersistedAgentTarget;
use crate::files::transfer::relaunch_credentials::RelaunchSources;
use crate::files::transfer::{TransferPhase, TransferProgress, TransferStateTag};
use crate::network::test_support::FakeAgent;
use crate::terminal::backend::ConnectionConfig;
use termihub_core::connection::ConnectionTypeRegistry;

// ── Fixtures ───────────────────────────────────────────────────────

/// The app after a restart: no live sessions, the saved connections in
/// `dir`, and an in-memory credential store the test can seed and inspect.
struct App {
    manager: SessionManager,
    connections: ConnectionManager,
    store: Arc<RecordingStore>,
    _dir: tempfile::TempDir,
}

impl App {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(RecordingStore::default());
        let connections =
            ConnectionManager::new_for_test(dir.path(), store.clone()).expect("connections");
        Self {
            manager: SessionManager::new(
                ConnectionTypeRegistry::new(),
                Arc::new(FakeAgent::default()),
            ),
            connections,
            store,
            _dir: dir,
        }
    }

    fn sources(&self) -> AppSources<'_> {
        AppSources {
            manager: &self.manager,
            connections: Some(&self.connections),
        }
    }

    /// Save `conn`; returns the id it is stored under.
    fn save(&self, conn: SavedConnection) -> String {
        self.connections.save_connection(conn).expect("save")
    }

    /// Store `secret` for saved connection `id` under its own store key.
    fn store_secret(&self, id: &str, kind: CredentialType, secret: &str) {
        let (_, owner) = self.connections.transfer_connection(id).expect("saved");
        self.store
            .set(&crate::credential::CredentialKey::new(&owner, kind), secret)
            .expect("seed secret");
    }

    fn lock_store(&self) {
        self.store
            .locked
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// A session the user has open again but that is not connected — or, as
    /// after a restart, a stale id bound to the saved connection.
    async fn open_disconnected_session(&self, session_id: &str, connection_id: &str) {
        self.manager
            .insert_test_session(
                session_id,
                Box::new(termihub_core::backends::ftp::Ftp::new()),
            )
            .await;
        self.manager
            .bind_saved_connection(session_id, connection_id)
            .await;
    }
}

fn saved(name: &str, type_id: &str, settings: Value) -> SavedConnection {
    SavedConnection {
        extra: Default::default(),
        icon: None,
        icon_color: None,
        icon_emoji: None,
        id: name.to_string(),
        name: name.to_string(),
        config: ConnectionConfig {
            type_id: type_id.to_string(),
            settings,
        },
        folder_id: None,
        terminal_options: None,
        source_file: None,
    }
}

/// A loopback port nothing listens on (bound, then released).
fn refused_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.local_addr().expect("addr").port()
}

fn ssh_password(name: &str, port: u16) -> SavedConnection {
    saved(
        name,
        "ssh",
        json!({ "host": "127.0.0.1", "port": port, "username": "alice",
                "authMethod": "password", "savePassword": true }),
    )
}

fn ssh_key(name: &str, key_path: &str) -> SavedConnection {
    saved(
        name,
        "ssh",
        json!({ "host": "127.0.0.1", "port": refused_port(), "username": "alice",
                "authMethod": "key", "keyPath": key_path }),
    )
}

#[cfg(feature = "ftp")]
fn ftp(name: &str, anonymous: bool) -> SavedConnection {
    saved(
        name,
        "ftp",
        json!({ "host": "ftp.internal", "port": 21, "username": "alice",
                "anonymous": anonymous, "savePassword": true }),
    )
}

fn blocked<T>(result: Result<T, RelaunchBlocked>) -> RelaunchBlocked {
    match result {
        Ok(_) => panic!("the relaunch must not get a connection"),
        Err(blocked) => blocked,
    }
}

fn failed_message<T>(result: Result<T, RelaunchBlocked>) -> String {
    match blocked(result) {
        RelaunchBlocked::Failed(message) => message,
        other => panic!("expected a Failed row, got {other:?}"),
    }
}

/// Bound every network-facing step so a hang is a test failure, not a stuck run.
async fn bounded<F: std::future::Future>(what: &str, fut: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(30), fut)
        .await
        .unwrap_or_else(|_| panic!("{what} did not settle"))
}

// ── AppSources: what a relaunch reads from the running app ─────────

/// After a restart the persisted session id names nothing; the SFTP
/// resolution error is what surfaces.
#[tokio::test]
async fn a_session_id_from_before_the_restart_is_not_a_live_target() {
    let app = App::new();
    let err = match app.sources().live_target("sess-before-restart").await {
        Ok(_) => panic!("no session is live after a restart"),
        Err(e) => e,
    };
    assert!(!err.to_string().is_empty(), "the row gets a reason");
}

/// A session that is open but neither SFTP- nor FTP-backed (here: not
/// connected) is never used as an executor.
#[tokio::test]
async fn a_session_without_a_transfer_backend_is_not_a_live_target() {
    let app = App::new();
    app.open_disconnected_session("sess-1", "files").await;
    assert!(app.sources().live_target("sess-1").await.is_err());
    assert_eq!(
        app.sources().sessions_for_saved_connection("files").await,
        vec!["sess-1".to_string()],
        "the binding itself is reported"
    );
    assert!(app
        .sources()
        .sessions_for_saved_connection("other")
        .await
        .is_empty());
}

#[test]
fn without_a_connection_manager_only_live_sessions_can_be_used() {
    let manager = SessionManager::new(
        ConnectionTypeRegistry::new(),
        Arc::new(FakeAgent::default()),
    );
    let sources = AppSources {
        manager: &manager,
        connections: None,
    };
    let err = match sources.saved_connection("files") {
        Ok(_) => panic!("no saved connections without a manager"),
        Err(e) => e,
    };
    assert_eq!(err, "saved connections are unavailable");
    assert_eq!(
        sources.credential_store().status(),
        CredentialStoreStatus::Unavailable,
        "the empty store is never mistaken for an unlocked one"
    );
    let mut settings = json!({ "proxyJump": [{ "connectionId": "hop" }] });
    let before = settings.clone();
    sources
        .resolve_jump_hosts(&mut settings, "files")
        .expect("nothing to resolve against");
    assert_eq!(settings, before, "settings untouched");
}

#[test]
fn a_saved_connection_resolves_with_its_store_owner_and_a_deleted_one_fails() {
    let app = App::new();
    let id = app.save(ssh_password("files", 22));
    let source = app.sources().saved_connection(&id).expect("saved");
    assert_eq!(source.connection.id, id);
    assert_eq!(source.owner.as_deref(), Some(id.as_str()));

    assert!(
        app.sources().saved_connection("deleted-since").is_err(),
        "a connection deleted while the app was closed is not found"
    );
}

#[test]
fn the_app_store_is_the_connection_managers_store() {
    let app = App::new();
    assert_eq!(
        app.sources().credential_store().status(),
        CredentialStoreStatus::Unlocked
    );
    app.lock_store();
    assert_eq!(
        app.sources().credential_store().status(),
        CredentialStoreStatus::Locked
    );
}

/// An unreadable key counts as encrypted, so a relaunch asks the store for a
/// passphrase (and pauses without one) rather than connecting with nothing.
#[test]
fn key_encryption_is_detected_and_an_unreadable_key_counts_as_encrypted() {
    let app = App::new();
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("gone");
    assert!(app.sources().key_is_encrypted(&missing.to_string_lossy()));

    let encrypted = dir.path().join("encrypted");
    std::fs::write(
        &encrypted,
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n",
    )
    .unwrap();
    assert!(app.sources().key_is_encrypted(&encrypted.to_string_lossy()));

    let plain = dir.path().join("plain");
    std::fs::write(
        &plain,
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    )
    .unwrap();
    assert!(!app.sources().key_is_encrypted(&plain.to_string_lossy()));
}

/// A saved jump-host chain is expanded to inline hops in order.
#[test]
fn a_jump_host_chain_is_resolved_in_order() {
    let app = App::new();
    let first = app.save(saved(
        "hop-a",
        "ssh",
        json!({ "host": "a.internal", "username": "u", "authMethod": "agent" }),
    ));
    let second = app.save(saved(
        "hop-b",
        "ssh",
        json!({ "host": "b.internal", "username": "u", "authMethod": "agent" }),
    ));
    let root = app.save(ssh_password("files", 22));
    let mut settings = json!({
        "host": "127.0.0.1",
        "proxyJump": [{ "connectionId": first }, { "connectionId": second }],
    });
    app.sources()
        .resolve_jump_hosts(&mut settings, &root)
        .expect("chain resolves");
    let hosts: Vec<&str> = settings["proxyJump"]
        .as_array()
        .expect("inline chain")
        .iter()
        .map(|hop| hop["host"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(hosts, ["a.internal", "b.internal"]);
}

#[test]
fn a_jump_host_deleted_since_the_interruption_fails_the_resolution() {
    let app = App::new();
    let root = app.save(ssh_password("files", 22));
    let mut settings = json!({ "proxyJump": [{ "connectionId": "deleted-hop" }] });
    assert!(app
        .sources()
        .resolve_jump_hosts(&mut settings, &root)
        .is_err());
}

/// The unattended SFTP connect reports a dead host as an error, promptly.
#[tokio::test]
async fn an_unreachable_host_fails_the_unattended_sftp_connect() {
    let app = App::new();
    let config = SshConfig {
        host: "127.0.0.1".to_string(),
        port: refused_port(),
        username: "alice".to_string(),
        ..SshConfig::default()
    };
    let result = bounded("connect", app.sources().connect_sftp(config)).await;
    assert!(result.is_err(), "nothing listens there");
}

// ── resolve_session_target through the real app sources ────────────

#[tokio::test]
async fn a_record_without_a_saved_connection_fails_as_session_unavailable() {
    let app = App::new();
    let message =
        failed_message(resolve_session_target(&app.sources(), "sess-before-restart", None).await);
    assert!(
        message.starts_with("Cannot resume: session unavailable"),
        "{message}"
    );
    assert!(app.store.calls().is_empty(), "the store is never read");
}

#[tokio::test]
async fn a_saved_connection_deleted_since_the_interruption_fails_closed() {
    let app = App::new();
    let message = failed_message(
        resolve_session_target(&app.sources(), "sess-before-restart", Some("deleted")).await,
    );
    assert!(message.starts_with("Cannot resume:"), "{message}");
    assert!(app.store.calls().is_empty(), "no secret is read for it");
}

/// A locked store is never unlocked by a relaunch: the row stays paused, and
/// nothing connects (a connect attempt would have failed the row instead).
#[tokio::test]
async fn a_locked_store_pauses_the_row_without_connecting() {
    let app = App::new();
    let id = app.save(ssh_password("files", refused_port()));
    app.store_secret(&id, CredentialType::Password, "hunter2");
    app.lock_store();
    let result = resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await;
    assert_eq!(blocked(result), RelaunchBlocked::NeedsCredentials);
}

#[tokio::test]
async fn a_password_that_is_not_stored_pauses_the_row() {
    let app = App::new();
    let id = app.save(ssh_password("files", refused_port()));
    let result = resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await;
    assert_eq!(blocked(result), RelaunchBlocked::NeedsCredentials);
}

/// An encrypted (here: unreadable) key without a stored passphrase must fail
/// closed — the relaunch path never prompts for it.
#[tokio::test]
async fn an_encrypted_key_without_a_stored_passphrase_pauses_the_row() {
    let app = App::new();
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("id_ed25519");
    let id = app.save(ssh_key("files", &key.to_string_lossy()));
    let result = resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await;
    assert_eq!(blocked(result), RelaunchBlocked::NeedsCredentials);
}

/// With the secret stored the relaunch connects unattended; a host that is
/// gone fails the row with the connect error, and the store is only read.
#[tokio::test]
async fn a_stored_secret_for_an_unreachable_host_fails_the_row() {
    let app = App::new();
    let id = app.save(ssh_password("files", refused_port()));
    app.store_secret(&id, CredentialType::Password, "hunter2");
    let before = app.store.snapshot();
    let message = failed_message(
        bounded(
            "relaunch",
            resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)),
        )
        .await,
    );
    assert!(
        message.starts_with("Cannot resume: could not connect"),
        "{message}"
    );
    assert!(
        !message.contains("hunter2"),
        "the secret never reaches the row"
    );
    assert_eq!(app.store.snapshot(), before, "the relaunch writes nothing");
}

#[tokio::test]
async fn a_saved_chain_with_a_deleted_jump_host_fails_the_row() {
    let app = App::new();
    let mut conn = ssh_password("files", refused_port());
    conn.config.settings["proxyJump"] = json!([{ "connectionId": "deleted-hop" }]);
    let id = app.save(conn);
    app.store_secret(&id, CredentialType::Password, "hunter2");
    let message = failed_message(
        resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await,
    );
    assert!(message.starts_with("Cannot resume:"), "{message}");
}

#[tokio::test]
async fn a_saved_connection_without_file_transfer_fails_the_row() {
    let app = App::new();
    let id = app.save(saved(
        "shell",
        "telnet",
        json!({ "host": "127.0.0.1", "port": 23 }),
    ));
    let message = failed_message(
        resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await,
    );
    assert!(
        message.contains("do not support file transfers"),
        "{message}"
    );
}

/// The FTP config is recovered from the saved connection, with the password
/// re-sourced from the store into memory only.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn an_ftp_config_is_recovered_with_its_stored_password() {
    let app = App::new();
    let id = app.save(ftp("files", false));
    app.store_secret(&id, CredentialType::Password, "ftp-secret");
    match resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await {
        Ok(SessionTarget::Ftp(config)) => {
            assert_eq!(config.host, "ftp.internal");
            assert_eq!(config.username, "alice");
            assert_eq!(config.password.as_deref(), Some("ftp-secret"));
        }
        Ok(SessionTarget::Sftp(_)) => panic!("an FTP connection resolves to FTP"),
        Err(e) => panic!("expected an FTP target, got {e:?}"),
    }
    let saved = app.connections.transfer_connection(&id).unwrap().0;
    assert!(
        saved.config.settings.get("password").is_none(),
        "the secret is never written back to the saved connection"
    );
}

/// A reopened session of the saved connection that is not connected is
/// skipped; the store path still resumes the row.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn a_disconnected_reopened_session_falls_through_to_the_store() {
    let app = App::new();
    let id = app.save(ftp("files", true));
    app.open_disconnected_session("sess-reopened", &id).await;
    match resolve_session_target(&app.sources(), "sess-before-restart", Some(&id)).await {
        Ok(SessionTarget::Ftp(config)) => assert!(config.anonymous),
        Ok(SessionTarget::Sftp(_)) => panic!("an FTP connection resolves to FTP"),
        Err(e) => panic!("expected an FTP target, got {e:?}"),
    }
    assert!(
        app.store.calls().is_empty(),
        "anonymous FTP needs no secret"
    );
}

// ── resolve_remote_copy ────────────────────────────────────────────

fn end<'a>(session_id: &'a str, saved: Option<&'a str>) -> CopyEnd<'a> {
    CopyEnd {
        session_id,
        saved_connection_id: saved,
        container_id: None,
        agent: None,
    }
}

#[tokio::test]
async fn an_unavailable_source_end_names_the_source() {
    let app = App::new();
    let message = failed_message(
        resolve_remote_copy(&app.sources(), end("src-gone", None), end("dst-gone", None)).await,
    );
    assert!(message.ends_with("(the source of the copy)"), "{message}");
}

#[cfg(feature = "ftp")]
#[tokio::test]
async fn an_ftp_end_of_a_remote_copy_fails_closed() {
    let app = App::new();
    let id = app.save(ftp("files", true));
    let message = failed_message(
        resolve_remote_copy(&app.sources(), end("src", Some(&id)), end("dst", None)).await,
    );
    assert!(message.contains("needs SFTP on both ends"), "{message}");
    assert!(message.ends_with("(the source of the copy)"), "{message}");
}

/// An agent end whose agent is not reconnected yet keeps the row paused — it
/// is not relabelled into a failure.
#[tokio::test]
async fn an_agent_end_not_reconnected_yet_keeps_the_row_paused() {
    let app = App::new();
    let agent = PersistedAgentTarget {
        agent_id: "agent-1".to_string(),
        remote_session_id: "remote-old".to_string(),
        definition_id: Some("def-a".to_string()),
    };
    let src = CopyEnd {
        agent: Some(&agent),
        ..end("src", None)
    };
    let result = resolve_remote_copy(&app.sources(), src, end("dst", None)).await;
    assert_eq!(blocked(result), RelaunchBlocked::AgentSessionUnavailable);
}

/// The ordering rule, with a fake resolver: the source first; the destination
/// is never resolved when the source is unavailable.
#[tokio::test]
async fn the_destination_is_not_resolved_when_the_source_fails() {
    let seen = Mutex::new(Vec::new());
    let result: Result<((), ()), _> = resolve_both_ends("src", "dst", |which| {
        seen.lock().unwrap().push(which);
        async move { Err(RelaunchBlocked::Failed("Cannot resume: gone".to_string())) }
    })
    .await;
    assert_eq!(
        blocked(result),
        RelaunchBlocked::Failed("Cannot resume: gone (the source of the copy)".to_string())
    );
    assert_eq!(*seen.lock().unwrap(), ["src"]);
}

#[tokio::test]
async fn a_failed_destination_end_names_the_destination() {
    let seen = Mutex::new(Vec::new());
    let result = resolve_both_ends("src", "dst", |which| {
        seen.lock().unwrap().push(which);
        async move {
            match which {
                "src" => Ok(1),
                _ => Err(RelaunchBlocked::Failed("Cannot resume: gone".to_string())),
            }
        }
    })
    .await;
    assert_eq!(
        blocked(result),
        RelaunchBlocked::Failed("Cannot resume: gone (the destination of the copy)".to_string())
    );
    assert_eq!(*seen.lock().unwrap(), ["src", "dst"]);
}

#[tokio::test]
async fn a_missing_secret_on_either_end_passes_through_unlabelled() {
    let result = resolve_both_ends("src", "dst", |which| async move {
        match which {
            "src" => Ok(1),
            _ => Err(RelaunchBlocked::NeedsCredentials),
        }
    })
    .await;
    assert_eq!(blocked(result), RelaunchBlocked::NeedsCredentials);

    let both = resolve_both_ends("src", "dst", |which| async move {
        Ok::<_, RelaunchBlocked>(which.len())
    })
    .await;
    assert_eq!(both, Ok((3, 3)));
}

// ── run_session_target: the relaunched executor ────────────────────

/// Deterministic, non-repeating-per-chunk content.
fn content(len: usize, salt: u8) -> Vec<u8> {
    (0..len)
        .map(|i| ((i % 251) as u8).wrapping_add(salt))
        .collect()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A sink recording every emitted progress event.
fn recording_sink() -> (ProgressSink, Arc<Mutex<Vec<TransferProgress>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let rec = events.clone();
    let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
        rec.lock().expect("lock").push(p.clone());
    });
    (sink, events)
}

/// The byte offset the relaunched executor started at: the first
/// `Transferring` event it emitted.
fn started_at(events: &Arc<Mutex<Vec<TransferProgress>>>) -> u64 {
    events
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.phase == TransferPhase::Transferring)
        .map(|p| p.transferred)
        .expect("the executor started transferring")
}

const REMOTE_NAME: &str = "data.bin";
const LOGIN: (&str, &str) = ("relaunch", "relaunch-pw");

/// The embedded FTP server, serving `root` on a loopback port. Stopped on drop.
struct FtpServer {
    service: EmbeddedServerService,
    addr: SocketAddr,
}

impl FtpServer {
    fn start(root: &Path) -> Self {
        let mut service = EmbeddedServerService::new(ServerType::Ftp);
        service
            .start_with(EmbeddedServerConfig {
                id: "relaunch-ftp".to_string(),
                name: "relaunch-ftp".to_string(),
                server_type: ServerType::Ftp,
                root_directory: s(root),
                bind_host: "127.0.0.1".to_string(),
                port: 0,
                auto_start: false,
                read_only: false,
                directory_listing: None,
                ftp_auth: Some(FtpAuth::Credentials {
                    username: LOGIN.0.to_string(),
                    password: LOGIN.1.to_string(),
                }),
                http_auth: None,
                max_transfer_bytes: None,
                max_concurrent_sessions: None,
                extra: Default::default(),
            })
            .expect("embedded FTP server starts");
        let addr = service.local_addr().expect("bound address");
        Self { service, addr }
    }

    #[cfg(feature = "ftp")]
    fn target(&self) -> SessionTarget {
        SessionTarget::Ftp(termihub_core::config::FtpConfig {
            host: self.addr.ip().to_string(),
            port: self.addr.port(),
            username: LOGIN.0.to_string(),
            password: Some(LOGIN.1.to_string()),
            ..termihub_core::config::FtpConfig::default()
        })
    }
}

impl Drop for FtpServer {
    fn drop(&mut self) {
        self.service.shutdown();
    }
}

/// Run `target` as a relaunch does: the handle registered with the persisted
/// `total`, seeded with the persisted source mtime, started from `offset`.
#[allow(clippy::too_many_arguments)]
async fn relaunch(
    target: SessionTarget,
    direction: TransferDirection,
    local: &Path,
    total: u64,
    persisted_mtime: Option<u64>,
    offset: u64,
) -> (Arc<TransferHandle>, Arc<Mutex<Vec<TransferProgress>>>) {
    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "relaunched",
        "sess-before-restart",
        direction,
        REMOTE_NAME,
        &format!("/{REMOTE_NAME}"),
        total,
    );
    handle.set_source_mtime(persisted_mtime);
    let (sink, events) = recording_sink();
    bounded(
        "relaunched transfer",
        run_session_target(
            target,
            direction,
            format!("/{REMOTE_NAME}"),
            s(local),
            handle.clone(),
            registry,
            sink,
            offset,
        ),
    )
    .await;
    (handle, events)
}

/// A server-side source and the mtime a first, interrupted run recorded
/// for it (what `transfers.json` holds after the restart).
#[cfg(feature = "ftp")]
async fn served_source(server: &FtpServer, root: &Path, bytes: &[u8]) -> Option<u64> {
    std::fs::write(root.join(REMOTE_NAME), bytes).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let (handle, _) = relaunch(
        server.target(),
        TransferDirection::Download,
        &scratch.path().join("probe.bin"),
        0,
        None,
        0,
    )
    .await;
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    handle.source_mtime()
}

const LEN: usize = 300 * 1024;
const PARTIAL: usize = 100 * 1024;

/// The happy path: an unchanged source resumes from the checkpoint and the
/// result is byte-identical to the source.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn a_partial_ftp_download_resumes_from_the_checkpoint() {
    let root = tempfile::tempdir().unwrap();
    let server = FtpServer::start(root.path());
    let source = content(LEN, 0);
    let mtime = served_source(&server, root.path(), &source).await;

    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join(REMOTE_NAME);
    std::fs::write(&local, &source[..PARTIAL]).unwrap();
    let (handle, events) = relaunch(
        server.target(),
        TransferDirection::Download,
        &local,
        LEN as u64,
        mtime,
        PARTIAL as u64,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(
        started_at(&events),
        PARTIAL as u64,
        "resumed, not restarted"
    );
    assert_eq!(std::fs::read(&local).unwrap(), source);
}

/// A source rewritten (new size) while the app was closed restarts from
/// zero: the stale partial is replaced, never spliced onto the new content.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn a_source_changed_since_the_interruption_restarts_from_zero() {
    let root = tempfile::tempdir().unwrap();
    let server = FtpServer::start(root.path());
    let stale = content(LEN, 0);
    let mtime = served_source(&server, root.path(), &stale).await;
    let rewritten = content(LEN + 4096, 7);
    std::fs::write(root.path().join(REMOTE_NAME), &rewritten).unwrap();

    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join(REMOTE_NAME);
    std::fs::write(&local, &stale[..PARTIAL]).unwrap();
    let (handle, events) = relaunch(
        server.target(),
        TransferDirection::Download,
        &local,
        LEN as u64,
        mtime,
        PARTIAL as u64,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(started_at(&events), 0, "restarted from zero");
    assert_eq!(std::fs::read(&local).unwrap(), rewritten);
}

/// The local partial was deleted while the app was closed: resuming at the
/// checkpoint would land a file missing its first bytes. It must not.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn a_deleted_local_partial_never_lands_a_file_missing_its_prefix() {
    let root = tempfile::tempdir().unwrap();
    let server = FtpServer::start(root.path());
    let source = content(LEN, 0);
    let mtime = served_source(&server, root.path(), &source).await;

    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join(REMOTE_NAME);
    let (handle, _) = relaunch(
        server.target(),
        TransferDirection::Download,
        &local,
        LEN as u64,
        mtime,
        PARTIAL as u64,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(
        std::fs::read(&local).unwrap(),
        source,
        "the landed file is whole, never missing the checkpoint's prefix"
    );
}

/// The local partial was truncated (shorter than the checkpoint): the
/// result must still be byte-identical to the source.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn a_local_partial_shorter_than_the_checkpoint_never_lands_a_gap() {
    let root = tempfile::tempdir().unwrap();
    let server = FtpServer::start(root.path());
    let source = content(LEN, 0);
    let mtime = served_source(&server, root.path(), &source).await;

    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join(REMOTE_NAME);
    std::fs::write(&local, &source[..PARTIAL / 2]).unwrap();
    let (handle, _) = relaunch(
        server.target(),
        TransferDirection::Download,
        &local,
        LEN as u64,
        mtime,
        PARTIAL as u64,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(
        std::fs::read(&local).unwrap(),
        source,
        "the landed file is whole, never missing the checkpoint's prefix"
    );
}

/// An upload relaunched from its checkpoint maps to the FTP upload direction
/// and completes the remote file byte-identically.
#[cfg(feature = "ftp")]
#[tokio::test]
async fn a_partial_ftp_upload_resumes_into_the_remote_file() {
    let root = tempfile::tempdir().unwrap();
    let server = FtpServer::start(root.path());
    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join(REMOTE_NAME);
    let source = content(LEN, 3);
    std::fs::write(&local, &source).unwrap();
    std::fs::write(root.path().join(REMOTE_NAME), &source[..PARTIAL]).unwrap();
    let local_mtime = std::fs::metadata(&local)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_nanos()).ok());

    let (handle, _) = relaunch(
        server.target(),
        TransferDirection::Upload,
        &local,
        LEN as u64,
        local_mtime,
        PARTIAL as u64,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(
        std::fs::read(root.path().join(REMOTE_NAME)).unwrap(),
        source
    );
    assert_eq!(
        std::fs::read(&local).unwrap(),
        source,
        "the source is untouched"
    );
}

/// A server that accepts and never greets: the relaunched executor parks in
/// its connect, so a cancel lands *during* the relaunch.
async fn parked_server() -> (u16, tokio::sync::mpsc::UnboundedReceiver<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            held.push(stream);
            let _ = tx.send(());
        }
    });
    (port, rx)
}

/// Cancel a relaunch of `target` once it has connected to the parked server:
/// the row is cancelled exactly once. A cancelled **download** discards its
/// own partial destination (the documented cancel semantics, as for a fresh
/// download — `ftp_fault_03_cancel_removes_partial_download`); a cancelled
/// **upload** never touches its local source.
async fn cancel_during_relaunch(
    target: SessionTarget,
    direction: TransferDirection,
    mut accepted: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join(REMOTE_NAME);
    let partial = content(PARTIAL, 1);
    std::fs::write(&local, &partial).unwrap();
    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "relaunched",
        "sess-before-restart",
        direction,
        REMOTE_NAME,
        "/data.bin",
        LEN as u64,
    );
    let (sink, events) = recording_sink();
    let task = tokio::spawn(run_session_target(
        target,
        direction,
        "/data.bin".to_string(),
        s(&local),
        handle.clone(),
        registry.clone(),
        sink,
        PARTIAL as u64,
    ));
    bounded("connect to the parked server", accepted.recv())
        .await
        .expect("server alive");

    assert!(registry.cancel("relaunched"));
    bounded("cancelled relaunch", task).await.expect("task");

    assert_eq!(handle.state().tag(), TransferStateTag::Cancelled);
    let cancelled = events
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p.phase == TransferPhase::Cancelled)
        .count();
    assert_eq!(cancelled, 1, "exactly one terminal emit");
    match direction {
        TransferDirection::Upload => assert_eq!(
            std::fs::read(&local).unwrap(),
            partial,
            "a cancelled upload relaunch leaves its local source untouched"
        ),
        TransferDirection::Download => assert!(
            !local.exists(),
            "a cancelled download relaunch discards its partial, never leaves a stub"
        ),
    }
}

#[cfg(feature = "ftp")]
#[tokio::test]
async fn cancelling_a_relaunched_ftp_download_discards_only_its_partial() {
    let (port, accepted) = parked_server().await;
    let target = SessionTarget::Ftp(termihub_core::config::FtpConfig {
        host: "127.0.0.1".to_string(),
        port,
        connect_timeout_secs: 120,
        ..termihub_core::config::FtpConfig::default()
    });
    cancel_during_relaunch(target, TransferDirection::Download, accepted).await;
}

#[cfg(feature = "ftp")]
#[tokio::test]
async fn cancelling_a_relaunched_ftp_upload_keeps_the_source() {
    let (port, accepted) = parked_server().await;
    let target = SessionTarget::Ftp(termihub_core::config::FtpConfig {
        host: "127.0.0.1".to_string(),
        port,
        connect_timeout_secs: 120,
        ..termihub_core::config::FtpConfig::default()
    });
    cancel_during_relaunch(target, TransferDirection::Upload, accepted).await;
}

#[tokio::test]
async fn cancelling_a_relaunched_sftp_download_discards_only_its_partial() {
    let (port, accepted) = parked_server().await;
    let target = SessionTarget::Sftp(Arc::new(SftpFileBrowser::new(SshConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "alice".to_string(),
        ..SshConfig::default()
    })));
    cancel_during_relaunch(target, TransferDirection::Download, accepted).await;
}
