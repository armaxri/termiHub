//! SSH authentication utilities using russh.
//!
//! Provides [`connect_and_authenticate()`] for establishing an authenticated
//! russh session, and [`check_ssh_agent_status()`] for querying SSH agent
//! availability.

use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::config::expand_config_value;
use crate::config::SshConfig;
use crate::errors::SessionError;

use super::handler::{ForwardedChannelRegistry, LivenessWatch, SshSession, TermiHubHandler};
use super::keyboard_interactive::{
    keyboard_interactive_prompter, offers_keyboard_interactive, run_keyboard_interactive,
    KeyboardInteractivePrompter, KiContext, KiMode, AUTH_METHOD_KEYBOARD_INTERACTIVE,
};
use super::legacy_pem;
use super::prompt_clock::timeout_excluding_prompts;

/// Connect to an SSH server, perform handshake, and authenticate.
///
/// Returns an authenticated session handle and a channel registry for
/// remote-port-forward notifications. Most callers only need the handle;
/// the registry is used by [`RemoteForwarder`] and the X11 event loop.
///
/// The connect is bounded by [`SshConfig::connect_timeout`] so an unreachable
/// host fails fast rather than blocking until the OS TCP timeout (#841).
pub async fn connect_and_authenticate(
    config: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    connect_and_authenticate_cancellable(config, None).await
}

/// Like [`connect_and_authenticate`], but additionally abortable via a
/// [`CancellationToken`].
///
/// Cancelling the token (e.g. when a tunnel is stopped mid-connect) aborts the
/// in-flight TCP connect / SSH handshake promptly instead of waiting out the
/// connect timeout or the OS TCP timeout (#841). The whole connect is also
/// bounded by [`SshConfig::connect_timeout`].
pub async fn connect_and_authenticate_cancellable(
    config: &SshConfig,
    cancel: Option<CancellationToken>,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let (session, registry, _liveness) =
        connect_and_authenticate_cancellable_with_liveness(config, cancel).await?;
    Ok((session, registry))
}

/// Like [`connect_and_authenticate_cancellable`], but also returns the native
/// session-[`LivenessWatch`] (#1297) so a tunnel supervisor can observe true
/// session death (transport failure / peer disconnect / keepalive miss) without
/// polling a throwaway channel. Non-tunnel callers use the plain variant, which
/// drops the watch.
pub async fn connect_and_authenticate_cancellable_with_liveness(
    config: &SshConfig,
    cancel: Option<CancellationToken>,
) -> Result<(SshSession, ForwardedChannelRegistry, LivenessWatch), SessionError> {
    let timeout = config.connect_timeout();
    let connect = async {
        // Time the user spends answering a keyboard-interactive prompt does not
        // count against the network connect timeout (#3371).
        timeout_excluding_prompts(timeout, do_connect_and_authenticate(config))
            .await
            .map_err(|_| {
                SessionError::SpawnFailed(format!(
                    "Connection timed out after {}s",
                    timeout.as_secs()
                ))
            })?
    };

    match cancel {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => {
                    Err(SessionError::SpawnFailed("Connection cancelled".to_string()))
                }
                res = connect => res,
            }
        }
        None => connect.await,
    }
}

/// Establish the TCP connection, run the SSH handshake, and authenticate.
///
/// Kept separate so [`connect_and_authenticate_cancellable_with_liveness`] can
/// wrap it in a timeout and an optional cancellation `select!`.
async fn do_connect_and_authenticate(
    config: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry, LivenessWatch), SessionError> {
    let addr = format!("{}:{}", config.host, config.port);

    // Async connect so the surrounding connect timeout / cancellation token can
    // interrupt a hung connect; a blocking std connect would ignore them (#841).
    let tokio_tcp = tokio::net::TcpStream::connect(&addr)
        .await
        // Typed, locale-independent discriminant so consumers classify an
        // unreachable host structurally rather than by matching the "Connection
        // failed" text (I18N-002 / ERR-003).
        .map_err(|e| SessionError::ConnectionFailed(e.to_string()))?;

    // Configure TCP keepalives on the connected socket before the SSH
    // handshake so a half-open transport is torn down promptly. Shared with the
    // telnet backend via `crate::net` to keep the tuning identical (#1123).
    crate::net::enable_tcp_keepalive(&tokio_tcp);

    handshake_and_authenticate(config, tokio_tcp).await
}

