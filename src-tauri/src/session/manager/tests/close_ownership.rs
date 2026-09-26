//! Tab close vs. session ownership (#3401): closing a tab in a window or desktop
//! that no longer controls the session must not tear the session down.

use super::*;

use std::sync::Mutex as StdMutex;

use crate::commands::session::{
    close_session_with_disposition, tab_close_disposition, TabCloseDisposition,
};
use crate::session::remote_proxy::{ReattachOutcome, RemoteProxy};
use crate::window::{OutputEmitTarget, WindowManager};

// ── RecordingAgent ────────────────────────────────────────────────

/// An `AgentRpcClient` that records the calls a close path makes, so a test can
/// assert no `connection.close` (`close_session`) reached the agent.
#[derive(Clone, Default)]
struct RecordingAgent {
    calls: Arc<StdMutex<Vec<String>>>,
}

impl RecordingAgent {
    fn record(&self, call: String) {
        self.calls.lock().expect("call log").push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("call log").clone()
    }
}

impl AgentRpcClient for RecordingAgent {
    fn connect_agent(
        &self,
        _: &str,
        _: &RemoteAgentConfig,
        _: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, _: &str) -> bool {
        false
    }
    fn disconnect_agent(&self, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn get_capabilities(&self, _: &str) -> Option<AgentCapabilities> {
        None
    }
    fn shutdown_agent(&self, _: &str, _: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(&self, _: &str, method: &str, _: Value) -> Result<Value, TerminalError> {
        self.record(format!("send_request:{method}"));
        Ok(Value::Null)
    }
    fn create_session(
        &self,
        _: &str,
        _: &str,
        _: Value,
        _: Option<&str>,
        _: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        unimplemented!()
    }
    fn attach_session(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        Ok(())
    }
    fn close_session(&self, _: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        self.record(format!("close_session:{remote_session_id}"));
        Ok(())
    }
    fn list_sessions(&self, _: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(&self, _: &str) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, _: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        _: &str,
        _: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, _: &str, _: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        _: &str,
        _: &str,
        _: OutputSender,
    ) -> Result<(), TerminalError> {
        Ok(())
    }
    fn unregister_session_output(&self, _: &str, sid: &str) -> Result<(), TerminalError> {
        self.record(format!("unregister_session_output:{sid}"));
        Ok(())
    }
    fn register_monitoring_output(
        &self,
        _: &str,
        _: &str,
        _: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(&self, _: &str, sid: &str) -> Result<(), TerminalError> {
        self.record(format!("unregister_monitoring_output:{sid}"));
        Ok(())
    }
    fn send_session_input(&self, _: &str, sid: &str, _: &[u8]) -> Result<(), TerminalError> {
        self.record(format!("send_session_input:{sid}"));
        Ok(())
    }
    fn resize_session(&self, _: &str, _: &str, _: u16, _: u16) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(&self, _: &str, _: &AgentSettings) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

/// A `SessionManager` holding one agent-proxied session (`sid` → remote `r1`)
/// backed by a real [`RemoteProxy`] over the recording agent.
async fn manager_with_agent_session(sid: &str) -> (SessionManager, RecordingAgent) {
    let agent = RecordingAgent::default();
    let client: Arc<dyn AgentRpcClient> = Arc::new(agent.clone());
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), client.clone());
    let (proxy, outcome) =
        RemoteProxy::reconnect_existing("agent-1".into(), "r1".into(), client).expect("proxy");
    assert_eq!(outcome, ReattachOutcome::Attached);
    manager
        .insert_test_remote_session(sid, Box::new(proxy), "agent-1", "r1")
        .await;
    (manager, agent)
}

// ── Disposition rule ──────────────────────────────────────────────

#[test]
fn disposition_owner_or_unclaimed_close_closes() {
    assert_eq!(
        tab_close_disposition(false, true, false),
        TabCloseDisposition::Close
    );
}

#[test]
fn disposition_non_owner_window_keeps_the_session() {
    assert_eq!(
        tab_close_disposition(false, false, false),
        TabCloseDisposition::KeepForOwningWindow
    );
    // An agent session evicted *and* owned by another window: still kept.
    assert_eq!(
        tab_close_disposition(false, false, true),
        TabCloseDisposition::KeepForOwningWindow
    );
}

#[test]
fn disposition_agent_evicted_tab_releases_only_the_view() {
    assert_eq!(
        tab_close_disposition(false, true, true),
        TabCloseDisposition::ReleaseEvictedView
    );
}

#[test]
fn disposition_intentional_kill_always_closes() {
    for (may_close, evicted) in [(true, false), (false, false), (true, true), (false, true)] {
        assert_eq!(
            tab_close_disposition(true, may_close, evicted),
            TabCloseDisposition::Close,
            "a user kill (Open Connections) is explicit and always closes"
        );
    }
}

// ── Window takeover: local terminal session ───────────────────────

/// Window `win-1` took the session over from `main`. Closing `main`'s stale tab
/// leaves the session alive and the owner still in control; the owner's own
/// close then closes it as before.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn non_owner_window_close_keeps_session_for_owner() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    let disconnected = Arc::new(AtomicBool::new(false));
    manager
        .insert_test_session("s1", Box::new(DisconnectSpy::new(disconnected.clone())))
        .await;
    let wm = WindowManager::new();
    wm.claim("s1", "main");
    wm.claim("s1", "win-1");

    let disposition = tab_close_disposition(false, wm.may_close("s1", "main"), false);
    assert_eq!(disposition, TabCloseDisposition::KeepForOwningWindow);
    close_session_with_disposition(&manager, "s1", disposition)
        .await
        .expect("non-owner close");

    assert!(manager.has_session("s1").await, "session must stay alive");
    assert!(
        !disconnected.load(Ordering::SeqCst),
        "a non-owner's tab close must not disconnect the backend"
    );
    // The owner keeps control: its input still reaches the session and output
    // is still routed to it.
    manager
        .send_input("s1", b"ls\n")
        .await
        .expect("owner input after the evicted close");
    assert_eq!(
        wm.output_target("s1"),
        OutputEmitTarget::Window("win-1".to_string())
    );

    // The owner closing its tab keeps today's semantics.
    let disposition = tab_close_disposition(false, wm.may_close("s1", "win-1"), false);
    assert_eq!(disposition, TabCloseDisposition::Close);
    close_session_with_disposition(&manager, "s1", disposition)
        .await
        .expect("owner close");
    assert!(!manager.has_session("s1").await);
    assert!(disconnected.load(Ordering::SeqCst));
}

// ── Desktop takeover: agent session Evicted ───────────────────────

/// Another desktop took the agent session over (the tab is `Evicted`). Closing
/// the tab drops this desktop's view but sends no `connection.close` — the
/// remote process the other desktop uses keeps running.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn evicted_agent_tab_close_sends_no_connection_close() {
    let (manager, agent) = manager_with_agent_session("s1").await;

