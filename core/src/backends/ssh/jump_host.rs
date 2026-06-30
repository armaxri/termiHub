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

use super::auth::{connect_and_authenticate_cancellable, connect_and_authenticate_over_channel};
use super::handler::{ForwardedChannelRegistry, SshSession};
use super::session_pool::{shared_gateway_pool, PooledRef, SshGateway};

/// A reference-counted hold on a pooled, shared gateway session.
///
/// Returned by [`connect_target`] (and [`connect_target_through_pooled_gateway`])
/// for jump-host connections; keep it alive for the lifetime of the target
/// session it carries, and drop it afterwards to release the gateway back to the
/// pool.
pub type GatewayHold = PooledRef<Arc<SshGateway>>;

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

/// The connect state of a single node on a jump-host path during a live probe.
///
/// Drives the per-hop status indicators in the **Show Connection Path** popover
/// (#962): each node starts implicitly *pending* (no event yet), flips to
/// [`Connecting`](HopStatus::Connecting) when the probe begins that step, then
/// resolves to [`Connected`](HopStatus::Connected) or [`Failed`](HopStatus::Failed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HopStatus {
    /// The probe is currently establishing this node's connection.
    Connecting,
    /// This node was reached and authenticated successfully.
    Connected,
    /// This node could not be reached / authenticated.
    Failed,
}

/// A single per-hop status update emitted while probing a connection path.
///
/// `index` is the node's zero-based position along the path **excluding** the
/// local "You" origin: gateway hops come first (outermost → innermost), and the
/// final target is the last index (`index == total - 1`). `total` is the count of
/// such nodes (gateway hops + target), so the UI can map an update straight onto
/// the rendered chain. `message` carries the failure reason for
/// [`HopStatus::Failed`] and is empty otherwise.
#[derive(Debug, Clone)]
pub struct HopProgress {
    /// Zero-based node index along the path (gateway hops then target).
    pub index: usize,
    /// Total probed nodes (gateway hops + target).
    pub total: usize,
    /// Node host.
    pub host: String,
    /// Node port.
    pub port: u16,
    /// Current connect status of this node.
    pub status: HopStatus,
    /// Failure reason for [`HopStatus::Failed`]; empty otherwise.
    pub message: String,
}

