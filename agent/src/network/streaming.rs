//! Streaming tool runs: `tool.start` / `tool.cancel` (#3353).
//!
//! The collect-and-return `tool.run` gathers a whole run before replying, so the
//! desktop's 60 s request timeout caps it, results arrive all at once, and Stop
//! cannot reach the agent. A streaming run fixes all three:
//!
//! * `tool.start` validates the request, spawns the core [`ToolRegistry`] tool in
//!   its own task, and **returns at once**;
//! * every [`ToolEvent`] the tool emits is buffered in a bounded per-run
//!   [`StreamingHost`] and flushed to the client as `tool.event` notifications —
//!   batched (coalesced) up to [`MAX_BATCH_EVENTS`] per notification, at least
//!   every [`FLUSH_INTERVAL`];
//! * the run ends with exactly one `tool.done` carrying the aggregate or error;
//! * `tool.cancel` trips the run's [`CancellationToken`]; the tool stops early and
//!   `tool.done` reports `cancelled: true` with its partial aggregate.
//!
//! Orphan protection: every run is a child of the connection's token, so
//! [`ToolRunManager::shutdown`] (called when the client disconnects) cancels them
//! all and suppresses any further notification — nothing leaks into the next
//! client of a `--listen` agent. Independently, a run is cancelled once it has
//! lived for [`MAX_RUN_LIFETIME`], and a tool that ignores cancellation is
//! abandoned after [`CANCEL_GRACE`].

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Notify;
use tokio::time::{MissedTickBehavior, Sleep};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use termihub_core::tool::{ToolError, ToolEvent, ToolHost, ToolRegistry};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{
    ToolDoneNotification, ToolEventNotification, TOOL_DONE, TOOL_EVENT,
};

/// Most streaming runs one connection may have in flight at once.
pub const MAX_CONCURRENT_RUNS: usize = 16;

/// Generous per-run lifetime cap. A run still going after this long is
/// cancelled, so a desktop that lost track of a run (or an unbounded ping) can
/// never leave it running forever.
pub const MAX_RUN_LIFETIME: Duration = Duration::from_secs(4 * 60 * 60);

/// How long a cancelled run may take to return before it is abandoned.
pub const CANCEL_GRACE: Duration = Duration::from_secs(10);

/// Bound on events buffered for one run and not yet flushed. Beyond it events
/// are dropped (and counted in `tool.done`'s `droppedEvents`) instead of growing
/// memory without limit.
pub const MAX_PENDING_EVENTS: usize = 65_536;

/// Most events coalesced into one `tool.event` notification. Keeps each NDJSON
/// line far below the protocol's 1 MiB limit.
pub const MAX_BATCH_EVENTS: usize = 256;

/// Upper bound on how long an emitted event waits before it is flushed.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// Longest accepted run id.
pub const MAX_RUN_ID_LEN: usize = 128;

/// Tunable limits for a [`ToolRunManager`]; production uses [`RunLimits::default`],
/// tests shrink them to drive the paths under paused time.
#[derive(Debug, Clone, Copy)]
pub struct RunLimits {
    pub max_concurrent: usize,
    pub max_lifetime: Duration,
    pub cancel_grace: Duration,
    pub max_pending: usize,
}

impl Default for RunLimits {
    fn default() -> Self {
        Self {
            max_concurrent: MAX_CONCURRENT_RUNS,
            max_lifetime: MAX_RUN_LIFETIME,
            cancel_grace: CANCEL_GRACE,
            max_pending: MAX_PENDING_EVENTS,
        }
    }
}

/// Why `tool.start` refused a run.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StartError {
    #[error("streaming tool runs are not available on this connection")]
    Unavailable,
    #[error("Unknown tool: {0}")]
    UnknownTool(String),
    #[error("invalid run id (must be 1..={MAX_RUN_ID_LEN} characters)")]
    InvalidRunId,
    #[error("a run with id '{0}' is already active")]
    DuplicateRunId(String),
    #[error("too many concurrent tool runs (limit {0})")]
    TooManyRuns(usize),
}

// ── Streaming host ────────────────────────────────────────────────────────

#[derive(Default)]
struct HostBuffer {
    pending: VecDeque<ToolEvent>,
    dropped: u64,
}

/// A [`ToolHost`] that queues events in a bounded buffer and wakes the run's
/// flusher once a full batch is ready. `emit` never blocks.
struct StreamingHost {
    buf: Mutex<HostBuffer>,
    ready: Notify,
    max_pending: usize,
}

