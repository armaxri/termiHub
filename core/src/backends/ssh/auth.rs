//! SSH authentication utilities using russh.
//!
//! Provides [`connect_and_authenticate()`] for establishing an authenticated
//! russh session, and [`check_ssh_agent_status()`] for querying SSH agent
//! availability.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use socket2::TcpKeepalive;
use tokio_util::sync::CancellationToken;

use crate::config::expand_config_value;
use crate::config::SshConfig;
use crate::errors::SessionError;

use super::handler::{ForwardedChannelRegistry, SshSession, TermiHubHandler};

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
/// Kept separate so [`connect_and_authenticate_cancellable`] can wrap it in a
/// timeout and an optional cancellation `select!`.
async fn do_connect_and_authenticate(
    config: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let addr = format!("{}:{}", config.host, config.port);

    // Async connect so the surrounding connect timeout / cancellation token can
    // interrupt a hung connect; a blocking std connect would ignore them (#841).
    let tokio_tcp = tokio::net::TcpStream::connect(&addr)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("Connection failed: {e}")))?;

    // Configure TCP keepalives on the connected socket before the SSH handshake.
    // This mirrors the libssh2 setup: probe after 2 s idle, retry every 2 s,
    // give up after 1 failed probe.
    {
        let ka = {
            let base = TcpKeepalive::new()
                .with_time(Duration::from_secs(2))
                .with_interval(Duration::from_secs(2));
            #[cfg(not(target_os = "windows"))]
            let base = base.with_retries(1);
            base
        };
        if let Err(e) = socket2::SockRef::from(&tokio_tcp).set_tcp_keepalive(&ka) {
            tracing::warn!("TCP keepalive setup failed: {e}");
        }
    }

    let russh_config = Arc::new(russh::client::Config {
        // SSH-level keepalives: send every 30 s, abort after 3 unanswered.
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });

    let (handler, registry) = TermiHubHandler::new();

    let mut session = russh::client::connect_stream(russh_config, tokio_tcp, handler)
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH handshake failed: {e}")))?;

    authenticate(&mut session, config).await?;

    Ok((session, registry))
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

            let key_pair = russh::keys::load_secret_key(&key_path, passphrase)
                .map_err(|e| SessionError::SpawnFailed(format!("Failed to load key: {e}")))?;

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
        use std::path::Path;
        match std::env::var("SSH_AUTH_SOCK") {
            Ok(sock_path) if !sock_path.is_empty() => {
                if Path::new(&sock_path).exists() {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                }
            }
            _ => "stopped".to_string(),
        }
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

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn check_ssh_agent_status_stopped_when_sock_unset() {
        let orig = std::env::var("SSH_AUTH_SOCK").ok();
        // SAFETY: test-only, single-threaded test runner
        unsafe { std::env::remove_var("SSH_AUTH_SOCK") };
        let status = check_ssh_agent_status();
        assert_eq!(status, "stopped");
        if let Some(val) = orig {
            unsafe { std::env::set_var("SSH_AUTH_SOCK", val) };
        }
    }
}
