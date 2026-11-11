//! No monitoring open — failed or switched — may leave an untracked live
//! monitor (#5305).
//!
//! These drive [`MonitoringController::start_session_monitoring`] end to end
//! against a `tauri::test::mock_app()` (no windows) whose managed agent RPC
//! client is the scripted [`FakeAgent`], and assert that:
//!
//! - a failed agent subscribe unregisters its output route and stops the
//!   agent's collect loop in the background, and a reopen supersedes that stop;
//! - a run-location switch tears the previous location's provider down before
//!   the new subscription replaces it, in both directions.
//!
//! The deferred-stop registry is process-wide, so every test uses its own
//! agent id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tauri::Manager;
use termihub_core::connection::{Capabilities, ConnectionType, OutputReceiver, SettingsSchema};
use termihub_core::errors::{CoreError, SessionError};
use termihub_core::files::FileBrowser;
use termihub_core::monitoring::MonitoringSubscription;
use termihub_core::protocol::methods::{
    CONNECTION_MONITORING_SUBSCRIBE, CONNECTION_MONITORING_UNSUBSCRIBE,
};
use tokio_util::sync::CancellationToken;

use super::super::line_ending::LineEnding;
use super::super::manager::session_io::SessionIo;
use super::super::manager::SessionInfo;
use super::*;
use crate::network::test_support::FakeAgent;
use crate::session::agent_monitor_stops;

pub(super) type Sessions = Mutex<HashMap<String, SessionEntry>>;
pub(super) type Tasks = Mutex<HashMap<String, AbortHandle>>;
pub(super) type Overrides = Mutex<HashMap<String, Arc<dyn MonitoringProvider + Send + Sync>>>;

/// The session's own ("This computer") monitoring provider: counts subscribes
/// and unsubscribes and keeps each live subscription's senders, so its
/// channels stay open until it is unsubscribed — like a real collect loop.
#[derive(Default)]
pub(super) struct CountingProvider {
    subscribes: AtomicUsize,
    unsubscribes: AtomicUsize,
    live: StdMutex<Vec<Box<dyn std::any::Any + Send>>>,
}

impl CountingProvider {
    fn running(&self) -> bool {
        !self.live.lock().unwrap().is_empty()
    }
}

#[async_trait::async_trait]
impl MonitoringProvider for CountingProvider {
    async fn subscribe(&self) -> Result<MonitoringSubscription, CoreError> {
        self.subscribes.fetch_add(1, Ordering::SeqCst);
        let (stats_tx, stats) = tokio::sync::mpsc::channel(4);
        let (status_tx, status) = tokio::sync::mpsc::channel(4);
        self.live
            .lock()
            .unwrap()
            .push(Box::new((stats_tx, status_tx)));
        Ok(MonitoringSubscription { stats, status })
    }
    async fn unsubscribe(&self) -> Result<(), CoreError> {
        self.unsubscribes.fetch_add(1, Ordering::SeqCst);
        self.live.lock().unwrap().clear();
        Ok(())
    }
    async fn set_interval(&self, _interval: Duration) {}
    async fn set_paused(&self, _paused: bool) {}
    async fn cancel_connect(&self) {}
}

/// A session connection whose monitoring capability is a [`CountingProvider`].
struct MonitoredConnection {
    provider: Arc<CountingProvider>,
}

#[async_trait::async_trait]
impl ConnectionType for MonitoredConnection {
    fn type_id(&self) -> &str {
        "monitored-mock"
    }
    fn display_name(&self) -> &str {
        "Monitored"
    }
    fn settings_schema(&self) -> SettingsSchema {
        SettingsSchema { groups: vec![] }
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            monitoring: true,
            file_browser: false,
            graphical: false,
            resize: false,
            persistent: false,
            terminal: true,
            tunneling: false,
        }
    }
    async fn connect(&mut self, _settings: serde_json::Value) -> Result<(), SessionError> {
        Ok(())
    }
    async fn disconnect(&mut self) -> Result<(), SessionError> {
        Ok(())
    }
    fn is_connected(&self) -> bool {
        true
    }
    fn write(&self, _data: &[u8]) -> Result<(), SessionError> {
        Ok(())
    }
    fn resize(&self, _cols: u16, _rows: u16) -> Result<(), SessionError> {
        Ok(())
    }
    fn subscribe_output(&self) -> OutputReceiver {
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        rx
    }
    fn monitoring(&self) -> Option<&dyn MonitoringProvider> {
        Some(self.provider.as_ref())
    }
    fn monitoring_handle(&self) -> Option<Arc<dyn MonitoringProvider + Send + Sync>> {
        Some(self.provider.clone())
    }
    fn file_browser(&self) -> Option<&dyn FileBrowser> {
        None
    }
}