impl StreamingHost {
    fn new(max_pending: usize) -> Self {
        Self {
            buf: Mutex::new(HostBuffer::default()),
            ready: Notify::new(),
            max_pending,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HostBuffer> {
        self.buf.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Take up to [`MAX_BATCH_EVENTS`] queued events, oldest first.
    fn take_batch(&self) -> Vec<ToolEvent> {
        let mut buf = self.lock();
        let n = buf.pending.len().min(MAX_BATCH_EVENTS);
        buf.pending.drain(..n).collect()
    }

    fn dropped(&self) -> u64 {
        self.lock().dropped
    }
}

impl ToolHost for StreamingHost {
    fn emit(&self, event: ToolEvent) {
        let full_batch = {
            let mut buf = self.lock();
            if buf.pending.len() >= self.max_pending {
                buf.dropped += 1;
                false
            } else {
                buf.pending.push_back(event);
                buf.pending.len() >= MAX_BATCH_EVENTS
            }
        };
        if full_batch {
            self.ready.notify_one();
        }
    }
}

// ── Run manager ───────────────────────────────────────────────────────────

/// Per-connection registry of streaming tool runs.
pub struct ToolRunManager {
    /// Where `tool.event` / `tool.done` go. Unset on a handler with no transport
    /// (unit tests), which then reports streaming as unavailable.
    notification_tx: OnceLock<NotificationSender>,
    /// Active runs by id → their cancellation token.
    runs: Mutex<HashMap<String, CancellationToken>>,
    /// Parent of every run's token; cancelled when the client disconnects.
    connection: CancellationToken,
    limits: RunLimits,
}

impl ToolRunManager {
    pub fn new(limits: RunLimits) -> Arc<Self> {
        Arc::new(Self {
            notification_tx: OnceLock::new(),
            runs: Mutex::new(HashMap::new()),
            connection: CancellationToken::new(),
            limits,
        })
    }

    /// Wire the connection's notification channel. Only the first call wins.
    pub fn set_notification_sender(&self, tx: NotificationSender) {
        let _ = self.notification_tx.set(tx);
    }

    /// Whether `tool.start` can be served (advertised as `toolStreaming`).
    pub fn is_available(&self) -> bool {
        self.notification_tx.get().is_some() && !self.connection.is_cancelled()
    }

    fn runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Number of runs still in flight.
    pub fn active_runs(&self) -> usize {
        self.runs().len()
    }

    /// Validate and launch a run. Returns once the run is registered; its
    /// results stream as notifications.
    pub fn start(
        self: &Arc<Self>,
        registry: Arc<ToolRegistry>,
        run_id: String,
        tool_id: String,
        params: Value,
    ) -> Result<(), StartError> {
        if !self.is_available() {
            return Err(StartError::Unavailable);
        }
        if run_id.is_empty() || run_id.len() > MAX_RUN_ID_LEN {
            return Err(StartError::InvalidRunId);
        }
        if !registry.has_tool(&tool_id) {
            return Err(StartError::UnknownTool(tool_id));
        }
        let cancel = self.connection.child_token();
        {
            let mut runs = self.runs();
            if runs.contains_key(&run_id) {
                return Err(StartError::DuplicateRunId(run_id));
            }
            if runs.len() >= self.limits.max_concurrent {
                return Err(StartError::TooManyRuns(self.limits.max_concurrent));
            }
            runs.insert(run_id.clone(), cancel.clone());
        }

        debug!(%run_id, %tool_id, "tool run started");
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let done = manager
                .drive(&registry, &run_id, &tool_id, params, cancel)
                .await;
            manager.runs().remove(&run_id);
            debug!(%run_id, cancelled = done.cancelled, "tool run finished");
            manager.notify(TOOL_DONE, &done);
        });
        Ok(())
    }

    /// Cancel a run. Idempotent: `false` when the id is unknown or finished.
    pub fn cancel(&self, run_id: &str) -> bool {
        match self.runs().get(run_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// The client disconnected: cancel every run and stop notifying.
    pub fn shutdown(&self) {
        self.connection.cancel();
    }

    /// Send a notification unless the connection is gone.
    fn notify<T: serde::Serialize>(&self, method: &str, params: &T) {
        if self.connection.is_cancelled() {
            return;
        }
        let Some(tx) = self.notification_tx.get() else {
            return;
        };
        match serde_json::to_value(params) {
            Ok(value) => {
                let _ = tx.send(JsonRpcNotification::new(method, value));
            }
            Err(e) => warn!("failed to serialize {method}: {e}"),
        }
    }

    /// Flush every queued event as `tool.event` batches.
    fn flush(&self, run_id: &str, host: &StreamingHost) {
        loop {
            let events = host.take_batch();
            if events.is_empty() {
                return;
            }
            self.notify(
                TOOL_EVENT,
                &ToolEventNotification {
                    run_id: run_id.to_string(),
                    events,
                },
            );
        }
    }

    /// Run the tool to completion (or cancellation), streaming as it goes, and
    /// build the `tool.done` params.
    async fn drive(
        &self,
        registry: &ToolRegistry,
        run_id: &str,
        tool_id: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> ToolDoneNotification {
        let host = Arc::new(StreamingHost::new(self.limits.max_pending));
        let dyn_host: Arc<dyn ToolHost> = host.clone();
        let run = registry.run(tool_id, params, dyn_host, cancel.clone());
        tokio::pin!(run);

        let lifetime = tokio::time::sleep(self.limits.max_lifetime);
        tokio::pin!(lifetime);
        let mut lifetime_hit = false;
        let mut grace: Option<Pin<Box<Sleep>>> = None;
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

        let outcome = loop {
            tokio::select! {
                res = &mut run => break Some(res),
                _ = host.ready.notified() => self.flush(run_id, &host),
                _ = ticker.tick() => self.flush(run_id, &host),
                _ = &mut lifetime, if !lifetime_hit => {
                    lifetime_hit = true;
                    warn!(%run_id, "tool run exceeded its lifetime cap; cancelling");
                    cancel.cancel();
                }
                _ = cancel.cancelled(), if grace.is_none() => {
                    grace = Some(Box::pin(tokio::time::sleep(self.limits.cancel_grace)));
                }
                _ = wait_optional(&mut grace) => {
                    warn!(%run_id, "tool ignored cancellation; abandoning the run");
                    break None;
                }
            }
        };
        self.flush(run_id, &host);

        let mut done = ToolDoneNotification {
            run_id: run_id.to_string(),
            cancelled: cancel.is_cancelled(),
            dropped_events: host.dropped(),
            ..Default::default()
        };
        match outcome {
            Some(Ok(result)) => done.result = Some(result),
            Some(Err(ToolError::Cancelled(_))) => {
                done.cancelled = true;
                done.error = Some("tool run was cancelled".to_string());
            }
            Some(Err(e)) => done.error = Some(e.to_string()),
            None => done.error = Some("tool run did not stop after cancel".to_string()),
        }
        if lifetime_hit && done.result.is_none() && done.error.is_none() {
            done.error = Some("tool run exceeded the agent's lifetime cap".to_string());
        }
        done
    }
}

/// Await the grace timer when armed; pend forever otherwise.
fn wait_optional(timer: &mut Option<Pin<Box<Sleep>>>) -> impl Future<Output = ()> + '_ {
    async move {
        match timer.as_mut() {
            Some(t) => t.as_mut().await,
            None => std::future::pending::<()>().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use termihub_core::tool::Tool;
    use tokio::sync::mpsc::UnboundedReceiver;

    /// Emits `count` `tick` events, sleeping `step` between them; honours
    /// cancellation by returning its partial count.
    struct SlowTool {
        count: u64,
        step: Duration,
    }

    #[async_trait]
    impl Tool for SlowTool {
        fn tool_id(&self) -> &str {
            "slow"
        }
        fn display_name(&self) -> &str {
            "Slow"
        }
        async fn run(
            &self,
            _params: Value,
            host: Arc<dyn ToolHost>,
            cancel: CancellationToken,
        ) -> Result<Value, ToolError> {
            let mut sent = 0u64;
            for i in 0..self.count {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(self.step) => {}
                }
                host.emit(ToolEvent::new("tick", json!({ "i": i })));
                sent += 1;
            }
            Ok(json!({ "sent": sent }))
        }
    }

    /// Never returns, ignoring cancellation.
    struct StuckTool;

    #[async_trait]
    impl Tool for StuckTool {
        fn tool_id(&self) -> &str {
            "stuck"
        }
        fn display_name(&self) -> &str {
            "Stuck"
        }
        async fn run(
            &self,
            _params: Value,
            _host: Arc<dyn ToolHost>,
            _cancel: CancellationToken,
        ) -> Result<Value, ToolError> {
            std::future::pending::<()>().await;
            Ok(json!({}))
        }
    }

    fn registry(count: u64, step: Duration) -> Arc<ToolRegistry> {
        let mut r = ToolRegistry::new();
        r.register(Arc::new(SlowTool { count, step }));
        r.register(Arc::new(StuckTool));
        Arc::new(r)
    }

    fn manager(limits: RunLimits) -> (Arc<ToolRunManager>, UnboundedReceiver<JsonRpcNotification>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let m = ToolRunManager::new(limits);
        m.set_notification_sender(tx);
        (m, rx)
    }

    /// Drain notifications for `run_id` until `tool.done`; returns
    /// `(events_in_order, done)`.
    async fn collect(
        rx: &mut UnboundedReceiver<JsonRpcNotification>,
    ) -> (Vec<ToolEvent>, Vec<usize>, ToolDoneNotification) {
        let mut events = Vec::new();
        let mut batches = Vec::new();
        loop {
            let n = rx.recv().await.expect("channel open");
            match n.method.as_str() {
                TOOL_EVENT => {
                    let ev: ToolEventNotification = serde_json::from_value(n.params).unwrap();
                    assert!(!ev.events.is_empty(), "never an empty batch");
                    batches.push(ev.events.len());
                    events.extend(ev.events);
                }
                TOOL_DONE => {
                    let done: ToolDoneNotification = serde_json::from_value(n.params).unwrap();
                    return (events, batches, done);
                }
                other => panic!("unexpected notification {other}"),
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn streams_events_live_then_done() {
        let (m, mut rx) = manager(RunLimits::default());
        m.start(
            registry(3, Duration::from_secs(1)),
            "r1".into(),
            "slow".into(),
            json!({}),
        )
        .unwrap();

        // The first event is flushed long before the run finishes.
        let first = rx.recv().await.unwrap();
        assert_eq!(first.method, TOOL_EVENT);
        assert_eq!(first.params["runId"], "r1");
        assert_eq!(first.params["events"][0]["payload"]["i"], 0);

        let (rest, _, done) = collect(&mut rx).await;
        assert_eq!(rest.len(), 2);
        assert_eq!(done.run_id, "r1");
        assert_eq!(done.result, Some(json!({ "sent": 3 })));
        assert!(!done.cancelled);
        assert!(done.error.is_none());
        assert_eq!(m.active_runs(), 0);
    }

    /// A run far longer than the desktop's old 60 s request bound streams to
    /// completion — paused time, no real waiting.
    #[tokio::test(start_paused = true)]
    async fn run_longer_than_sixty_seconds_completes() {
        let (m, mut rx) = manager(RunLimits::default());
        // 1000 events, one every 150 ms → 150 s of (virtual) run time.
        m.start(
            registry(1000, Duration::from_millis(150)),
            "long".into(),
            "slow".into(),
            json!({}),
        )
        .unwrap();
        let started = tokio::time::Instant::now();
        let (events, _, done) = collect(&mut rx).await;
        assert!(started.elapsed() > Duration::from_secs(60));
        assert_eq!(events.len(), 1000);
        // Order is preserved across batches.
        for (i, e) in events.iter().enumerate() {
            assert_eq!(e.payload["i"], i as u64);
        }
        assert_eq!(done.result, Some(json!({ "sent": 1000 })));
    }

    #[tokio::test(start_paused = true)]
    async fn bursts_are_coalesced_into_bounded_batches() {
        let (m, mut rx) = manager(RunLimits::default());
        // 1000 events with no delay between them → coalesced batches.
        m.start(
            registry(1000, Duration::ZERO),
            "burst".into(),
            "slow".into(),
            json!({}),
        )
        .unwrap();
        let (events, batches, done) = collect(&mut rx).await;
        assert_eq!(events.len(), 1000);
        assert!(batches.iter().all(|&n| n <= MAX_BATCH_EVENTS));
        assert!(
            batches.len() < 1000,
            "events must be coalesced: {batches:?}"
        );
        assert_eq!(done.dropped_events, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_buffer_drops_and_counts_overflow() {
        let limits = RunLimits {
            max_pending: 10,
            ..RunLimits::default()
        };
        let host = StreamingHost::new(limits.max_pending);
        for i in 0..25 {
            host.emit(ToolEvent::new("tick", json!({ "i": i })));
        }
        assert_eq!(host.dropped(), 15);
        assert_eq!(host.take_batch().len(), 10);
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_stops_the_run_and_reports_cancelled() {
        let (m, mut rx) = manager(RunLimits::default());
        m.start(
            registry(1000, Duration::from_secs(1)),
            "c1".into(),
            "slow".into(),
            json!({}),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(3500)).await;
        assert!(m.cancel("c1"));
        let (events, _, done) = collect(&mut rx).await;
        assert!(done.cancelled);
        assert!(done.error.is_none(), "partial aggregate, not an error");
        let sent = done.result.unwrap()["sent"].as_u64().unwrap();
        assert!(sent < 1000);
        assert_eq!(events.len() as u64, sent);
        // Idempotent once finished.
        assert!(!m.cancel("c1"));
        assert_eq!(m.active_runs(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn connection_drop_cancels_runs_and_goes_silent() {
        let (m, mut rx) = manager(RunLimits::default());
        let reg = registry(1000, Duration::from_secs(1));
        m.start(reg.clone(), "a".into(), "slow".into(), json!({}))
            .unwrap();
        m.start(reg, "b".into(), "slow".into(), json!({})).unwrap();
        assert_eq!(m.active_runs(), 2);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        m.shutdown();
        // Let the runs observe the cancel and unwind.
        for _ in 0..50 {
            if m.active_runs() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(m.active_runs(), 0, "runs cleaned up");
        // Nothing — not even tool.done — is sent after the drop.
        while let Ok(n) = rx.try_recv() {
            assert_eq!(n.method, TOOL_EVENT, "only pre-drop events: {n:?}");
        }
        assert!(!m.is_available());
        assert_eq!(
            m.start(
                registry(1, Duration::ZERO),
                "c".into(),
                "slow".into(),
                json!({})
            ),
            Err(StartError::Unavailable)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn lifetime_cap_cancels_a_run() {
        let limits = RunLimits {
            max_lifetime: Duration::from_secs(5),
            ..RunLimits::default()
        };
        let (m, mut rx) = manager(limits);
        m.start(
            registry(1000, Duration::from_secs(1)),
            "l".into(),
            "slow".into(),
            json!({}),
        )
        .unwrap();
        let (_, _, done) = collect(&mut rx).await;
        assert!(done.cancelled);
        let sent = done.result.unwrap()["sent"].as_u64().unwrap();
        assert!((4..=5).contains(&sent), "stopped at the cap, sent {sent}");
    }

    #[tokio::test(start_paused = true)]
    async fn tool_ignoring_cancel_is_abandoned_after_grace() {
        let (m, mut rx) = manager(RunLimits::default());
        m.start(
            registry(1, Duration::ZERO),
            "s".into(),
            "stuck".into(),
            json!({}),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(m.cancel("s"));
        let (_, _, done) = collect(&mut rx).await;
        assert!(done.cancelled);
        assert!(done.error.unwrap().contains("did not stop"));
        assert_eq!(m.active_runs(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn start_rejects_bad_requests() {
        let (m, _rx) = manager(RunLimits {
            max_concurrent: 1,
            ..RunLimits::default()
        });
        let reg = registry(1000, Duration::from_secs(1));
        assert_eq!(
            m.start(reg.clone(), "x".into(), "nope".into(), json!({})),
            Err(StartError::UnknownTool("nope".into()))
        );
        assert_eq!(
            m.start(reg.clone(), String::new(), "slow".into(), json!({})),
            Err(StartError::InvalidRunId)
        );
        assert_eq!(
            m.start(reg.clone(), "y".repeat(200), "slow".into(), json!({})),
            Err(StartError::InvalidRunId)
        );
        m.start(reg.clone(), "one".into(), "slow".into(), json!({}))
            .unwrap();
        assert_eq!(
            m.start(reg.clone(), "one".into(), "slow".into(), json!({})),
            Err(StartError::DuplicateRunId("one".into()))
        );
        assert_eq!(
            m.start(reg, "two".into(), "slow".into(), json!({})),
            Err(StartError::TooManyRuns(1))
        );
    }

    #[test]
    fn without_a_sender_streaming_is_unavailable() {
        let m = ToolRunManager::new(RunLimits::default());
        assert!(!m.is_available());
    }
}
