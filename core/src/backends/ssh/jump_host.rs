//! SSH jump host (`ProxyJump`) connection support.
//!
//! Establishes an authenticated SSH session on a target host that is only
//! reachable through one or more bastion hops, mirroring OpenSSH's `-J` /
//! `ProxyJump`. Each hop is connected in turn; the connection to hop N+1 (or the
//! final target) is tunnelled over a `direct-tcpip` channel opened on hop N's
//! session — the same primitive the SSH tunnel forwarders use.

use crate::config::SshConfig;
use crate::errors::SessionError;

use super::auth::{connect_and_authenticate, connect_and_authenticate_over_channel};
use super::handler::{ForwardedChannelRegistry, SshSession};

/// An authenticated SSH session on the target, reached through a jump-host chain.
///
/// The intermediate hop sessions are retained in [`intermediates`](Self::intermediates):
/// dropping them would tear down the `direct-tcpip` channels that carry the
/// target session, so the caller must keep this struct (or at least
/// `intermediates`) alive for the lifetime of [`session`](Self::session).
pub struct JumpHostConnection {
    /// Authenticated session on the final target host.
    pub session: SshSession,
    /// Forwarded-channel registry for the target session (X11 / remote forwards).
    pub registry: ForwardedChannelRegistry,
    /// Bastion / intermediate hop sessions kept alive to hold the chain open.
    pub intermediates: Vec<SshSession>,
}

/// Connect to `target` through its [`SshConfig::proxy_jump`] chain.
///
/// Hops are ordered outermost → innermost (`ssh -J edge,bastion` ⇒
/// `[edge, bastion]`). The first hop is reached by a direct TCP connection; every
/// subsequent hop and the final target are reached over a `direct-tcpip` channel
/// opened on the preceding hop's session.
///
/// Returns an error if the chain is empty — callers should only invoke this when
/// `proxy_jump` is non-empty.
pub async fn connect_through_jump_hosts(
    target: &SshConfig,
) -> Result<JumpHostConnection, SessionError> {
    let hops = &target.proxy_jump;
    let first = hops
        .first()
        .ok_or_else(|| SessionError::SpawnFailed("Jump host chain is empty".to_string()))?;

    // First hop: an ordinary direct TCP connection.
    let (mut current, _registry) = connect_and_authenticate(&first.to_ssh_config()).await?;
    let mut intermediates: Vec<SshSession> = Vec::new();

    // Each subsequent hop: open a direct-tcpip channel on the current session to
    // the next hop, then handshake/authenticate the next session over it.
    for (idx, hop) in hops.iter().enumerate().skip(1) {
        let cfg = hop.to_ssh_config();
        let channel = current
            .channel_open_direct_tcpip(&cfg.host, cfg.port as u32, "localhost", 0)
            .await
            .map_err(|e| {
                SessionError::SpawnFailed(format!(
                    "Jump host hop {} ({}:{}) channel failed: {e}",
                    idx + 1,
                    cfg.host,
                    cfg.port
                ))
            })?;
        let (next, _registry) = connect_and_authenticate_over_channel(&cfg, channel).await?;
        intermediates.push(current);
        current = next;
    }

    // Final hop → target: tunnel the target session over the innermost hop.
    let channel = current
        .channel_open_direct_tcpip(&target.host, target.port as u32, "localhost", 0)
        .await
        .map_err(|e| {
            SessionError::SpawnFailed(format!(
                "Direct-tcpip channel to target {}:{} failed: {e}",
                target.host, target.port
            ))
        })?;
    let (session, registry) = connect_and_authenticate_over_channel(target, channel).await?;
    intermediates.push(current);

    Ok(JumpHostConnection {
        session,
        registry,
        intermediates,
    })
}