/// Run the SSH handshake over an established byte stream and authenticate.
///
/// Shared by the direct-TCP path ([`do_connect_and_authenticate`]) and the
/// jump-host path ([`connect_and_authenticate_over_channel`]). The transport is
/// any async byte stream: a [`tokio::net::TcpStream`] for a direct connection, or
/// a forwarded `direct-tcpip` channel stream for a hop.
async fn handshake_and_authenticate<S>(
    config: &SshConfig,
    stream: S,
) -> Result<(SshSession, ForwardedChannelRegistry, LivenessWatch), SessionError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let russh_config = Arc::new(russh::client::Config {
        // SSH-level keepalives: send every `keepalive_interval` (default 30 s),
        // abort after `keepalive_max_count` unanswered (default 3). Both are
        // configurable per connection (PROD-024) and fall back to the historical
        // defaults when unset, so existing connections are unchanged. On
        // exhaustion russh ends the session task and fires the handler's
        // `disconnected`, which drives the native liveness watch (#1297).
        keepalive_interval: Some(config.keepalive_interval()),
        keepalive_max: config.keepalive_max_count() as usize,
        ..Default::default()
    });

    // Enable agent-channel bridging on this session only when the connection
    // opted into forwarding (#1699). Jump hops build a minimal config with the
    // default (`false`), so a hop never bridges the agent.
    let (handler, registry, liveness) = TermiHubHandler::new_with_forwarding(
        config.host.clone(),
        config.port,
        config.forward_agent,
    );

    let mut session = russh::client::connect_stream(russh_config, stream, handler)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH handshake failed: {e}")))?;

    authenticate(&mut session, config).await?;

    Ok((session, registry, liveness))
}

/// Establish and authenticate an SSH session over an existing forwarded channel.
///
/// The `channel` must be a `direct-tcpip` channel opened on a previous hop's
/// session (via [`channel_open_direct_tcpip`](russh::client::Handle::channel_open_direct_tcpip))
/// targeting the next hop or the final target `host:port`. The russh handshake
/// runs over the channel's byte stream — the same `into_stream()` transport that
/// SFTP, X11, and the tunnel forwarders use. Used by the jump-host connect path.
///
/// Unlike [`connect_and_authenticate_cancellable`], this has **no built-in
/// timeout or cancellation** — a hop that accepts the channel but never speaks
/// SSH would hang. The caller must bound it; the jump-host path does so per hop
/// via `run_hop_step`.
pub async fn connect_and_authenticate_over_channel(
    config: &SshConfig,
    channel: russh::Channel<russh::client::Msg>,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let (session, registry, _liveness) =
        connect_and_authenticate_over_channel_with_liveness(config, channel).await?;
    Ok((session, registry))
}

/// Like [`connect_and_authenticate_over_channel`], but also returns the native
/// session-[`LivenessWatch`] (#1297) for the jump-host tunnel path. Non-tunnel
/// jump-host callers use the plain variant, which drops the watch.
pub async fn connect_and_authenticate_over_channel_with_liveness(
    config: &SshConfig,
    channel: russh::Channel<russh::client::Msg>,
) -> Result<(SshSession, ForwardedChannelRegistry, LivenessWatch), SessionError> {
    handshake_and_authenticate(config, channel.into_stream()).await
}

/// Perform SSH authentication on an already-connected session.
///
/// Runs the configured primary method (`agent` / `key` / `password`, or
/// `keyboard-interactive`), then — when the server asks for more — continues
/// with keyboard-interactive (#3371): as a second factor after a partial
/// success, or as a fallback after a refused password when the server offers
/// it. See [`keyboard_interactive`](super::keyboard_interactive) for the
/// prompt flow and the password auto-answer heuristic.
async fn authenticate(session: &mut SshSession, config: &SshConfig) -> Result<(), SessionError> {
    let prompter = keyboard_interactive_prompter();
    authenticate_with_prompter(session, config, prompter.as_deref()).await
}

