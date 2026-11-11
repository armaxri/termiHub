//! In-place reopen of an agent-hosted serial port after it drops (#5396).
//!
//! A direct serial tab reopens its port through the desktop's backend redrive
//! (#5390). An agent-hosted serial session lives in a session daemon on the
//! agent host, so the port it uses is only visible there. This module puts the
//! reopen where the port is: [`SerialReopen`] wraps the serial backend inside
//! the daemon and, when the port drops, keeps the **same session** alive while
//! it retries on the shared reconnect policy
//! ([`policy_for`]`(`[`ReconnectKind::Terminal`]`)`).
//!
//! # Identity
//!
//! Each attempt asks the core resolver, [`resolve_reconnect_port`], with the
//! agent host's own [`SerialPortProbe`] — the same rules as a direct tab:
//!
//! - the configured port is reopened only when the device on it is the device
//!   that was open before the drop (when the platform can read a USB identity);
//! - a different or unidentifiable device is never opened;
//! - a renamed port is followed only on a unique serial-number match.
//!
//! # What the desktop sees
//!
//! Every step is published on a watch channel as a [`ReopenStatus`]: waiting
//! (attempt *n*, the backoff window, the reason), connecting, reconnected or
//! gave up. The daemon loop forwards it to the attached worker as
//! [`MSG_RECONNECT`](super::protocol::MSG_RECONNECT), and the worker forwards
//! it to the desktop as a `connection.reconnect` notification, which drives the
//! tab's reconnect strip.
//!
//! # Ending
//!
//! At the policy's attempt limit the loop publishes `gaveUp` and closes the
//! session output, so the daemon ends the session exactly as a drop did before
//! #5396. A kill (the desktop's Stop, or a tab close) runs
//! [`ConnectionType::disconnect`], which cancels the loop.
//!
//! Only a serial session whose Auto-Reconnect setting is on is wrapped
//! ([`wants_reopen`]); every other session runs its backend unchanged.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use termihub_core::config::SerialConfig;
use termihub_core::connection::{
    auto_reconnect_enabled_for, Capabilities, ConnectionType, OutputReceiver, OutputSender,
    SettingsSchema,
};
use termihub_core::errors::SessionError;
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringProvider;
use termihub_core::protocol::methods::SessionReconnectStatus;
use termihub_core::reconnect_backoff::{
    policy_for, reconnect_reducer, system_jitter, BackoffConfig, ReconnectEvent, ReconnectKind,
    ReconnectPhase, INITIAL_RECONNECT_STATE,
};
use termihub_core::session::serial_reconnect::{
    resolve_reconnect_port, ReconnectPortResolution, SerialDeviceIdentity, SerialPortProbe,
};

/// The connection type id of the serial backend.
const SERIAL_TYPE_ID: &str = "serial";

/// Capacity of the session output channel the wrapper hands the daemon.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Builds a fresh, unconnected serial backend for each (re)open.
pub(crate) type ConnectionFactory = Arc<dyn Fn() -> Box<dyn ConnectionType> + Send + Sync>;

/// The jitter source of the backoff windows (injectable for tests).
pub(crate) type JitterFn = Box<dyn FnMut() -> f64 + Send + Sync>;

/// One published reconnect step: the status and its per-session sequence
/// number, which only ever grows, so a desktop can drop a late or replayed one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReopenStatus {
    /// Grows by one with every published step of this session.
    pub(crate) seq: u64,
    /// The step.
    #[serde(flatten)]
    pub(crate) status: SessionReconnectStatus,
}

impl ReopenStatus {
    /// Whether the step belongs to a running loop (waiting or connecting), i.e.
    /// a worker attaching now needs to hear it.
    pub(crate) fn is_running(&self) -> bool {
        matches!(
            self.status,
            SessionReconnectStatus::Waiting { .. } | SessionReconnectStatus::Connecting { .. }
        )
    }

    /// Whether the loop gave up.
    pub(crate) fn is_gave_up(&self) -> bool {
        matches!(self.status, SessionReconnectStatus::GaveUp { .. })
    }
}

/// The receiving end of a session's reconnect steps; `None` until the first.
pub(crate) type ReopenStatusRx = watch::Receiver<Option<ReopenStatus>>;

/// Whether a daemon session of `type_id` with `settings` reopens its port in
/// place after a drop: a serial session with Auto-Reconnect on (the serial
/// default, #5390).
pub(crate) fn wants_reopen(type_id: &str, settings: &Value) -> bool {
    type_id == SERIAL_TYPE_ID && auto_reconnect_enabled_for(type_id, settings)
}

/// The configured port of a serial settings bag, with `${env:…}` expanded as
/// the backend does on connect.
fn configured_port(settings: &Value) -> Option<String> {
    let config: SerialConfig = serde_json::from_value(settings.clone()).ok()?;
    let port = config.expand().port;
    (!port.is_empty()).then_some(port)
}

