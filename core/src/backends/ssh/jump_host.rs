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

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

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

/// Bound a single hop's connect step by a per-hop timeout and an optional
/// cancellation token, naming the hop in any failure.
///
/// The channel-based connect path (`channel_open_direct_tcpip` +
/// [`connect_and_authenticate_over_channel`]) has no timeout of its own, so a
/// hung or blackholed intermediate hop would otherwise block the whole chain
/// indefinitely (#938). Wrapping each hop step here gives OpenSSH-like per-hop
/// `ConnectTimeout` semantics and a clear "which hop hung" error. Cancelling the
/// token aborts a hung hop promptly instead of waiting out the timeout, mirroring
/// [`connect_and_authenticate_cancellable`](super::auth::connect_and_authenticate_cancellable);
/// threading a real token through the (shared) pooled gateway path is follow-up
/// #952, so production callers currently pass `None`.
async fn run_hop_step<T, F>(
    hop_label: &str,
    timeout: Duration,
    cancel: Option<&CancellationToken>,
    step: F,
) -> Result<T, SessionError>
where
    F: Future<Output = Result<T, SessionError>>,
{
    let bounded = async {
        tokio::time::timeout(timeout, step).await.map_err(|_| {
            SessionError::SpawnFailed(format!(
                "Jump host {hop_label} timed out after {}s",
                timeout.as_secs()
            ))
        })?
    };

    match cancel {
        Some(token) => {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(SessionError::SpawnFailed(format!(
                    "Jump host {hop_label} connection cancelled"
                ))),
                res = bounded => res,
            }
        }
        None => bounded.await,
    }
}

/// Reach `cfg` over a `direct-tcpip` channel opened on `current`, bounded by the
/// hop's per-hop timeout and `cancel` (see [`run_hop_step`]).
///
/// Shared by every channel-tunnelled step — each intermediate gateway hop and the
/// final target — which differ only in the config and the label.
async fn connect_hop_over_channel(
    current: &SshSession,
    cfg: &SshConfig,
    label: &str,
    cancel: Option<&CancellationToken>,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    run_hop_step(label, cfg.connect_timeout(), cancel, async {
        let channel = current
            .channel_open_direct_tcpip(&cfg.host, cfg.port as u32, "localhost", 0)
            .await
            .map_err(|e| {
                SessionError::SpawnFailed(format!("Jump host {label} channel failed: {e}"))
            })?;
        connect_and_authenticate_over_channel(cfg, channel).await
    })
    .await
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
/// Every hop is bounded by its [`SshConfig::connect_timeout`] (intermediate hops
/// fall back to the default, as [`JumpHostConfig`] carries no per-hop override),
/// and a failure names the offending hop, so a hung intermediate hop fails within
/// its budget instead of hanging the whole chain (#938).
///
/// Returns an error if `hops` is empty.
pub async fn connect_gateway_chain(hops: &[JumpHostConfig]) -> Result<SshGateway, SessionError> {
    let first = hops
        .first()
        .ok_or_else(|| SessionError::SpawnFailed("Jump host chain is empty".to_string()))?;

    // First hop: an ordinary direct TCP connection, already bounded by its
    // connect timeout (#841). Label any failure with the hop.
    let first_cfg = first.to_ssh_config();
    let (mut current, mut registry) =
        connect_and_authenticate(&first_cfg).await.map_err(|e| {
            SessionError::SpawnFailed(format!(
                "Jump host {}: {e}",
                hop_label(1, &first_cfg.host, first_cfg.port)
            ))
        })?;
    let mut intermediate_sessions: Vec<SshSession> = Vec::new();

    // Each subsequent hop: open a direct-tcpip channel on the current session to
    // the next hop, then handshake/authenticate the next session over it — the
    // whole step bounded by the hop's timeout.
    for (idx, hop) in hops.iter().enumerate().skip(1) {
        let cfg = hop.to_ssh_config();
        let label = hop_label(idx + 1, &cfg.host, cfg.port);
        let (next, next_registry) =
            connect_hop_over_channel(&current, &cfg, &label, None).await?;
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
/// target session over it, bounded by the target's connect timeout (#938).
async fn open_target_over_gateway(
    gateway: &SshSession,
    target: &SshConfig,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let label = format!("target {}:{}", target.host, target.port);
    connect_hop_over_channel(gateway, target, &label, None).await
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

    let gateway = pool
        .get_or_create(&key, || async {
            connect_gateway_chain(&target.proxy_jump)
                .await
                .map(Arc::new)
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

/// Human-readable hop label (`hop 2 (bastion:22)`) used in chain errors so the
/// user sees which hop failed or timed out.
fn hop_label(num: usize, host: &str, port: u16) -> String {
    format!("hop {num} ({host}:{port})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

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

    /// A hung hop step (one that never resolves) must fail within the per-hop
    /// timeout — surfacing *which* hop hung — instead of blocking the whole
    /// chain indefinitely (#938).
    #[tokio::test]
    async fn hop_step_times_out_and_names_the_hop() {
        let label = "hop 2 (bastion:22)";
        let start = Instant::now();
        let result: Result<(), SessionError> =
            run_hop_step(label, Duration::from_secs(1), None, async {
                // A blackholed intermediate hop never completes the handshake.
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(())
            })
            .await;
        let elapsed = start.elapsed();

        let err = result.expect_err("hung hop should time out");
        let msg = err.to_string();
        assert!(msg.contains("timed out"), "unexpected error: {msg}");
        assert!(msg.contains(label), "error should name the hop: {msg}");
        assert!(
            elapsed < Duration::from_secs(5),
            "timeout took too long: {elapsed:?}"
        );
    }

    /// Cancelling the token mid-connect aborts a hung hop promptly, well before
    /// the per-hop timeout would fire (#938).
    #[tokio::test]
    async fn hop_step_aborts_when_token_cancelled() {
        let label = "hop 2 (bastion:22)";
        let token = CancellationToken::new();
        let cancel_handle = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_handle.cancel();
        });

        let start = Instant::now();
        let result: Result<(), SessionError> =
            run_hop_step(label, Duration::from_secs(30), Some(&token), async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(())
            })
            .await;
        let elapsed = start.elapsed();

        let err = result.expect_err("cancelled hop should fail");
        let msg = err.to_string();
        assert!(msg.contains("cancelled"), "unexpected error: {msg}");
        assert!(msg.contains(label), "error should name the hop: {msg}");
        assert!(
            elapsed < Duration::from_secs(2),
            "cancellation took too long: {elapsed:?}"
        );
    }

    /// A hop that completes within budget returns its value untouched, and the
    /// per-hop timeout/cancellation wrapper adds no overhead on the happy path.
    #[tokio::test]
    async fn hop_step_passes_through_on_success() {
        let token = CancellationToken::new();
        let result = run_hop_step(
            "hop 2 (bastion:22)",
            Duration::from_secs(1),
            Some(&token),
            async { Ok::<_, SessionError>(42) },
        )
        .await;
        assert_eq!(result.expect("hop should succeed"), 42);
    }
}
