//! Agent-side unattended connects (#3877), driven against an in-process SSH
//! server on a loopback TCP port so the real `ssh` connection type runs its
//! real handshake, host-key check and authentication — exactly the code a
//! session daemon or an in-process session runs through [`connect`].
//!
//! Every path that would need the desktop fails fast with its typed kind, and
//! nothing is ever relayed to a prompter: no prompter is registered here, and
//! an unattended connect must not need one.

use super::*;

use std::borrow::Cow;
use std::sync::{Arc, Mutex, OnceLock};

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Response, Session};
use russh::{Channel, MethodKind, MethodSet};
use termihub_core::backends::ssh::host_key::{
    fingerprint_sha256, host_key_verifier, set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    KnownHostsStatus,
};
use termihub_core::errors::ConnectFailureKind;

/// The password the test server's first keyboard-interactive round accepts.
const PASSWORD: &str = "hunter2";

/// A passphrase-protected OpenSSH ed25519 key (passphrase `test-passphrase`),
/// generated with `ssh-keygen` for these tests only.
const ENCRYPTED_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABDz+qoxRm
PRuT9RT+9nY3kKAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIEsXaGR99x2rYAVH
8Hw7/9v0HmirT1qZiqc6Ra2ZUKepAAAAoGyTgSPczR6S6nfJOKMR+46phR7Zl6ODz34tzi
NMiyjsy8QU/ijez0gwQ6/bprtmUtpw04UPPlLxAw1qRH6Smb65jCIkQWAL/CSxS3l5cBPl
Yf8Xbz1lqDO+8W4yxlk6j5mMu81CK4jWG6yogLfwxDi6fbuXSdqj4Z5l2POC316MIaLXK+
KAIjHsGOT4hxy4zo0ITbSG7fXX+BK1Ou973wY=
-----END OPENSSH PRIVATE KEY-----
";

fn ed25519(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}

/// The host key of a server the test verifier trusts.
fn trusted_host_key() -> PrivateKey {
    ed25519(31)
}

/// The host key of a server nobody has trusted yet.
fn untrusted_host_key() -> PrivateKey {
    ed25519(32)
}

/// The client key the server accepts for key auth.
fn client_key() -> PrivateKey {
    ed25519(33)
}

/// Trusts exactly [`trusted_host_key`] (plus, like the headless default, a key
/// recorded in `~/.ssh/known_hosts`) — attended and unattended alike.
struct TrustTestServer {
    fingerprint: String,
}

#[async_trait::async_trait]
impl HostKeyVerifier for TrustTestServer {
    async fn verify(&self, info: &HostKeyInfo) -> bool {
        self.trusts(info)
    }

    async fn verify_unattended(&self, info: &HostKeyInfo) -> bool {
        self.trusts(info)
    }
}

impl TrustTestServer {
    fn trusts(&self, info: &HostKeyInfo) -> bool {
        info.fingerprint == self.fingerprint || info.known_hosts == KnownHostsStatus::Match
    }
}

/// Register [`TrustTestServer`] as the process-wide verifier, and assert that
/// it is the one in force.
///
/// The verifier is a set-once process global, so a test that registered a
/// different one first would make these tests observe the wrong policy. They
/// used to skip in that case, which made them order-dependent: the agent-hosted
/// tunnel E2E tests registered a trust-all verifier in this same binary, and
/// whichever ran first won (#4288, TBE2-001). Those tests now run in their own
/// binary (`agent/tests/tunnel_integration.rs`), and a foreign verifier here is
/// a failure, never a skip.
fn install_verifier() {
    static OURS: OnceLock<Arc<dyn HostKeyVerifier>> = OnceLock::new();
    let ours = OURS.get_or_init(|| {
        let verifier: Arc<dyn HostKeyVerifier> = Arc::new(TrustTestServer {
            fingerprint: fingerprint_sha256(trusted_host_key().public_key()),
        });
        let _ = set_host_key_verifier(Arc::clone(&verifier));
        verifier
    });
    let active = host_key_verifier().expect("a host-key verifier is registered");
    assert!(
        Arc::ptr_eq(&active, ours),
        "another host-key verifier is registered in this process; the unattended \
         tests must own the process-wide verifier (#4288)"
    );
}

