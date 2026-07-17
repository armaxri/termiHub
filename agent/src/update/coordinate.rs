//! Coordinated update: tell every other host, wait for them to leave, proceed
//! (#1351, SI-5 / Approach 3 of the remote-agent update strategy).
//!
//! The [`UpdateStrategy::Coordinated`](super::UpdateStrategy::Coordinated) half
//! of the update story. `agent.request_update` broadcasts an
//! [`agent.update_pending`](crate::protocol::methods::AGENT_UPDATE_PENDING)
//! notification to every *other* client on the host, gives them a bounded window
//! to disconnect cleanly, and then hands the actual binary swap to the existing
//! deferred-apply path ([`SessionManager::request_deferred_update`]). Nothing in
//! this module applies an update; it only decides *when* it is polite to.
//!
//! ```text
//!   desktop A ──agent.request_update──► worker A
//!                                         │ broadcast (registry daemon, ADR-11)
//!                                         ▼
//!             worker B ──agent.update_pending──► desktop B  "being updated…"
//!                                         │                   └─ disconnects
//!                                         ▼
//!                       wait: peers gone? ──yes──► apply
//!                              └──10 s elapsed───► apply anyway
//! ```
//!
//! # The ack *is* the disconnect
//!
//! There is no `agent.update_ack` RPC, deliberately. The issue's contract is
//! "proceed when all disconnect or timeout", and a disconnect is already
//! observable host-wide: the registry drops a client's record when its worker
//! deregisters *or* when its socket closes, so a desktop that acks by leaving —
//! or that crashes — looks identical from here. An explicit ack would add
//! protocol surface that a crashed peer could never send, and would still need
//! this same timeout underneath it. So the peer set shrinking to nothing *is*
//! the ack, and [`wait_for_peers`] watches exactly that.
//!
//! # Why polling, and why that is not a hedge
//!
//! [`wait_for_peers`] polls the registry's client list rather than waiting on a
//! pushed "client left" event. The registry protocol has no such event, and
//! inventing one here would be new cross-worker protocol surface for a path that
//! runs **once per update, for at most ten seconds, against an in-memory list
//! over a local socket**. A hundred sub-millisecond round trips in the whole
//! life of an update is not a cost worth new wire vocabulary. If a future
//! feature needs live departure events for their own sake, that is the change
//! that should add them — not this one.
//!
//! # Degrading without lying
//!
//! Every failure here resolves to *proceed*, never to *block*. A registry that
//! cannot answer yields [`CoordinationOutcome::NoHostView`] and the update goes
//! ahead: the pre-registry behaviour was a hard cut with no notice at all, so a
//! missing registry must not be worse than not having had one. The outcome type
//! keeps these cases distinct so the RPC result can tell the caller *why* it
//! proceeded — coordinated, timed out, or unable to see the host — rather than
//! flattening them into a bare success.

use std::time::Duration;

use async_trait::async_trait;
use tracing::{debug, info, warn};

use crate::registry_daemon::client::RegistryClient;
use crate::registry_daemon::protocol::BroadcastEnvelope;

/// How long other hosts get to disconnect before the update proceeds anyway.
///
/// Ten seconds, from the issue's acceptance criteria. Long enough for a desktop
/// to render the notice, suspend its sessions and close its connection; short
/// enough that one wedged or already-dead peer cannot hold an update hostage.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// How often to re-read the host-wide client list while waiting.
///
/// A local round trip to an in-memory list, so the cost is noise; 100 ms bounds
/// the post-ack idle wait to a tenth of a second while keeping the worst case at
/// ~100 polls for the whole update.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// What the agent tells other hosts, and what it can see of them.
///
/// A trait rather than a bare [`RegistryClient`] so the ack/timeout machine is
/// unit-testable against a scripted peer set — the real registry needs two
/// processes and a socket, which is the integration suite's job, not a unit
/// test's.
#[async_trait]
pub trait PeerCoordinator: Send + Sync {
    /// `client_id`s of every client on this host **except** `self_id`, or `None`
    /// when the host-wide view is unavailable.
    ///
    /// `None` is "cannot see", not "nobody there" — the distinction is the whole
    /// reason this returns an `Option` (see [`CoordinationOutcome::NoHostView`]).
    async fn peer_ids(&self, self_id: &str) -> Option<Vec<String>>;

    /// Fan a notification out to every other worker on this host.
    fn broadcast(&self, envelope: BroadcastEnvelope);
}