/// [`authenticate`] with an explicit keyboard-interactive prompter, generic over
/// the client handler so tests can drive it against an in-process server.
async fn authenticate_with_prompter<H>(
    session: &mut russh::client::Handle<H>,
    config: &SshConfig,
    prompter: Option<&dyn KeyboardInteractivePrompter>,
) -> Result<(), SessionError>
where
    H: russh::client::Handler,
{
    let ki = KiContext {
        host: &config.host,
        port: config.port,
        username: &config.username,
        password: config.password.as_deref().filter(|p| !p.is_empty()),
    };

    let primary = match config.auth_method.as_str() {
        AUTH_METHOD_KEYBOARD_INTERACTIVE => {
            return run_keyboard_interactive(session, &ki, KiMode::Explicit, prompter).await;
        }

        "agent" => authenticate_with_agent(session, &config.username).await?,

        "key" => {
            let key_path_str = config
                .key_path
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("~/.ssh/id_rsa");
            let expanded = expand_config_value(key_path_str);
            let key_path = PathBuf::from(&expanded);
            let passphrase = config.password.as_deref();

            let key_pair = match russh::keys::load_secret_key(&key_path, passphrase) {
                Ok(key) => key,
                // russh 0.61 can't load passphrase-protected legacy-PEM EC keys
                // (its PKCS#5 path assumes RSA); fall back to our own loader.
                Err(orig) => load_legacy_pem_ec_key(&key_path, passphrase, orig)?,
            };

            // For RSA keys, negotiate the strongest hash the server accepts
            // (rsa-sha2-512/256); the choice is ignored for ed25519/ecdsa keys.
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| SessionError::SpawnFailed(format!("Key auth failed: {e}")))?
                .flatten();

            session
                .authenticate_publickey(
                    &config.username,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
                )
                .await
                .map_err(|e| SessionError::SpawnFailed(format!("Key auth failed: {e}")))?
        }

        _ => {
            // Default: password auth.
            let password = config.password.as_deref().unwrap_or("");
            session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| SessionError::SpawnFailed(format!("Password auth failed: {e}")))?
        }
    };

    match continuation_after(&config.auth_method, &primary) {
        Continuation::Done => Ok(()),
        Continuation::KeyboardInteractive(mode) => {
            run_keyboard_interactive(session, &ki, mode, prompter).await
        }
        // Genuine credential rejection (wrong password/passphrase or refused
        // key). Surface the typed, locale-independent discriminant so the
        // frontend can gate the destructive stored-credential discard on the
        // machine-stable signal rather than on English message text (I18N-001).
        // A transport/protocol error *during* the auth exchange is a different
        // failure and keeps its `SpawnFailed` mapping above.
        Continuation::Rejected => Err(SessionError::AuthFailed),
    }
}

/// What to do after the primary auth method returned `result`.
#[derive(Debug, PartialEq, Eq)]
enum Continuation {
    /// Authenticated.
    Done,
    /// Continue with keyboard-interactive in the given mode (#3371).
    KeyboardInteractive(KiMode),
    /// Credentials rejected.
    Rejected,
}

/// Decide whether a primary-method result is final or should continue with
/// keyboard-interactive (#3371).
///
/// - Success → done.
/// - Partial success with keyboard-interactive remaining → second factor.
/// - A refused `password` while the server offers keyboard-interactive →
///   password fallback (PAM / `PasswordAuthentication no`).
/// - Anything else (e.g. a refused key without partial success) → rejected, as
///   before: a key-configured connection never turns into a surprise prompt.
fn continuation_after(auth_method: &str, result: &russh::client::AuthResult) -> Continuation {
    match result {
        russh::client::AuthResult::Success => Continuation::Done,
        russh::client::AuthResult::Failure {
            remaining_methods,
            partial_success,
        } => {
            if !offers_keyboard_interactive(remaining_methods) {
                Continuation::Rejected
            } else if *partial_success {
                Continuation::KeyboardInteractive(KiMode::SecondFactor)
            } else if auth_method != "key" && auth_method != "agent" {
                Continuation::KeyboardInteractive(KiMode::PasswordFallback)
            } else {
                Continuation::Rejected
            }
        }
    }
}