/// Regression for #4288: the verifier the unattended tests install is the one
/// in force, whatever order the tests run in.
#[test]
fn install_verifier_owns_the_process_wide_verifier() {
    install_verifier();
    install_verifier();
}

/// What the test server saw, for assertions.
#[derive(Default)]
struct Observed {
    /// Keyboard-interactive answers, per round.
    ki_answers: Vec<Vec<String>>,
    /// Whether a shell was requested (the connect completed).
    shell: bool,
}

#[derive(Clone)]
struct Server {
    observed: Arc<Mutex<Observed>>,
    client_key: PublicKey,
    round: usize,
}

fn ki_round(prompt: &str) -> Auth {
    Auth::Partial {
        name: Cow::Borrowed(""),
        instructions: Cow::Borrowed(""),
        prompts: Cow::Owned(vec![(Cow::Owned(prompt.to_string()), false)]),
    }
}

fn methods(kinds: &[MethodKind]) -> MethodSet {
    MethodSet::from(kinds)
}

impl russh::server::Handler for Server {
    type Error = russh::Error;

    /// `PasswordAuthentication no`: keyboard-interactive or a key instead.
    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Reject {
            proceed_with_methods: Some(methods(&[
                MethodKind::KeyboardInteractive,
                MethodKind::PublicKey,
            ])),
            partial_success: false,
        })
    }

    async fn auth_publickey(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(if key.key_data() == self.client_key.key_data() {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    /// Round 1 asks the password (the saved one auto-answers it), round 2 a
    /// one-time code — which an unattended connect can never give.
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let Some(response) = response else {
            self.round = 0;
            return Ok(ki_round("Password: "));
        };
        let answers: Vec<String> = response
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .collect();
        self.observed
            .lock()
            .unwrap()
            .ki_answers
            .push(answers.clone());
        self.round += 1;
        Ok(match self.round {
            1 if answers == [PASSWORD] => ki_round("Verification code: "),
            _ => Auth::reject(),
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn shell_request(
        &mut self,
        _channel: russh::ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.observed.lock().unwrap().shell = true;
        Ok(())
    }
}

/// Start the test server with `host_key` on a loopback port.
async fn serve(host_key: PrivateKey) -> (u16, Arc<Mutex<Observed>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let config = Arc::new(russh::server::Config {
        keys: vec![host_key],
        auth_rejection_time: std::time::Duration::ZERO,
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..Default::default()
    });
    let observed = Arc::new(Mutex::new(Observed::default()));
    let server = Server {
        observed: observed.clone(),
        client_key: client_key().public_key().clone(),
        round: 0,
    };
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = config.clone();
            let handler = server.clone();
            tokio::spawn(async move {
                if let Ok(running) = russh::server::run_stream(config, stream, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    (port, observed)
}

fn settings(port: u16, auth: serde_json::Value) -> serde_json::Value {
    let mut settings = serde_json::json!({
        "host": "127.0.0.1",
        "port": port,
        "username": "ops",
        "shellIntegration": false,
    });
    if let (Some(base), Some(extra)) = (settings.as_object_mut(), auth.as_object()) {
        base.extend(extra.clone());
    }
    settings
}

/// Connect a fresh agent `ssh` connection to `port`, unattended or not.
async fn connect_ssh(
    port: u16,
    auth: serde_json::Value,
    unattended: bool,
) -> (Box<dyn ConnectionType>, Result<(), SessionError>) {
    let registry = crate::registry::build_registry();
    let mut connection = registry.create("ssh").expect("ssh type");
    let result = connect(connection.as_mut(), settings(port, auth), unattended).await;
    (connection, result)
}

fn kind(result: &Result<(), SessionError>) -> Option<ConnectFailureKind> {
    match result {
        Ok(()) => panic!("the unattended connect must be refused"),
        Err(e) => crate::ki_prompt::relay::relayed_connect_failure_kind(e),
    }
}

// ── Refusals ─────────────────────────────────────────────────────────

/// A one-time-code round after the auto-answered password is refused as
/// `interaction_required` — never relayed to the desktop.
#[tokio::test]
async fn unattended_otp_round_is_interaction_required() {
    install_verifier();
    let (port, observed) = serve(trusted_host_key()).await;
    let (_conn, result) = connect_ssh(
        port,
        serde_json::json!({"authMethod": "password", "password": PASSWORD}),
        true,
    )
    .await;
    assert_eq!(kind(&result), Some(ConnectFailureKind::InteractionRequired));
    let observed = observed.lock().unwrap();
    assert_eq!(
        observed.ki_answers,
        vec![vec![PASSWORD.to_string()]],
        "only the saved password is sent; the OTP round is never answered"
    );
    assert!(!observed.shell);
}

/// A host key that is not trusted yet is refused as `host_key_untrusted`
/// before any credential is sent.
#[tokio::test]
async fn unattended_untrusted_host_key_is_refused() {
    install_verifier();
    let (port, observed) = serve(untrusted_host_key()).await;
    let (_conn, result) = connect_ssh(
        port,
        serde_json::json!({"authMethod": "password", "password": PASSWORD}),
        true,
    )
    .await;
    assert_eq!(kind(&result), Some(ConnectFailureKind::HostKeyUntrusted));
    assert!(observed.lock().unwrap().ki_answers.is_empty());
}

/// Password auth with no stored password never sends an empty one: it is
/// refused as `interaction_required`.
#[tokio::test]
async fn unattended_missing_password_is_interaction_required() {
    install_verifier();
    let (port, observed) = serve(trusted_host_key()).await;
    let (_conn, result) =
        connect_ssh(port, serde_json::json!({"authMethod": "password"}), true).await;
    assert_eq!(kind(&result), Some(ConnectFailureKind::InteractionRequired));
    assert!(observed.lock().unwrap().ki_answers.is_empty());
}

/// An encrypted key with no stored passphrase is refused as
/// `interaction_required` instead of asking for the passphrase.
#[tokio::test]
async fn unattended_missing_passphrase_is_interaction_required() {
    install_verifier();
    let dir = tempfile::tempdir().expect("tempdir");
    let key_path = dir.path().join("id_ed25519");
    std::fs::write(&key_path, ENCRYPTED_KEY).expect("write key");
    let (port, observed) = serve(trusted_host_key()).await;
    let (_conn, result) = connect_ssh(
        port,
        serde_json::json!({"authMethod": "key", "keyPath": key_path.to_string_lossy()}),
        true,
    )
    .await;
    assert_eq!(kind(&result), Some(ConnectFailureKind::InteractionRequired));
    assert!(!observed.lock().unwrap().shell);
}

// ── Success ──────────────────────────────────────────────────────────

/// Key auth with an unencrypted key needs nobody: the unattended connect
/// completes and opens the shell.
#[tokio::test]
async fn unattended_key_auth_connects() {
    install_verifier();
    let dir = tempfile::tempdir().expect("tempdir");
    let key_path = dir.path().join("id_ed25519");
    let pem = client_key()
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .expect("encode key");
    std::fs::write(&key_path, pem.as_bytes()).expect("write key");
    let (port, observed) = serve(trusted_host_key()).await;
    let (mut conn, result) = connect_ssh(
        port,
        serde_json::json!({"authMethod": "key", "keyPath": key_path.to_string_lossy()}),
        true,
    )
    .await;
    result.expect("key auth connects unattended");
    // The shell request is fire-and-forget (`want_reply = false`): wait for
    // the server to see it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !observed.lock().unwrap().shell && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(observed.lock().unwrap().shell, "the shell was opened");
    let _ = conn.disconnect().await;
}

/// The env handoff to a session daemon: only `"1"` means unattended, and an
/// attended launch explicitly clears an inherited value.
#[test]
fn daemon_env_handoff() {
    assert!(parse(Some("1")));
    assert!(!parse(None));
    assert!(!parse(Some("")));
    assert!(!parse(Some("true")));

    let mut command = std::process::Command::new("termihub-agent");
    export(&mut command, true);
    assert!(command
        .get_envs()
        .any(|(k, v)| k == UNATTENDED_ENV && v == Some("1".as_ref())));

    let mut command = std::process::Command::new("termihub-agent");
    export(&mut command, false);
    assert!(command
        .get_envs()
        .any(|(k, v)| k == UNATTENDED_ENV && v.is_none()));
}
