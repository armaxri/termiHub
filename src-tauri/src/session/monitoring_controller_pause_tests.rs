//! Pause, resume and interval changes on an agent-hosted monitor share the
//! per-host gate with subscribe and unsubscribe (#5318).
//!
//! These drive [`MonitoringController`] end to end against a
//! `tauri::test::mock_app()` (no windows) whose managed agent RPC client is the
//! scripted [`FakeAgent`], and assert that:
//!
//! - a pause whose agent stop fails is not lost: the desktop stays paused and
//!   the agent's collect loop is stopped in the background until it confirms;
//! - a resume supersedes a stop still owed for the host, so a late retry can
//!   never stop the resumed monitor;
//! - an interval change never restarts a paused or stopped monitor on the agent.
//!
//! The deferred-stop registry is process-wide, so every test uses its own
//! agent id.

use std::sync::Arc;

use termihub_core::protocol::methods::{
    CONNECTION_MONITORING_SUBSCRIBE, CONNECTION_MONITORING_UNSUBSCRIBE,
};

use super::open_tests::{
    advance, agent_refusing, app_with, count, maps_with_session, on_agent, Overrides,
};
use super::*;
use crate::network::test_support::FakeAgent;
use crate::session::agent_monitor_stops;

/// The interval of the last `connection.monitoring.subscribe` sent.
fn last_subscribe_interval(agent: &FakeAgent) -> Option<u64> {
    agent
        .requests()
        .into_iter()
        .rev()
        .find(|(m, _)| m == CONNECTION_MONITORING_SUBSCRIBE)
        .and_then(|(_, p)| p["interval_ms"].as_u64())
}

/// The last monitoring verb the agent received.
fn last_verb(agent: &FakeAgent) -> Option<String> {
    agent
        .requests()
        .into_iter()
        .rev()
        .map(|(m, _)| m)
        .find(|m| m == CONNECTION_MONITORING_SUBSCRIBE || m == CONNECTION_MONITORING_UNSUBSCRIBE)
}

async fn override_proxy(overrides: &Overrides) -> Arc<dyn MonitoringProvider + Send + Sync> {
    overrides
        .lock()
        .await
        .get("sess")
        .cloned()
        .expect("the agent monitor is recorded as an override")
}

#[tokio::test(start_paused = true)]
async fn pause_and_resume_stop_and_restart_the_agent_loop() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring("sess", Some(3000), on_agent("pause-ok"), app.handle().clone())
        .await
        .expect("agent start");
    assert_eq!(count(&agent, CONNECTION_MONITORING_SUBSCRIBE), 1);

    controller
        .set_session_monitoring_paused("sess", true)
        .await
        .expect("pause");
    assert_eq!(count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE), 1);
    assert!(!agent_monitor_stops::stop_pending("pause-ok", "self"));

    controller
        .set_session_monitoring_paused("sess", false)
        .await
        .expect("resume");
    assert_eq!(count(&agent, CONNECTION_MONITORING_SUBSCRIBE), 2);
    assert_eq!(last_subscribe_interval(&agent), Some(3000));

    advance(60).await;
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE),
        1,
        "no stop is retried after a confirmed pause"
    );

    controller.stop_session_monitoring("sess").await.ok();
}

/// A pause the agent did not confirm must not leave its collect loop running
/// while the desktop shows Paused: the stop is retried until it lands.
#[tokio::test(start_paused = true)]
async fn a_failed_pause_stops_the_agent_loop_in_the_background() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![(CONNECTION_MONITORING_UNSUBSCRIBE, 1)]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring("sess", None, on_agent("pause-fails"), app.handle().clone())
        .await
        .expect("agent start");

    controller
        .set_session_monitoring_paused("sess", true)
        .await
        .expect("the pause is honoured on the desktop");
    assert!(
        agent_monitor_stops::stop_pending("pause-fails", "self"),
        "the unconfirmed agent stop is owed"
    );

    advance(5).await;
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE),
        2,
        "refused once, then confirmed by the retry"
    );
    assert!(!agent_monitor_stops::stop_pending("pause-fails", "self"));
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_SUBSCRIBE),
        1,
        "nothing restarted the paused monitor"
    );

    controller.stop_session_monitoring("sess").await.ok();
}

/// A resume supersedes a stop still owed from a failed pause: once the resume
/// lands, no retry of that stop reaches the agent.
#[tokio::test(start_paused = true)]
async fn a_resume_cancels_a_pending_stop() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![(CONNECTION_MONITORING_UNSUBSCRIBE, usize::MAX)]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring("sess", None, on_agent("resume-wins"), app.handle().clone())
        .await
        .expect("agent start");
    controller
        .set_session_monitoring_paused("sess", true)
        .await
        .expect("pause");
    advance(2).await;
    let retried = count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE);
    assert!(retried >= 2, "the pause's stop was retried");

    controller
        .set_session_monitoring_paused("sess", false)
        .await
        .expect("resume");
    assert!(!agent_monitor_stops::stop_pending("resume-wins", "self"));

    advance(120).await;
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE),
        retried,
        "no stop reaches the agent after the resume"
    );
    assert_eq!(
        last_verb(&agent).as_deref(),
        Some(CONNECTION_MONITORING_SUBSCRIBE),
        "the resumed monitor is still subscribed"
    );
}

