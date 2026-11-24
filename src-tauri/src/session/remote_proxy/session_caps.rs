//! The per-session capabilities of an agent-hosted session (#5953).
//!
//! A fresh connect and a resumed session ([`RemoteProxy::resume_existing`])
//! both ask the agent what the session's type can do and set up the file
//! browser, monitoring and process proxies from the answer, so a tab that
//! re-attached its session keeps its Files sidebar and status bar.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use serde_json::Value;

use super::*;

/// What an agent session's connect settings say about the session: its type,
/// its own config and the saved definition it came from.
pub(super) struct RemoteSessionTarget {
    /// The agent's type id. The user-facing "shell" is the agent's "local", so
    /// capability lookups and the monitoring host ("local" → "self") match.
    pub(super) session_type: String,
    /// The session's own config (the settings' `config`, else the settings).
    pub(super) config: Value,
    /// The saved connection definition the session is linked to, so it can be
    /// re-attached after a tab close or a restart. The frontend puts
    /// `definitionId` inside the connection settings, which
    /// `SessionManager::create_connection` wraps under `config`; other callers
    /// pass it beside `type`.
    pub(super) definition_id: Option<String>,
}

impl RemoteSessionTarget {
    pub(super) fn from_settings(settings: &Value) -> Self {
        let raw_type = settings
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("local");
        let session_type = match raw_type {
            "shell" => "local".to_string(),
            other => other.to_string(),
        };
        let config = settings
            .get("config")
            .cloned()
            .unwrap_or_else(|| settings.clone());
        let definition_id = config
            .get("definitionId")
            .or_else(|| config.get("definition_id"))
            .or_else(|| settings.get("definitionId"))
            .or_else(|| settings.get("definition_id"))
            .and_then(|v| v.as_str())
            .map(String::from);
        Self {
            session_type,
            config,
            definition_id,
        }
    }
}

impl RemoteProxy {
    /// Re-attach the agent's still-running session `remote_session_id` for a
    /// tab that showed it (#5953), with the capabilities a fresh connect of
    /// `settings` would get.
    ///
    /// A session another desktop holds is never taken over (single-attach):
    /// that refusal is an error, so the caller starts a new session instead.
    pub(crate) async fn resume_existing(
        agent_id: &str,
        remote_session_id: &str,
        agent_manager: Arc<dyn AgentRpcClient>,
        settings: &Value,
    ) -> Result<Self, SessionError> {
        let (aid, rsid, mgr) = (
            agent_id.to_string(),
            remote_session_id.to_string(),
            agent_manager.clone(),
        );
        // `reconnect_existing` parks on the agent's reply: blocking pool.
        let (mut proxy, outcome) =
            tokio::task::spawn_blocking(move || Self::reconnect_existing(aid, rsid, mgr))
                .await
                .map_err(|e| SessionError::SpawnFailed(format!("spawn_blocking join: {e}")))??;
        if outcome == ReattachOutcome::HeldByPeer {
            let _ = agent_manager.unregister_session_output(agent_id, remote_session_id);
            return Err(SessionError::SpawnFailed(
                "Session is held by another desktop".to_string(),
            ));
        }
        let target = RemoteSessionTarget::from_settings(settings);
        if let Ok(mut t) = proxy.remote_type_id.lock() {
            t.clone_from(&target.session_type);
        }
        proxy
            .adopt_session_capabilities(
                &target.session_type,
                &target.config,
                target.definition_id,
                remote_session_id,
            )
            .await?;
        Ok(proxy)
    }