#[async_trait]
impl PeerCoordinator for RegistryClient {
    async fn peer_ids(&self, self_id: &str) -> Option<Vec<String>> {
        let clients = self.list().await?;
        Some(
            clients
                .into_iter()
                .map(|c| c.client_id)
                .filter(|id| id != self_id)
                .collect(),
        )
    }

    fn broadcast(&self, envelope: BroadcastEnvelope) {
        RegistryClient::broadcast(self, envelope);
    }
}

/// Why the update was cleared to proceed.
///
/// Every variant means "go ahead" — they differ only in what the caller can
/// honestly report about the hosts it was coordinating with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinationOutcome {
    /// This was the only client on the host. Nothing was broadcast.
    NoPeers,
    /// Every notified peer disconnected inside [`ACK_TIMEOUT`].
    AllDisconnected {
        /// How many peers were notified.
        notified: u32,
    },
    /// [`ACK_TIMEOUT`] elapsed with peers still attached. They get the hard cut
    /// the pre-#1351 behaviour always gave them.
    TimedOut {
        /// How many peers were notified.
        notified: u32,
        /// `client_id`s still attached when the window closed.
        remaining: Vec<String>,
    },
    /// No host-wide view — the registry is absent, starting, or wedged. Nothing
    /// was broadcast because there is no one to broadcast through.
    NoHostView,
}

impl CoordinationOutcome {
    /// How many other hosts were told about this update.
    pub fn notified(&self) -> u32 {
        match self {
            Self::AllDisconnected { notified } | Self::TimedOut { notified, .. } => *notified,
            Self::NoPeers | Self::NoHostView => 0,
        }
    }

    /// Whether every notified peer left before the window closed.
    ///
    /// `true` for [`NoPeers`](Self::NoPeers) — an empty set is trivially all
    /// gone, and the caller's question is "was anyone cut off?", not "did anyone
    /// ack?".
    pub fn all_acked(&self) -> bool {
        matches!(self, Self::NoPeers | Self::AllDisconnected { .. })
    }
}

/// Notify every other host, then wait for them to leave (or for the window to
/// close).
///
/// Returns once it is time to apply the update. Never fails: see the module
/// docs on degrading without lying.
pub async fn coordinate_update(
    coordinator: &dyn PeerCoordinator,
    self_id: &str,
    notification: BroadcastEnvelope,
    timeout: Duration,
) -> CoordinationOutcome {
    let Some(peers) = coordinator.peer_ids(self_id).await else {
        warn!("Coordinated update: no host-wide view; proceeding without notifying peers");
        return CoordinationOutcome::NoHostView;
    };

    if peers.is_empty() {
        debug!("Coordinated update: no other hosts attached; proceeding immediately");
        return CoordinationOutcome::NoPeers;
    }

    let notified = peers.len() as u32;
    info!(
        "Coordinated update: notifying {notified} other host(s); waiting up to {}s for them to disconnect",
        timeout.as_secs()
    );
    coordinator.broadcast(notification);

    wait_for_peers(coordinator, self_id, peers, timeout).await
}

