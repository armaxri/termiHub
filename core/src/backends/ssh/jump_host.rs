//! SSH jump host (`ProxyJump`) connection support.
//!
//! Establishes an authenticated SSH session on a target host that is only
//! reachable through one or more bastion hops, mirroring OpenSSH's `-J` /
//! `ProxyJump`. Each hop is connected in turn; the connection to hop N+1 (or the
//! final target) is tunnelled over a `direct-tcpip` channel opened on hop N's
//! session — the same primitive the SSH tunnel forwarders use.

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::config::SshConfig;
use crate::errors::SessionError;

use super::auth::{connect_and_authenticate_cancellable, connect_and_authenticate_over_channel};
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

/// Bound a single hop's connect step by a per-hop timeout and an optional
/// cancellation token, naming the hop in any failure.
///
/// The channel-based connect path (`channel_open_direct_tcpip` +
/// [`connect_and_authenticate_over_channel`]) has no timeout of its own, so a
/// hung or blackholed intermediate hop would otherwise block the whole chain
/// indefinitely (#938). Wrapping each hop step here gives OpenSSH-like per-hop
/// `ConnectTimeout` semantics and a clear "which hop hung" error. Cancelling the
/// token (e.g. when the connection is torn down mid-connect) aborts a hung hop
/// promptly instead of waiting out the timeout, mirroring
/// [`connect_and_authenticate_cancellable`].
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
    connect_through_jump_hosts_cancellable(target, None).await
}

/// Like [`connect_through_jump_hosts`], but abortable via a [`CancellationToken`]
/// and with each hop bounded by a per-hop connect timeout.
///
/// Every step — the direct first hop, each channel-tunnelled intermediate hop,
/// and the final target — is bounded by that hop's
/// [`SshConfig::connect_timeout`] (intermediate hops fall back to the default
/// timeout, as [`JumpHostConfig`](crate::config::JumpHostConfig) carries no
/// per-hop override) and aborts promptly if `cancel` fires. A hung intermediate
/// hop therefore fails within its budget, naming the offending hop, instead of
/// hanging the whole chain (#938).
pub async fn connect_through_jump_hosts_cancellable(
    target: &SshConfig,
    cancel: Option<CancellationToken>,
) -> Result<JumpHostConnection, SessionError> {
    let hops = &target.proxy_jump;
    let first = hops
        .first()
        .ok_or_else(|| SessionError::SpawnFailed("Jump host chain is empty".to_string()))?;

    // First hop: an ordinary direct TCP connection, already bounded by its
    // connect timeout and cancellation (#841). Label failures with the hop.
    let first_cfg = first.to_ssh_config();
    let (mut current, _registry) =
        connect_and_authenticate_cancellable(&first_cfg, cancel.clone())
            .await
            .map_err(|e| {
                SessionError::SpawnFailed(format!(
                    "Jump host {}: {e}",
                    hop_label(1, &first_cfg.host, first_cfg.port)
                ))
            })?;
    let mut intermediates: Vec<SshSession> = Vec::new();

    // Each subsequent hop: open a direct-tcpip channel on the current session to
    // the next hop, then handshake/authenticate the next session over it — the
    // whole step bounded by the hop's timeout and cancellation.
    for (idx, hop) in hops.iter().enumerate().skip(1) {
        let cfg = hop.to_ssh_config();
        let label = hop_label(idx + 1, &cfg.host, cfg.port);
        let (next, _registry) = run_hop_step(
            &label,
            cfg.connect_timeout(),
            cancel.as_ref(),
            async {
                let channel = current
                    .channel_open_direct_tcpip(&cfg.host, cfg.port as u32, "localhost", 0)
                    .await
                    .map_err(|e| {
                        SessionError::SpawnFailed(format!("{label} channel failed: {e}"))
                    })?;
                connect_and_authenticate_over_channel(&cfg, channel).await
            },
        )
        .await?;
        intermediates.push(current);
        current = next;
    }

    // Final hop → target: tunnel the target session over the innermost hop,
    // bounded by the target's connect timeout and cancellation.
    let target_label = format!("target {}:{}", target.host, target.port);
    let (session, registry) = run_hop_step(
        &target_label,
        target.connect_timeout(),
        cancel.as_ref(),
        async {
            let channel = current
                .channel_open_direct_tcpip(&target.host, target.port as u32, "localhost", 0)
                .await
                .map_err(|e| {
                    SessionError::SpawnFailed(format!(
                        "Direct-tcpip channel to {target_label} failed: {e}"
                    ))
                })?;
            connect_and_authenticate_over_channel(target, channel).await
        },
    )
    .await?;
    intermediates.push(current);

    Ok(JumpHostConnection {
        session,
        registry,
        intermediates,
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
    use std::time::{Duration, Instant};

    /// A hung hop step (one that never resolves) must fail within the per-hop
    /// timeout — surfacing *which* hop hung — instead of blocking the whole
    /// chain indefinitely (#938).
    #[tokio::test]
    async fn hop_step_times_out_and_names_the_hop() {
        let label = "hop 2 (bastion:22)";
        let start = Instant::now();
        let result: Result<(), SessionError> = run_hop_step(
            label,
            Duration::from_secs(1),
            None,
            async {
                // A blackholed intermediate hop never completes the handshake.
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(())
            },
        )
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
        let result: Result<(), SessionError> = run_hop_step(
            label,
            Duration::from_secs(30),
            Some(&token),
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(())
            },
        )
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
        let result =
            run_hop_step("hop 2 (bastion:22)", Duration::from_secs(1), Some(&token), async {
                Ok::<_, SessionError>(42)
            })
            .await;
        assert_eq!(result.expect("hop should succeed"), 42);
    }
}
