//! A failed monitoring close must not leave an untracked live monitor (#5301).
//!
//! These drive [`MonitoringController::stop_session_monitoring`] against a real
//! agent-mediated [`RemoteMonitoringProxy`] over the scripted [`FakeAgent`],
//! whose `connection.monitoring.unsubscribe` fails, and assert that every part
//! of the monitor still comes down: the push task, the output route, the
//! status-derivation driver and — once the agent answers — the agent's own
//! collect loop.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use termihub_core::protocol::methods::CONNECTION_MONITORING_UNSUBSCRIBE;

use super::*;
use crate::network::test_support::FakeAgent;
use crate::session::agent_monitor_stops;

type Sessions = Mutex<HashMap<String, SessionEntry>>;
type Tasks = Mutex<HashMap<String, AbortHandle>>;
type Overrides = Mutex<HashMap<String, Arc<dyn MonitoringProvider + Send + Sync>>>;

/// A push-task stand-in that runs until aborted; the receiver resolves (with
/// `Err`) exactly when the task is dropped.
fn pending_task() -> (
    impl std::future::Future<Output = ()> + Send + 'static,
    tokio::sync::oneshot::Receiver<()>,
) {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let task = async move {
        let _tx = tx;
        std::future::pending::<()>().await;
    };
    (task, rx)
}

fn agent_refusing_unsubscribe(n: usize) -> Arc<FakeAgent> {
    Arc::new(FakeAgent {
        refuse_times: StdMutex::new(vec![(CONNECTION_MONITORING_UNSUBSCRIBE, n)]),
        ..FakeAgent::default()
    })
}

fn unsubscribes(agent: &FakeAgent) -> usize {
    agent
        .requests()
        .iter()
        .filter(|(m, _)| m == CONNECTION_MONITORING_UNSUBSCRIBE)
        .count()
}

/// A subscribed agent-self monitor registered the way `start` registers one:
/// an override proxy plus a running push task. Returns the live subscription's
/// stats receiver and the push task's abort signal.
async fn start_agent_monitor(
    agent_id: &str,
    agent: &Arc<FakeAgent>,
    controller: &MonitoringController<'_, HashMap<String, SessionEntry>>,
    overrides: &Overrides,
) -> (
    termihub_core::monitoring::MonitoringReceiver,
    tokio::sync::oneshot::Receiver<()>,
) {
    let proxy: Arc<dyn MonitoringProvider + Send + Sync> = Arc::new(
        RemoteMonitoringProxy::for_agent_self(agent_id.to_string(), agent.clone()),
    );
    let subscription = proxy.subscribe().await.expect("subscribe");
    overrides.lock().await.insert("sess".to_string(), proxy);
    let (task, aborted) = pending_task();
    controller.spawn_and_register("sess", task).await;
    (subscription.stats, aborted)
}

#[tokio::test(start_paused = true)]
async fn a_close_whose_agent_stop_fails_still_tears_everything_down() {
    let (sessions, tasks, overrides): (Sessions, Tasks, Overrides) = Default::default();
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing_unsubscribe(1);
    let (mut stats, aborted) =
        start_agent_monitor("close-fails", &agent, &controller, &overrides).await;
    assert_eq!(agent.monitoring_routes.lock().unwrap().len(), 1);

    let result = controller.stop_session_monitoring("sess").await;

    // The failure is reported…
    let err = result.expect_err("an unconfirmed agent stop is reported");
    assert!(err.to_string().contains("retrying"), "got: {err}");
    // …but the local teardown is complete: push task aborted, override and
    // output route gone, and the status driver ended (its stats feed closed).
    tokio::time::timeout(Duration::from_secs(3), aborted)
        .await
        .expect("push task aborted promptly")
        .expect_err("an aborted task drops its sender");
    assert!(tasks.lock().await.is_empty(), "no push task left");
    assert!(overrides.lock().await.is_empty(), "no override left");
    assert!(
        agent.monitoring_routes.lock().unwrap().is_empty(),
        "the output route is unregistered"
    );
    let ended = tokio::time::timeout(Duration::from_secs(3), stats.recv())
        .await
        .expect("the status driver ends promptly");
    assert!(ended.is_none(), "the status driver's stats channel is closed");

    // The agent's own collect loop is not left running: the stop is retried
    // in the background until the agent confirms it.
    assert!(agent_monitor_stops::stop_pending("close-fails", "self"));
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(unsubscribes(&agent), 2, "refused once, then confirmed");
    assert!(!agent_monitor_stops::stop_pending("close-fails", "self"));
}

#[tokio::test(start_paused = true)]
async fn a_successful_close_tears_down_and_owes_no_stop() {
    let (sessions, tasks, overrides): (Sessions, Tasks, Overrides) = Default::default();
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing_unsubscribe(0);
    let (mut stats, aborted) =
        start_agent_monitor("close-ok", &agent, &controller, &overrides).await;

    controller
        .stop_session_monitoring("sess")
        .await
        .expect("a confirmed stop succeeds");

    tokio::time::timeout(Duration::from_secs(3), aborted)
        .await
        .expect("push task aborted promptly")
        .expect_err("an aborted task drops its sender");
    assert!(tasks.lock().await.is_empty());
    assert!(overrides.lock().await.is_empty());
    assert!(agent.monitoring_routes.lock().unwrap().is_empty());
    assert!(stats.recv().await.is_none(), "the status driver ended");
    assert!(!agent_monitor_stops::stop_pending("close-ok", "self"));

    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(unsubscribes(&agent), 1, "exactly one stop, no retries");
}

/// An agent that never answers the stop: the push task is still aborted and
/// the error is reported rather than swallowed.
#[tokio::test]
async fn a_close_against_an_agent_that_never_confirms_still_aborts_the_push_task() {
    let (sessions, tasks, overrides): (Sessions, Tasks, Overrides) = Default::default();
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = Arc::new(FakeAgent {
        refuse: vec![CONNECTION_MONITORING_UNSUBSCRIBE],
        ..FakeAgent::default()
    });
    let (_stats, aborted) =
        start_agent_monitor("close-always-fails", &agent, &controller, &overrides).await;

    assert!(controller.stop_session_monitoring("sess").await.is_err());
    tokio::time::timeout(Duration::from_secs(3), aborted)
        .await
        .expect("push task aborted promptly")
        .expect_err("an aborted task drops its sender");
    assert!(tasks.lock().await.is_empty());
}
