//! `connection.exit` with an end cause ends the agent-hosted session and hands
//! the cause to its proxy (#5732); one without a cause changes nothing.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;

use serde_json::{json, Value};
use termihub_core::connection::{EndCauseSlot, SessionEndCause};
use termihub_core::protocol::methods::{CONNECTION_EXIT, CONNECTION_OUTPUT};

use super::*;

/// One registered session: its output route, end-cause slot and receiver.
fn registered(
    session_id: &str,
) -> (
    SessionExitRoutes,
    HashMap<String, OutputSender>,
    EndCauseSlot,
    mpsc::Receiver<Vec<u8>>,
) {
    let mut routes = SessionExitRoutes::default();
    let slot = EndCauseSlot::new();
    routes.register(session_id.to_string(), slot.clone());
    let (tx, rx) = mpsc::channel();
    let mut outputs = HashMap::new();
    outputs.insert(session_id.to_string(), tx);
    (routes, outputs, slot, rx)
}

fn route(
    routes: &mut SessionExitRoutes,
    outputs: &mut HashMap<String, OutputSender>,
    method: &str,
    params: Value,
) -> bool {
    route_session_exit_notification(routes, outputs, "agent-1", method, &params)
}

#[test]
fn an_exit_with_a_cause_records_it_and_ends_the_output_stream() {
    let (mut routes, mut outputs, slot, rx) = registered("s1");

    let handled = route(
        &mut routes,
        &mut outputs,
        CONNECTION_EXIT,
        json!({ "session_id": "s1", "exit_code": 0, "end_cause": "remote_closed" }),
    );

    assert!(handled);
    assert_eq!(slot.get(), Some(SessionEndCause::RemoteClosed));
    assert!(!outputs.contains_key("s1"), "the output route is dropped");
    assert!(
        matches!(rx.try_recv(), Err(mpsc::TryRecvError::Disconnected)),
        "the proxy's output stream ends"
    );
}

#[test]
fn an_exit_without_a_cause_keeps_the_session_as_before() {
    // A pre-0.38.0 agent's `connection.exit` has no `end_cause`.
    let (mut routes, mut outputs, slot, rx) = registered("s1");

    let handled = route(
        &mut routes,
        &mut outputs,
        CONNECTION_EXIT,
        json!({ "session_id": "s1", "exit_code": 0 }),
    );

    assert!(handled);
    assert_eq!(slot.get(), None);
    assert!(outputs.contains_key("s1"), "the output route stays");
    assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
}

#[test]
fn an_unknown_cause_from_a_newer_agent_reads_as_none() {
    let (mut routes, mut outputs, slot, _rx) = registered("s1");

    route(
        &mut routes,
        &mut outputs,
        CONNECTION_EXIT,
        json!({ "session_id": "s1", "exit_code": 0, "end_cause": "solar_flare" }),
    );

    assert_eq!(slot.get(), None);
    assert!(outputs.contains_key("s1"));
}

#[test]
fn an_exit_for_another_session_leaves_this_one_alone() {
    let (mut routes, mut outputs, slot, _rx) = registered("s1");

    route(
        &mut routes,
        &mut outputs,
        CONNECTION_EXIT,
        json!({ "session_id": "s2", "exit_code": null, "end_cause": "io_error" }),
    );

    assert_eq!(slot.get(), None);
    assert!(outputs.contains_key("s1"));
}

#[test]
fn other_methods_and_malformed_payloads() {
    let (mut routes, mut outputs, slot, _rx) = registered("s1");

    assert!(!route(
        &mut routes,
        &mut outputs,
        CONNECTION_OUTPUT,
        json!({ "session_id": "s1", "data": "" }),
    ));
    // Malformed: handled (dropped), nothing changes.
    assert!(route(
        &mut routes,
        &mut outputs,
        CONNECTION_EXIT,
        json!({ "exit_code": 0, "end_cause": "remote_closed" }),
    ));
    assert_eq!(slot.get(), None);
    assert!(outputs.contains_key("s1"));
}

#[test]
fn a_removed_or_unretained_route_records_nothing() {
    let (mut routes, mut outputs, slot, _rx) = registered("s1");
    routes.retain(&HashSet::new());

    route(
        &mut routes,
        &mut outputs,
        CONNECTION_EXIT,
        json!({ "session_id": "s1", "exit_code": 0, "end_cause": "timeout" }),
    );

    assert_eq!(slot.get(), None, "no route, no cause");
    // The session still ends: the agent says it is over.
    assert!(!outputs.contains_key("s1"));

    let (mut routes, _outputs, slot, _rx) = registered("s2");
    routes.remove("s2");
    assert!(routes.routes.is_empty());
    assert_eq!(slot.get(), None);
}
