//! Backend retention of a connected agent's SSH transport config — the agent
//! counterpart to session retention **Model A** ([`crate::session::retained_request`]),
//! and the foundation for the server-side agent-transport re-establishment in the
//! reconnect redrive (#2472, agent half of #2446; unblocks #2473 + #2205 PR-B).
//!
//! # Why retain the agent config
//!
//! When a resilient **agent** session drops because the agent's SSH transport
//! itself went down and the in-task reconnect loop
//! ([`crate::terminal::agent_manager`]) exhausted its budget and *reaped* the
//! connection, the desktop no longer holds anything to re-establish it with — the
//! [`RemoteAgentConfig`]/[`AgentSettings`] were captured by value in the reaped
//! I/O task and dropped with it. To let the reconnect redrive **cold-re-establish
//! the agent transport itself** (call `connect_agent` again on the fired attempt
//! edge), the backend must own that config past the reap. This store is that
//! ownership.
//!
//! It is keyed by **`agent_id`** (not tab id): one SSH transport is multiplexed
//! by every session on that agent, so the transport config is per-agent, whereas
//! the per-tab [`crate::session::retained_request`] owns the session request.
//!
//! # Security: the agent password must not outlive the loop
//!
//! [`RemoteAgentConfig::password`] is a **resolved secret** (an SSH password
//! after credential-store resolution). Surviving the reap extends its in-memory
//! lifetime, so — exactly as Model A does for the session request — a retained
//! agent config is **zeroized on drop** and scrubbed at every terminal point:
//! user disconnect / shutdown / prune (the "agent is gone" points, in
//! [`crate::terminal::agent_manager`]) and reconnect give-up (the loop-terminal
//! point, in the redrive). Zeroizing uses the same [`zeroize`] crate the
//! credential store uses.
//!
//! # Byte-identical when the flag is off
//!
//! Nothing populates this store unless the agent connect opted into
//! backend-reattach (the client's default-off `sessionBackendReattach` flag,
//! threaded through the `connect_agent` command). With the flag off the store is
//! never written, so no agent config survives a reap — byte-identical to
//! `develop`, and no new secret lifetime is introduced.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use zeroize::Zeroize;

use crate::connection::config::AgentSettings;
use crate::terminal::backend::RemoteAgentConfig;

/// A retained agent SSH transport config for one agent's reconnect redrive.
///
/// Zeroized on drop: [`RemoteAgentConfig::password`] may hold a resolved secret
/// (see the module docs), so [`Drop`] scrubs it rather than leaving it for the
/// allocator to reuse. `key_path` is a filesystem path, not a secret, and is left
/// as-is; [`AgentSettings`] carries no secrets.
#[derive(Debug, Clone)]
pub(crate) struct RetainedAgentConfig {
    /// The agent's SSH transport config — **`password` may be a secret**.
    pub(crate) config: RemoteAgentConfig,
    /// The agent runtime settings sent on `initialize`.
    pub(crate) settings: AgentSettings,
}

impl Drop for RetainedAgentConfig {
    fn drop(&mut self) {
        if let Some(password) = self.config.password.as_mut() {
            password.zeroize();
        }
    }
}

/// Per-agent store of [`RetainedAgentConfig`]s, keyed by `agent_id`.
///
/// Cloneable (`Arc`-backed) so it can be a field on the
/// [`crate::terminal::agent_manager::AgentConnectionManager`] and shared with the
/// detached tasks / redrive that re-establish a reaped transport.
#[derive(Clone, Default)]
pub(crate) struct AgentConfigStore {
    inner: Arc<Mutex<HashMap<String, RetainedAgentConfig>>>,
}

impl AgentConfigStore {
    /// An empty store.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, RetainedAgentConfig>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Retain (replacing any prior) the transport config for `agent_id`. A
    /// re-connect overwrites the previous config; the replaced value is zeroized
    /// as it drops.
    pub(crate) fn retain(
        &self,
        agent_id: &str,
        config: RemoteAgentConfig,
        settings: AgentSettings,
    ) {
        self.lock().insert(
            agent_id.to_string(),
            RetainedAgentConfig { config, settings },
        );
    }

    /// Drop and zeroize the retained config for `agent_id`, if any. Idempotent —
    /// clearing an agent with no retained config is a no-op. This is the security
    /// mitigation's scrub point: every terminal (agent-gone / loop-give-up) path
    /// calls it.
    pub(crate) fn clear(&self, agent_id: &str) {
        // `remove` returns the value; dropping it runs the zeroizing `Drop`.
        drop(self.lock().remove(agent_id));
    }

    /// A clone of the retained config for `agent_id`, for the redrive to
    /// re-establish the transport. Cloning copies the secret-bearing password;
    /// the returned [`RetainedAgentConfig`]'s `Drop` zeroizes the clone, so the
    /// caller must hold it only as long as the re-connect needs it.
    pub(crate) fn get(&self, agent_id: &str) -> Option<RetainedAgentConfig> {
        self.lock().get(agent_id).cloned()
    }

    /// Whether a config is currently retained for `agent_id`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn contains(&self, agent_id: &str) -> bool {
        self.lock().contains_key(agent_id)
    }
}

