//! Unit tests for the post-reconnect re-attach of hosted agent sessions (#4017).

use serde_json::json;

use super::*;
use termihub_core::protocol::methods::{SessionListEntry, SessionListResult};

fn hosted(remote: &str, tab: &str) -> AgentHostedSession {
    AgentHostedSession {
        remote_session_id: remote.to_string(),
        session_id: format!("desktop-{remote}"),
        tab_id: tab.to_string(),
    }
}

fn entry(id: &str, attached: bool) -> SessionListEntry {
    SessionListEntry {
        session_id: id.to_string(),
        title: id.to_string(),
        session_type: "local".to_string(),
        status: "running".to_string(),
        created_at: String::new(),
        last_activity: String::new(),
        attached,
        definition_id: None,
    }
}

/// The nightly agent-reconnect grade's shape: after a transport sever the fresh
/// agent worker lists the counter's session as running but **unattached**
/// (#3369), so the desktop must re-attach it or the counter stays frozen.
#[test]
fn an_unattached_hosted_session_is_reattached() {
    let recovered = RecoveredSessions::from_list(SessionListResult {
        sessions: vec![entry("s-counter", false)],
    });
    assert!(recovered.live.contains("s-counter"));
    assert!(recovered.unattached.contains("s-counter"));

    let to_attach = sessions_to_reattach(&[hosted("s-counter", "tab-1")], &recovered, &[]);
    assert_eq!(to_attach, vec!["s-counter".to_string()]);
}

#[test]
fn attached_foreign_and_evicted_sessions_are_not_reattached() {
    let recovered = RecoveredSessions::from_list(SessionListResult {
        sessions: vec![
            entry("s-held", true),
            entry("s-not-ours", false),
            entry("s-evicted", false),
        ],
    });
    let hosted = [hosted("s-held", "tab-1"), hosted("s-evicted", "tab-2")];
    // Already held by this worker: nothing to do. Unattached but hosted by no
    // tab of this desktop: never adopted. Evicted tab: only an explicit Reclaim.
    let to_attach = sessions_to_reattach(&hosted, &recovered, &["s-evicted".to_string()]);
    assert!(to_attach.is_empty(), "{to_attach:?}");
}

#[test]
fn a_session_hosted_by_two_tabs_is_attached_once() {
    let recovered = RecoveredSessions::from_list(SessionListResult {
        sessions: vec![entry("s-1", false)],
    });
    let to_attach = sessions_to_reattach(
        &[hosted("s-1", "tab-1"), hosted("s-1", "tab-2")],
        &recovered,
        &[],
    );
    assert_eq!(to_attach, vec!["s-1".to_string()]);
}

#[test]
fn attach_replies_are_classified_by_id_and_code() {
    let ok = jsonrpc::JsonRpcMessage::Response {
        id: 7,
        result: json!({}),
    };
    assert_eq!(classify_attach_reply(&ok, 7), Some(AttachReply::Attached));
    assert_eq!(
        classify_attach_reply(&ok, 8),
        None,
        "another request's reply"
    );

    let held = jsonrpc::JsonRpcMessage::Error {
        id: 7,
        code: Some(SESSION_HELD_BY_OTHER),
        message: "held".into(),
        data: None,
    };
    assert_eq!(
        classify_attach_reply(&held, 7),
        Some(AttachReply::HeldElsewhere)
    );

    let gone = jsonrpc::JsonRpcMessage::Error {
        id: 7,
        code: Some(-32001),
        message: "Session not found".into(),
        data: None,
    };
    assert_eq!(classify_attach_reply(&gone, 7), Some(AttachReply::Failed));

    let output = jsonrpc::JsonRpcMessage::Notification {
        method: "connection.output".into(),
        params: json!({}),
    };
    assert_eq!(classify_attach_reply(&output, 7), None);
}

/// Output lines that arrive in the same chunk as the attach reply must reach the
/// tab, and a trailing partial line must stay for the resumed I/O loop.
#[test]
fn complete_lines_are_collected_and_a_partial_line_is_kept() {
    let mut buf = LineSplitter::new();
    buf.push(
        b"{\"jsonrpc\":\"2.0\",\"method\":\"connection.output\",\"params\":{\"session_id\":\"s\"}}\n\
         {\"jsonrpc\":\"2.0\",\"method\":\"connection.out",
    );
    let mut notifications = Vec::new();
    drain_complete_lines("a", &mut buf, &mut notifications);
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].0, "connection.output");
    let tail = b"{\"jsonrpc\":\"2.0\",\"method\":\"connection.out";
    assert_eq!(buf.buffered_len(), tail.len(), "the partial line is kept");
}
