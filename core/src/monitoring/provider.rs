//! Async monitoring provider trait for connection types.
//!
//! Unlike the synchronous [`StatsCollector`](super::StatsCollector) trait
//! (used by dedicated monitoring backends), `MonitoringProvider` is the
//! async capability interface returned by
//! [`ConnectionType::monitoring()`](crate::connection::ConnectionType::monitoring).

use crate::errors::CoreError;
use crate::monitoring::types::SystemStats;

/// Async receiver for periodic [`SystemStats`] updates.
pub type MonitoringReceiver = tokio::sync::mpsc::Receiver<SystemStats>;

/// Async sender for periodic [`SystemStats`] updates (used by implementations).
pub type MonitoringSender = tokio::sync::mpsc::Sender<SystemStats>;

/// Async monitoring capability exposed by connection types.
///
/// Connection types that support monitoring return
/// `Some(&dyn MonitoringProvider)` from
/// [`ConnectionType::monitoring()`](crate::connection::ConnectionType::monitoring).
/// The provider starts sending stats when subscribed and stops when
/// unsubscribed.
#[async_trait::async_trait]
pub trait MonitoringProvider: Send {
    /// Start monitoring and return a receiver for stats updates.
    ///
    /// Implementations typically spawn a background task that periodically
    /// collects stats and sends them through the channel.
    async fn subscribe(&self) -> Result<MonitoringReceiver, CoreError>;

    /// Stop monitoring and clean up background tasks.
    async fn unsubscribe(&self) -> Result<(), CoreError>;
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
