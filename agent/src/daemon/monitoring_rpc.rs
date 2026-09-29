//! System monitoring for daemon-hosted sessions (#3871).
//!
//! Agent-hosted SSH, Docker and WSL sessions are persistent, so their
//! [`ConnectionType`](termihub_core::connection::ConnectionType) — and with it
//! the backend's own [`MonitoringProvider`] (the SSH exec loop, the Docker
//! `/proc` exec with its `docker stats` fallback, the WSL exec) — lives in the
//! session daemon, not in the worker. The worker reaches it over the frame
//! protocol, the same way process list / kill do (#3210):
//!
//! - In the connect handshake the daemon's [`MSG_CAPABILITIES`] frame carries
//!   [`CAP_MONITORING`] when its backend has a monitoring provider. A daemon
//!   started by an older agent does not set it, so the worker never sends it a
//!   request it would silently drop.
//! - The worker sends [`MSG_MONITORING_REQUEST`] (JSON [`MonitoringRequest`]):
//!   subscribe, unsubscribe, set the interval, or pause.
//! - The daemon answers every request with a [`MonitoringEvent::Reply`] and,
//!   while subscribed, streams [`MonitoringEvent::Stats`] and
//!   [`MonitoringEvent::Status`] in [`MSG_MONITORING_EVENT`] frames — only to
//!   the connection that subscribed. When that connection stops holding the
//!   session (detach, drop, takeover) the daemon stops the provider.
//!
//! On the worker, [`DaemonMonitoringProvider`] turns this back into an ordinary
//! [`MonitoringProvider`], so the agent's monitoring manager streams it to the
//! desktop exactly like any other provider.
//!
//! [`MSG_CAPABILITIES`]: super::protocol::MSG_CAPABILITIES
//! [`CAP_MONITORING`]: super::protocol::CAP_MONITORING
//! [`MSG_MONITORING_EVENT`]: super::protocol::MSG_MONITORING_EVENT

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use termihub_core::errors::CoreError;
use termihub_core::monitoring::{
    MonitorStatusSender, MonitorStatusUpdate, MonitoringProvider, MonitoringSender,
    MonitoringSubscription, SystemStats,
};

use super::client::{write_frame_timed, DaemonWriterHandle};
use super::protocol::MSG_MONITORING_REQUEST;

/// Upper bound on one provider call inside the daemon. A subscribe probes the
/// target once (and opens a dedicated SSH connection for an SSH session), so
/// it is generous.
pub const DAEMON_OP_TIMEOUT: Duration = Duration::from_secs(45);

/// How long the worker waits for a reply; longer than [`DAEMON_OP_TIMEOUT`] so
/// the daemon's own timeout (a typed failure) normally wins.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

/// Smallest interval the daemon applies, matching the agent's own floor.
pub const MIN_INTERVAL_MS: u64 = 500;

/// Channel capacity of the samples the worker hands to its subscriber.
const STATS_CAPACITY: usize = 16;

/// Channel capacity of the status transitions (they are rare).
const STATUS_CAPACITY: usize = 8;

/// Monitoring requests queued for the daemon's monitor worker. The desktop
/// sends one at a time, so this is a safety bound, never a working limit.
pub const MAX_QUEUED_REQUESTS: usize = 8;

/// A monitoring request from the worker to the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitoringRequest {
    /// Correlates the reply.
    pub id: u64,
    #[serde(flatten)]
    pub op: MonitoringOp,
}

/// The operation a [`MonitoringRequest`] asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MonitoringOp {
    /// Start (or restart) the backend's provider and stream its samples.
    Subscribe,
    /// Stop the provider and the stream.
    Unsubscribe,
    /// Change the collection interval of the running loop.
    SetInterval { interval_ms: u64 },
    /// Pause or resume collection.
    SetPaused { paused: bool },
}

/// A daemon → worker monitoring frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum MonitoringEvent {
    /// The outcome of the request with this id; `error` is set when it failed.
    Reply {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A sample from the backend's provider.
    Stats { stats: Box<SystemStats> },
    /// A collect-loop status transition from the backend's provider.
    Status { update: MonitorStatusUpdate },
    /// The provider's stream ended (its loop stopped for good).
    Ended,
}

