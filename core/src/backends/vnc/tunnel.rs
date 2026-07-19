//! Optional SSH-tunnel transport for the VNC backend.
//!
//! When the connection editor's **SSH Tunnel** group is enabled, the VNC server
//! is reached through an SSH local forward rather than a direct TCP connection —
//! the same thing `ssh -L` does. Rather than hand-roll forwarding, this reuses
//! the existing SSH backend ([`connect_and_authenticate`]) to establish an
//! authenticated session, then opens a `direct-tcpip` channel to the VNC target
//! and pumps bytes between that channel and a loopback [`TcpListener`].
//!
//! Why a loopback listener instead of handing the channel stream straight to the
//! RFB client: `vnc::VncConnector` requires its transport to be
//! `AsyncRead + AsyncWrite + Send + Sync`, and a russh channel stream is not
//! `Sync`. Bridging through a real `TcpStream` (which is `Sync`) keeps the RFB
//! client's bound satisfied and mirrors how a native SSH local forward presents
//! the tunnel as a local port.

use std::sync::Arc;

use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::backends::ssh::auth::connect_and_authenticate;
use crate::errors::SessionError;

use super::config::VncConfig;

/// A live SSH tunnel to a VNC server.
///
/// Holds the loopback address the RFB client should connect to, and keeps the
/// forwarder task alive. Dropping it cancels the token and tears the tunnel down.
#[derive(Debug)]
pub struct SshTunnel {
    /// Loopback `127.0.0.1:<port>` the RFB client connects to.
    pub local_port: u16,
    cancel: CancellationToken,
}

impl SshTunnel {
    /// Establish an SSH tunnel to `<vnc_host>:<vnc_port>` using the SSH settings
    /// in `cfg`, returning the loopback endpoint to connect the RFB client to.
    ///
    /// The SSH session and a single-connection forwarder run on a background task
    /// bounded by the returned tunnel's cancellation token.
    pub async fn establish(
        cfg: &VncConfig,
        vnc_host: String,
        vnc_port: u16,
    ) -> Result<Self, SessionError> {
        // Reuse the SSH backend's auth machinery: password, key file (with an
        // optional passphrase), or ssh-agent — chosen by the editor's SSH-tunnel
        // "SSH Auth Method" field (#1714).
        let ssh_config = cfg.tunnel_ssh_config();

        if ssh_config.host.is_empty() {
            return Err(SessionError::InvalidConfig(
                "SSH tunnel enabled but no SSH host configured".to_string(),
            ));
        }

        // Authenticate the SSH gateway first, so an SSH failure surfaces before
        // we bind anything locally.
        let (session, _registry) = connect_and_authenticate(&ssh_config)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("SSH tunnel connect failed: {e}")))?;
        let session = Arc::new(session);

        // Bind an ephemeral loopback port for the RFB client to dial.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("tunnel listener bind failed: {e}")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| SessionError::SpawnFailed(format!("tunnel listener addr failed: {e}")))?;
        let local_port = local_addr.port();

        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        tokio::spawn(async move {
            run_forwarder(
                listener,
                session,
                vnc_host,
                vnc_port,
                local_port,
                task_cancel,
            )
            .await;
        });

        Ok(Self { local_port, cancel })
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Accept the single loopback connection from the RFB client and pump it over a
/// `direct-tcpip` channel to the VNC target until either side closes or the
/// tunnel is cancelled.
async fn run_forwarder(
    listener: TcpListener,
    session: Arc<crate::backends::ssh::handler::SshSession>,
    vnc_host: String,
    vnc_port: u16,
    local_port: u16,
    cancel: CancellationToken,
) {
    let mut local = tokio::select! {
        _ = cancel.cancelled() => return,
        accepted = listener.accept() => match accepted {
            Ok((sock, _)) => sock,
            Err(e) => {
                warn!(error = %e, "vnc ssh-tunnel accept failed");
                return;
            }
        },
    };

    let channel = match session
        .channel_open_direct_tcpip(&vnc_host, vnc_port as u32, "127.0.0.1", local_port as u32)
        .await
    {
        Ok(ch) => ch,
        Err(e) => {
            warn!(error = %e, host = %vnc_host, port = vnc_port, "vnc ssh-tunnel direct-tcpip open failed");
            return;
        }
    };
    let mut remote = channel.into_stream();

    tokio::select! {
        _ = cancel.cancelled() => {}
        result = copy_bidirectional(&mut local, &mut remote) => {
            if let Err(e) = result {
                debug!(error = %e, "vnc ssh-tunnel forward ended");
            }
        }
    }
}

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
        let tunnel = SshTunnel::establish(cfg, host, port).await?;
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
    async fn tunnel_requires_ssh_host() {
        let cfg = VncConfig {
            use_ssh_tunnel: true,
            ..VncConfig::default()
        };
        let err = SshTunnel::establish(&cfg, "vnc".to_string(), 5900)
            .await
            .unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn direct_transport_connect_error_is_surfaced() {
        // Port 0 with no tunnel resolves to an OS-refused connect, exercising the
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
