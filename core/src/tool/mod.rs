//! One-shot / streaming diagnostic tools behind a uniform trait.
//!
//! A [`Tool`] is a stateless invocation — ping, traceroute, port scan, DNS
//! lookup, Wake-on-LAN — with no persistent lifecycle. This is the twin of the
//! long-lived [`Service`](crate::service::Service) abstraction: where a service
//! *runs*, a tool is *invoked*.
//!
//! The network diagnostics already exist as plain functions in
//! [`crate::network`]. This module wraps each one behind a single trait so that
//! both host processes (the desktop and the remote agent) can drive them
//! through one uniform interface, gated only by which registry the caller
//! reaches. The trait adds two things the bare functions lack:
//!
//! * a **uniform host** ([`ToolHost`]) that streamed intermediate results are
//!   emitted through, identical whether the tool runs locally or on an agent;
//! * a **cancellation token** so an in-flight run can be aborted.
//!
//! # Architecture
//!
//! Concrete tools live here in core so the desktop and agent share one
//! implementation. A [`ToolRegistry`] (twin of
//! [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry)) is
//! populated at startup — [`ToolRegistry::with_builtin_network_tools`] wires the
//! full network-diagnostics set — and dispatches an invocation by tool id.
//!
//! # Example
//!
//! ```ignore
//! let registry = ToolRegistry::with_builtin_network_tools();
//! let host = CollectingHost::new();
//! let result = registry
//!     .run("dns", json!({ "hostname": "example.com", "recordType": "A" }),
//!          host.clone(), CancellationToken::new())
//!     .await?;
//! for event in host.take() { /* streamed records */ }
//! ```

pub mod network_tools;
pub mod registry;

pub use network_tools::builtin_network_tools;
pub use registry::{ToolInfo, ToolRegistry};

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::network::NetworkError;

/// A single intermediate result streamed by a tool during a run.
///
/// Streaming tools (ping, port scan, traceroute, ping sweep) emit one event per
/// result through the [`ToolHost`]; the final aggregate (stats / summary) is the
/// value returned from [`Tool::run`]. One-shot tools (DNS, open ports, WoL) emit
/// nothing and return their whole result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    /// Discriminator for the payload shape, e.g. `"result"`, `"hop"`.
    pub kind: String,
    /// The serialized result record.
    pub payload: Value,
}

impl ToolEvent {
    /// Build an event, serializing `payload` to JSON.
    ///
    /// Serialization of the built-in result types is infallible; a payload that
    /// somehow fails to serialize degrades to `null` rather than panicking,
    /// keeping the emit path free of `unwrap`.
    pub fn new(kind: impl Into<String>, payload: impl Serialize) -> Self {
        Self {
            kind: kind.into(),
            payload: serde_json::to_value(payload).unwrap_or(Value::Null),
        }
    }
}

/// Uniform sink a [`Tool`] streams its intermediate [`ToolEvent`]s to.
///
/// The host is what makes a tool location-agnostic: a locally-run tool emits to
/// a host that forwards to the desktop UI, while an agent-run tool emits to a
/// host that relays over JSON-RPC — the tool itself is identical either way.
pub trait ToolHost: Send + Sync {
    /// Emit one streamed result. Must not block.
    fn emit(&self, event: ToolEvent);
}

/// A [`ToolHost`] that buffers every emitted event in memory.
///
/// Used by callers that collect a whole run before responding — the agent's
/// non-streaming `tool.run` JSON-RPC method, and unit tests.
#[derive(Debug, Default)]
pub struct CollectingHost {
    events: std::sync::Mutex<Vec<ToolEvent>>,
}

impl CollectingHost {
    /// Create an empty collecting host wrapped in an [`Arc`] ready to pass to
    /// [`Tool::run`].
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Snapshot the events collected so far without draining them.
    pub fn events(&self) -> Vec<ToolEvent> {
        self.events.lock().expect("tool host mutex poisoned").clone()
    }

    /// Drain and return all collected events.
    pub fn take(&self) -> Vec<ToolEvent> {
        std::mem::take(&mut *self.events.lock().expect("tool host mutex poisoned"))
    }
}

impl ToolHost for CollectingHost {
    fn emit(&self, event: ToolEvent) {
        self.events
            .lock()
            .expect("tool host mutex poisoned")
            .push(event);
    }
}

/// Errors from invoking a [`Tool`].
#[derive(Error, Debug)]
pub enum ToolError {
    /// No tool with the requested id is registered.
    #[error("Unknown tool: {0}")]
    UnknownTool(String),

    /// The params JSON did not match the tool's expected shape.
    #[error("Invalid params for tool '{tool}': {reason}")]
    InvalidParams {
        /// The tool that rejected the params.
        tool: String,
        /// Why the params were rejected.
        reason: String,
    },

    /// The run was cancelled before completing.
    #[error("Tool '{0}' was cancelled")]
    Cancelled(String),

    /// The underlying network operation failed.
    #[error(transparent)]
    Network(#[from] NetworkError),

    /// Any other execution failure.
    #[error("Tool execution failed: {0}")]
    Execution(String),
}

/// A stateless, one-shot or streaming diagnostic invocation.
///
/// Concrete tools are stateless singletons; a [`ToolRegistry`] holds one shared
/// instance of each and dispatches by [`tool_id`](Self::tool_id).
#[async_trait]
pub trait Tool: Send + Sync {
    /// Machine-readable identifier (e.g. `"ping"`, `"port_scan"`).
    fn tool_id(&self) -> &str;

    /// Human-readable display name (e.g. `"Ping"`).
    fn display_name(&self) -> &str;

    /// Run the tool.
    ///
    /// Intermediate results are streamed via `host`; the returned [`Value`] is
    /// the run's final aggregate (stats / summary), or `{}` for tools with no
    /// aggregate. `cancel` aborts an in-flight run — streaming tools stop early
    /// and return whatever aggregate they have so far.
    async fn run(
        &self,
        params: Value,
        host: Arc<dyn ToolHost>,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    // Object-safety / Send+Sync guards mirroring the connection module.
    fn _assert_object_safe(_: &dyn Tool) {}
    fn _assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn tool_is_send_sync() {
        _assert_send_sync::<Box<dyn Tool>>();
        _assert_send_sync::<Arc<dyn ToolHost>>();
    }

    #[test]
    fn collecting_host_buffers_and_drains() {
        let host = CollectingHost::new();
        host.emit(ToolEvent::new("result", serde_json::json!({ "seq": 1 })));
        host.emit(ToolEvent::new("result", serde_json::json!({ "seq": 2 })));
        assert_eq!(host.events().len(), 2);

        let drained = host.take();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].kind, "result");
        assert_eq!(drained[0].payload["seq"], 1);
        // Draining empties the buffer.
        assert!(host.events().is_empty());
    }

    #[test]
    fn tool_event_serializes_camel_case() {
        let event = ToolEvent::new("hop", serde_json::json!({ "hop": 3 }));
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "hop");
        assert_eq!(json["payload"]["hop"], 3);
    }
}
