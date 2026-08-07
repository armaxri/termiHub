//! Persistent-session management facade over the [`SessionManager`].
//!
//! Extracted from [`SessionManager`](super::manager::SessionManager) (#2111,
//! follow-up to the file-ops seam #2076 and the monitoring seam #2110) as the
//! last and highest-coupling of the three `SessionManager` seams. Every method
//! here is the exact logic that lived inline on the manager: the persistent
//! registry bookkeeping, the idempotency checks, the emitted
//! `persistent-session-state-changed` events, the lock ordering, the error
//! messages, and — crucially — the reconnect path that re-creates a
//! [`RemoteProxy`] and re-spawns the output reader after an agent SSH drop are
//! exactly what lived on the manager.
//!
//! Unlike [`FileOps`](super::file_ops::FileOps) and
//! [`MonitoringController`](super::monitoring_controller::MonitoringController),
//! which borrow only isolated maps, this facade borrows the whole
//! [`SessionManager`]. The reason is genuine coupling, not convenience: the
//! persistent cluster drives the manager's own session lifecycle —
//! [`start_persistent_session`](PersistentController::start_persistent_session)
//! calls [`SessionManager::create_connection`],
//! [`stop_persistent_session`](PersistentController::stop_persistent_session)
//! calls [`SessionManager::close_session`], and
//! [`attach_persistent_tab`](PersistentController::attach_persistent_tab) reuses
//! `SessionManager::ensure_output_buffer` and `SessionManager::run_output_reader`
//! and re-inserts a `SessionEntry` into the shared `sessions` map. It still
//! carries no state of its own; the manager constructs one on demand via
//! `SessionManager::persistent`, and the persistent registry (`persistent_sessions`)
//! remains a field on the manager.

use std::collections::HashSet;

use tracing::info;

use termihub_core::connection::ConnectionType;

use crate::utils::errors::TerminalError;

use super::line_ending::LineEnding;
use super::manager::{
    EventEmitter, PersistentRecord, PersistentSessionStateEvent, PersistentSessionSummary,
    SessionEntry, SessionInfo, SessionManager,
};
use super::remote_proxy::RemoteProxy;

/// Borrowing facade exposing the manager's persistent-session operations.
///
/// Holds only a borrow of the [`SessionManager`], so it carries no state of its
/// own; the manager constructs one on demand via
/// [`SessionManager::persistent`](super::manager::SessionManager). Each method
/// mirrors the persistent-session operation that previously lived inline on the
/// manager and delegates back to the manager for the shared session-lifecycle
/// primitives (`create_connection`, `close_session`, `run_output_reader`).
pub(super) struct PersistentController<'a> {
    manager: &'a SessionManager,
}

impl<'a> PersistentController<'a> {
    /// Wrap the manager whose persistent registry this facade drives.
    pub(super) fn new(manager: &'a SessionManager) -> Self {
        Self { manager }
    }

