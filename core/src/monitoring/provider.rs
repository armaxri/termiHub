//! Async monitoring provider trait for connection types.
//!
//! Unlike the synchronous [`StatsCollector`](super::StatsCollector) trait
//! (used by dedicated monitoring backends), `MonitoringProvider` is the
//! async capability interface returned by
//! [`ConnectionType::monitoring()`](crate::connection::ConnectionType::monitoring).

use std::time::Duration;

use crate::errors::CoreError;
use crate::monitoring::status::MonitorStatusReceiver;
use crate::monitoring::types::SystemStats;

/// Async receiver for periodic [`SystemStats`] updates.
pub type MonitoringReceiver = tokio::sync::mpsc::Receiver<SystemStats>;

/// Async sender for periodic [`SystemStats`] updates (used by implementations).
pub type MonitoringSender = tokio::sync::mpsc::Sender<SystemStats>;

/// The two channels returned by [`MonitoringProvider::subscribe`].
///
/// `stats` carries the periodic [`SystemStats`] samples; `status` carries the
/// collector loop's observable lifecycle
/// ([`MonitorStatus`](crate::monitoring::status::MonitorStatus)) so a
/// mid-stream drop surfaces as `Stale` rather than silently freezing the last
/// sample (#1229, audit gap G1).
pub struct MonitoringSubscription {
    /// Periodic system-stats samples.
    pub stats: MonitoringReceiver,
    /// Collector-loop status transitions (`Connecting` → `Live` → `Stale` → …).
    pub status: MonitorStatusReceiver,
}

/// Async monitoring capability exposed by connection types.
///
/// Connection types that support monitoring return
/// `Some(&dyn MonitoringProvider)` from
/// [`ConnectionType::monitoring()`](crate::connection::ConnectionType::monitoring).
/// The provider starts sending stats when subscribed and stops when
/// unsubscribed.
#[async_trait::async_trait]
pub trait MonitoringProvider: Send {
    /// Start monitoring and return receivers for stats and status updates.
    ///
    /// Implementations typically spawn a background task that periodically
    /// collects stats and sends them (plus status transitions) through the
    /// channels in the returned [`MonitoringSubscription`].
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError>;

    /// Stop monitoring and clean up background tasks.
    async fn unsubscribe(&self) -> Result<(), CoreError>;

    /// Set the collection interval for the running loop (#1233).
    ///
    /// Takes effect on the next tick. Providers whose cadence is not
    /// user-configurable may implement this as a no-op.
    async fn set_interval(&self, interval: Duration);

    /// Pause or resume collection while keeping the transport open (#1233).
    ///
    /// A paused loop stops collecting but does not tear down its session, so a
    /// later resume picks up immediately.
    async fn set_paused(&self, paused: bool);

    /// Abort an in-flight connect / collect (#1233, Cancel control).
    ///
    /// Cancels the loop's [`CancellationToken`](tokio_util::sync::CancellationToken)
    /// so a still-connecting monitor stops promptly instead of waiting out the
    /// handshake timeout.
    async fn cancel_connect(&self);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verify MonitoringProvider is object-safe and Send.
    fn _assert_object_safe(_: &dyn MonitoringProvider) {}
    fn _assert_send<T: Send>() {}

    #[test]
    fn monitoring_provider_is_send() {
        _assert_send::<Box<dyn MonitoringProvider>>();
    }
}