/// Probe the full connection path to `target` — every jump-host hop in order and
/// then the target itself — reporting each node's live status through
/// `on_progress`, and tearing the probe connections down again when done.
///
/// This backs the **Show Connection Path** popover's live per-hop status (#962).
/// It reuses the same per-hop connect primitives as the real connect path
/// ([`connect_gateway_chain`] semantics: first hop direct, subsequent hops over
/// `direct-tcpip` channels, the target over the innermost gateway) so a probe
/// exercises the exact reachability/auth the eventual session would, but it does
/// **not** touch the shared gateway pool and drops everything on return — it is a
/// transient reachability check, not a session.
///
/// For each node the callback fires once with [`HopStatus::Connecting`] before the
/// attempt and once with the resolved [`HopStatus::Connected`] /
/// [`HopStatus::Failed`] after. On the first failure the probe stops and returns
/// the error; nodes past the failure get no event (the UI leaves them pending).
/// `cancel` aborts an in-flight probe promptly (see [`run_hop_step`]).
///
/// A direct (no jump host) target is a single-node path (`total == 1`).
pub async fn probe_connection_path(
    target: &SshConfig,
    cancel: Option<&CancellationToken>,
    on_progress: &mut (dyn FnMut(HopProgress) + Send),
) -> Result<(), SessionError> {
    let hops = &target.proxy_jump;
    let total = hops.len() + 1;

    // Walk the gateway chain, reporting each hop, keeping intermediate sessions
    // alive so the next hop's channel can be opened over the previous one.
    let mut current: Option<SshSession> = None;
    // Earlier hop sessions whose channels carry the chain; dropped at the end.
    let mut keep_alive: Vec<SshSession> = Vec::new();

    for (idx, hop) in hops.iter().enumerate() {
        let cfg = hop.to_ssh_config();
        on_progress(HopProgress {
            index: idx,
            total,
            host: cfg.host.clone(),
            port: cfg.port,
            status: HopStatus::Connecting,
            message: String::new(),
        });

        let label = hop_label(idx + 1, &cfg.host, cfg.port);
        let result = match current.take() {
            // First hop: direct TCP connect + auth, bounded by its timeout/cancel.
            None => run_hop_step(&label, cfg.connect_timeout(), cancel, async {
                connect_and_authenticate_cancellable(&cfg, cancel.cloned()).await
            })
            .await
            .map(|(session, _registry)| session),
            // Subsequent hops: tunnel over the preceding hop's session.
            Some(prev) => {
                let res = connect_hop_over_channel(&prev, &cfg, &label, cancel)
                    .await
                    .map(|(session, _registry)| session);
                keep_alive.push(prev);
                res
            }
        };

        match result {
            Ok(session) => {
                on_progress(HopProgress {
                    index: idx,
                    total,
                    host: cfg.host.clone(),
                    port: cfg.port,
                    status: HopStatus::Connected,
                    message: String::new(),
                });
                current = Some(session);
            }
            Err(e) => {
                on_progress(HopProgress {
                    index: idx,
                    total,
                    host: cfg.host.clone(),
                    port: cfg.port,
                    status: HopStatus::Failed,
                    message: e.to_string(),
                });
                return Err(e);
            }
        }
    }

    // Final node: the target itself (direct when there were no hops, otherwise
    // reached over the innermost gateway session).
    let target_index = total - 1;
    on_progress(HopProgress {
        index: target_index,
        total,
        host: target.host.clone(),
        port: target.port,
        status: HopStatus::Connecting,
        message: String::new(),
    });

    let target_result = match current.take() {
        None => connect_and_authenticate_cancellable(target, cancel.cloned())
            .await
            .map(|(session, _registry)| session),
        Some(gateway) => {
            let label = format!("target {}:{}", target.host, target.port);
            let res = connect_hop_over_channel(&gateway, target, &label, cancel)
                .await
                .map(|(session, _registry)| session);
            keep_alive.push(gateway);
            res
        }
    };

    match target_result {
        Ok(_session) => {
            on_progress(HopProgress {
                index: target_index,
                total,
                host: target.host.clone(),
                port: target.port,
                status: HopStatus::Connected,
                message: String::new(),
            });
            Ok(())
        }
        Err(e) => {
            on_progress(HopProgress {
                index: target_index,
                total,
                host: target.host.clone(),
                port: target.port,
                status: HopStatus::Failed,
                message: e.to_string(),
            });
            Err(e)
        }
    }
    // `keep_alive`, `current`, and the target session drop here, tearing the probe
    // connections down — the probe leaves no lingering sessions.
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
/// [`connect_and_authenticate_cancellable`](super::auth::connect_and_authenticate_cancellable).
/// The shell and tunnel connect paths thread a real token here (#952); the
/// non-pooled [`connect_through_jump_hosts`] helper passes `None`.
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
/// Every hop is bounded by its [`SshConfig::connect_timeout`] — the hop's own
/// per-hop `connect_timeout_secs` override (#951), or the default when unset — and
/// a failure names the offending hop, so a hung intermediate hop fails within its
/// budget instead of hanging the whole chain (#938).
///
/// Returns an error if `hops` is empty.
pub async fn connect_gateway_chain(
    hops: &[JumpHostConfig],
    cancel: Option<&CancellationToken>,
) -> Result<SshGateway, SessionError> {
    let first = hops
        .first()
        .ok_or_else(|| SessionError::SpawnFailed("Jump host chain is empty".to_string()))?;

    // First hop: an ordinary direct TCP connection, bounded by its connect
    // timeout (#841) and abortable via `cancel` (#952). Label any failure.
    let first_cfg = first.to_ssh_config();
    let (mut current, mut registry) =
        connect_and_authenticate_cancellable(&first_cfg, cancel.cloned())
            .await
            .map_err(|e| {
                SessionError::SpawnFailed(format!(
                    "Jump host {}: {e}",
                    hop_label(1, &first_cfg.host, first_cfg.port)
                ))
            })?;
    let mut intermediate_sessions: Vec<SshSession> = Vec::new();

    // Each subsequent hop: open a direct-tcpip channel on the current session to
    // the next hop, then handshake/authenticate the next session over it — the
    // whole step bounded by the hop's timeout and `cancel`.
    for (idx, hop) in hops.iter().enumerate().skip(1) {
        let cfg = hop.to_ssh_config();
        let label = hop_label(idx + 1, &cfg.host, cfg.port);
        let (next, next_registry) =
            connect_hop_over_channel(&current, &cfg, &label, cancel).await?;
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
/// target session over it, bounded by the target's connect timeout (#938) and
/// `cancel` (#952).
async fn open_target_over_gateway(
    gateway: &SshSession,
    target: &SshConfig,
    cancel: Option<&CancellationToken>,
) -> Result<(SshSession, ForwardedChannelRegistry), SessionError> {
    let label = format!("target {}:{}", target.host, target.port);
    connect_hop_over_channel(gateway, target, &label, cancel).await
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
///
/// `cancel` aborts an in-flight connect — both the (single-flight) gateway-chain
/// creation and the target handshake — promptly instead of waiting out the
/// per-hop timeouts (#952).
pub async fn connect_target_through_pooled_gateway(
    target: &SshConfig,
    cancel: Option<&CancellationToken>,
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
            connect_gateway_chain(&target.proxy_jump, cancel)
                .await
                .map(Arc::new)
        })
        .await?;

    let (session, registry) = open_target_over_gateway(&gateway.session, target, cancel).await?;
    Ok((session, registry, gateway))
}

/// Connect to `target`, honoring its [`SshConfig::proxy_jump`] chain.
///
/// When `proxy_jump` is empty this is a plain [`connect_and_authenticate`]; when
/// it is non-empty the target is reached through its **pooled, shared** gateway
/// (see [`connect_target_through_pooled_gateway`]) and a [`GatewayHold`] is
/// returned to keep that gateway alive for the session's lifetime (`None` for a
/// direct connection).
///
/// This is the single entry point every SSH provider — the shell connector, the
/// SFTP file browser, and monitoring — uses so they all reach a jump-host target
/// through the bastion instead of attempting a (failing) direct connection
/// (#939), sharing one gateway session across the connection's providers.
///
/// `cancel`, when supplied, aborts an in-flight connect (direct handshake or each
/// jump-host hop) promptly instead of waiting out the connect timeout — used to
/// cancel a still-connecting shell session (#952). Providers that have no
/// cancellation signal (SFTP, monitoring) pass `None`.
pub async fn connect_target(
    target: &SshConfig,
    cancel: Option<&CancellationToken>,
) -> Result<(SshSession, ForwardedChannelRegistry, Option<GatewayHold>), SessionError> {
    if target.proxy_jump.is_empty() {
        let (session, registry) =
            connect_and_authenticate_cancellable(target, cancel.cloned()).await?;
        Ok((session, registry, None))
    } else {
        let (session, registry, gateway) =
            connect_target_through_pooled_gateway(target, cancel).await?;
        Ok((session, registry, Some(gateway)))
    }
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
    } = connect_gateway_chain(&target.proxy_jump, None).await?;

    let (session, registry) = open_target_over_gateway(&gateway, target, None).await?;

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

    /// Build an SSH target config with the given inline jump-host chain. A short
    /// per-hop connect timeout keeps the probe tests fast.
    fn target_with_hops(host: &str, port: u16, hops: Vec<JumpHostConfig>) -> SshConfig {
        SshConfig {
            host: host.to_string(),
            port,
            username: "u".to_string(),
            auth_method: "agent".to_string(),
            connect_timeout_secs: Some(2),
            proxy_jump: hops,
            ..SshConfig::default()
        }
    }

    /// Probing a target whose first jump host is unreachable must report that hop
    /// `Connecting` then `Failed`, stop there (no event for later nodes), and
    /// return the error. `total` reflects gateway hops + target (#962).
    #[tokio::test]
    async fn probe_reports_connecting_then_failed_on_unreachable_first_hop() {
        // Port 1 is reserved and refuses connections fast → quick deterministic fail.
        let mut hop = hop("127.0.0.1", 1, "u");
        hop.connect_timeout_secs = Some(2);
        let target = target_with_hops("10.255.255.1", 22, vec![hop]);

        let mut events: Vec<HopProgress> = Vec::new();
        let result = probe_connection_path(&target, None, &mut |p| events.push(p)).await;

        assert!(
            result.is_err(),
            "unreachable first hop should fail the probe"
        );
        assert_eq!(
            events.len(),
            2,
            "expected Connecting + Failed, got {events:?}"
        );

        assert_eq!(events[0].index, 0);
        assert_eq!(events[0].total, 2, "1 hop + target");
        assert_eq!(events[0].host, "127.0.0.1");
        assert_eq!(events[0].status, HopStatus::Connecting);

        assert_eq!(events[1].index, 0);
        assert_eq!(events[1].status, HopStatus::Failed);
        assert!(
            !events[1].message.is_empty(),
            "failure should carry a reason"
        );

        // The target node (index 1) must never have been touched.
        assert!(
            events.iter().all(|e| e.index == 0),
            "probe must stop at the failed hop: {events:?}"
        );
    }

    /// A direct (no jump host) target whose host is unreachable is a single-node
    /// path (`total == 1`): the target node reports `Connecting` then `Failed`.
    #[tokio::test]
    async fn probe_direct_target_is_single_node_path() {
        let target = target_with_hops("127.0.0.1", 1, vec![]);

        let mut events: Vec<HopProgress> = Vec::new();
        let result = probe_connection_path(&target, None, &mut |p| events.push(p)).await;

        assert!(result.is_err());
        assert_eq!(events.len(), 2, "Connecting + Failed for the single node");
        assert!(events.iter().all(|e| e.index == 0 && e.total == 1));
        assert_eq!(events[0].status, HopStatus::Connecting);
        assert_eq!(events[1].status, HopStatus::Failed);
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