#[tokio::test(start_paused = true)]
async fn an_interval_change_resubscribes_a_running_monitor() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring("sess", None, on_agent("interval-ok"), app.handle().clone())
        .await
        .expect("agent start");

    controller
        .set_session_monitoring_interval("sess", 5000)
        .await
        .expect("interval change");
    assert_eq!(count(&agent, CONNECTION_MONITORING_SUBSCRIBE), 2);
    assert_eq!(last_subscribe_interval(&agent), Some(5000));
    assert!(!agent_monitor_stops::stop_pending("interval-ok", "self"));

    controller.stop_session_monitoring("sess").await.ok();
}

/// An interval change while paused only records the cadence: the agent loop
/// stays stopped, and the resume restarts it at the new interval.
#[tokio::test(start_paused = true)]
async fn an_interval_change_while_paused_waits_for_the_resume() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring(
            "sess",
            None,
            on_agent("interval-paused"),
            app.handle().clone(),
        )
        .await
        .expect("agent start");
    controller
        .set_session_monitoring_paused("sess", true)
        .await
        .expect("pause");

    controller
        .set_session_monitoring_interval("sess", 7000)
        .await
        .expect("interval change");
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_SUBSCRIBE),
        1,
        "the paused agent loop is not restarted"
    );

    controller
        .set_session_monitoring_paused("sess", false)
        .await
        .expect("resume");
    assert_eq!(count(&agent, CONNECTION_MONITORING_SUBSCRIBE), 2);
    assert_eq!(last_subscribe_interval(&agent), Some(7000));

    controller.stop_session_monitoring("sess").await.ok();
}

/// An interval change that resolved the monitor before a stop removed it must
/// not resurrect the stopped agent loop — nor supersede its deferred stop.
#[tokio::test(start_paused = true)]
async fn an_interval_change_after_a_stop_does_not_resurrect_the_monitor() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![(CONNECTION_MONITORING_UNSUBSCRIBE, 1)]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring(
            "sess",
            None,
            on_agent("interval-stopped"),
            app.handle().clone(),
        )
        .await
        .expect("agent start");
    let proxy = override_proxy(&overrides).await;

    assert!(controller.stop_session_monitoring("sess").await.is_err());
    assert!(agent_monitor_stops::stop_pending("interval-stopped", "self"));

    proxy.set_interval(Duration::from_millis(4000)).await;
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_SUBSCRIBE),
        1,
        "the stopped monitor is not re-subscribed"
    );
    assert!(
        agent_monitor_stops::stop_pending("interval-stopped", "self"),
        "the owed stop is not superseded"
    );

    advance(5).await;
    assert_eq!(count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE), 2);
    assert!(!agent_monitor_stops::stop_pending("interval-stopped", "self"));
    assert_eq!(
        last_verb(&agent).as_deref(),
        Some(CONNECTION_MONITORING_UNSUBSCRIBE)
    );
}

/// An interval change and a stop racing on the host gate, in either order:
/// the agent always ends stopped.
#[tokio::test(start_paused = true)]
async fn an_interval_change_racing_a_stop_leaves_the_agent_stopped() {
    for (agent_id, interval_first) in [("race-stop-first", false), ("race-interval-first", true)] {
        let (sessions, tasks, overrides, _provider) = maps_with_session().await;
        let controller = MonitoringController::new(&sessions, &tasks, &overrides);
        let agent = agent_refusing(vec![]);
        let app = app_with(&agent);

        controller
            .start_session_monitoring("sess", None, on_agent(agent_id), app.handle().clone())
            .await
            .expect("agent start");
        let proxy = override_proxy(&overrides).await;

        // Hold the host gate so both calls queue up on it.
        let gate = agent_monitor_stops::hold_host(agent_id, "self").await;
        let release = async {
            advance(1).await;
            drop(gate);
        };
        let interval = proxy.set_interval(Duration::from_millis(9000));
        let stop = async {
            controller.stop_session_monitoring("sess").await.ok();
        };
        if interval_first {
            tokio::join!(interval, stop, release);
        } else {
            tokio::join!(stop, interval, release);
        }

        advance(60).await;
        assert_eq!(
            last_verb(&agent).as_deref(),
            Some(CONNECTION_MONITORING_UNSUBSCRIBE),
            "{agent_id}: the agent ends stopped"
        );
        assert!(!agent_monitor_stops::stop_pending(agent_id, "self"));
    }
}