    /// Ask the agent for `session_type`'s capabilities and set up the file
    /// browser, monitoring and process proxies for the session `remote_sid`.
    /// A malformed reply leaves the defaults in place.
    pub(super) async fn adopt_session_capabilities(
        &mut self,
        session_type: &str,
        config: &Value,
        definition_id: Option<String>,
        remote_sid: &str,
    ) -> Result<(), SessionError> {
        let session_type = session_type.to_string();
        let remote_sid = remote_sid.to_string();
        let mgr = self.agent_manager.clone();
        let agent_id_owned = self.agent_id.clone();
        let caps_result = tokio::task::spawn_blocking(move || {
            mgr.send_request(
                &agent_id_owned,
                termihub_core::protocol::methods::CONNECTION_TYPES,
                serde_json::json!({}),
            )
        })
        .await
        .map_err(|e| SessionError::SpawnFailed(format!("spawn_blocking join: {e}")))?;
        // Parse the reply into the shared `ConnectionTypesResult` DTO (DUP-001)
        // and pick this session type's typed `Capabilities` — replacing the
        // hand-rolled `get("types")`/`get("typeId")`/`get("capabilities")`
        // indexing. A malformed reply leaves the defaults in place.
        if let Ok(caps_result) = caps_result {
            let type_info = serde_json::from_value::<ConnectionTypesResult>(caps_result)
                .ok()
                .and_then(|r| r.types.into_iter().find(|t| t.type_id == session_type));
            if let Some(type_info) = type_info {
                let parsed = type_info.capabilities;
                if let Ok(mut c) = self.remote_capabilities.lock() {
                    *c = parsed.clone();
                }
                // Set up file browser proxy if supported. The agent browses
                // a session by its remote session id: a local session on the
                // agent host, an SSH/Docker/FTP/WSL session inside its own
                // remote host, container, server or distribution — which only
                // a 0.22.0+ agent (`sessionFiles`, #3242) serves. On an older
                // agent the file browser says to update the agent.
                if parsed.file_browser {
                    let is_local = session_type == "local";
                    let agent_caps = self.agent_manager.get_capabilities(self.agent_id());
                    let agent_browses_session =
                        agent_caps.as_ref().is_some_and(|caps| caps.session_files);
                    let agent_outdated = !is_local && !agent_browses_session;
                    // Queued transfers (#3587) need ranged slices on top.
                    let file_ranges =
                        !agent_outdated && agent_caps.as_ref().is_some_and(|caps| caps.file_ranges);
                    // A crashed upload trims its partial (#5736) on top.
                    let file_truncate =
                        file_ranges && agent_caps.as_ref().is_some_and(|caps| caps.file_truncate);
                    self.file_browser_proxy = Some(RemoteFileBrowserProxy {
                        agent_id: self.agent_id.clone(),
                        remote_session_id: remote_sid.clone(),
                        agent_manager: self.agent_manager.clone(),
                        agent_outdated,
                        file_ranges,
                        file_truncate,
                        definition_id: definition_id.clone(),
                        filesystem: hosted_filesystem(&self.agent_id, &session_type, config),
                        filesystem_hint: hosted_filesystem_hint(
                            &self.agent_id,
                            &session_type,
                            config,
                            definition_id.as_deref(),
                        )
                        .or_else(|| {
                            // A local session browses the agent host itself
                            // (#5439): the server the agent was dialled to.
                            (session_type == "local")
                                .then(|| self.agent_manager.agent_host_hint(self.agent_id()))
                                .flatten()
                        }),
                        attribute_ops: hosted_attribute_ops(
                            &session_type,
                            agent_outdated,
                            agent_caps
                                .as_ref()
                                .and_then(|caps| caps.host_file_attribute_ops),
                        ),
                    });
                }
                // Set up monitoring proxy if supported.
                if parsed.monitoring {
                    // Local sessions are monitored on the agent host itself
                    // via the "self" sentinel; SSH/Docker/WSL sessions use the
                    // session ID, which a 0.21.0+ agent (`sessionMonitoring`,
                    // #3871) serves through that session's own backend. On an
                    // older agent the status bar says to update the agent.
                    let is_local = session_type == "local";
                    let monitoring_host = if is_local {
                        "self".to_string()
                    } else {
                        remote_sid.clone()
                    };
                    let agent_monitors_session = self
                        .agent_manager
                        .get_capabilities(self.agent_id())
                        .is_some_and(|caps| caps.session_monitoring);
                    self.monitoring_proxy = Some(Arc::new(RemoteMonitoringProxy {
                        agent_id: self.agent_id.clone(),
                        monitoring_host,
                        agent_manager: self.agent_manager.clone(),
                        interval_ms: Arc::new(AtomicU64::new(DEFAULT_MONITORING_INTERVAL_MS)),
                        paused_tx: tokio::sync::watch::channel(false).0,
                        subscribed: AtomicBool::new(false),
                        agent_outdated: !is_local && !agent_monitors_session,
                    }));
                    // A host that can be monitored can also have its processes
                    // listed/killed (PROD-0028). For a local agent session the
                    // "self"-hosted manager runs on the agent; the agent scopes
                    // by the connection id it receives (None for local). An
                    // SSH/Docker/WSL session is scoped to its remote session id,
                    // which a 0.20.0+ agent (`sessionProcesses`, #3210) serves
                    // through that session's own backend. On an older agent the
                    // table still opens and says to update the agent.
                    let is_local = session_type == "local";
                    let process_connection_id = if is_local {
                        None
                    } else {
                        Some(remote_sid.clone())
                    };
                    let agent_serves_session = self
                        .agent_manager
                        .get_capabilities(self.agent_id())
                        .is_some_and(|caps| caps.session_processes);
                    self.process_proxy = Some(Arc::new(RemoteProcessProxy {
                        agent_id: self.agent_id.clone(),
                        connection_id: process_connection_id,
                        agent_manager: self.agent_manager.clone(),
                        agent_outdated: !is_local && !agent_serves_session,
                    }));
                }
            }
        }
        Ok(())
    }
}
