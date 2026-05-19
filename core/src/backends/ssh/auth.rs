//! SSH authentication utilities using russh.
//!
//! Provides [`connect_and_authenticate()`] for establishing an authenticated
//! russh session, and [`check_ssh_agent_status()`] for querying SSH agent
//! availability.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use socket2::TcpKeepalive;

use crate::config::expand::expand_tilde;
use crate::config::SshConfig;
use crate::errors::SessionError;

use super::handler::{ForwardedChannelRegistry, SshSession, TermiHubHandler};

/// Connect to an SSH server, perform handshake, and authenticate.
///
/// Returns an authenticated session handle and a channel registry for
/// remote-port-forward notifications. Most callers only need the handle;
/// the registry is used by [`RemoteForwarder`] and the X11 event loop.
pub async fn connect_and_authenticate(
    config: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let addr = format!("{}:{}", config.host, config.port);

    // Connect a plain TCP stream so we can configure keepalives before handing
    // it to russh. This mirrors the libssh2 setup: probe after 2 s idle, retry
    // every 2 s, give up after 1 failed probe.
    let std_tcp = std::net::TcpStream::connect(&addr)
        .map_err(|e| SessionError::SpawnFailed(format!("Connection failed: {e}")))?;

    {
        let ka = {
            let base = TcpKeepalive::new()
                .with_time(Duration::from_secs(2))
                .with_interval(Duration::from_secs(2));
            #[cfg(not(target_os = "windows"))]
            let base = base.with_retries(1);
            base
        };
        if let Err(e) = socket2::SockRef::from(&std_tcp).set_tcp_keepalive(&ka) {
            tracing::warn!("TCP keepalive setup failed: {e}");
        }
    }

    std_tcp
        .set_nonblocking(true)
        .map_err(|e| SessionError::SpawnFailed(format!("Failed to set non-blocking: {e}")))?;

    let tokio_tcp = tokio::net::TcpStream::from_std(std_tcp)
        .map_err(|e| SessionError::SpawnFailed(format!("TcpStream conversion failed: {e}")))?;

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
            let expanded = expand_tilde(key_path_str);
            let key_path = PathBuf::from(&expanded);
            let passphrase = config.password.as_deref();

            let key_pair = russh_keys::load_secret_key(&key_path, passphrase)
                .map_err(|e| SessionError::SpawnFailed(format!("Failed to load key: {e}")))?;

            session
                .authenticate_publickey(&config.username, Arc::new(key_pair))
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
    let mut agent = russh_keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH agent connect failed: {e}")))?;
    let keys = agent
        .request_identities()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH agent list keys failed: {e}")))?;
    for key in keys {
        let (returned, result) = session.authenticate_future(username, key, agent).await;
        agent = returned;
        match result {
            Ok(true) => return Ok(true),
            Ok(false) => continue,
            Err(e) => return Err(SessionError::SpawnFailed(format!("Agent auth failed: {e}"))),
        }
    }
    Ok(false)
}

/// Try each identity offered by the SSH agent until one succeeds (Windows OpenSSH named pipe).
#[cfg(windows)]
async fn authenticate_with_agent(
    session: &mut SshSession,
    username: &str,
) -> Result<bool, SessionError> {
    let mut agent =
        russh_keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("SSH agent connect failed: {e}")))?;
    let keys = agent
        .request_identities()
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("SSH agent list keys failed: {e}")))?;
    for key in keys {
        let (returned, result) = session.authenticate_future(username, key, agent).await;
        agent = returned;
        match result {
            Ok(true) => return Ok(true),
            Ok(false) => continue,
            Err(e) => return Err(SessionError::SpawnFailed(format!("Agent auth failed: {e}"))),
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
