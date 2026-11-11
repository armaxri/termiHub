//! Tests for the deferred agent monitoring stops (#5301).
//!
//! The registry is process-wide, so every test uses its own agent id.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use termihub_core::protocol::methods::{
    CONNECTION_MONITORING_SUBSCRIBE, CONNECTION_MONITORING_UNSUBSCRIBE,
};

use super::*;
use crate::network::test_support::FakeAgent;

fn unsubscribes(agent: &FakeAgent) -> usize {
    agent
        .requests()
        .iter()
        .filter(|(m, _)| m == CONNECTION_MONITORING_UNSUBSCRIBE)
        .count()
}

/// An agent whose first `n` unsubscribes fail, then succeed.
fn agent_refusing_unsubscribe(n: usize) -> Arc<FakeAgent> {
    Arc::new(FakeAgent {
        refuse_times: Mutex::new(vec![(CONNECTION_MONITORING_UNSUBSCRIBE, n)]),
        ..FakeAgent::default()
    })
}

/// Let the retry task run through `secs` seconds of (paused) virtual time.
async fn advance(secs: u64) {
    for _ in 0..secs * 10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_deferred_stop_retries_until_the_agent_confirms_it() {
    let agent = agent_refusing_unsubscribe(2);
    defer_stop("stops-retry", "self", agent.clone());
    assert!(stop_pending("stops-retry", "self"));

    // 1s + 2s + 4s of backoff covers two failures and the success.
    advance(10).await;

    assert_eq!(unsubscribes(&agent), 3, "two refused, then confirmed");
    assert!(!stop_pending("stops-retry", "self"));

    // Confirmed: no further unsubscribes.
    advance(120).await;
    assert_eq!(unsubscribes(&agent), 3);
}

#[tokio::test(start_paused = true)]
async fn a_new_subscribe_supersedes_a_deferred_stop() {
    let agent = agent_refusing_unsubscribe(usize::MAX);
    defer_stop("stops-supersede", "self", agent.clone());
    advance(2).await;
    let before = unsubscribes(&agent);
    assert!(before >= 1, "the stop was retried");

    // The user reopens monitoring on the same agent host: the new
    // subscription replaces the old one on the agent, so the stop must not
    // be sent any more — it would stop the new monitor.
    drop(begin_subscribe("stops-supersede", "self").await);

    advance(120).await;
    assert!(
        unsubscribes(&agent) <= before + 1,
        "at most the retry already in flight is sent after the resubscribe"
    );
    assert!(!stop_pending("stops-supersede", "self"));
}

#[tokio::test(start_paused = true)]
async fn a_retry_waits_for_a_subscribe_in_flight() {
    let agent = agent_refusing_unsubscribe(0);
    defer_stop("stops-gate", "self", agent.clone());

    // A subscribe holding the gate across its request blocks the retry; once
    // it lands it has superseded the stop, so the retry sends nothing.
    let gate = begin_subscribe("stops-gate", "self").await;
    agent
        .send_request(
            "stops-gate",
            CONNECTION_MONITORING_SUBSCRIBE,
            serde_json::json!({}),
        )
        .unwrap();
    advance(5).await;
    assert_eq!(unsubscribes(&agent), 0, "the retry waited on the gate");
    drop(gate);

    advance(60).await;
    assert_eq!(unsubscribes(&agent), 0, "the superseded stop is never sent");
    assert!(!stop_pending("stops-gate", "self"));
}

#[tokio::test(start_paused = true)]
async fn stops_are_tracked_per_agent_host() {
    let agent = agent_refusing_unsubscribe(0);
    defer_stop("stops-per-host", "sess-a", agent.clone());
    drop(begin_subscribe("stops-per-host", "sess-b").await);

    advance(5).await;
    let hosts: Vec<_> = agent
        .requests()
        .into_iter()
        .filter(|(m, _)| m == CONNECTION_MONITORING_UNSUBSCRIBE)
        .map(|(_, p)| p["host"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        hosts,
        ["sess-a"],
        "another host's subscribe does not cancel it"
    );
}

#[tokio::test(start_paused = true)]
async fn deferring_twice_runs_one_retry_task() {
    let agent = agent_refusing_unsubscribe(0);
    defer_stop("stops-dedupe", "self", agent.clone());
    defer_stop("stops-dedupe", "self", agent.clone());

    advance(60).await;
    assert_eq!(unsubscribes(&agent), 1);
}