/// Fallback loader for passphrase-protected **legacy-PEM** EC keys.
///
/// russh 0.61's PKCS#5 path decrypts such keys but parses the plaintext only as
/// RSA, so `load_secret_key` fails on a `-----BEGIN EC PRIVATE KEY-----` key.
/// When the file is one of those we decrypt and parse it ourselves; otherwise we
/// surface russh's `original_error` unchanged so unrelated failures keep their
/// message. See [`legacy_pem`].
fn load_legacy_pem_ec_key(
    key_path: &std::path::Path,
    passphrase: Option<&str>,
    original_error: russh::keys::Error,
) -> Result<russh::keys::PrivateKey, SessionError> {
    let fail = || SessionError::SpawnFailed(format!("Failed to load key: {original_error}"));
    let contents = std::fs::read_to_string(key_path).map_err(|_| fail())?;
    if !legacy_pem::is_encrypted_ec_pem(&contents) {
        return Err(fail());
    }
    let passphrase = passphrase.ok_or_else(|| {
        SessionError::SpawnFailed("Encrypted key requires a passphrase".to_string())
    })?;
    legacy_pem::load(&contents, passphrase)
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to load key: {e}")))
}

/// Try each identity offered by the SSH agent until one succeeds (Unix).
#[cfg(unix)]
async fn authenticate_with_agent<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    username: &str,
) -> Result<russh::client::AuthResult, SessionError> {
    let agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH agent connect failed: {e}")))?;
    authenticate_with_agent_client(session, username, agent).await
}

/// Try each identity offered by the SSH agent until one succeeds (Windows OpenSSH named pipe).
#[cfg(windows)]
async fn authenticate_with_agent<H: russh::client::Handler>(
    session: &mut russh::client::Handle<H>,
    username: &str,
) -> Result<russh::client::AuthResult, SessionError> {
    let agent =
        russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("SSH agent connect failed: {e}")))?;
    authenticate_with_agent_client(session, username, agent).await
}

/// Drive public-key authentication using the keys held by a connected SSH agent.
///
/// `russh` 0.61 drives agent auth through [`authenticate_publickey_with`], which
/// signs each challenge via the agent (which implements `Signer`). Certificate
/// identities are skipped — termiHub only authenticates with plain public keys.
#[cfg(any(unix, windows))]
async fn authenticate_with_agent_client<H, S>(
    session: &mut russh::client::Handle<H>,
    username: &str,
    mut agent: russh::keys::agent::client::AgentClient<S>,
) -> Result<russh::client::AuthResult, SessionError>
where
    H: russh::client::Handler,
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use russh::keys::agent::AgentIdentity;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH agent list keys failed: {e}")))?;

    // Negotiate the RSA hash once; ignored for ed25519/ecdsa agent keys.
    let hash_alg = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("Agent auth failed: {e}")))?
        .flatten();

    // With no usable identity the outcome is a plain rejection.
    let mut last = russh::client::AuthResult::Failure {
        remaining_methods: russh::MethodSet::empty(),
        partial_success: false,
    };
    for identity in identities {
        let public_key = match identity {
            AgentIdentity::PublicKey { key, .. } => key,
            _ => continue,
        };
        let result = session
            .authenticate_publickey_with(username, public_key, hash_alg, &mut agent)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Agent auth failed: {e}")))?;
        // Stop on success, and on a partial success: the key was accepted and
        // the server now wants a second factor (#3371).
        if matches!(
            result,
            russh::client::AuthResult::Success
                | russh::client::AuthResult::Failure {
                    partial_success: true,
                    ..
                }
        ) {
            return Ok(result);
        }
        last = result;
    }
    Ok(last)
}

/// SSH agent authentication is not supported on this platform.
#[cfg(not(any(unix, windows)))]
async fn authenticate_with_agent<H: russh::client::Handler>(
    _session: &mut russh::client::Handle<H>,
    _username: &str,
) -> Result<russh::client::AuthResult, SessionError> {
    Err(SessionError::SpawnFailed(
        "SSH agent authentication is not supported on this platform".to_string(),
    ))
}