    close_session_with_disposition(&manager, "s1", TabCloseDisposition::ReleaseEvictedView)
        .await
        .expect("evicted close");

    assert!(
        !manager.has_session("s1").await,
        "the local view is dropped"
    );
    let calls = agent.calls();
    assert!(
        !calls.iter().any(|c| c.starts_with("close_session")),
        "no connection.close for an evicted session; got {calls:?}"
    );
    assert!(
        !calls.iter().any(|c| c.starts_with("send_request")),
        "no RPC (detach/close) reaches the agent; got {calls:?}"
    );
    assert!(
        calls.contains(&"unregister_session_output:r1".to_string()),
        "the local output route is released; got {calls:?}"
    );
}

/// The controlling desktop's close still sends `connection.close` (unchanged).
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn owner_agent_tab_close_still_closes_remote_session() {
    let (manager, agent) = manager_with_agent_session("s1").await;

    close_session_with_disposition(&manager, "s1", TabCloseDisposition::Close)
        .await
        .expect("owner close");

    assert!(!manager.has_session("s1").await);
    assert!(
        agent.calls().contains(&"close_session:r1".to_string()),
        "the owner's close ends the remote session; got {:?}",
        agent.calls()
    );
}

/// A session with no agent route falls back to a normal close.
#[tokio::test]
async fn release_evicted_session_without_agent_route_closes() {
    let manager = SessionManager::new(ConnectionTypeRegistry::new(), Arc::new(NullAgent));
    let disconnected = Arc::new(AtomicBool::new(false));
    manager
        .insert_test_session("s1", Box::new(DisconnectSpy::new(disconnected.clone())))
        .await;
    manager
        .release_evicted_session("s1")
        .await
        .expect("fallback close");
    assert!(!manager.has_session("s1").await);
    assert!(disconnected.load(Ordering::SeqCst));
}
