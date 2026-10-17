//! Optional SSH-tunnel transport for the graphical backends (VNC, RDP #4865).
//!
//! When the connection editor's **SSH Tunnel** group is enabled, the server is
//! reached through an SSH local forward rather than a direct TCP connection —
//! the same thing `ssh -L` does. Rather than hand-roll forwarding, this reuses
//! the existing SSH backend ([`connect_and_authenticate`]) to establish an
//! authenticated session — host-key verification included, through the same
//! known-hosts trust flow every SSH connection uses — then opens a
//! `direct-tcpip` channel to the target and pumps bytes between that channel
//! and a loopback [`TcpListener`].
//!
//! Why a loopback listener instead of handing the channel stream straight to
//! the protocol client: `vnc::VncConnector` requires its transport to be
//! `AsyncRead + AsyncWrite + Send + Sync`, and a russh channel stream is not
//! `Sync`; the RDP client runs in a separate sidecar process that can only dial
//! a TCP address. A loopback port serves both, and mirrors how a native SSH
//! local forward presents the tunnel as a local port.

use std::sync::Arc;

use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::backends::ssh::auth::connect_and_authenticate;
use crate::backends::ssh::handler::SshSession;
use crate::config::SshConfig;
use crate::errors::SessionError;

/// A live SSH tunnel to a target server.
///
/// Holds the loopback address the protocol client should connect to, and keeps
/// the forwarder task alive. Dropping it cancels the token and tears the tunnel
/// down.
///
/// It also keeps the authenticated SSH session reachable, so the VNC
/// file-transfer side channel (#4191) can open an SFTP subsystem on it. That
/// channel's lifetime is bound to the tunnel's cancellation token: when the
/// token fires, the session is disconnected, which closes every channel on it.
pub struct SshTunnel {
    /// Loopback `127.0.0.1:<port>` the protocol client connects to.
    pub local_port: u16,
    /// The tunnel's authenticated SSH session (host key already verified).
    session: Arc<SshSession>,
    cancel: CancellationToken,
}

impl std::fmt::Debug for SshTunnel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshTunnel")
            .field("local_port", &self.local_port)
            .field("cancelled", &self.cancel.is_cancelled())
            .finish_non_exhaustive()
    }
}

impl SshTunnel {
    /// Establish an SSH tunnel through the gateway in `ssh_config` to
    /// `<target_host>:<target_port>` (as seen from the gateway), returning the
    /// loopback endpoint to connect the protocol client to.
    ///
    /// The SSH session and a single-connection forwarder run on a background
    /// task bounded by the returned tunnel's cancellation token.
    pub async fn establish(
        ssh_config: &SshConfig,
        target_host: String,
        target_port: u16,
    ) -> Result<Self, SessionError> {
        if ssh_config.host.trim().is_empty() {
            return Err(SessionError::InvalidConfig(
                "SSH tunnel enabled but no SSH host configured".to_string(),
            ));
        }

        // Authenticate the SSH gateway first, so an SSH failure (including a
        // rejected or unconfirmed host key) surfaces before we bind anything.
        let (session, _registry) = connect_and_authenticate(ssh_config)
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("SSH tunnel connect failed: {e}")))?;
        let session = Arc::new(session);

        // Bind an ephemeral loopback port for the protocol client to dial.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| SessionError::SpawnFailed(format!("tunnel listener bind failed: {e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| SessionError::SpawnFailed(format!("tunnel listener addr failed: {e}")))?
            .port();

        let cancel = CancellationToken::new();
        tokio::spawn(run_forwarder(
            listener,
            session.clone(),
            target_host,
            target_port,
            local_port,
            cancel.clone(),
        ));
        spawn_disconnect_on_cancel(session.clone(), cancel.clone());

        Ok(Self {
            local_port,
            session,
            cancel,
        })
    }

    /// The tunnel's authenticated SSH session, for opening an SFTP subsystem
    /// channel on it (#4191). `None` once the tunnel has been torn down.
    pub fn ssh_session(&self) -> Option<Arc<SshSession>> {
        (!self.cancel.is_cancelled()).then(|| self.session.clone())
    }

    /// Tear the tunnel down once `parent` fires, as well as on drop — so a
    /// session that ends on its own (the RDP sidecar exiting) closes the SSH
    /// connection without waiting for its owner to be dropped.
    pub fn close_with(&self, parent: &CancellationToken) {
        let parent = parent.clone();
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = parent.cancelled() => cancel.cancel(),
                _ = cancel.cancelled() => {}
            }
        });
    }

    /// Whether the tunnel has been torn down.
    pub fn is_closed(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

/// Disconnect `session` once `cancel` fires, so anything still riding it — the
/// file-transfer SFTP channel (#4191) — ends with the tunnel instead of keeping
/// the SSH connection alive through its own `Arc`.
fn spawn_disconnect_on_cancel(session: Arc<SshSession>, cancel: CancellationToken) {
    tokio::spawn(async move {
        cancel.cancelled().await;
        if let Err(e) = session
            .disconnect(russh::Disconnect::ByApplication, "tunnel closed", "en")
            .await
        {
            debug!(error = %e, "ssh-tunnel disconnect after cancel failed");
        }
    });
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Accept the single loopback connection from the protocol client and pump it
/// over a `direct-tcpip` channel to the target until either side closes or the
/// tunnel is cancelled.
async fn run_forwarder(
    listener: TcpListener,
    session: Arc<SshSession>,
    target_host: String,
    target_port: u16,
    local_port: u16,
    cancel: CancellationToken,
) {
    let mut local = tokio::select! {
        _ = cancel.cancelled() => return,
        accepted = listener.accept() => match accepted {
            Ok((sock, _)) => sock,
            Err(e) => {
                warn!(error = %e, "ssh-tunnel accept failed");
                return;
            }
        },
    };
    // One client per tunnel: stop listening so nothing else on this computer
    // can ride the authenticated forward.
    drop(listener);

    let channel = match session
        .channel_open_direct_tcpip(
            &target_host,
            u32::from(target_port),
            "127.0.0.1",
            u32::from(local_port),
        )
        .await
    {
        Ok(ch) => ch,
        Err(e) => {
            warn!(error = %e, host = %target_host, port = target_port, "ssh-tunnel direct-tcpip open failed");
            return;
        }
    };
    let mut remote = channel.into_stream();

    tokio::select! {
        _ = cancel.cancelled() => {}
        result = copy_bidirectional(&mut local, &mut remote) => {
            if let Err(e) = result {
                debug!(error = %e, "ssh-tunnel forward ended");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tunnel_requires_ssh_host() {
        let err = SshTunnel::establish(&SshConfig::default(), "target".to_string(), 5900)
            .await
            .unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }

    #[tokio::test]
    async fn blank_ssh_host_is_rejected_before_any_network_io() {
        let cfg = SshConfig {
            host: "   ".to_string(),
            ..SshConfig::default()
        };
        let err = SshTunnel::establish(&cfg, "target".to_string(), 3389)
            .await
            .unwrap_err();
        assert!(matches!(err, SessionError::InvalidConfig(_)));
    }
}
