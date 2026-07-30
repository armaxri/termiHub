//! Long-lived services behind a uniform trait.
//!
//! A [`Service`] is a long-lived, stateful thing with a lifecycle —
//! `start` / `stop` / `status` / `subscribe_events` — plus a
//! [`settings_schema`](Service::settings_schema) and
//! [`capabilities`](Service::capabilities), exactly like
//! [`ConnectionType`](crate::connection::ConnectionType). This is the twin of
//! the one-shot [`Tool`](crate::tool::Tool) abstraction: where a tool is
//! *invoked*, a service *runs*.
//!
//! Intended implementors (moved onto the trait in later phases, per the
//! stateless-UI concept #2139): the embedded HTTP/FTP/TFTP servers, SSH
//! tunnels, the HTTP monitor, and system monitors. This module lands the
//! substrate — the trait, a [`ServiceRegistry`] (twin of
//! [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry)), and a
//! reusable [`EventChannel`] — so those services can be lifted onto it without
//! any behaviour change now.
//!
//! # Architecture
//!
//! The core crate defines only the trait and data types. Concrete services live
//! in the desktop (`src-tauri/`) and agent (`agent/`) crates, which register
//! their factories with a [`ServiceRegistry`] at startup. A service streams
//! status/stats through the core-owned [`EventChannel`] rather than a
//! host-specific emitter, so the same implementation runs on the desktop or an
//! agent.

pub mod registry;

pub use registry::{ServiceFactory, ServiceInfo, ServiceRegistry};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::connection::SettingsSchema;

/// Default capacity of a service's event broadcast channel.
///
/// A slow subscriber that lags past this many buffered events will observe a
/// [`broadcast::error::RecvError::Lagged`] on its next receive rather than
/// stalling the emitter — status/stats events are advisory, so dropping the
/// oldest is the right trade-off.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Lifecycle state of a [`Service`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "detail")]
pub enum ServiceStatus {
    /// Not running.
    Stopped,
    /// A start is in progress.
    Starting,
    /// Running normally.
    Running,
    /// A stop is in progress.
    Stopping,
    /// Terminated abnormally; carries a human-readable reason.
    Failed(String),
}

/// A status/stats event emitted by a running service.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEvent {
    /// Discriminator for the payload shape, e.g. `"status"`, `"stats"`.
    pub kind: String,
    /// The serialized event body.
    pub payload: Value,
}

impl ServiceEvent {
    /// Build an event, serializing `payload` to JSON (degrading a serialization
    /// failure to `null` rather than panicking).
    pub fn new(kind: impl Into<String>, payload: impl Serialize) -> Self {
        Self {
            kind: kind.into(),
            payload: serde_json::to_value(payload).unwrap_or(Value::Null),
        }
    }
}

/// Receiver end of a service's event stream.
pub type ServiceEventReceiver = broadcast::Receiver<ServiceEvent>;

/// A multi-subscriber event channel a [`Service`] emits status/stats through.
///
/// Services embed one and expose it via
/// [`subscribe_events`](Service::subscribe_events). Emitting with no
/// subscribers is a no-op, so a service may emit freely regardless of whether
/// anyone is listening.
#[derive(Debug, Clone)]
pub struct EventChannel {
    sender: broadcast::Sender<ServiceEvent>,
}

impl EventChannel {
    /// Create a channel with the default capacity.
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self { sender }
    }

    /// Emit an event to all current subscribers. No-op when there are none.
    pub fn emit(&self, event: ServiceEvent) {
        let _ = self.sender.send(event);
    }

    /// Subscribe to the event stream. Each call yields an independent receiver.
    pub fn subscribe(&self) -> ServiceEventReceiver {
        self.sender.subscribe()
    }

    /// Current number of active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

impl Default for EventChannel {
    fn default() -> Self {
        Self::new()
    }
}