// ── Daemon side ─────────────────────────────────────────────────────

/// A command for the daemon's monitor worker.
#[derive(Debug)]
pub enum MonitorCommand {
    /// A request from the connection of generation `gen`.
    Request {
        gen: u64,
        request: MonitoringRequest,
    },
    /// The subscribing connection no longer holds the session: stop.
    Release,
}

/// Where the monitor worker sends its events, tagged with the connection
/// generation they belong to. The daemon loop drops an event whose generation
/// is no longer the attached one.
pub type MonitorEventSender = mpsc::Sender<(u64, MonitoringEvent)>;

/// Spawn the daemon's monitor worker for `provider`.
///
/// One task handles every request in order, so a subscribe that is still
/// probing its target is never overtaken by the unsubscribe that follows it.
/// It runs on its own task, so a slow probe never stalls output forwarding.
pub fn spawn_monitor_worker(
    provider: Arc<dyn MonitoringProvider + Send + Sync>,
    events: MonitorEventSender,
) -> mpsc::Sender<MonitorCommand> {
    let (tx, rx) = mpsc::channel(MAX_QUEUED_REQUESTS);
    tokio::spawn(monitor_worker(provider, rx, events));
    tx
}

/// The running stream of a subscription.
struct ActiveStream {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl ActiveStream {
    fn stop(self) {
        self.cancel.cancel();
        self.task.abort();
    }
}

async fn monitor_worker(
    provider: Arc<dyn MonitoringProvider + Send + Sync>,
    mut commands: mpsc::Receiver<MonitorCommand>,
    events: MonitorEventSender,
) {
    let mut active: Option<ActiveStream> = None;
    while let Some(command) = commands.recv().await {
        match command {
            MonitorCommand::Release => {
                if let Some(stream) = active.take() {
                    debug!("Monitoring subscriber released the session; stopping");
                    stream.stop();
                    unsubscribe(provider.as_ref()).await;
                }
            }
            MonitorCommand::Request { gen, request } => {
                let error = serve(provider.as_ref(), gen, request.op, &mut active, &events).await;
                let reply = MonitoringEvent::Reply {
                    id: request.id,
                    error,
                };
                if events.send((gen, reply)).await.is_err() {
                    break;
                }
            }
        }
    }
    // The daemon loop ended: never leave a provider loop running behind it.
    if let Some(stream) = active.take() {
        stream.stop();
        unsubscribe(provider.as_ref()).await;
    }
}

/// Run one request against `provider`; `Some(message)` when it failed.
async fn serve(
    provider: &(dyn MonitoringProvider + Send + Sync),
    gen: u64,
    op: MonitoringOp,
    active: &mut Option<ActiveStream>,
    events: &MonitorEventSender,
) -> Option<String> {
    match op {
        MonitoringOp::Subscribe => {
            if let Some(stream) = active.take() {
                stream.stop();
            }
            match tokio::time::timeout(DAEMON_OP_TIMEOUT, provider.subscribe()).await {
                Ok(Ok(subscription)) => {
                    let cancel = CancellationToken::new();
                    let task = tokio::spawn(forward_stream(
                        gen,
                        subscription,
                        events.clone(),
                        cancel.clone(),
                    ));
                    *active = Some(ActiveStream { cancel, task });
                    None
                }
                Ok(Err(e)) => Some(e.to_string()),
                Err(_) => Some(format!(
                    "monitoring subscribe timed out after {DAEMON_OP_TIMEOUT:?}"
                )),
            }
        }
        MonitoringOp::Unsubscribe => {
            if let Some(stream) = active.take() {
                stream.stop();
            }
            unsubscribe(provider).await;
            None
        }
        MonitoringOp::SetInterval { interval_ms } => {
            let interval = Duration::from_millis(interval_ms.max(MIN_INTERVAL_MS));
            bounded(provider.set_interval(interval)).await
        }
        MonitoringOp::SetPaused { paused } => bounded(provider.set_paused(paused)).await,
    }
}

/// Await a provider control call under [`DAEMON_OP_TIMEOUT`].
async fn bounded(call: impl std::future::Future<Output = ()>) -> Option<String> {
    match tokio::time::timeout(DAEMON_OP_TIMEOUT, call).await {
        Ok(()) => None,
        Err(_) => Some(format!(
            "monitoring control timed out after {DAEMON_OP_TIMEOUT:?}"
        )),
    }
}

async fn unsubscribe(provider: &(dyn MonitoringProvider + Send + Sync)) {
    match tokio::time::timeout(DAEMON_OP_TIMEOUT, provider.unsubscribe()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => debug!("Monitoring unsubscribe failed: {e}"),
        Err(_) => warn!("Monitoring unsubscribe timed out"),
    }
}

/// Stream a subscription's samples and status transitions as events until it
/// ends or is cancelled.
async fn forward_stream(
    gen: u64,
    mut subscription: MonitoringSubscription,
    events: MonitorEventSender,
    cancel: CancellationToken,
) {
    let mut status_open = true;
    loop {
        let event = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            update = subscription.status.recv(), if status_open => match update {
                Some(update) => MonitoringEvent::Status { update },
                None => {
                    status_open = false;
                    continue;
                }
            },
            stats = subscription.stats.recv() => match stats {
                Some(stats) => MonitoringEvent::Stats { stats: Box::new(stats) },
                None => break,
            },
        };
        if events.send((gen, event)).await.is_err() {
            return;
        }
    }
    // The provider stopped: pass on any final status (typically `Offline`),
    // then say the stream is over.
    while let Ok(update) = subscription.status.try_recv() {
        if events
            .send((gen, MonitoringEvent::Status { update }))
            .await
            .is_err()
        {
            return;
        }
    }
    let _ = events.send((gen, MonitoringEvent::Ended)).await;
}

