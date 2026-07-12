//! Per-process registry of clients connected to this agent.
//!
//! The desktop opens **one agent process per `--stdio` channel**
//! (`src-tauri/src/terminal/agent_manager.rs` execs `termihub-agent --stdio`
//! over a russh exec channel), so a single agent process serves exactly one
//! desktop client. The [`ConnectionRegistry`] records that client — its
//! agent-assigned id, the reported client name/version, and when it completed
//! `initialize` — so the process can answer "who is connected" without guessing.
//!
//! The container is shaped to hold *many* clients (add / remove / list / get)
//! even though the `--stdio` path only ever holds one: the TCP `--listen` mode
//! (`agent/src/io/tcp.rs`) serves clients sequentially over a shared
//! [`crate::session::manager::SessionManager`], and any future coordination
//! layer (see the multi-host topology ADR in `docs/architecture.md`) builds on
//! the same generic API.
//!
//! Concurrency follows the agent's existing state-sharing pattern
//! (`Arc<Mutex<HashMap<..>>>`, as in `agent_manager.rs`): a `std::sync::Mutex`
//! guarding a `HashMap`, held only for the duration of each map operation and
//! never across an `.await`. Poisoned locks are recovered (`into_inner`) rather
//! than panicking, matching `AgentConnectionManager::is_connected`.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};

/// A single client currently connected to this agent process.
///
/// Populated from the `initialize` request: `client` and `client_version` are
/// the values the client reported, `client_id` is an agent-assigned identifier
/// for this connection, and `connected_since` is stamped when `initialize`
/// completed. Uses [`chrono::DateTime<Utc>`] to match both the concept's
/// `ConnectedClient` shape (source of truth) and the wire format the future
/// `agent.list_connections` RPC will serialize — the same time type the agent's
/// session snapshots already use (`created_at`).
///
/// The metadata fields are the deliberate public shape for the upcoming
/// `agent.list_connections` RPC (#1349); until it lands they are read only by
/// tests, hence the `dead_code` allow in non-test builds.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct ConnectedClient {
    /// Agent-assigned unique id for this client connection.
    pub client_id: String,
    /// Client name reported in `initialize` (e.g. `"termihub-desktop"`).
    pub client: String,
    /// Client version reported in `initialize`.
    pub client_version: String,
    /// Wall-clock timestamp of when the client completed `initialize`.
    pub connected_since: DateTime<Utc>,
}

/// Thread-safe registry of the clients connected to this agent process.
#[derive(Debug, Default)]
pub struct ConnectionRegistry {
    clients: Mutex<HashMap<String, ConnectedClient>>,
}

impl ConnectionRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a client that has completed `initialize`, returning the stored
    /// entry. Re-registering an existing `client_id` replaces the previous
    /// entry (e.g. a re-`initialize` on the same connection).
    pub fn register(
        &self,
        client_id: impl Into<String>,
        client: impl Into<String>,
        client_version: impl Into<String>,
    ) -> ConnectedClient {
        let entry = ConnectedClient {
            client_id: client_id.into(),
            client: client.into(),
            client_version: client_version.into(),
            connected_since: Utc::now(),
        };
        let mut guard = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(entry.client_id.clone(), entry.clone());
        entry
    }

    /// Remove a client from the registry (called when its connection drops),
    /// returning the removed entry if it was present.
    pub fn remove(&self, client_id: &str) -> Option<ConnectedClient> {
        let mut guard = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(client_id)
    }

    /// Look up a single connected client by id.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get(&self, client_id: &str) -> Option<ConnectedClient> {
        let guard = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(client_id).cloned()
    }

    /// Snapshot of every currently connected client.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn list(&self) -> Vec<ConnectedClient> {
        let guard = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        guard.values().cloned().collect()
    }

    /// Number of currently connected clients.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn len(&self) -> usize {
        let guard = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        guard.len()
    }

    /// Whether no clients are currently connected.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_adds_client() {
        let reg = ConnectionRegistry::new();
        let c = reg.register("id-1", "termihub-desktop", "1.2.3");

        assert_eq!(c.client_id, "id-1");
        assert_eq!(c.client, "termihub-desktop");
        assert_eq!(c.client_version, "1.2.3");
        assert_eq!(reg.len(), 1);
        assert!(!reg.is_empty());
    }

    #[test]
    fn get_returns_registered_metadata() {
        let reg = ConnectionRegistry::new();
        reg.register("id-1", "desktop", "0.1.0");

        let got = reg.get("id-1").expect("client should be present");
        assert_eq!(got.client, "desktop");
        assert_eq!(got.client_version, "0.1.0");
        assert!(reg.get("missing").is_none());
    }

    #[test]
    fn connected_since_is_recent() {
        let reg = ConnectionRegistry::new();
        let before = Utc::now();
        let c = reg.register("id-1", "desktop", "0.1.0");
        let after = Utc::now();
        assert!(
            c.connected_since >= before && c.connected_since <= after,
            "connected_since must be stamped at registration time"
        );
    }

    #[test]
    fn add_then_remove_leaves_registry_empty() {
        let reg = ConnectionRegistry::new();
        reg.register("id-1", "desktop", "0.1.0");

        let removed = reg.remove("id-1").expect("remove should return the client");
        assert_eq!(removed.client_id, "id-1");
        assert!(reg.is_empty());
        assert_eq!(reg.len(), 0);
        assert!(reg.remove("id-1").is_none());
    }

    #[test]
    fn multiple_clients_list_correctly() {
        let reg = ConnectionRegistry::new();
        reg.register("id-1", "desktop-a", "1.0.0");
        reg.register("id-2", "desktop-b", "2.0.0");
        reg.register("id-3", "desktop-c", "3.0.0");

        assert_eq!(reg.len(), 3);
        let mut ids: Vec<String> = reg.list().into_iter().map(|c| c.client_id).collect();
        ids.sort();
        assert_eq!(ids, vec!["id-1", "id-2", "id-3"]);
    }

    #[test]
    fn re_register_same_id_replaces_entry() {
        let reg = ConnectionRegistry::new();
        reg.register("id-1", "desktop", "1.0.0");
        reg.register("id-1", "desktop", "1.1.0");

        assert_eq!(reg.len(), 1);
        assert_eq!(
            reg.get("id-1").expect("client present").client_version,
            "1.1.0"
        );
    }
}
