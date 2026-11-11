//! Reaping monitoring subscriptions no client can receive (#5306).
//!
//! A `--listen` agent keeps its [`MonitoringManager`] across client
//! connections, so a monitor survives a transport reconnect: the desktop's
//! agent link drops (an SSH blip, a laptop sleep) and comes back, and the
//! status bar keeps streaming without a re-subscribe. The flip side is that a
//! desktop that goes away for good (app quit or crash while the agent was
//! unreachable) leaves every collect loop it started polling forever, with
//! nobody listening.
//!
//! The rule: once the **last** connected client disconnects, every
//! subscription gets a grace period ([`ORPHAN_GRACE`]). A client that connects
//! within it keeps the subscriptions exactly as they are — same collect loop,
//! no gap — and may re-subscribe (which replaces in place) as usual. When the
//! grace ends with no client connected, every subscription is stopped. A
//! client that connects later simply subscribes again.
//!
//! Stdio mode never calls into this: its agent process exits with its client,
//! which already stops every monitor.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

use super::MonitoringManager;

/// How long monitoring subscriptions outlive the last client's disconnect.
///
/// The desktop's reconnect loops give up after
/// [`RECONNECT_GIVE_UP_WINDOW_MS`](termihub_core::reconnect_backoff::RECONNECT_GIVE_UP_WINDOW_MS)
/// (181 s of backoff, plus each attempt's own connect timeout), so a grace of
/// five minutes covers every reconnect the desktop would make on its own, with
/// room to spare. Session daemons, by contrast, are unbounded by default
/// (`TERMIHUB_DAEMON_DETACHED_TIMEOUT_SECS`) because a shell's state cannot be
/// recreated; a monitor can, by one `connection.monitoring.subscribe`, so it is
/// bounded. Like the registry daemon's idle timeout, erring low costs only a
/// re-subscribe.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(300);

/// Env var overriding [`ORPHAN_GRACE`], in whole seconds.
///
/// An absent, empty, zero or non-numeric value keeps the default, so a typo
/// can never turn the reap off or make it immediate.
pub const ORPHAN_GRACE_ENV: &str = "TERMIHUB_AGENT_MONITORING_ORPHAN_GRACE_SECS";

/// The configured orphan grace: [`ORPHAN_GRACE_ENV`] or [`ORPHAN_GRACE`].
pub fn orphan_grace_from_env() -> Duration {
    orphan_grace_from(|key| std::env::var(key).ok())
}

/// [`orphan_grace_from_env`] over an injected environment `lookup`.
fn orphan_grace_from(lookup: impl Fn(&str) -> Option<String>) -> Duration {
    crate::daemon::process::positive_secs(lookup(ORPHAN_GRACE_ENV).as_deref())
        .unwrap_or(ORPHAN_GRACE)
}

/// Which clients are connected, and the reap armed for when none is.
#[derive(Default)]
pub(super) struct ClientPresence {
    /// Clients currently connected.
    connected: usize,
    /// Bumped on every connect and every arming, so a reap armed by an
    /// earlier disconnect never fires after a later reconnect.
    generation: u64,
    /// Cancels the armed reap's timer.
    pending: Option<CancellationToken>,
}

impl MonitoringManager {
    /// A client connected: cancel any armed reap. Its subscriptions keep
    /// running untouched.
    pub fn client_connected(&self) {
        let mut presence = self.lock_presence();
        presence.connected += 1;
        presence.generation += 1;
        if let Some(pending) = presence.pending.take() {
            pending.cancel();
            debug!("Client reconnected within the monitoring grace; keeping subscriptions");
        }
    }

    /// A client disconnected. When it was the last one, arm a reap that stops
    /// every subscription after `grace` unless a client connects first.
    pub fn client_disconnected(self: &Arc<Self>, grace: Duration) {
        let (generation, cancel) = {
            let mut presence = self.lock_presence();
            presence.connected = presence.connected.saturating_sub(1);
            if presence.connected > 0 {
                return;
            }
            presence.generation += 1;
            let cancel = CancellationToken::new();
            if let Some(old) = presence.pending.replace(cancel.clone()) {
                old.cancel();
            }
            (presence.generation, cancel)
        };

        // Weak: an armed reap must not keep a shut-down manager alive.
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(grace) => {
                    if let Some(manager) = manager.upgrade() {
                        manager.reap_if_orphaned(generation, grace).await;
                    }
                }
            }
        });
    }

    /// Stop every subscription, unless a client connected since the reap for
    /// `generation` was armed.
    async fn reap_if_orphaned(&self, generation: u64, grace: Duration) {
        // Check presence under the subscriptions lock: a client's subscribe
        // inserts under it and always follows its connect, so a subscription
        // made by a client that connected after this check is never drained.
        let drained: Vec<_> = {
            let mut subs = self.subscriptions.lock().await;
            {
                let mut presence = self.lock_presence();
                if presence.connected > 0 || presence.generation != generation {
                    return;
                }
                presence.pending = None;
            }
            subs.drain().collect()
        };
        if drained.is_empty() {
            return;
        }
        info!(
            "No client connected for {}s; stopping {} orphaned monitoring subscription(s)",
            grace.as_secs(),
            drained.len()
        );
        for (host, sub) in drained {
            sub.stop().await;
            debug!("Reaped orphaned monitoring subscription for '{host}'");
        }
    }

    fn lock_presence(&self) -> std::sync::MutexGuard<'_, ClientPresence> {
        // Nothing panics while holding this lock (it only updates counters), so
        // a poisoned guard's state is still consistent.
        self.presence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
#[path = "orphan_reaper_tests.rs"]
mod tests;
