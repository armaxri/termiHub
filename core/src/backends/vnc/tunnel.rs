//! The VNC transport: a direct TCP connect, or one through the shared SSH
//! local forward ([`crate::backends::ssh_tunnel`]) when the connection editor's
//! **SSH Tunnel** group is enabled.

use tokio::net::TcpStream;

pub use crate::backends::ssh_tunnel::SshTunnel;
use crate::errors::SessionError;

use super::config::VncConfig;

/// Connect the RFB transport for `cfg`, either directly or through an SSH tunnel.
///
/// Returns the connected [`TcpStream`] plus an optional [`SshTunnel`] guard that
/// must be kept alive for the lifetime of the session (dropping it closes the
/// tunnel).
pub async fn connect_transport(
    cfg: &VncConfig,
) -> Result<(TcpStream, Option<SshTunnel>), SessionError> {
    let host = cfg.host.clone();
    let port = cfg.effective_port();

    if cfg.use_ssh_tunnel {
        // Password, key file (with an optional passphrase), or ssh-agent —
        // chosen by the editor's SSH-tunnel "SSH Auth Method" field (#1714).
        let tunnel = SshTunnel::establish(&cfg.tunnel_ssh_config(), host, port).await?;
        let stream = TcpStream::connect(("127.0.0.1", tunnel.local_port))
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("tunnel local connect failed: {e}")))?;
        Ok((stream, Some(tunnel)))
    } else {
        let stream = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("VNC connect failed: {e}")))?;
        Ok((stream, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tunnel_without_ssh_host_is_invalid_config() {
        let cfg = VncConfig {
            use_ssh_tunnel: true,
            ..VncConfig::default()
        };
        let err = connect_transport(&cfg).await.unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn direct_transport_connect_error_is_surfaced() {
        // Port 1 with no tunnel resolves to an OS-refused connect, exercising the
        // direct (non-tunnel) error path deterministically.
        let cfg = VncConfig {
            host: "127.0.0.1".to_string(),
            port: 1, // privileged/closed on the test host → connect fails fast
            ..VncConfig::default()
        };
        let result = connect_transport(&cfg).await;
        assert!(result.is_err());
    }
}
