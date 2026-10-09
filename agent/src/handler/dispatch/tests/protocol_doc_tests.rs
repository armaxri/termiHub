//! `docs/remote-protocol.md` stays in sync with the dispatcher (#4325).
//!
//! The spec documents each request method under a `` ### `name` `` heading in
//! its `## Methods` section and each notification under one in
//! `## Notifications`. These tests read the method table straight from the
//! [`RpcModule`] the agent serves, so a newly registered method that nobody
//! documented fails here, and so does a documented method that was removed.

use super::*;
use std::collections::BTreeSet;

/// The protocol spec, embedded at compile time so a doc edit rebuilds the test.
const PROTOCOL_DOC: &str = include_str!("../../../../../docs/remote-protocol.md");

/// The `name` of every `` ### `name` `` heading between the `## {section}`
/// heading and the next `## ` heading. A heading with trailing text, such as
/// `` ### `agent.forward.data` (notification) ``, still counts.
fn documented_names(section: &str) -> BTreeSet<String> {
    let start = format!("## {section}");
    let mut in_section = false;
    let mut names = BTreeSet::new();
    for line in PROTOCOL_DOC.lines() {
        if line.starts_with("## ") {
            in_section = line.trim_end() == start;
            continue;
        }
        if !in_section {
            continue;
        }
        let Some(rest) = line.strip_prefix("### `") else {
            continue;
        };
        if let Some((name, _)) = rest.split_once('`') {
            names.insert(name.to_string());
        }
    }
    assert!(
        !names.is_empty(),
        "no `### \\`name\\`` headings found under `## {section}` in docs/remote-protocol.md"
    );
    names
}

/// Every method the dispatcher registers.
fn registered_methods() -> BTreeSet<String> {
    let handler = make_handler();
    handler.module.method_names().map(str::to_string).collect()
}

#[test]
fn every_registered_method_is_documented() {
    let documented = documented_names("Methods");
    let missing: Vec<_> = registered_methods()
        .into_iter()
        .filter(|m| !documented.contains(m))
        .collect();
    assert!(
        missing.is_empty(),
        "methods the agent dispatcher registers but docs/remote-protocol.md does not document \
         under `## Methods` (add a `### \\`name\\`` section with params, result, errors and the \
         protocol version): {missing:?}"
    );
}

#[test]
fn every_documented_method_is_registered() {
    let registered = registered_methods();
    let stale: Vec<_> = documented_names("Methods")
        .into_iter()
        .filter(|m| !registered.contains(m))
        .collect();
    assert!(
        stale.is_empty(),
        "docs/remote-protocol.md documents methods under `## Methods` that the agent dispatcher \
         does not register (remove them or note the removal in the version history): {stale:?}"
    );
}

#[test]
fn every_notification_is_documented() {
    // Notifications are emitted from many places rather than registered in one
    // table, so this list is the inventory: every agent → desktop notification
    // constant in `termihub_core::protocol::methods`.
    let notifications = [
        pm::CONNECTION_OUTPUT,
        pm::CONNECTION_EXIT,
        pm::CONNECTION_EVICTED,
        pm::CONNECTION_FILES_ONLY,
        pm::CONNECTION_MONITORING_DATA,
        pm::CONNECTION_MONITORING_STATUS,
        pm::AGENT_FORWARD_OPEN,
        pm::AGENT_FORWARD_DATA,
        pm::AGENT_FORWARD_CLOSE,
        pm::AGENT_FORWARD_ACK,
        pm::TOOL_EVENT,
        pm::TOOL_DONE,
        pm::SSH_KEYBOARD_INTERACTIVE_PROMPT,
        pm::SSH_KEYBOARD_INTERACTIVE_CLOSED,
        pm::AGENT_UPDATE_PENDING,
        pm::AGENT_UPDATE_AVAILABLE,
    ];
    let documented = documented_names("Notifications");
    let missing: Vec<_> = notifications
        .into_iter()
        .filter(|n| !documented.contains(*n))
        .collect();
    assert!(
        missing.is_empty(),
        "notifications missing from `## Notifications` in docs/remote-protocol.md: {missing:?}"
    );
}

#[test]
fn documented_names_reads_headings_with_trailing_text() {
    // `agent.forward.data` is both a method and a notification; its notification
    // heading carries a "(notification)" suffix and must still be found.
    assert!(documented_names("Notifications").contains("agent.forward.data"));
    assert!(documented_names("Methods").contains("initialize"));
}