// ── Worker side ─────────────────────────────────────────────────────

/// Where the worker delivers a subscription's streamed events.
#[derive(Debug)]
struct MonitorSink {
    stats: MonitoringSender,
    status: MonitorStatusSender,
}

/// Per-client monitoring state shared between a
/// [`DaemonClient`](super::client::DaemonClient), its reader task and the
/// [`DaemonMonitoringProvider`]s handed out for it.
#[derive(Debug, Default)]
pub struct MonitoringChannel {
    /// Whether the connected daemon advertised monitoring support.
    supported: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    /// The live subscription's channels; `None` while not subscribed.
    sink: Mutex<Option<MonitorSink>>,
}

impl MonitoringChannel {
    /// Whether the connected daemon serves monitoring requests.
    pub fn supported(&self) -> bool {
        self.supported.load(Ordering::SeqCst)
    }

    /// Record the connected daemon's advertised support.
    pub fn set_supported(&self, supported: bool) {
        self.supported.store(supported, Ordering::SeqCst);
    }

    /// Reserve a request id and the receiver its reply is delivered to.
    fn register(&self) -> (u64, oneshot::Receiver<Option<String>>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);
        (id, rx)
    }

    /// Drop a request that will not be answered (failed write, timeout).
    fn forget(&self, id: u64) {
        self.pending().remove(&id);
    }

    fn install_sink(&self, sink: MonitorSink) {
        *self.sink() = Some(sink);
    }

    /// Stop delivering streamed events; the subscriber's receivers close.
    fn clear_sink(&self) {
        self.sink().take();
    }

    /// Route a [`MSG_MONITORING_EVENT`](super::protocol::MSG_MONITORING_EVENT)
    /// payload. Malformed events and replies to unknown requests are dropped.
    pub fn deliver(&self, payload: &[u8]) {
        let event: MonitoringEvent = match serde_json::from_slice(payload) {
            Ok(e) => e,
            Err(e) => {
                debug!("Malformed monitoring event from daemon: {e}");
                return;
            }
        };
        match event {
            MonitoringEvent::Reply { id, error } => match self.pending().remove(&id) {
                Some(tx) => {
                    let _ = tx.send(error);
                }
                None => debug!("Monitoring reply for unknown request {id}"),
            },
            MonitoringEvent::Stats { stats } => {
                if let Some(sink) = self.sink().as_ref() {
                    if sink.stats.try_send(*stats).is_err() {
                        debug!("Monitoring subscriber is behind or gone; sample dropped");
                    }
                }
            }
            MonitoringEvent::Status { update } => {
                if let Some(sink) = self.sink().as_ref() {
                    let _ = sink.status.try_send(update);
                }
            }
            MonitoringEvent::Ended => self.clear_sink(),
        }
    }

    /// Fail every pending request and end the stream (the daemon connection
    /// ended or changed).
    pub fn fail_all(&self) {
        self.pending().clear();
        self.clear_sink();
    }

    /// Whether a subscription's stream is being delivered.
    #[cfg(test)]
    pub fn has_sink(&self) -> bool {
        self.sink().is_some()
    }

    /// Number of requests awaiting a reply.
    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.pending().len()
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Option<String>>>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn sink(&self) -> std::sync::MutexGuard<'_, Option<MonitorSink>> {
        self.sink.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// [`MonitoringProvider`] for a daemon-hosted session: runs the session