    /// Start a persistent session for `connection_id`.
    ///
    /// Creates a backend session and registers it in the persistent registry.
    /// Returns the new session ID. If a session for this connection already exists,
    /// returns `Ok(existing_session_id)` without creating a duplicate.
    pub(super) async fn start_persistent_session<E: EventEmitter>(
        &self,
        connection_id: &str,
        type_id: &str,
        settings: serde_json::Value,
        agent_id: Option<&str>,
        emitter: E,
    ) -> Result<String, TerminalError> {
        // Idempotency: if already running return the existing session ID.
        {
            let ps = self.manager.persistent_sessions.lock().await;
            if let Some(record) = ps.get(connection_id) {
                let sessions = self.manager.sessions.lock().await;
                if sessions.contains_key(&record.session_id) {
                    return Ok(record.session_id.clone());
                }
                // Session is registered but backend entry is gone (crashed) — fall through.
            }
        }

        let session_id = self
            .manager
            .create_connection(type_id, settings, agent_id, None, false, emitter.clone())
            .await?;

        // Capture the agent-side remote session ID so that attach_persistent_tab
        // can re-create the RemoteProxy if the desktop session is cleaned up after
        // an agent SSH disconnect (while the daemon itself survives).
        let remote_session_id = {
            let sessions = self.manager.sessions.lock().await;
            sessions
                .get(&session_id)
                .and_then(|e| e.remote_session_id.clone())
        };

        {
            let mut ps = self.manager.persistent_sessions.lock().await;
            ps.insert(
                connection_id.to_string(),
                PersistentRecord {
                    connection_id: connection_id.to_string(),
                    session_id: session_id.clone(),
                    attached_tabs: HashSet::new(),
                    remote_session_id,
                    agent_id: agent_id.map(|s| s.to_string()),
                },
            );
        }

        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(session_id.clone()),
            state: "running".to_string(),
            attached_tab_count: 0,
            error_message: None,
        });

        info!(connection_id, session_id, "Persistent session started");
        Ok(session_id)
    }

    /// Adopt an already-running agent session into the persistent registry.
    ///
    /// Used when the desktop discovers a surviving agent session (e.g. via
    /// the sidebar's Active Sessions list after a tab close) and wants to
    /// re-attach to it with full scrollback replay. Inserts a
    /// [`PersistentRecord`] pointing at the existing agent session without
    /// spawning a new one. The desktop's `sessions` map is intentionally
    /// left untouched — the next `attach_persistent_tab` call detects the
    /// missing entry and re-creates the `RemoteProxy` via
    /// [`RemoteProxy::reconnect_existing`].
    ///
    /// Idempotent: if a record already exists for `connection_id` and points
    /// at the same agent session, this is a no-op. If it points at a
    /// different session id, returns an error so callers can decide whether
    /// to stop the old one first.
    pub(super) async fn adopt_persistent_session<E: EventEmitter>(
        &self,
        connection_id: &str,
        agent_id: &str,
        agent_session_id: &str,
        emitter: E,
    ) -> Result<String, TerminalError> {
        let session_id = agent_session_id.to_string();

        let mut ps = self.manager.persistent_sessions.lock().await;
        if let Some(existing) = ps.get(connection_id) {
            if existing.remote_session_id.as_deref() == Some(agent_session_id) {
                return Ok(existing.session_id.clone());
            }
            return Err(TerminalError::SpawnFailed(format!(
                "Persistent session {connection_id} already adopted with a different agent session"
            )));
        }

        ps.insert(
            connection_id.to_string(),
            PersistentRecord {
                connection_id: connection_id.to_string(),
                session_id: session_id.clone(),
                attached_tabs: HashSet::new(),
                remote_session_id: Some(session_id.clone()),
                agent_id: Some(agent_id.to_string()),
            },
        );
        drop(ps);

        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(session_id.clone()),
            state: "running".to_string(),
            attached_tab_count: 0,
            error_message: None,
        });

        info!(
            connection_id,
            agent_id, agent_session_id, "Adopted existing agent persistent session"
        );
        Ok(session_id)
    }

    /// Stop a persistent session for `connection_id`.
    ///
    /// Closes the backend session and removes the persistent registry entry.
    /// No-op if the session is not registered as persistent.
    pub(super) async fn stop_persistent_session<E: EventEmitter>(
        &self,
        connection_id: &str,
        emitter: E,
    ) -> Result<(), TerminalError> {
        let record = {
            let mut ps = self.manager.persistent_sessions.lock().await;
            ps.remove(connection_id)
        };

        let Some(record) = record else {
            return Ok(());
        };

        self.manager.close_session(&record.session_id).await?;

        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(record.session_id.clone()),
            state: "stopped".to_string(),
            attached_tab_count: 0,
            error_message: None,
        });

        info!(connection_id, session_id = %record.session_id, "Persistent session stopped");
        Ok(())
    }

    /// Register `tab_id` as attached to the persistent session for `connection_id`.
    ///
    /// Returns the new attached-tab count. Returns an error if the session is not
    /// registered and cannot be reconnected.
    ///
    /// When the agent SSH connection drops, `emit_and_cleanup` removes the desktop
    /// session from `sessions` but leaves the `PersistentRecord` intact because the
    /// daemon process on the remote host is still alive. The next `attach_persistent_tab`
    /// call detects the missing session entry and calls
    /// [`RemoteProxy::reconnect_existing`] to re-establish the desktop side, reusing
    /// the same session ID so the tab's `existingSessionId` prop keeps working without
    /// any frontend state update.
    pub(super) async fn attach_persistent_tab<E: EventEmitter>(
        &self,
        connection_id: &str,
        tab_id: &str,
        emitter: E,
    ) -> Result<u32, TerminalError> {
        // Phase 1: Read record info without holding the persistent_sessions lock so we
        // never hold it simultaneously with the sessions lock (avoids deadlock ordering).
        let (session_id, opt_agent_id, opt_remote_sid) = {
            let ps = self.manager.persistent_sessions.lock().await;
            let record = ps.get(connection_id).ok_or_else(|| {
                TerminalError::SessionNotFound(format!(
                    "No persistent session for connection {connection_id}"
                ))
            })?;
            (
                record.session_id.clone(),
                record.agent_id.clone(),
                record.remote_session_id.clone(),
            )
        };

        // Phase 2: Check if the backend session is alive. If not, try to re-create
        // the RemoteProxy by reconnecting to the surviving daemon on the agent.
        let session_alive = self.manager.sessions.lock().await.contains_key(&session_id);
        if !session_alive {
            match (opt_agent_id, opt_remote_sid) {
                (Some(agent_id), Some(remote_sid)) => {
                    // Re-create the RemoteProxy for the daemon that survived the disconnect.
                    // This calls register_session_output + attach_session synchronously, so
                    // buffer replay will be in-flight before subscribe_output() bridges it.
                    //
                    // `attach_session` internally uses `oneshot::Receiver::blocking_recv`,
                    // which parks the calling thread; run on the blocking thread pool so the
                    // tokio worker stays free to drive `agent_io_task` and deliver the reply.
                    let agent_mgr = self.manager.agent_manager.clone();
                    let agent_id_clone = agent_id.clone();
                    let remote_sid_clone = remote_sid.clone();
                    let proxy = tokio::task::spawn_blocking(move || {
                        RemoteProxy::reconnect_existing(agent_id_clone, remote_sid_clone, agent_mgr)
                    })
                    .await
                    .map_err(|e| TerminalError::SpawnFailed(format!("spawn_blocking join: {e}")))?
                    .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

                    let output_rx = proxy.subscribe_output();

                    // Re-insert under the same session_id so the tab's existingSessionId
                    // prop and the TerminalOutputDispatcher's pendingOutput buffer both
                    // continue to work without any frontend state update.
                    {
                        let mut sessions = self.manager.sessions.lock().await;
                        sessions.insert(
                            session_id.clone(),
                            SessionEntry {
                                connection: Box::new(proxy),
                                info: SessionInfo {
                                    id: session_id.clone(),
                                    title: "Persistent Session".to_string(),
                                    connection_type: "remote".to_string(),
                                    alive: true,
                                    agent_id: Some(agent_id),
                                    spawned: false,
                                },
                                remote_session_id: Some(remote_sid),
                                line_ending: LineEnding::default(),
                            },
                        );
                    }

                    // Spawn output reader for the re-created session.
                    let sessions_clone = self.manager.sessions.clone();
                    let emitter_clone = emitter.clone();
                    let capture = self.manager.ensure_output_buffer(&session_id);
                    let output_buffers = self.manager.output_buffers.clone();
                    let session_loggers = self.manager.session_loggers.clone();
                    let session_tab_ids = self.manager.session_tab_ids.clone();
                    let sid = session_id.clone();
                    tokio::spawn(async move {
                        SessionManager::run_output_reader(
                            sid,
                            output_rx,
                            emitter_clone,
                            sessions_clone,
                            false,
                            capture,
                            output_buffers,
                            session_loggers,
                            session_tab_ids,
                        )
                        .await;
                    });

                    info!(
                        connection_id,
                        session_id = %session_id,
                        "Persistent session backend re-created after agent reconnect"
                    );
                }
                _ => {
                    return Err(TerminalError::SessionNotFound(format!(
                        "Persistent session {} for connection {} is no longer alive",
                        session_id, connection_id
                    )));
                }
            }
        }

        // Phase 3: Register tab attachment.
        let count = {
            let mut ps = self.manager.persistent_sessions.lock().await;
            let record = ps.get_mut(connection_id).ok_or_else(|| {
                TerminalError::SessionNotFound(format!(
                    "No persistent session for connection {connection_id}"
                ))
            })?;
            record.attached_tabs.insert(tab_id.to_string());
            record.attached_tabs.len() as u32
        };

        let state = if count > 0 { "attached" } else { "running" }.to_string();
        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.to_string(),
            session_id: Some(session_id),
            state,
            attached_tab_count: count,
            error_message: None,
        });

        Ok(count)
    }

    /// Unregister `tab_id` from the persistent session identified by `session_id`.
    ///
    /// Keeps the backend session alive. Returns the new attached-tab count.
    /// No-op (returns 0) if the session is not in the persistent registry.
    pub(super) async fn detach_persistent_tab<E: EventEmitter>(
        &self,
        session_id: &str,
        tab_id: &str,
        emitter: E,
    ) -> Result<u32, TerminalError> {
        let (connection_id, count) = {
            let mut ps = self.manager.persistent_sessions.lock().await;
            let Some(record) = ps.values_mut().find(|r| r.session_id == session_id) else {
                return Ok(0);
            };
            record.attached_tabs.remove(tab_id);
            let count = record.attached_tabs.len() as u32;
            (record.connection_id.clone(), count)
        };

        let state = if count > 0 { "attached" } else { "running" }.to_string();
        emitter.emit_persistent_state(&PersistentSessionStateEvent {
            connection_id: connection_id.clone(),
            session_id: Some(session_id.to_string()),
            state,
            attached_tab_count: count,
            error_message: None,
        });

        info!(
            session_id,
            tab_id,
            remaining = count,
            "Tab detached from persistent session"
        );
        Ok(count)
    }

    /// List all registered persistent sessions and their current state.
    pub(super) async fn list_persistent_sessions(&self) -> Vec<PersistentSessionSummary> {
        let ps = self.manager.persistent_sessions.lock().await;
        ps.values()
            .map(|r| PersistentSessionSummary {
                connection_id: r.connection_id.clone(),
                session_id: r.session_id.clone(),
                attached_tab_count: r.attached_tabs.len() as u32,
            })
            .collect()
    }

    /// Fetch the scrollback buffer from the agent for a persistent session.
    ///
    /// Sends `session.getBuffer` over JSON-RPC to the agent, which queries
    /// the daemon's ring buffer non-destructively and returns a base64-encoded
    /// snapshot.
    pub(super) async fn get_remote_session_buffer(
        &self,
        session_id: &str,
    ) -> Result<Vec<u8>, TerminalError> {
        let (agent_id, remote_sid) = {
            let sessions = self.manager.sessions.lock().await;
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;
            let agent_id =
                entry.info.agent_id.clone().ok_or_else(|| {
                    TerminalError::RemoteError("not a remote session".to_string())
                })?;
            let remote_sid = entry.remote_session_id.clone().ok_or_else(|| {
                TerminalError::RemoteError("remote session ID unavailable".to_string())
            })?;
            (agent_id, remote_sid)
        };

        // Run the sync RPC on the blocking thread pool — its internal
        // `oneshot::Receiver::blocking_recv` would otherwise park a tokio worker.
        let mgr = self.manager.agent_manager.clone();
        let result = tokio::task::spawn_blocking(move || {
            mgr.send_request(
                &agent_id,
                "session.getBuffer",
                serde_json::json!({ "session_id": remote_sid }),
            )
        })
        .await
        .map_err(|e| TerminalError::RemoteError(format!("spawn_blocking join: {e}")))?
        .map_err(|e| TerminalError::RemoteError(e.to_string()))?;

        let b64 = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
        if b64.is_empty() {
            return Ok(Vec::new());
        }

        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| TerminalError::RemoteError(format!("base64 decode error: {e}")))
    }
}
