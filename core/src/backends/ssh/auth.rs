//! SSH authentication utilities using russh.
//!
//! Provides [`connect_and_authenticate()`] for establishing an authenticated
//! russh session, and [`check_ssh_agent_status()`] for querying SSH agent
//! availability.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::config::expand_config_value;
use crate::config::SshConfig;
use crate::errors::SessionError;

use super::handler::{ForwardedChannelRegistry, LivenessWatch, SshSession, TermiHubHandler};
use super::legacy_pem;

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
        tokio::time::timeout(timeout, do_connect_and_authenticate(config))
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
        .map_err(|e| SessionError::SpawnFailed(format!("Connection failed: {e}")))?;

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
        // SSH-level keepalives: send every 30 s, abort after 3 unanswered. On
        // exhaustion russh ends the session task and fires the handler's
        // `disconnected`, which drives the native liveness watch (#1297).
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
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
async fn authenticate(session: &mut SshSession, config: &SshConfig) -> Result<(), SessionError> {
    let success = match config.auth_method.as_str() {
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
                .success()
        }

        _ => {
            // Default: password auth.
            let password = config.password.as_deref().unwrap_or("");
            session
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| SessionError::SpawnFailed(format!("Password auth failed: {e}")))?
                .success()
        }
    };

    if !success {
        return Err(SessionError::SpawnFailed(
            "Authentication failed".to_string(),
        ));
    }

    Ok(())
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
async fn authenticate_with_agent(
    session: &mut SshSession,
    username: &str,
) -> Result<bool, SessionError> {
    let agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH agent connect failed: {e}")))?;
    authenticate_with_agent_client(session, username, agent).await
}

/// Try each identity offered by the SSH agent until one succeeds (Windows OpenSSH named pipe).
#[cfg(windows)]
async fn authenticate_with_agent(
    session: &mut SshSession,
    username: &str,
) -> Result<bool, SessionError> {
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
async fn authenticate_with_agent_client<S>(
    session: &mut SshSession,
    username: &str,
    mut agent: russh::keys::agent::client::AgentClient<S>,
) -> Result<bool, SessionError>
where
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

    for identity in identities {
        let public_key = match identity {
            AgentIdentity::PublicKey { key, .. } => key,
            _ => continue,
        };
        let result = session
            .authenticate_publickey_with(username, public_key, hash_alg, &mut agent)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("Agent auth failed: {e}")))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// SSH agent authentication is not supported on this platform.
#[cfg(not(any(unix, windows)))]
async fn authenticate_with_agent(
    _session: &mut SshSession,
    _username: &str,
) -> Result<bool, SessionError> {
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
    use std::time::Instant;

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