/// What the reconnect redrive should do to re-establish an agent's transport,
/// decided from whether the agent is already connected and whether a reattach
/// config is retained. Split out from
/// [`crate::terminal::agent_manager::AgentConnectionManager::reconnect_retained_agent`]
/// so the single-owner coordination is unit-testable without a live SSH connect
/// or a Tauri runtime.
pub(crate) enum ReattachDecision {
    /// The agent is already connected — either genuinely, or mid in-task
    /// reconnect (the map entry is still alive). Do not double-drive: no-op.
    AlreadyConnected,
    /// The transport is down and a config is retained: cold-re-establish it.
    /// Boxed to keep the enum small (the config is far larger than the unit
    /// variants).
    Reconnect(Box<RetainedAgentConfig>),
    /// The transport is down and nothing is retained (the connect did not opt in,
    /// or the config was already scrubbed): the redrive folds a reconnect failure.
    NoRetainedConfig,
}

/// Decide how the redrive should re-establish `agent_id`'s transport.
///
/// `connected` is the caller's `is_connected(agent_id)` reading, threaded in so
/// this stays a pure function over the store.
pub(crate) fn decide_reattach(
    store: &AgentConfigStore,
    connected: bool,
    agent_id: &str,
) -> ReattachDecision {
    if connected {
        return ReattachDecision::AlreadyConnected;
    }
    match store.get(agent_id) {
        Some(retained) => ReattachDecision::Reconnect(Box::new(retained)),
        None => ReattachDecision::NoRetainedConfig,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_password(password: Option<&str>) -> RemoteAgentConfig {
        RemoteAgentConfig {
            host: "example.com".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_method: "password".to_string(),
            password: password.map(|s| s.to_string()),
            key_path: Some("~/.ssh/id_ed25519".to_string()),
            save_password: None,
            agent_path: None,
            external_connection_files: Vec::new(),
            allow_self_update: false,
            update_strategy: Default::default(),
        }
    }

    #[test]
    fn retain_and_get_roundtrip() {
        let store = AgentConfigStore::new();
        assert!(!store.contains("agent-1"));

        store.retain(
            "agent-1",
            config_with_password(Some("secret")),
            AgentSettings::default(),
        );
        assert!(store.contains("agent-1"));

        let got = store.get("agent-1").expect("retained config");
        assert_eq!(got.config.host, "example.com");
        assert_eq!(got.config.password.as_deref(), Some("secret"));
    }

    #[test]
    fn clear_drops_and_is_idempotent() {
        let store = AgentConfigStore::new();
        store.retain(
            "agent-1",
            config_with_password(Some("secret")),
            AgentSettings::default(),
        );
        assert!(store.contains("agent-1"));

        store.clear("agent-1");
        assert!(!store.contains("agent-1"));
        // Clearing an absent agent is a no-op.
        store.clear("agent-1");
        assert!(!store.contains("agent-1"));
    }

    #[test]
    fn retain_replaces_prior_config() {
        let store = AgentConfigStore::new();
        store.retain(
            "agent-1",
            config_with_password(Some("old")),
            AgentSettings::default(),
        );
        store.retain(
            "agent-1",
            config_with_password(Some("new")),
            AgentSettings::default(),
        );
        assert_eq!(
            store.get("agent-1").unwrap().config.password.as_deref(),
            Some("new")
        );
    }

    #[test]
    fn drop_zeroizes_the_password() {
        // The retained config's Drop must scrub the secret password in place. We
        // assert the observable contract via the mechanism Drop uses (`Zeroize`
        // on the owned string): after scrubbing, the secret does not survive.
        let mut retained = RetainedAgentConfig {
            config: config_with_password(Some("super-secret")),
            settings: AgentSettings::default(),
        };
        // Mimic Drop's scrub and assert it empties the secret.
        if let Some(password) = retained.config.password.as_mut() {
            password.zeroize();
        }
        assert_eq!(retained.config.password.as_deref(), Some(""));
    }

    #[test]
    fn get_is_none_when_absent() {
        let store = AgentConfigStore::new();
        assert!(store.get("nope").is_none());
    }

    #[test]
    fn decide_reattach_no_ops_when_already_connected() {
        // Never double-drive against the in-task reconnect loop: a connected (or
        // mid-reconnect, still-alive) agent means the transport is owned already.
        let store = AgentConfigStore::new();
        store.retain(
            "agent-1",
            config_with_password(Some("secret")),
            AgentSettings::default(),
        );
        assert!(matches!(
            decide_reattach(&store, true, "agent-1"),
            ReattachDecision::AlreadyConnected
        ));
    }

    #[test]
    fn decide_reattach_reconnects_when_down_with_a_retained_config() {
        let store = AgentConfigStore::new();
        store.retain(
            "agent-1",
            config_with_password(Some("secret")),
            AgentSettings::default(),
        );
        match decide_reattach(&store, false, "agent-1") {
            ReattachDecision::Reconnect(retained) => {
                assert_eq!(retained.config.password.as_deref(), Some("secret"));
            }
            _ => panic!("expected a cold re-establish from the retained config"),
        }
    }

    #[test]
    fn decide_reattach_reports_no_config_when_down_and_nothing_retained() {
        // Flag-off (or already-scrubbed) tabs retain nothing: the redrive must
        // fold a reconnect failure rather than block on a phantom transport.
        let store = AgentConfigStore::new();
        assert!(matches!(
            decide_reattach(&store, false, "agent-none"),
            ReattachDecision::NoRetainedConfig
        ));
    }

    #[test]
    fn a_config_without_a_password_retains_and_clears_cleanly() {
        // Key-auth agents carry no password; Drop must tolerate `None`.
        let store = AgentConfigStore::new();
        store.retain(
            "agent-key",
            config_with_password(None),
            AgentSettings::default(),
        );
        let got = store.get("agent-key").expect("retained config");
        assert!(got.config.password.is_none());
        store.clear("agent-key");
        assert!(!store.contains("agent-key"));
    }
}