/// backend's own provider inside the session daemon and receives its stream.
pub struct DaemonMonitoringProvider {
    writer: DaemonWriterHandle,
    channel: Arc<MonitoringChannel>,
}

impl DaemonMonitoringProvider {
    pub fn new(writer: DaemonWriterHandle, channel: Arc<MonitoringChannel>) -> Self {
        Self { writer, channel }
    }

    /// Send `op` and await the daemon's reply. `Err` carries the message of a
    /// transport failure or of the daemon's own failure.
    async fn call(&self, op: MonitoringOp) -> Result<(), String> {
        let (id, rx) = self.channel.register();
        let payload = serde_json::to_vec(&MonitoringRequest { id, op })
            .map_err(|e| format!("encode monitoring request: {e}"))?;
        let sent = {
            let mut guard = self.writer.lock().await;
            match guard.as_mut() {
                Some(writer) => write_frame_timed(writer, MSG_MONITORING_REQUEST, &payload)
                    .await
                    .map_err(|e| e.to_string()),
                None => Err("the session is not attached".to_string()),
            }
        };
        if let Err(e) = sent {
            self.channel.forget(id);
            return Err(e);
        }
        match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
            Ok(Ok(None)) => Ok(()),
            Ok(Ok(Some(error))) => Err(error),
            Ok(Err(_)) => Err("the session daemon connection closed".to_string()),
            Err(_) => {
                self.channel.forget(id);
                Err(format!(
                    "no reply from the session daemon in {REPLY_TIMEOUT:?}"
                ))
            }
        }
    }
}

#[async_trait::async_trait]
impl MonitoringProvider for DaemonMonitoringProvider {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        // Install the sink before asking, so the first sample, which may race
        // the reply, is not lost.
        let (stats_tx, stats_rx) = mpsc::channel(STATS_CAPACITY);
        let (status_tx, status_rx) = mpsc::channel(STATUS_CAPACITY);
        self.channel.install_sink(MonitorSink {
            stats: stats_tx,
            status: status_tx,
        });
        if let Err(e) = self.call(MonitoringOp::Subscribe).await {
            self.channel.clear_sink();
            return Err(CoreError::Other(e));
        }
        Ok(MonitoringSubscription {
            stats: stats_rx,
            status: status_rx,
        })
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        self.channel.clear_sink();
        self.call(MonitoringOp::Unsubscribe)
            .await
            .map_err(CoreError::Other)
    }

    async fn set_interval(&self, interval: Duration) {
        let interval_ms = u64::try_from(interval.as_millis()).unwrap_or(u64::MAX);
        if let Err(e) = self.call(MonitoringOp::SetInterval { interval_ms }).await {
            warn!("Failed to set the session monitoring interval: {e}");
        }
    }

    async fn set_paused(&self, paused: bool) {
        if let Err(e) = self.call(MonitoringOp::SetPaused { paused }).await {
            warn!("Failed to pause/resume session monitoring: {e}");
        }
    }

    async fn cancel_connect(&self) {
        // The connect probe runs inside the daemon and is bounded there by
        // `DAEMON_OP_TIMEOUT`; the agent's monitoring manager never calls this.
    }
}

#[cfg(test)]
mod tests;
