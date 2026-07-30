//! Runtime registry of available [`Tool`]s.
//!
//! Twin of [`ConnectionTypeRegistry`](crate::connection::ConnectionTypeRegistry).
//! Because tools are stateless singletons, the registry holds one shared
//! [`Arc<dyn Tool>`] per id (rather than a per-invocation factory) and
//! dispatches a run by id.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::network_tools::builtin_network_tools;
use super::{Tool, ToolError, ToolHost};

/// Metadata about a registered tool for UI discovery.
///
/// Serializable so it can be sent to the frontend or across JSON-RPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    /// Machine-readable identifier (e.g. `"ping"`).
    pub tool_id: String,
    /// Human-readable display name (e.g. `"Ping"`).
    pub display_name: String,
}

/// Runtime registry of available tools.
///
/// Desktop and agent crates populate this at startup — usually via
/// [`with_builtin_network_tools`](Self::with_builtin_network_tools) — then
/// dispatch invocations by id.
#[derive(Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    /// Insertion order for deterministic listing.
    order: Vec<String>,
}

impl ToolRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a registry pre-populated with every built-in network tool.
    pub fn with_builtin_network_tools() -> Self {
        let mut registry = Self::new();
        for tool in builtin_network_tools() {
            registry.register(tool);
        }
        registry
    }

    /// Register a tool under its own [`tool_id`](Tool::tool_id).
    ///
    /// Re-registering an existing id replaces the instance but keeps its
    /// position in the listing order.
    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        let id = tool.tool_id().to_string();
        if !self.tools.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.tools.insert(id, tool);
    }

    /// List all registered tools with their metadata, in registration order.
    pub fn available_tools(&self) -> Vec<ToolInfo> {
        self.order
            .iter()
            .filter_map(|id| self.tools.get(id))
            .map(|t| ToolInfo {
                tool_id: t.tool_id().to_string(),
                display_name: t.display_name().to_string(),
            })
            .collect()
    }

    /// Fetch a registered tool by id.
    pub fn get(&self, tool_id: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(tool_id).cloned()
    }

    /// Whether a tool with the given id is registered.
    pub fn has_tool(&self, tool_id: &str) -> bool {
        self.tools.contains_key(tool_id)
    }

    /// Remove a previously-registered tool. Returns `true` if one was removed.
    pub fn unregister(&mut self, tool_id: &str) -> bool {
        if self.tools.remove(tool_id).is_some() {
            self.order.retain(|id| id != tool_id);
            true
        } else {
            false
        }
    }

    /// Dispatch a run to the tool with the given id.
    ///
    /// Returns [`ToolError::UnknownTool`] when no such tool is registered;
    /// otherwise forwards to [`Tool::run`].
    pub async fn run(
        &self,
        tool_id: &str,
        params: Value,
        host: Arc<dyn ToolHost>,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        let tool = self
            .get(tool_id)
            .ok_or_else(|| ToolError::UnknownTool(tool_id.to_string()))?;
        tool.run(params, host, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool::{CollectingHost, ToolEvent};
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A controllable tool: emits `n` `tick` events, one per loop, stopping
    /// early if cancelled. Lets the registry tests exercise streaming and
    /// cancellation without any network.
    struct CountingTool {
        emitted: Arc<AtomicU32>,
    }

    #[async_trait]
    impl Tool for CountingTool {
        fn tool_id(&self) -> &str {
            "counting"
        }
        fn display_name(&self) -> &str {
            "Counting"
        }
        async fn run(
            &self,
            params: Value,
            host: Arc<dyn ToolHost>,
            cancel: CancellationToken,
        ) -> Result<Value, ToolError> {
            let n = params["n"].as_u64().unwrap_or(0);
            let mut sent = 0u32;
            for i in 0..n {
                if cancel.is_cancelled() {
                    return Err(ToolError::Cancelled(self.tool_id().to_string()));
                }
                host.emit(ToolEvent::new("tick", json!({ "i": i })));
                sent += 1;
                self.emitted.store(sent, Ordering::SeqCst);
            }
            Ok(json!({ "sent": sent }))
        }
    }

    #[test]
    fn builtin_registry_lists_network_tools_in_order() {
        let registry = ToolRegistry::with_builtin_network_tools();
        let ids: Vec<String> = registry
            .available_tools()
            .into_iter()
            .map(|t| t.tool_id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "ping",
                "ping_sweep",
                "port_scan",
                "traceroute",
                "dns",
                "open_ports",
                "wol"
            ]
        );
        assert!(registry.has_tool("ping"));
        assert!(!registry.has_tool("nope"));
    }

    #[tokio::test]
    async fn unknown_tool_returns_error() {
        let registry = ToolRegistry::new();
        let host = CollectingHost::new();
        let err = registry
            .run("ghost", json!({}), host, CancellationToken::new())
            .await
            .expect_err("unknown tool must error");
        assert!(matches!(err, ToolError::UnknownTool(id) if id == "ghost"));
    }

    #[tokio::test]
    async fn run_streams_events_and_returns_aggregate() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(CountingTool {
            emitted: Arc::new(AtomicU32::new(0)),
        }));

        let host = CollectingHost::new();
        let result = registry
            .run(
                "counting",
                json!({ "n": 3 }),
                host.clone(),
                CancellationToken::new(),
            )
            .await
            .expect("run must succeed");

        assert_eq!(result["sent"], 3);
        let events = host.take();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, "tick");
        assert_eq!(events[2].payload["i"], 2);
    }

    #[tokio::test]
    async fn cancellation_stops_a_run() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(CountingTool {
            emitted: Arc::new(AtomicU32::new(0)),
        }));

        // A pre-cancelled token means the tool aborts before its first emit.
        let cancel = CancellationToken::new();
        cancel.cancel();
        let host = CollectingHost::new();
        let err = registry
            .run("counting", json!({ "n": 100 }), host.clone(), cancel)
            .await
            .expect_err("cancelled run must error");
        assert!(matches!(err, ToolError::Cancelled(id) if id == "counting"));
        assert!(host.take().is_empty());
    }

    #[test]
    fn unregister_removes_tool_and_order() {
        let mut registry = ToolRegistry::with_builtin_network_tools();
        assert!(registry.unregister("ping"));
        assert!(!registry.has_tool("ping"));
        assert!(!registry.unregister("ping"));
        let ids: Vec<String> = registry
            .available_tools()
            .into_iter()
            .map(|t| t.tool_id)
            .collect();
        assert!(!ids.contains(&"ping".to_string()));
        assert!(ids.contains(&"dns".to_string()));
    }
}
