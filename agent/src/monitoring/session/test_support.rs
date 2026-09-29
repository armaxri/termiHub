//! Test support shared by the agent's session-monitoring tests (#3871): a
//! scriptable backend monitoring provider and a sample builder.

use std::sync::Mutex;

use termihub_core::errors::CoreError;
use termihub_core::monitoring::{
    MonitorStatusSender, MonitorStatusUpdate, MonitoringProvider, MonitoringSender,
    MonitoringSubscription, SystemStats,
};

/// A sample whose `hostname` identifies it. Built from JSON so fields a
/// later protocol adds (with serde defaults) never break the tests.
pub fn stats(hostname: &str) -> SystemStats {
    serde_json::from_value(serde_json::json!({
        "hostname": hostname,
        "uptimeSeconds": 1.0,
        "loadAverage": [0.1, 0.2, 0.3],
        "cpuUsagePercent": 12.5,
        "memoryTotalKb": 1024,
        "memoryAvailableKb": 512,
        "memoryUsedPercent": 50.0,
        "diskTotalKb": 2048,
        "diskUsedKb": 1024,
        "diskUsedPercent": 50.0,
        "osInfo": "Linux",
    }))
    .expect("a valid SystemStats sample")
}

/// A backend monitoring provider the test drives: `subscribe` hands out
/// receivers whose senders the test pushes samples / status through.
#[derive(Default)]
pub struct FakeProvider {
    /// When set, `subscribe` fails with this message.
    pub fail: Option<String>,
    feed: Mutex<Option<(MonitoringSender, MonitorStatusSender)>>,
    calls: Mutex<Vec<String>>,
}

impl FakeProvider {
    pub fn failing(message: &str) -> Self {
        Self {
            fail: Some(message.to_string()),
            ..Self::default()
        }
    }

    /// Every provider call so far, in order.
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    /// Whether a subscription is live (its receivers not yet dropped).
    pub fn is_subscribed(&self) -> bool {
        self.feed
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(tx, _)| !tx.is_closed())
    }

    /// Push a sample into the live subscription.
    pub async fn push(&self, sample: SystemStats) {
        let tx = self.feed.lock().unwrap().as_ref().map(|(tx, _)| tx.clone());
        tx.expect("subscribed")
            .send(sample)
            .await
            .expect("receiver alive");
    }

    /// Push a status transition into the live subscription.
    pub async fn push_status(&self, update: MonitorStatusUpdate) {
        let tx = self.feed.lock().unwrap().as_ref().map(|(_, tx)| tx.clone());
        tx.expect("subscribed")
            .send(update)
            .await
            .expect("receiver alive");
    }

    /// End the live subscription's stream (the provider's loop stopped).
    pub fn end(&self) {
        self.feed.lock().unwrap().take();
    }

    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait::async_trait]
impl MonitoringProvider for FakeProvider {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        self.record("subscribe".into());
        if let Some(message) = &self.fail {
            return Err(CoreError::Other(message.clone()));
        }
        let (stats_tx, stats) = tokio::sync::mpsc::channel(16);
        let (status_tx, status) = tokio::sync::mpsc::channel(8);
        *self.feed.lock().unwrap() = Some((stats_tx, status_tx));
        Ok(MonitoringSubscription { stats, status })
    }

    async fn unsubscribe(&self) -> Result<(), CoreError> {
        self.record("unsubscribe".into());
        self.end();
        Ok(())
    }

    async fn set_interval(&self, interval: std::time::Duration) {
        self.record(format!("interval:{}", interval.as_millis()));
    }

    async fn set_paused(&self, paused: bool) {
        self.record(format!("paused:{paused}"));
    }

    async fn cancel_connect(&self) {
        self.record("cancel".into());
    }
}