/// The maps plus a `sess` session backed by a fresh [`CountingProvider`].
pub(super) async fn maps_with_session() -> (Sessions, Tasks, Overrides, Arc<CountingProvider>) {
    let (sessions, tasks, overrides): (Sessions, Tasks, Overrides) = Default::default();
    let provider = Arc::new(CountingProvider::default());
    sessions.lock().await.insert(
        "sess".to_string(),
        SessionEntry {
            connection: Arc::new(MonitoredConnection {
                provider: provider.clone(),
            }),
            info: SessionInfo {
                id: "sess".to_string(),
                title: "Monitored".to_string(),
                connection_type: "monitored-mock".to_string(),
                alive: true,
                agent_id: None,
                spawned: false,
            },
            remote_session_id: None,
            line_ending: LineEnding::default(),
            reader_cancel: CancellationToken::new(),
            io: SessionIo::default(),
        },
    );
    (sessions, tasks, overrides, provider)
}

/// A mock app (no windows) whose managed agent RPC client is `agent`.
pub(super) fn app_with(agent: &Arc<FakeAgent>) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(agent.clone() as Arc<dyn AgentRpcClient>);
    app
}

pub(super) fn agent_refusing(times: Vec<(&'static str, usize)>) -> Arc<FakeAgent> {
    Arc::new(FakeAgent {
        refuse_times: StdMutex::new(times),
        ..FakeAgent::default()
    })
}

pub(super) fn count(agent: &FakeAgent, method: &str) -> usize {
    agent.requests().iter().filter(|(m, _)| m == method).count()
}

pub(super) fn routes(agent: &FakeAgent) -> usize {
    agent.monitoring_routes.lock().unwrap().len()
}

/// Let background tasks run through `secs` seconds of (paused) virtual time.
pub(super) async fn advance(secs: u64) {
    for _ in 0..secs * 10 {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub(super) fn on_agent(agent_id: &str) -> RunLocation {
    RunLocation::Agent(agent_id.to_string())
}

/// A subscribe that fails after the agent may have acted must not leave the
/// output route registered, nor the agent's collect loop running.
#[tokio::test(start_paused = true)]
async fn a_failed_agent_subscribe_drops_its_route_and_stops_the_agent_loop() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![(CONNECTION_MONITORING_SUBSCRIBE, 1)]);
    let app = app_with(&agent);

    let result = controller
        .start_session_monitoring("sess", None, on_agent("open-fails"), app.handle().clone())
        .await;

    assert!(result.is_err(), "the failed open is reported");
    assert!(tasks.lock().await.is_empty(), "no push task");
    assert!(overrides.lock().await.is_empty(), "no override recorded");
    assert_eq!(routes(&agent), 0, "the output route is unregistered");
    assert!(
        agent_monitor_stops::stop_pending("open-fails", "self"),
        "the agent half is stopped in the background"
    );

    advance(5).await;
    assert_eq!(count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE), 1);
    assert!(!agent_monitor_stops::stop_pending("open-fails", "self"));
}

/// A reopen after a failed subscribe supersedes the deferred stop: the stop
/// is never sent, so it cannot stop the monitor the user just reopened.
#[tokio::test(start_paused = true)]
async fn a_reopen_supersedes_the_stop_of_a_failed_subscribe() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![(CONNECTION_MONITORING_SUBSCRIBE, 1)]);
    let app = app_with(&agent);
    let location = on_agent("open-reopen");

    assert!(controller
        .start_session_monitoring("sess", None, location.clone(), app.handle().clone())
        .await
        .is_err());
    controller
        .start_session_monitoring("sess", None, location, app.handle().clone())
        .await
        .expect("the reopen succeeds");

    advance(120).await;
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE),
        0,
        "the superseded stop is never sent"
    );
    assert!(!agent_monitor_stops::stop_pending("open-reopen", "self"));
    assert_eq!(routes(&agent), 1, "the reopened monitor keeps its route");
    assert!(overrides.lock().await.contains_key("sess"));
    assert_eq!(tasks.lock().await.len(), 1);

    controller.stop_session_monitoring("sess").await.ok();
}

