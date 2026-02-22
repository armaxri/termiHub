//! System monitoring: periodic stats collection and notification streaming.
//!
//! Supports monitoring the agent's own host ("self") and remote SSH
//! jump targets (by connection ID). Stats are collected at a configurable
//! interval and sent as `monitoring.data` JSON-RPC notifications.

pub mod collector;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::SshSessionConfig;
use crate::session::definitions::ConnectionStore;

use self::collector::{LocalCollector, SshCollector, StatsCollector};

/// Default collection interval in milliseconds.
const DEFAULT_INTERVAL_MS: u64 = 2000;

/// Minimum allowed collection interval in milliseconds.
const MIN_INTERVAL_MS: u64 = 500;

/// Manages active monitoring subscriptions.
///
/// Each subscription spawns a background tokio task that periodically
/// collects system stats and sends `monitoring.data` notifications.
pub struct MonitoringManager {
    subscriptions: Mutex<HashMap<String, Subscription>>,
    notification_tx: NotificationSender,
    connection_store: Arc<ConnectionStore>,
}

/// An active monitoring subscription.
struct Subscription {
    cancel: CancellationToken,
    join_handle: JoinHandle<()>,
}

impl MonitoringManager {
    pub fn new(
        notification_tx: NotificationSender,
        connection_store: Arc<ConnectionStore>,
    ) -> Self {
        Self {
            subscriptions: Mutex::new(HashMap::new()),
            notification_tx,
            connection_store,
        }
    }

    /// Start monitoring a host.
    ///
    /// - `host = "self"`: monitor the agent's own host
    /// - `host = "<connection_id>"`: monitor a remote host via SSH
    ///
    /// If already subscribed to this host, the existing subscription is
    /// replaced (unsubscribed then re-subscribed).
    pub async fn subscribe(&self, host: &str, interval_ms: Option<u64>) -> Result<()> {
        let interval = interval_ms
            .unwrap_or(DEFAULT_INTERVAL_MS)
            .max(MIN_INTERVAL_MS);

        // If already subscribed, cancel the old subscription first
        {
            let mut subs = self.subscriptions.lock().await;
            if let Some(old) = subs.remove(host) {
                old.cancel.cancel();
                old.join_handle.abort();
                debug!("Replaced existing monitoring subscription for '{host}'");
            }
        }

        // Create the appropriate collector
        let collector: Box<dyn StatsCollector> = if host == "self" {
            Box::new(LocalCollector::new())
        } else {
            // Look up the connection to get SSH config
            let connection = self
                .connection_store
                .get(host)
                .await
                .ok_or_else(|| anyhow::anyhow!("Connection not found: {host}"))?;

            if connection.session_type != "ssh" {
                bail!(
                    "Monitoring is only supported for SSH connections (got '{}')",
                    connection.session_type
                );
            }

            let ssh_config: SshSessionConfig = serde_json::from_value(connection.config)
                .map_err(|e| anyhow::anyhow!("Invalid SSH config for connection '{host}': {e}"))?;

            // Open SSH connection in a blocking task
            let collector = tokio::task::spawn_blocking(move || SshCollector::new(&ssh_config))
                .await
                .map_err(|e| anyhow::anyhow!("Failed to spawn SSH collector task: {e}"))??;

            Box::new(collector)
        };

        let cancel = CancellationToken::new();
        let host_label = host.to_string();
        let tx = self.notification_tx.clone();

        let join_handle = tokio::spawn(monitoring_task(
            host_label.clone(),
            collector,
            Duration::from_millis(interval),
            tx,
            cancel.clone(),
        ));

        info!(
            "Started monitoring subscription for '{}' (interval: {}ms)",
            host, interval
        );

        let mut subs = self.subscriptions.lock().await;
        subs.insert(
            host.to_string(),
            Subscription {
                cancel,
                join_handle,
            },
        );

        Ok(())
    }

    /// Stop monitoring a host. Returns `true` if a subscription existed.
    pub async fn unsubscribe(&self, host: &str) -> bool {
        let mut subs = self.subscriptions.lock().await;
        if let Some(sub) = subs.remove(host) {
            sub.cancel.cancel();
            sub.join_handle.abort();
            info!("Stopped monitoring subscription for '{host}'");
            true
        } else {
            false
        }
    }

    /// Cancel all active subscriptions (called during agent shutdown).
    pub async fn shutdown(&self) {
        let mut subs = self.subscriptions.lock().await;
        for (host, sub) in subs.drain() {
            sub.cancel.cancel();
            sub.join_handle.abort();
            debug!("Shutdown: cancelled monitoring for '{host}'");
        }
    }
}

/// Background task that periodically collects stats and sends notifications.
///
/// The collector is wrapped in `Arc<std::sync::Mutex>` so it can be shared
/// with `spawn_blocking` calls (collection involves blocking I/O).
async fn monitoring_task(
    host: String,
    collector: Box<dyn StatsCollector>,
    interval: Duration,
    tx: NotificationSender,
    cancel: CancellationToken,
) {
    let collector = Arc::new(std::sync::Mutex::new(collector));
    let mut ticker = tokio::time::interval(interval);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("Monitoring task for '{}' cancelled", host);
                break;
            }
            _ = ticker.tick() => {
                let collector = collector.clone();
                let host_label = host.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let mut c = collector.lock().unwrap();
                    c.collect(&host_label)
                }).await;

                match result {
                    Ok(Ok(data)) => {
                        let notification = JsonRpcNotification::new(
                            "monitoring.data",
                            serde_json::to_value(&data).unwrap(),
                        );
                        if tx.send(notification).is_err() {
                            debug!("Notification channel closed, stopping monitoring for '{}'", host);
                            break;
                        }
                    }
                    Ok(Err(e)) => {
                        warn!("Monitoring collection failed for '{}': {}", host, e);
                    }
                    Err(e) => {
                        warn!("Monitoring task panicked for '{}': {}", host, e);
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribe_self_and_unsubscribe() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        // Subscribe to self
        let result = manager.subscribe("self", Some(1000)).await;
        assert!(result.is_ok());

        // Should have one subscription
        assert_eq!(manager.subscriptions.lock().await.len(), 1);

        // Unsubscribe
        assert!(manager.unsubscribe("self").await);
        assert_eq!(manager.subscriptions.lock().await.len(), 0);

        // Unsubscribe again returns false
        assert!(!manager.unsubscribe("self").await);
    }

    #[tokio::test]
    async fn subscribe_replaces_existing() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        manager.subscribe("self", Some(2000)).await.unwrap();
        manager.subscribe("self", Some(5000)).await.unwrap();

        // Should still be one subscription (replaced)
        assert_eq!(manager.subscriptions.lock().await.len(), 1);

        manager.shutdown().await;
    }

    #[tokio::test]
    async fn subscribe_unknown_connection_fails() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        let result = manager.subscribe("nonexistent-conn", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn shutdown_clears_all() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let tmp =
            std::env::temp_dir().join(format!("termihub-mon-test-{}.json", uuid::Uuid::new_v4()));
        let store = Arc::new(ConnectionStore::new_temp(tmp));
        let manager = MonitoringManager::new(tx, store);

        manager.subscribe("self", Some(1000)).await.unwrap();
        assert_eq!(manager.subscriptions.lock().await.len(), 1);

        manager.shutdown().await;
        assert_eq!(manager.subscriptions.lock().await.len(), 0);
    }
}