/// `settings` with its `port` replaced, for a reopen that follows a renamed port.
fn with_port(mut settings: Value, port: &str) -> Value {
    if let Some(map) = settings.as_object_mut() {
        map.insert("port".to_string(), Value::String(port.to_string()));
    }
    settings
}

/// A serial backend that reopens its port in place after it drops (see the
/// module docs).
pub(crate) struct SerialReopen {
    factory: ConnectionFactory,
    probe: Arc<dyn SerialPortProbe>,
    policy: BackoffConfig,
    jitter: Option<JitterFn>,
    /// Metadata only (type id, schema, capabilities); never connected.
    meta: Box<dyn ConnectionType>,
    /// The open backend; `None` while the port is down.
    inner: Arc<Mutex<Option<Box<dyn ConnectionType>>>>,
    output_tx: Option<OutputSender>,
    output_rx: Mutex<Option<OutputReceiver>>,
    status_tx: Arc<watch::Sender<Option<ReopenStatus>>>,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl SerialReopen {
    /// A wrapper that opens its backends with `factory`, checks ports with
    /// `probe` and retries on the shared terminal reconnect policy.
    pub(crate) fn new(factory: ConnectionFactory, probe: Arc<dyn SerialPortProbe>) -> Self {
        Self::with_policy(
            factory,
            probe,
            policy_for(ReconnectKind::Terminal),
            Box::new(system_jitter),
        )
    }

    /// [`new`](Self::new) with an explicit policy and jitter source.
    pub(crate) fn with_policy(
        factory: ConnectionFactory,
        probe: Arc<dyn SerialPortProbe>,
        policy: BackoffConfig,
        jitter: JitterFn,
    ) -> Self {
        let meta = factory();
        let (output_tx, output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
        let (status_tx, _) = watch::channel(None);
        Self {
            factory,
            probe,
            policy,
            jitter: Some(jitter),
            meta,
            inner: Arc::new(Mutex::new(None)),
            output_tx: Some(output_tx),
            output_rx: Mutex::new(Some(output_rx)),
            status_tx: Arc::new(status_tx),
            cancel: CancellationToken::new(),
            task: None,
        }
    }

    /// The session's reconnect steps.
    pub(crate) fn status_watch(&self) -> ReopenStatusRx {
        self.status_tx.subscribe()
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, Option<Box<dyn ConnectionType>>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for SerialReopen {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[async_trait::async_trait]
impl ConnectionType for SerialReopen {
    fn type_id(&self) -> &str {
        self.meta.type_id()
    }

    fn display_name(&self) -> &str {
        self.meta.display_name()
    }

    fn settings_schema(&self) -> SettingsSchema {
        self.meta.settings_schema()
    }

    fn capabilities(&self) -> Capabilities {
        self.meta.capabilities()
    }

    async fn connect(&mut self, settings: Value) -> Result<(), SessionError> {
        let Some(output_tx) = self.output_tx.take() else {
            return Err(SessionError::AlreadyExists("Already connected".to_string()));
        };
        let mut conn = (self.factory)();
        if let Err(e) = conn.connect(settings.clone()).await {
            self.output_tx = Some(output_tx);
            return Err(e);
        }
        let rx = conn.subscribe_output();
        let configured = configured_port(&settings);
        // The device that is open now; a reopen must find the same one.
        let remembered = configured.as_deref().and_then(|p| self.probe.identity(p));
        *self.lock_inner() = Some(conn);

        let supervisor = Supervisor {
            factory: Arc::clone(&self.factory),
            probe: Arc::clone(&self.probe),
            policy: self.policy,
            jitter: self
                .jitter
                .take()
                .unwrap_or_else(|| Box::new(system_jitter)),
            inner: Arc::clone(&self.inner),
            output_tx,
            status_tx: Arc::clone(&self.status_tx),
            cancel: self.cancel.clone(),
            settings,
            configured,
            remembered,
            seq: 0,
        };
        self.task = Some(tokio::spawn(supervisor.run(rx)));
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), SessionError> {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        let conn = self.lock_inner().take();
        match conn {
            Some(mut conn) => conn.disconnect().await,
            None => Ok(()),
        }
    }

    fn is_connected(&self) -> bool {
        self.lock_inner().as_ref().is_some_and(|c| c.is_connected())
    }

    fn interrupt_io(&self) {
        if let Some(conn) = self.lock_inner().as_ref() {
            conn.interrupt_io();
        }
    }

    fn write(&self, data: &[u8]) -> Result<(), SessionError> {
        match self.lock_inner().as_ref() {
            Some(conn) => conn.write(data),
            // The port is down and being reopened: the input has nowhere to go.
            None => Err(SessionError::NotRunning(
                "Serial port is reconnecting".to_string(),
            )),
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        match self.lock_inner().as_ref() {
            Some(conn) => conn.resize(cols, rows),
            None => Ok(()),
        }
    }

    fn subscribe_output(&self) -> OutputReceiver {
        let taken = self
            .output_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        taken.unwrap_or_else(|| {
            // Only one subscriber: a second one gets a closed channel.
            let (_tx, rx) = mpsc::channel(1);
            rx
        })
    }

    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        None
    }

    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// The task that forwards the open port's output and runs the reopen loop
/// after a drop.
struct Supervisor {
    factory: ConnectionFactory,
    probe: Arc<dyn SerialPortProbe>,
    policy: BackoffConfig,
    jitter: JitterFn,
    inner: Arc<Mutex<Option<Box<dyn ConnectionType>>>>,
    output_tx: OutputSender,
    status_tx: Arc<watch::Sender<Option<ReopenStatus>>>,
    cancel: CancellationToken,
    settings: Value,
    configured: Option<String>,
    remembered: Option<SerialDeviceIdentity>,
    seq: u64,
}

impl Supervisor {
    async fn run(mut self, mut rx: OutputReceiver) {
        loop {
            if !self.forward(&mut rx).await {
                return;
            }
            // The port dropped: release the dead backend.
            let dead = self.inner.lock().unwrap_or_else(|e| e.into_inner()).take();
            if let Some(mut dead) = dead {
                let _ = dead.disconnect().await;
            }
            let Some(configured) = self.configured.clone() else {
                // Nothing to reopen: end the session as before.
                return;
            };
            match self.reopen(&configured).await {
                Some((conn, next_rx)) => {
                    *self.inner.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
                    rx = next_rx;
                }
                // Gave up or stopped: dropping `output_tx` ends the session.
                None => return,
            }
        }
    }

    /// Forward output until the port's channel closes (`true`) or the session
    /// is stopped / its reader is gone (`false`).
    async fn forward(&self, rx: &mut OutputReceiver) -> bool {
        loop {
            let chunk = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return false,
                chunk = rx.recv() => chunk,
            };
            let Some(chunk) = chunk else {
                return true;
            };
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return false,
                sent = self.output_tx.send(chunk) => {
                    if sent.is_err() {
                        return false;
                    }
                }
            }
        }
    }

    fn publish(&mut self, status: SessionReconnectStatus) {
        self.seq += 1;
        self.status_tx.send_replace(Some(ReopenStatus {
            seq: self.seq,
            status,
        }));
    }

    /// Run one reconnect loop. `Some` carries the reopened backend and its
    /// output; `None` means the loop gave up or the session was stopped.
    async fn reopen(
        &mut self,
        configured: &str,
    ) -> Option<(Box<dyn ConnectionType>, OutputReceiver)> {
        info!(
            port = configured,
            "Serial port dropped; reopening it in place"
        );
        let policy = self.policy;
        let mut state = reconnect_reducer(
            &INITIAL_RECONNECT_STATE,
            ReconnectEvent::Drop,
            &policy,
            &mut *self.jitter,
        );
        let mut reason = format!("Serial port {configured} disconnected.");
        loop {
            self.publish(SessionReconnectStatus::Waiting {
                attempt: state.attempt,
                delay_ms: state.delay_ms,
                reason: Some(reason.clone()),
            });
            let delay = Duration::from_millis(u64::try_from(state.delay_ms).unwrap_or(0));
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return None,
                _ = tokio::time::sleep(delay) => {}
            }
            state = reconnect_reducer(&state, ReconnectEvent::Attempt, &policy, &mut *self.jitter);
            self.publish(SessionReconnectStatus::Connecting {
                attempt: state.attempt,
                reason: Some(reason.clone()),
            });

            match resolve_reconnect_port(configured, self.remembered.as_ref(), &*self.probe) {
                ReconnectPortResolution::Reopen { port } => {
                    let mut conn = (self.factory)();
                    match conn.connect(with_port(self.settings.clone(), &port)).await {
                        Ok(()) => {
                            if self.cancel.is_cancelled() {
                                let _ = conn.disconnect().await;
                                return None;
                            }
                            info!(port = %port, "Serial port reopened");
                            let rx = conn.subscribe_output();
                            self.publish(SessionReconnectStatus::Reconnected);
                            return Some((conn, rx));
                        }
                        Err(e) => {
                            reason = format!("Serial port {port} could not be opened: {e}");
                        }
                    }
                }
                other => {
                    reason = other
                        .waiting_reason(configured)
                        .unwrap_or_else(|| format!("Serial port {configured} is not available."));
                }
            }

            state = reconnect_reducer(&state, ReconnectEvent::Failure, &policy, &mut *self.jitter);
            if state.phase == ReconnectPhase::Gaveup {
                warn!(
                    port = configured,
                    "Serial port did not come back; giving up"
                );
                self.publish(SessionReconnectStatus::GaveUp {
                    reason: Some(reason),
                });
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests;