/// Capabilities declared by a service, for UI discovery and run-location routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCapabilities {
    /// Whether the service takes configuration (a non-empty settings schema).
    pub configurable: bool,
    /// Whether the service emits events on its [`EventChannel`].
    pub emits_events: bool,
    /// Whether this service is permanently desktop-only and must never be
    /// offered an agent run-location.
    ///
    /// The permanent desktop-host set (per the stateless-UI concept's Open
    /// Design Decision #4): credentials/keychain, spawn rendezvous, local file
    /// watch, and OS-window management. The desktop run-location selector omits
    /// the "agent" option for any service that sets this.
    pub desktop_only: bool,
}

/// A long-lived, stateful service with a start/stop lifecycle.
///
/// # Lifecycle
///
/// 1. Create via [`ServiceRegistry::create`]
/// 2. Read metadata: [`service_id`](Self::service_id),
///    [`display_name`](Self::display_name),
///    [`settings_schema`](Self::settings_schema),
///    [`capabilities`](Self::capabilities)
/// 3. [`start`](Self::start) with a config JSON value
/// 4. Observe: [`status`](Self::status),
///    [`subscribe_events`](Self::subscribe_events)
/// 5. [`stop`](Self::stop)
#[async_trait]
pub trait Service: Send {
    /// Machine-readable identifier (e.g. `"http_server"`).
    fn service_id(&self) -> &str;

    /// Human-readable display name (e.g. `"HTTP Server"`).
    fn display_name(&self) -> &str;

    /// Settings schema for dynamic UI form generation.
    fn settings_schema(&self) -> SettingsSchema;

    /// Capabilities of this service.
    fn capabilities(&self) -> ServiceCapabilities;

    /// Start the service using the provided config JSON.
    async fn start(&mut self, config: Value) -> Result<(), ServiceError>;

    /// Stop the service and release its resources.
    async fn stop(&mut self) -> Result<(), ServiceError>;

    /// Current lifecycle state.
    fn status(&self) -> ServiceStatus;

    /// Subscribe to the service's status/stats event stream.
    fn subscribe_events(&self) -> ServiceEventReceiver;
}

/// Errors from a [`Service`] lifecycle operation.
#[derive(Error, Debug)]
pub enum ServiceError {
    /// The config JSON was invalid for this service.
    #[error("Invalid service configuration: {0}")]
    InvalidConfig(String),

    /// The service failed to start.
    #[error("Service failed to start: {0}")]
    StartFailed(String),

    /// The service failed to stop cleanly.
    #[error("Service failed to stop: {0}")]
    StopFailed(String),

    /// No service with the requested id is registered.
    #[error("Unknown service: {0}")]
    Unknown(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn _assert_object_safe(_: &dyn Service) {}
    fn _assert_send<T: Send>() {}

    #[test]
    fn service_is_send() {
        _assert_send::<Box<dyn Service>>();
    }

    #[test]
    fn service_status_serde_roundtrip() {
        let running = serde_json::to_value(ServiceStatus::Running).unwrap();
        assert_eq!(running["state"], "running");
        let failed = serde_json::to_value(ServiceStatus::Failed("boom".into())).unwrap();
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["detail"], "boom");

        let back: ServiceStatus = serde_json::from_value(failed).unwrap();
        assert_eq!(back, ServiceStatus::Failed("boom".into()));
    }

    #[tokio::test]
    async fn event_channel_delivers_to_subscribers() {
        let channel = EventChannel::new();
        // Emitting with no subscribers is a no-op.
        assert_eq!(channel.subscriber_count(), 0);
        channel.emit(ServiceEvent::new("status", serde_json::json!({ "up": true })));

        let mut rx = channel.subscribe();
        assert_eq!(channel.subscriber_count(), 1);
        channel.emit(ServiceEvent::new("stats", serde_json::json!({ "requests": 5 })));

        let event = rx.recv().await.expect("event must arrive");
        assert_eq!(event.kind, "stats");
        assert_eq!(event.payload["requests"], 5);
    }

    #[test]
    fn service_capabilities_camel_case() {
        let caps = ServiceCapabilities {
            configurable: true,
            emits_events: true,
            desktop_only: false,
        };
        let json = serde_json::to_value(&caps).unwrap();
        assert!(json.as_object().unwrap().contains_key("emitsEvents"));
        assert!(json.as_object().unwrap().contains_key("desktopOnly"));
    }
}
