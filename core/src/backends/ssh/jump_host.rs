//! SSH jump host (`ProxyJump`) connection support.
//!
//! Establishes an authenticated SSH session on a target host that is only
//! reachable through one or more bastion hops, mirroring OpenSSH's `-J` /
//! `ProxyJump`. Each hop is connected in turn; the connection to hop N+1 (or the
//! final target) is tunnelled over a `direct-tcpip` channel opened on hop N's
//! session — the same primitive the SSH tunnel forwarders use.
//!
//! Gateway sessions are pooled and shared (see [`session_pool`](super::session_pool)):
//! multiple connections that reach their targets through the same bastion reuse a
//! single gateway `russh` session via [`connect_target_through_pooled_gateway`].

use std::sync::Arc;

use crate::config::{JumpHostConfig, SshConfig};
use crate::errors::SessionError;

use super::auth::{connect_and_authenticate, connect_and_authenticate_over_channel};
use super::handler::{ForwardedChannelRegistry, SshSession};
use super::session_pool::{shared_gateway_pool, PooledRef, SshGateway};

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

/// Stable pool key for a jump-host chain.
///
/// Two connections whose chains resolve to the same ordered hops share one
/// pooled gateway session. A hop is identified by its saved-connection id when
/// present, otherwise by its `user@host:port` (inline hops, which is what the
/// editor currently writes).
pub fn gateway_pool_key(hops: &[JumpHostConfig]) -> String {
    let mut key = String::from("gateway");
    for hop in hops {
        key.push('|');
        match hop.connection_id.as_deref() {
            Some(id) if !id.is_empty() => {
                key.push_str("id:");
                key.push_str(id);
            }
            _ => {
                key.push_str(&hop.username);
                key.push('@');
                key.push_str(&hop.host);
                key.push(':');
                key.push_str(&hop.port.to_string());
            }
        }
    }
    key
}

/// Connect the jump-host chain and return an authenticated session on the
/// innermost gateway hop, plus the outer-hop sessions kept alive to hold it.
///
/// Hops are ordered outermost → innermost (`ssh -J edge,bastion` ⇒
/// `[edge, bastion]`). The first hop is reached by a direct TCP connection; each
/// subsequent hop is reached over a `direct-tcpip` channel opened on the
/// preceding hop's session.
///
/// Returns an error if `hops` is empty.
pub async fn connect_gateway_chain(hops: &[JumpHostConfig]) -> Result<SshGateway, SessionError> {
    let first = hops
        .first()
        .ok_or_else(|| SessionError::SpawnFailed("Jump host chain is empty".to_string()))?;

    // First hop: an ordinary direct TCP connection.
    let (mut current, mut registry) = connect_and_authenticate(&first.to_ssh_config()).await?;
    let mut intermediate_sessions: Vec<SshSession> = Vec::new();

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
        let (next, next_registry) = connect_and_authenticate_over_channel(&cfg, channel).await?;
        intermediate_sessions.push(current);
        current = next;
        registry = next_registry;
    }

    Ok(SshGateway {
        session: current,
        registry,
        intermediate_sessions,
    })
}

/// Open a `direct-tcpip` channel from `gateway` to `target` and authenticate the
/// target session over it.
async fn open_target_over_gateway(
    gateway: &SshSession,
    target: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let channel = gateway
        .channel_open_direct_tcpip(&target.host, target.port as u32, "localhost", 0)
        .await
        .map_err(|e| {
            SessionError::SpawnFailed(format!(
                "Direct-tcpip channel to target {}:{} failed: {e}",
                target.host, target.port
            ))
        })?;
    connect_and_authenticate_over_channel(target, channel).await
}

/// Connect to `target` through its [`SshConfig::proxy_jump`] chain, reusing a
/// **pooled, shared** gateway session.
///
/// The gateway chain for `target.proxy_jump` is acquired from the process-wide
/// [`shared_gateway_pool`] — created once and shared (reference-counted) by every
/// connection that uses the same chain. A `direct-tcpip` channel is then opened
/// on the gateway to `target.host:target.port` and the target session is
/// authenticated over it.
///
/// The returned [`PooledRef`] holds the gateway reference: keep it alive for the
/// lifetime of the returned session and drop it (after the session ends) to
/// release the gateway back to the pool. `target.proxy_jump` must be non-empty.
pub async fn connect_target_through_pooled_gateway(
    target: &SshConfig,
) -> Result<
    (
        SshSession,
        ForwardedChannelRegistry,
        PooledRef<Arc<SshGateway>>,
    ),
    SessionError,
> {
    let pool = shared_gateway_pool();
    let key = gateway_pool_key(&target.proxy_jump);
    let hops = target.proxy_jump.clone();

    let gateway = pool
        .get_or_create(&key, || async move {
            connect_gateway_chain(&hops).await.map(Arc::new)
        })
        .await?;

    let (session, registry) = open_target_over_gateway(&gateway.session, target).await?;
    Ok((session, registry, gateway))
}

/// Connect to `target` through its [`SshConfig::proxy_jump`] chain with a
/// **dedicated** (non-pooled) gateway chain.
///
/// Used where session sharing is not applicable (e.g. one-off, non-pooled
/// callers and the `SSH-JUMP-01` integration test). For the terminal and tunnel
/// connect paths prefer [`connect_target_through_pooled_gateway`].
pub async fn connect_through_jump_hosts(
    target: &SshConfig,
) -> Result<JumpHostConnection, SessionError> {
    let SshGateway {
        session: gateway,
        registry: _gateway_registry,
        mut intermediate_sessions,
    } = connect_gateway_chain(&target.proxy_jump).await?;

    let (session, registry) = open_target_over_gateway(&gateway, target).await?;

    // Retain the innermost gateway alongside the outer hops: dropping any of them
    // would close the direct-tcpip channels carrying the target session.
    intermediate_sessions.push(gateway);

    Ok(JumpHostConnection {
        session,
        registry,
        intermediates: intermediate_sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(host: &str, port: u16, user: &str) -> JumpHostConfig {
        JumpHostConfig {
            host: host.to_string(),
            port,
            username: user.to_string(),
            auth_method: "agent".to_string(),
            ..JumpHostConfig::default()
        }
    }

    #[test]
    fn pool_key_is_stable_for_equal_inline_chains() {
        let a = vec![hop("bastion", 22, "admin")];
        let b = vec![hop("bastion", 22, "admin")];
        assert_eq!(gateway_pool_key(&a), gateway_pool_key(&b));
    }

    #[test]
    fn pool_key_differs_for_different_hosts() {
        let a = vec![hop("bastion-a", 22, "admin")];
        let b = vec![hop("bastion-b", 22, "admin")];
        assert_ne!(gateway_pool_key(&a), gateway_pool_key(&b));
    }

    #[test]
    fn pool_key_distinguishes_hop_order_and_count() {
        let one = vec![hop("edge", 22, "u")];
        let two = vec![hop("edge", 22, "u"), hop("inner", 22, "u")];
        let swapped = vec![hop("inner", 22, "u"), hop("edge", 22, "u")];
        assert_ne!(gateway_pool_key(&one), gateway_pool_key(&two));
        assert_ne!(gateway_pool_key(&two), gateway_pool_key(&swapped));
    }

    #[test]
    fn pool_key_prefers_connection_id_when_present() {
        let mut by_id = hop("ignored-host", 99, "ignored");
        by_id.connection_id = Some("Work/bastion".to_string());
        assert_eq!(gateway_pool_key(&[by_id]), "gateway|id:Work/bastion");
    }
}
