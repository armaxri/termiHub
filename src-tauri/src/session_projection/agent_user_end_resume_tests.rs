//! #5953: a user agent Disconnect detaches the hosted sessions — they keep
//! running on the agent host — so the tab's Reconnect must resume the tab's
//! own session instead of starting a second one beside it.
//!
//! Before the fix the Reconnect minted a new agent session while the old one
//! kept running unattached: "Active sessions" listed two identical rows for one
//! tab, and the update strip counted one session above a list of two. These
//! drive the production user end and `create_connection` against the shared
//! session-hosting `FakeAgent` (layer elimination: the agent itself keeps the
//! session; the desktop is what minted the second one).

use std::sync::atomic::Ordering;

use super::*;

/// The settings an agent shell tab connects with.
fn shell_settings() -> Value {
    serde_json::json!({ "config": {} })
}

impl Rig {
    /// The tab's Reconnect: the client create for `tab`'s next attempt.
    fn reconnect_tab(&self, tab: &str, attempt: u32) -> Result<String, String> {
        let manager = self.handle.state::<SessionManager>();
        tauri::async_runtime::block_on(manager.create_connection(
            "shell",
            shell_settings(),
            Some("agent-1"),
            Some(&format!("{tab}:{attempt}")),
            false,
            true, // resilient
            self.handle.clone(),
        ))
        .map_err(|e| e.to_string())
    }

    fn take_resumed(&self, session_id: &str) -> bool {
        self.handle
            .state::<SessionManager>()
            .take_resumed_session(session_id)
    }
}

/// The Reconnect of a user-ended tab re-attaches its still-running session: no
/// second session is minted, the attach names the old one, and the next drop
/// re-attaches it again through the retained request.
#[test]
fn reconnect_after_user_disconnect_resumes_the_tabs_session() {
    let rig = Rig::new(&["tab-a"]);
    assert_eq!(rig.agent.host().minted(), vec!["remote-0"]);
    rig.end_agent(AgentEndReason::User);

    let session = rig.reconnect_tab("tab-a", 1).expect("the reconnect connects");

    assert_eq!(
        rig.agent.host().minted(),
        vec!["remote-0"],
        "no second session beside the tab's own"
    );
    assert_eq!(
        rig.agent.calls_to("attach_session").last(),
        Some(&vec!["agent-1".to_string(), "remote-0".to_string()]),
        "the tab's own session is attached again"
    );
    assert!(rig.take_resumed(&session), "the tab learns it resumed");
    assert!(!rig.take_resumed(&session), "the flag is one-shot");
    let retained = rig
        .handle
        .state::<SessionManager>()
        .retained_request("tab-a")
        .expect("the resumed tab is resilient again");
    assert_eq!(retained.agent_session_id.as_deref(), Some("remote-0"));
}

/// When the agent no longer runs the session (it was shut down, or exited),
/// the Reconnect starts a new one, as before.
#[test]
fn reconnect_starts_fresh_when_the_session_is_gone() {
    let rig = Rig::new(&["tab-a"]);
    rig.end_agent(AgentEndReason::Shutdown);
    rig.agent
        .host()
        .session_recoverable
        .store(false, Ordering::SeqCst);

    let session = rig.reconnect_tab("tab-a", 1).expect("the reconnect connects");

    assert_eq!(rig.agent.host().minted(), vec!["remote-0", "remote-1"]);
    assert!(!rig.take_resumed(&session), "a new session is not a resume");
}

/// A Reconnect pressed while the agent is still down fails as before and keeps
/// the session to resume: the attempt after the agent is back resumes it.
#[test]
fn reconnect_while_the_agent_is_down_resumes_once_it_is_back() {
    let rig = Rig::new(&["tab-a"]);
    rig.end_agent(AgentEndReason::User);
    rig.agent.host().connected.store(false, Ordering::SeqCst);

    assert!(rig.reconnect_tab("tab-a", 1).is_err(), "no agent, no session");

    rig.agent.host().connect();
    let session = rig.reconnect_tab("tab-a", 2).expect("the agent is back");
    assert_eq!(rig.agent.host().minted(), vec!["remote-0"]);
    assert!(rig.take_resumed(&session));
}

/// Another tab never adopts a user-ended tab's session: only the tab that
/// showed it resumes it.
#[test]
fn another_tab_never_adopts_the_session() {
    let rig = Rig::new(&["tab-a"]);
    rig.end_agent(AgentEndReason::User);

    let session = rig.reconnect_tab("tab-b", 0).expect("a new tab connects");

    assert_eq!(rig.agent.host().minted(), vec!["remote-0", "remote-1"]);
    assert!(!rig.take_resumed(&session));
}