/// Check whether the SSH agent is running or stopped.
///
/// - **Windows**: tries to open the `openssh-ssh-agent` named pipe.
/// - **Unix**: checks if `SSH_AUTH_SOCK` is set and the socket file exists.
///
/// Returns `"running"` or `"stopped"`.
pub fn check_ssh_agent_status() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::fs::OpenOptions;
        let pipe_path = r"\\.\pipe\openssh-ssh-agent";
        match OpenOptions::new().read(true).open(pipe_path) {
            Ok(_) => "running".to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "stopped".to_string(),
            Err(_) => "running".to_string(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        agent_status_for_sock(std::env::var_os("SSH_AUTH_SOCK"))
    }
}

/// Resolve the agent status from an explicit `SSH_AUTH_SOCK` value (Unix).
///
/// The env-reading core of [`check_ssh_agent_status`]: an unset/empty path is
/// `"stopped"`, a path that exists is `"running"`, and a dangling path is
/// `"stopped"`. Keeping the env read out of this function lets tests exercise
/// each case by value, without mutating the process-global `SSH_AUTH_SOCK` and
/// racing other parallel tests (#2127).
#[cfg(not(target_os = "windows"))]
fn agent_status_for_sock(sock: Option<std::ffi::OsString>) -> String {
    use std::path::Path;
    match sock {
        Some(sock_path) if !sock_path.is_empty() => {
            if Path::new(&sock_path).exists() {
                "running".to_string()
            } else {
                "stopped".to_string()
            }
        }
        _ => "stopped".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Spawn a TCP listener that accepts one connection but never speaks SSH,
    /// so the handshake hangs. Returns the bound port.
    async fn spawn_silent_ssh_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        tokio::spawn(async move {
            // Accept and hold the connection open without sending a banner.
            if let Ok((stream, _)) = listener.accept().await {
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(stream);
            }
        });
        port
    }

    fn silent_config(port: u16, connect_timeout_secs: u64) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".to_string(),
            port,
            username: "tester".to_string(),
            auth_method: "password".to_string(),
            connect_timeout_secs: Some(connect_timeout_secs),
            ..SshConfig::default()
        }
    }

    /// The handshake against a server that never sends a banner must fail within
    /// the configured connect timeout rather than hanging (#841).
    #[tokio::test]
    async fn connect_times_out_on_silent_server() {
        let port = spawn_silent_ssh_server().await;
        let config = silent_config(port, 1);

        let start = Instant::now();
        let result = connect_and_authenticate(&config).await;
        let elapsed = start.elapsed();

        let err = match result {
            Ok(_) => panic!("connect should time out"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("timed out"),
            "unexpected error: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "timeout took too long: {elapsed:?}"
        );
    }

    /// Cancelling the token mid-handshake aborts the connect promptly, well
    /// before the (long) connect timeout would fire (#841).
    #[tokio::test]
    async fn connect_aborts_when_token_cancelled() {
        let port = spawn_silent_ssh_server().await;
        let config = silent_config(port, 30);

        let token = CancellationToken::new();
        let cancel_handle = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_handle.cancel();
        });

        let start = Instant::now();
        let result = connect_and_authenticate_cancellable(&config, Some(token)).await;
        let elapsed = start.elapsed();

        let err = match result {
            Ok(_) => panic!("connect should be cancelled"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("cancelled"),
            "unexpected error: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "cancellation took too long: {elapsed:?}"
        );
    }

    // ── keyboard-interactive continuation (#3371) ─────────────────────

    use crate::backends::ssh::ki_test_server::{
        connect as ki_connect, PasswordPolicy, Round, Script, ScriptedPrompter,
    };

    fn failure(methods: &[russh::MethodKind], partial: bool) -> russh::client::AuthResult {
        russh::client::AuthResult::Failure {
            remaining_methods: russh::MethodSet::from(methods),
            partial_success: partial,
        }
    }

    #[test]
    fn continuation_decisions() {
        use russh::MethodKind::{KeyboardInteractive as Ki, Password, PublicKey};
        assert_eq!(
            continuation_after("password", &russh::client::AuthResult::Success),
            Continuation::Done
        );
        // Second factor after any primary method.
        for method in ["key", "agent", "password"] {
            assert_eq!(
                continuation_after(method, &failure(&[Ki], true)),
                Continuation::KeyboardInteractive(KiMode::SecondFactor),
                "{method}"
            );
        }
        // Refused password with keyboard-interactive offered → fallback.
        assert_eq!(
            continuation_after("password", &failure(&[Password, Ki], false)),
            Continuation::KeyboardInteractive(KiMode::PasswordFallback)
        );
        // A refused key never turns into a surprise prompt.
        assert_eq!(
            continuation_after("key", &failure(&[PublicKey, Ki], false)),
            Continuation::Rejected
        );
        assert_eq!(
            continuation_after("agent", &failure(&[PublicKey, Ki], false)),
            Continuation::Rejected
        );
        // Nothing interactive on offer → plain rejection.
        assert_eq!(
            continuation_after("password", &failure(&[Password], false)),
            Continuation::Rejected
        );
    }

    fn ki_config(auth_method: &str, password: Option<&str>) -> SshConfig {
        SshConfig {
            host: "bastion.test".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_method: auth_method.to_string(),
            password: password.map(str::to_string),
            ..SshConfig::default()
        }
    }

    /// `PasswordAuthentication no` + PAM: the refused password falls back to
    /// keyboard-interactive, the password prompt is auto-answered, and the OTP
    /// is asked of the user.
    #[tokio::test]
    async fn password_falls_back_to_keyboard_interactive_with_otp() {
        let (mut session, observed) = ki_connect(Script {
            rounds: vec![
                Round::new(vec![("Password: ", false)], vec!["hunter2"]),
                Round::new(vec![("Verification code: ", false)], vec!["314159"]),
            ],
            password: PasswordPolicy::Disabled,
        })
        .await;
        let prompter = ScriptedPrompter::new(vec![Some(vec!["314159"])]);

        authenticate_with_prompter(
            &mut session,
            &ki_config("password", Some("hunter2")),
            Some(&prompter),
        )
        .await
        .expect("authenticated");
        assert_eq!(prompter.seen().len(), 1, "only the OTP is prompted");
        assert_eq!(observed.lock().unwrap().responses.len(), 2);
    }

    /// `AuthenticationMethods password,keyboard-interactive`: a correct password
    /// is a partial success and the OTP completes the login.
    #[tokio::test]
    async fn partial_success_continues_with_second_factor() {
        let (mut session, _observed) = ki_connect(Script {
            rounds: vec![Round::new(
                vec![("Verification code: ", false)],
                vec!["271828"],
            )],
            password: PasswordPolicy::FirstFactor("hunter2"),
        })
        .await;
        let prompter = ScriptedPrompter::new(vec![Some(vec!["271828"])]);

        authenticate_with_prompter(
            &mut session,
            &ki_config("password", Some("hunter2")),
            Some(&prompter),
        )
        .await
        .expect("authenticated");
        let seen = prompter.seen();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].prompts[0].prompt, "Verification code: ");
    }

    /// `AuthenticationMethods password,keyboard-interactive` with a mistyped OTP.
    ///
    /// With a real sshd the accepted password is a partial success, so the
    /// exchange runs in [`KiMode::SecondFactor`] and the wrong code is the typed
    /// `SecondFactorFailed` (covered at the exchange level by
    /// `wrong_answer_in_second_factor_mode_is_second_factor_failed`, and the
    /// partial-success → second-factor routing by
    /// `continuation_decisions`). The
    /// in-process russh 0.61 server, however, always clears `partial_success`
    /// on a password rejection, so here the client only sees "password refused,
    /// keyboard-interactive offered" and nothing proves the saved password was
    /// accepted: the typed OTP rejection conservatively stays `AuthFailed`.
    #[tokio::test]
    async fn wrong_otp_without_accepted_password_evidence_stays_auth_failed() {
        let (mut session, _observed) = ki_connect(Script {
            rounds: vec![Round::new(
                vec![("Verification code: ", false)],
                vec!["271828"],
            )],
            password: PasswordPolicy::FirstFactor("hunter2"),
        })
        .await;
        let prompter = ScriptedPrompter::new(vec![Some(vec!["000000"])]);

        let err = authenticate_with_prompter(
            &mut session,
            &ki_config("password", Some("hunter2")),
            Some(&prompter),
        )
        .await
        .expect_err("rejected");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    }

    /// PAM password fallback: the saved password is auto-answered and accepted,
    /// then the user mistypes the OTP → `SecondFactorFailed`, so the saved
    /// password survives (#3376).
    #[tokio::test]
    async fn password_fallback_wrong_otp_is_second_factor_failed() {
        let (mut session, _observed) = ki_connect(Script {
            rounds: vec![
                Round::new(vec![("Password: ", false)], vec!["hunter2"]),
                Round::new(vec![("Verification code: ", false)], vec!["314159"]),
            ],
            password: PasswordPolicy::Disabled,
        })
        .await;
        let prompter = ScriptedPrompter::new(vec![Some(vec!["000000"])]);

        let err = authenticate_with_prompter(
            &mut session,
            &ki_config("password", Some("hunter2")),
            Some(&prompter),
        )
        .await
        .expect_err("rejected");
        assert!(
            matches!(err, SessionError::SecondFactorFailed),
            "got {err:?}"
        );
    }

    /// PAM password fallback with a stale saved password: the auto-answered
    /// password round is rejected → the typed `AuthFailed` (discard allowed).
    #[tokio::test]
    async fn password_fallback_wrong_saved_password_is_auth_failed() {
        let (mut session, _observed) = ki_connect(Script {
            rounds: vec![
                Round::new(vec![("Password: ", false)], vec!["hunter2"]),
                Round::new(vec![("Verification code: ", false)], vec!["314159"]),
            ],
            password: PasswordPolicy::Disabled,
        })
        .await;
        let prompter = ScriptedPrompter::new(vec![]);

        let err = authenticate_with_prompter(
            &mut session,
            &ki_config("password", Some("stale")),
            Some(&prompter),
        )
        .await
        .expect_err("rejected");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
        assert!(prompter.seen().is_empty());
    }

    /// The explicit `keyboard-interactive` method skips the password method
    /// entirely and prompts; cancelling is a typed cancel.
    #[tokio::test]
    async fn explicit_method_prompts_and_cancel_is_typed() {
        let (mut session, _observed) = ki_connect(Script {
            rounds: vec![Round::new(vec![("Verification code: ", false)], vec!["1"])],
            password: PasswordPolicy::Disabled,
        })
        .await;
        let prompter = ScriptedPrompter::new(vec![None]);

        let err = authenticate_with_prompter(
            &mut session,
            &ki_config(AUTH_METHOD_KEYBOARD_INTERACTIVE, None),
            Some(&prompter),
        )
        .await
        .expect_err("cancelled");
        assert!(matches!(err, SessionError::AuthCancelled), "got {err:?}");
        assert_eq!(prompter.seen().len(), 1);
    }

    #[test]
    fn check_ssh_agent_status_returns_valid_value() {
        let status = check_ssh_agent_status();
        assert!(
            status == "running" || status == "stopped",
            "unexpected status: {status}"
        );
    }

    /// The status seam maps each `SSH_AUTH_SOCK` shape to running/stopped by
    /// value, so these cases never touch the process-global env and cannot race
    /// sibling tests (#2127).
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn agent_status_for_sock_maps_each_case() {
        // Unset and empty are both "stopped" — no live agent.
        assert_eq!(agent_status_for_sock(None), "stopped");
        assert_eq!(
            agent_status_for_sock(Some(std::ffi::OsString::new())),
            "stopped"
        );
        // A path that does not exist is a dangling socket — "stopped".
        assert_eq!(
            agent_status_for_sock(Some("/nonexistent/thub-2127-agent.sock".into())),
            "stopped"
        );
        // A path that exists reads as "running" (existence is all the check does).
        assert_eq!(
            agent_status_for_sock(Some(std::env::temp_dir().into_os_string())),
            "running"
        );
    }
}