/// A reopen racing a stop that is already being retried: once the reopen
/// lands, no further stop reaches the agent.
#[tokio::test(start_paused = true)]
async fn a_reopen_racing_a_retried_stop_wins() {
    let (sessions, tasks, overrides, _provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![
        (CONNECTION_MONITORING_SUBSCRIBE, 1),
        (CONNECTION_MONITORING_UNSUBSCRIBE, usize::MAX),
    ]);
    let app = app_with(&agent);
    let location = on_agent("open-race");

    assert!(controller
        .start_session_monitoring("sess", None, location.clone(), app.handle().clone())
        .await
        .is_err());
    // The stop is retried (and keeps failing) while the user reopens.
    advance(2).await;
    let retried = count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE);
    assert!(retried >= 1, "the stop was retried before the reopen");

    controller
        .start_session_monitoring("sess", None, location, app.handle().clone())
        .await
        .expect("the reopen succeeds");
    let subscribes = count(&agent, CONNECTION_MONITORING_SUBSCRIBE);

    advance(120).await;
    assert_eq!(
        count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE),
        retried,
        "no stop reaches the agent after the reopen"
    );
    assert_eq!(count(&agent, CONNECTION_MONITORING_SUBSCRIBE), subscribes);
    assert!(!agent_monitor_stops::stop_pending("open-race", "self"));
    assert_eq!(routes(&agent), 1, "the reopened monitor keeps its route");
}

/// Switching from "This computer" to an agent stops the session provider's
/// loop before the agent subscription replaces it.
#[tokio::test(start_paused = true)]
async fn a_local_to_agent_switch_stops_the_session_provider() {
    let (sessions, tasks, overrides, provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring(
            "sess",
            None,
            RunLocation::ThisComputer,
            app.handle().clone(),
        )
        .await
        .expect("local start");
    assert!(provider.running());

    controller
        .start_session_monitoring("sess", None, on_agent("switch-la"), app.handle().clone())
        .await
        .expect("agent start");

    assert_eq!(provider.unsubscribes.load(Ordering::SeqCst), 1);
    assert!(!provider.running(), "the local loop is stopped");
    assert_eq!(count(&agent, CONNECTION_MONITORING_SUBSCRIBE), 1);
    assert_eq!(routes(&agent), 1);
    assert!(overrides.lock().await.contains_key("sess"));
    assert_eq!(tasks.lock().await.len(), 1, "one push task");

    controller.stop_session_monitoring("sess").await.ok();
}

/// Switching from an agent back to "This computer" stops the agent's loop
/// and drops its override and route before the session provider subscribes.
#[tokio::test(start_paused = true)]
async fn an_agent_to_local_switch_stops_the_agent_monitor() {
    let (sessions, tasks, overrides, provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring("sess", None, on_agent("switch-al"), app.handle().clone())
        .await
        .expect("agent start");
    assert_eq!(routes(&agent), 1);

    controller
        .start_session_monitoring(
            "sess",
            None,
            RunLocation::ThisComputer,
            app.handle().clone(),
        )
        .await
        .expect("local start");

    assert_eq!(count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE), 1);
    assert_eq!(routes(&agent), 0, "the agent route is unregistered");
    assert!(overrides.lock().await.is_empty(), "the override is dropped");
    assert!(!agent_monitor_stops::stop_pending("switch-al", "self"));
    assert_eq!(provider.subscribes.load(Ordering::SeqCst), 1);
    assert!(provider.running());
    assert_eq!(tasks.lock().await.len(), 1, "one push task");

    controller.stop_session_monitoring("sess").await.ok();
    assert!(!provider.running());
}

/// A first start has nothing to tear down: the session provider is not
/// unsubscribed before it was ever subscribed.
#[tokio::test(start_paused = true)]
async fn a_first_start_tears_nothing_down() {
    let (sessions, tasks, overrides, provider) = maps_with_session().await;
    let controller = MonitoringController::new(&sessions, &tasks, &overrides);
    let agent = agent_refusing(vec![]);
    let app = app_with(&agent);

    controller
        .start_session_monitoring("sess", None, on_agent("first-start"), app.handle().clone())
        .await
        .expect("agent start");

    assert_eq!(provider.unsubscribes.load(Ordering::SeqCst), 0);
    assert_eq!(count(&agent, CONNECTION_MONITORING_UNSUBSCRIBE), 0);

    controller.stop_session_monitoring("sess").await.ok();
}