/// Poll the host-wide client set until the peers are gone or `timeout` elapses.
///
/// `peers` is the census the broadcast went to; it seeds the "still attached"
/// set so that a view which dies immediately after the census still reports who
/// was cut off, rather than an empty list that would read as a clean ack.
async fn wait_for_peers(
    coordinator: &dyn PeerCoordinator,
    self_id: &str,
    peers: Vec<String>,
    timeout: Duration,
) -> CoordinationOutcome {
    let notified = peers.len() as u32;
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_seen: Vec<String> = peers;

    loop {
        match coordinator.peer_ids(self_id).await {
            Some(peers) if peers.is_empty() => {
                info!("Coordinated update: all {notified} host(s) disconnected; proceeding");
                return CoordinationOutcome::AllDisconnected { notified };
            }
            Some(peers) => last_seen = peers,
            // The view blinked out mid-wait (registry restarting). Keep waiting
            // on the last set we saw rather than treating an unanswered poll as
            // either an ack or a failure — the supervisor reconnects on its own,
            // and the timeout still bounds us.
            None => debug!("Coordinated update: host view unavailable mid-wait; retrying"),
        }

        let now = tokio::time::Instant::now();
        if now >= deadline {
            warn!(
                "Coordinated update: {} host(s) still attached after {}s; proceeding anyway",
                last_seen.len(),
                timeout.as_secs()
            );
            return CoordinationOutcome::TimedOut {
                notified,
                remaining: last_seen,
            };
        }

        // Never sleep past the deadline: the last poll of the window must land
        // on it, not after it.
        tokio::time::sleep(POLL_INTERVAL.min(deadline - now)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    /// A scripted host: each `peer_ids` call pops the next programmed answer,
    /// and the final one repeats forever (so "they never leave" is expressible
    /// without scripting 100 identical polls).
    struct ScriptedHost {
        answers: Mutex<VecDeque<Option<Vec<String>>>>,
        broadcasts: Mutex<Vec<BroadcastEnvelope>>,
        polls: Mutex<u32>,
    }

    impl ScriptedHost {
        fn new(answers: Vec<Option<Vec<&str>>>) -> Self {
            let answers = answers
                .into_iter()
                .map(|a| a.map(|ids| ids.into_iter().map(String::from).collect()))
                .collect();
            Self {
                answers: Mutex::new(answers),
                broadcasts: Mutex::new(Vec::new()),
                polls: Mutex::new(0),
            }
        }

        fn broadcasts(&self) -> Vec<BroadcastEnvelope> {
            self.broadcasts.lock().unwrap().clone()
        }

        fn polls(&self) -> u32 {
            *self.polls.lock().unwrap()
        }
    }

    #[async_trait]
    impl PeerCoordinator for ScriptedHost {
        async fn peer_ids(&self, _self_id: &str) -> Option<Vec<String>> {
            *self.polls.lock().unwrap() += 1;
            let mut answers = self.answers.lock().unwrap();
            if answers.len() > 1 {
                answers.pop_front().flatten()
            } else {
                answers.front().cloned().flatten()
            }
        }

        fn broadcast(&self, envelope: BroadcastEnvelope) {
            self.broadcasts.lock().unwrap().push(envelope);
        }
    }

    fn envelope() -> BroadcastEnvelope {
        BroadcastEnvelope {
            origin_client_id: "self".into(),
            method: "agent.update_pending".into(),
            params: json!({"requestedByVersion": "1.2.3", "estimatedRestartSecs": 5}),
        }
    }

    /// A lone desktop must not pay the coordination cost — nothing to tell, and
    /// crucially no 10 s wait for an empty set.
    #[tokio::test]
    async fn lone_client_proceeds_without_broadcasting() {
        let host = ScriptedHost::new(vec![Some(vec![])]);

        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        assert_eq!(outcome, CoordinationOutcome::NoPeers);
        assert!(
            host.broadcasts().is_empty(),
            "nothing to broadcast to an empty host"
        );
        assert!(outcome.all_acked(), "an empty peer set cuts nobody off");
        assert_eq!(outcome.notified(), 0);
    }

    /// The requester is never its own peer — otherwise every update would wait
    /// ten seconds for the desktop that asked for it to disconnect.
    #[tokio::test]
    async fn the_requesting_client_is_not_a_peer() {
        // The real `RegistryClient::peer_ids` filters; this asserts the contract
        // that `coordinate_update` relies on it having done so.
        let host = ScriptedHost::new(vec![Some(vec![])]);
        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;
        assert_eq!(outcome, CoordinationOutcome::NoPeers);
    }

    /// The acceptance criterion's happy path: peers are told, peers leave, the
    /// update proceeds without burning the timeout.
    #[tokio::test(start_paused = true)]
    async fn peers_that_disconnect_release_the_update_early() {
        let host = ScriptedHost::new(vec![
            Some(vec!["b", "c"]), // pre-broadcast census
            Some(vec!["b", "c"]), // still there
            Some(vec!["c"]),      // b left
            Some(vec![]),         // c left
        ]);

        let start = tokio::time::Instant::now();
        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        assert_eq!(outcome, CoordinationOutcome::AllDisconnected { notified: 2 });
        assert!(outcome.all_acked());
        assert!(
            tokio::time::Instant::now() - start < ACK_TIMEOUT,
            "must proceed on the last disconnect, not on the timeout"
        );
        assert_eq!(host.broadcasts(), vec![envelope()], "peers must be told once");
    }

    /// "Host B never acks" — the timeout path the issue calls out explicitly.
    #[tokio::test(start_paused = true)]
    async fn a_peer_that_never_leaves_does_not_block_the_update() {
        let host = ScriptedHost::new(vec![Some(vec!["b"])]);

        let start = tokio::time::Instant::now();
        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;
        let waited = tokio::time::Instant::now() - start;

        assert_eq!(
            outcome,
            CoordinationOutcome::TimedOut {
                notified: 1,
                remaining: vec!["b".to_string()],
            }
        );
        assert!(!outcome.all_acked(), "a stuck peer is reported, not hidden");
        assert!(
            waited >= ACK_TIMEOUT,
            "must give the peer the full window: waited {waited:?}"
        );
        assert!(
            waited < ACK_TIMEOUT + POLL_INTERVAL * 2,
            "must not overshoot the window: waited {waited:?}"
        );
    }

    /// A missing registry must degrade to the pre-#1351 hard cut, not to a
    /// blocked update — and must not claim it notified anyone.
    #[tokio::test(start_paused = true)]
    async fn no_host_view_proceeds_without_waiting() {
        let host = ScriptedHost::new(vec![None]);

        let start = tokio::time::Instant::now();
        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        assert_eq!(outcome, CoordinationOutcome::NoHostView);
        assert_eq!(outcome.notified(), 0);
        assert!(!outcome.all_acked());
        assert!(host.broadcasts().is_empty(), "no view means no one to tell");
        assert!(
            tokio::time::Instant::now() - start < ACK_TIMEOUT,
            "an absent registry must not cost the full window"
        );
    }

    /// A registry restart mid-wait must not be read as "everyone left" — that
    /// would cut the peers off precisely when we cannot see them.
    #[tokio::test(start_paused = true)]
    async fn a_blinking_registry_mid_wait_is_not_an_ack() {
        let host = ScriptedHost::new(vec![
            Some(vec!["b"]), // census
            None,            // registry restarting
            None,            // still restarting
            Some(vec!["b"]), // back, b is still there
            Some(vec![]),    // b leaves
        ]);

        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        assert_eq!(outcome, CoordinationOutcome::AllDisconnected { notified: 1 });
    }

    /// When the view is down for the whole window, the peers we knew about are
    /// still reported as cut off rather than silently forgotten.
    #[tokio::test(start_paused = true)]
    async fn a_view_lost_for_the_whole_window_reports_the_last_known_peers() {
        let host = ScriptedHost::new(vec![
            Some(vec!["b"]), // census
            None,            // and never answers again
        ]);

        let outcome = coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        assert_eq!(
            outcome,
            CoordinationOutcome::TimedOut {
                notified: 1,
                remaining: vec!["b".to_string()],
            }
        );
    }

    /// The notification must reach peers verbatim — a receiving worker replays
    /// it without interpreting it, so anything lost here is lost for good.
    #[tokio::test(start_paused = true)]
    async fn the_broadcast_carries_the_notification_verbatim() {
        let host = ScriptedHost::new(vec![Some(vec!["b"]), Some(vec![])]);

        coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        let sent = host.broadcasts();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].origin_client_id, "self");
        assert_eq!(sent[0].method, "agent.update_pending");
        assert_eq!(sent[0].params["requestedByVersion"], "1.2.3");
        assert_eq!(sent[0].params["estimatedRestartSecs"], 5);
    }

    /// The window is polled, not slept through: a peer leaving early is noticed
    /// within a poll interval rather than at the deadline.
    #[tokio::test(start_paused = true)]
    async fn the_wait_polls_rather_than_sleeping_out_the_window() {
        let host = ScriptedHost::new(vec![Some(vec!["b"]), Some(vec!["b"]), Some(vec![])]);

        coordinate_update(&host, "self", envelope(), ACK_TIMEOUT).await;

        // census + two waits — proof the loop re-reads instead of waiting once.
        assert_eq!(host.polls(), 3);
    }

    /// A caller-supplied window is honoured, so a test (or a future setting)
    /// need not sit through ten seconds.
    #[tokio::test(start_paused = true)]
    async fn a_custom_timeout_is_honoured() {
        let host = ScriptedHost::new(vec![Some(vec!["b"])]);
        let timeout = Duration::from_millis(300);

        let start = tokio::time::Instant::now();
        let outcome = coordinate_update(&host, "self", envelope(), timeout).await;
        let waited = tokio::time::Instant::now() - start;

        assert!(matches!(outcome, CoordinationOutcome::TimedOut { .. }));
        assert!(waited >= timeout && waited < timeout + POLL_INTERVAL * 2);
    }

    #[test]
    fn the_documented_window_is_the_issues_ten_seconds() {
        assert_eq!(ACK_TIMEOUT, Duration::from_secs(10));
    }
}
