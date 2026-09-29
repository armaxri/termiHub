//! Monitoring an agent-hosted session through its backend's own provider
//! (#3871).
//!
//! An SSH, Docker or WSL session hosted by the agent already has a
//! [`MonitoringProvider`] — the backend's exec loop (for Docker with the
//! `docker stats` fallback for distroless containers), run in the session
//! daemon. Instead of the agent's own collectors, `connection.monitoring.*` for
//! such a session subscribes that provider and forwards its samples and status
//! transitions to the desktop as the usual `connection.monitoring.data` /
//! `connection.monitoring.status` notifications, keyed by the session id.

use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use termihub_core::monitoring::{
    MonitorStatus, MonitorStatusReason, MonitorStatusUpdate, MonitoringProvider,
    MonitoringSubscription,
};

use crate::io::transport::NotificationSender;
use crate::protocol::messages::JsonRpcNotification;
use crate::protocol::methods::{
    MonitoringData, MonitoringStatusNotification, CONNECTION_MONITORING_DATA,
    CONNECTION_MONITORING_STATUS,
};

/// Forward a provider subscription's stream to the desktop under `host` until
/// it ends or `cancel` fires.
///
/// When the stream ends on its own — the provider gave up, or the session
/// ended and took its daemon connection with it — the desktop is told the
/// monitor is `Offline` (unless the provider already said so), so it never
/// waits on a stream that is gone.
pub async fn forward_provider(
    host: String,
    mut subscription: MonitoringSubscription,
    tx: NotificationSender,
    cancel: CancellationToken,
) {
    let mut last_status: Option<MonitorStatus> = None;
    let mut status_open = true;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            update = subscription.status.recv(), if status_open => match update {
                Some(update) => {
                    last_status = Some(update.status);
                    if !send_status(&tx, &host, update) {
                        return;
                    }
                }
                None => status_open = false,
            },
            stats = subscription.stats.recv() => match stats {
                Some(stats) => {
                    if !send(&tx, CONNECTION_MONITORING_DATA, &MonitoringData::new(host.clone(), stats)) {
                        debug!("Notification channel closed, stopping monitoring for '{host}'");
                        return;
                    }
                }
                None => break,
            },
        }
    }

    while let Ok(update) = subscription.status.try_recv() {
        last_status = Some(update.status);
        if !send_status(&tx, &host, update) {
            return;
        }
    }
    if last_status != Some(MonitorStatus::Offline) {
        debug!("Session monitoring stream for '{host}' ended; reporting Offline");
        send_status(
            &tx,
            &host,
            MonitorStatusUpdate {
                status: MonitorStatus::Offline,
                reason: Some(MonitorStatusReason::Transport),
            },
        );
    }
}

/// Stop a session provider's loop, logging (not failing) an error: the
/// subscription is gone from the agent either way.
pub async fn stop_provider(provider: &(dyn MonitoringProvider + Send + Sync)) {
    if let Err(e) = provider.unsubscribe().await {
        debug!("Session monitoring unsubscribe failed: {e}");
    }
}

fn send_status(tx: &NotificationSender, host: &str, update: MonitorStatusUpdate) -> bool {
    let payload = MonitoringStatusNotification {
        host: host.to_string(),
        status: update.status,
        reason: update.reason,
    };
    send(tx, CONNECTION_MONITORING_STATUS, &payload)
}

/// Send one notification; `false` once the channel to the desktop is closed.
fn send(tx: &NotificationSender, method: &str, payload: &impl serde::Serialize) -> bool {
    match serde_json::to_value(payload) {
        Ok(value) => tx.send(JsonRpcNotification::new(method, value)).is_ok(),
        Err(e) => {
            warn!("Failed to serialize {method}: {e}");
            true
        }
    }
}

/// Test support shared by the agent's session-monitoring tests (#3871).
#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests;
