//! HTTP monitors on agents read like services (#6052) and stay on their agent
//! across a restart (#6039), over a scripted agent.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::Wry;
use termihub_core::protocol::methods::{SERVICE_START, SERVICE_STATUS, SERVICE_STOP};
use termihub_core::util::service_host::ServiceHost;

use super::*;
use crate::agent_service::hosted::{Outcome, StopPlan};
use crate::network::NetworkManager;
use crate::run_location::RunLocation;
use crate::test_support::agent_rpc::FakeAgent;
use crate::utils::errors::TerminalError;

/// The monitors an agent machine checks with.
#[derive(Default)]
struct Machine {
    running: Mutex<HashSet<String>>,
}

impl Machine {
    fn agent(self: &Arc<Self>) -> Arc<FakeAgent> {
        let this = Arc::clone(self);
        let mut agent = FakeAgent::session_host();
        agent.responder = Some(Box::new(move |method, params| this.answer(method, params)));
        Arc::new(agent)
    }

    fn answer(&self, method: &str, params: &Value) -> Option<Result<Value, TerminalError>> {
        let id = params["instanceId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let mut running = self.running.lock().unwrap();
        Some(Ok(match method {
            SERVICE_START => {
                running.insert(id);
                json!({"status": "running"})
            }
            SERVICE_STOP => json!({"stopped": running.remove(&id)}),
            SERVICE_STATUS if running.contains(&id) => json!({
                "running": true,
                "state": {"monitorId": id, "statusCode": 200, "latencyMs": 3, "ok": true,
                          "error": null, "timestampMs": 1_700_000_000_000_u64},
            }),
            SERVICE_STATUS => json!({"running": false}),
            _ => return None,
        }))
    }

    fn checks(&self, id: &str) -> bool {
        self.running.lock().unwrap().contains(id)
    }
}

fn online(agent: &FakeAgent, online: bool) {
    agent.host().connected.store(online, Ordering::SeqCst);
}

fn on_edge(id: &str) -> HttpMonitorConfig {
    let mut config = HttpMonitorConfig::new(
        format!("https://{id}.example/health"),
        30_000,
        "GET".into(),
        200,
        5_000,
    );
    config.id = id.into();
    config.host = ServiceHost::agent("edge");
    config
}

/// Started on agent "edge" as the manager starts one.
fn started(monitors: &AgentMonitors, id: &str) {
    monitors.list(on_edge(id));
    let ticket = monitors.hosted.begin(id).expect("not busy");
    let outcome = Outcome::Started {
        agent_id: "edge".into(),
        state: None,
    };
    monitors.hosted.finish(ticket, outcome, Instant::now());
}

fn tick(monitors: &AgentMonitors, agent: &FakeAgent) -> Applied {
    let (targets, _) = monitors.targets();
    monitors.apply(HostedServices::<HostedMonitors>::poll(agent, &targets))
}

fn state(monitors: &AgentMonitors, id: &str) -> HttpMonitorState {
    monitors
        .states::<Wry>(None)
        .into_iter()
        .find(|s| s.config.id == id)
        .expect("listed")
}

#[test]
fn a_monitor_whose_agent_is_gone_is_not_reachable_and_back_is_running() {
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    let monitors = AgentMonitors::with(HostedServices::default());
    started(&monitors, "m");
    machine.running.lock().unwrap().insert("m".into());

    let applied = tick(&monitors, &agent);
    assert_eq!(applied.checks.len(), 1, "the first check is passed on");
    let now = state(&monitors, "m");
    assert_eq!(
        (now.status, now.running),
        (HttpMonitorStatus::Running, true)
    );
    assert!(now.last_result.is_some_and(|check| check.ok));
    assert!(
        tick(&monitors, &agent).checks.is_empty(),
        "the same check once"
    );

    online(&agent, false);
    assert!(tick(&monitors, &agent).changed, "the row is told");
    let away = state(&monitors, "m");
    assert_eq!(away.status, HttpMonitorStatus::NotReachable);
    assert!(!away.running, "not running while its agent is gone");
    assert_eq!(monitors.running_with_url("https://m.example/health"), None);

    online(&agent, true);
    tick(&monitors, &agent);
    assert_eq!(state(&monitors, "m").status, HttpMonitorStatus::Running);
}

#[test]
fn a_stop_its_agent_did_not_get_is_owed_across_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    {
        let monitors = AgentMonitors::stored(dir.path());
        started(&monitors, "m");
        machine.running.lock().unwrap().insert("m".into());
        online(&agent, false);
        tick(&monitors, &agent);
        assert_eq!(
            monitors.hosted.stop("m"),
            StopPlan::StopThere("edge".into())
        );
        assert_eq!(state(&monitors, "m").status, HttpMonitorStatus::Stopping);
    }
    let monitors = AgentMonitors::stored(dir.path());
    monitors.list(on_edge("m"));
    assert_eq!(state(&monitors, "m").status, HttpMonitorStatus::Stopping);
    online(&agent, true);
    assert!(tick(&monitors, &agent).changed);
    assert!(!machine.checks("m"), "stopped there");
    assert_eq!(state(&monitors, "m").status, HttpMonitorStatus::Stopped);
}

#[test]
fn a_start_its_agent_never_answered_says_so_once_it_is_certain() {
    let machine = Arc::new(Machine::default());
    let agent = machine.agent();
    let monitors = AgentMonitors::with(HostedServices::default());
    monitors.list(on_edge("m"));
    let ticket = monitors.hosted.begin("m").unwrap();
    let outcome = Outcome::Unanswered {
        agent_id: "edge".into(),
        state: None,
    };
    let past = Instant::now() - crate::agent_service::hosted::UNKNOWN_SETTLE;
    monitors.hosted.finish(ticket, outcome, past);
    assert_eq!(
        state(&monitors, "m").status,
        HttpMonitorStatus::NotReachable,
        "may check there"
    );
    tick(&monitors, &agent);
    let failed = state(&monitors, "m");
    assert_eq!(failed.status, HttpMonitorStatus::Error);
    assert!(failed.reason.unwrap().contains("did not answer the start"));
}

#[test]
fn the_agent_is_not_sent_the_desktops_own_fields() {
    let config = on_edge("m");
    let sent = serde_json::to_value(for_agent(&config)).unwrap();
    assert!(sent.get("host").is_none(), "{sent}");
    assert_eq!(agent_of(&config), Some("edge"));
    assert_eq!(
        agent_of(&HttpMonitorConfig::new("u".into(), 1, "GET".into(), 200, 1)),
        None
    );
}

// ─── After a restart (#6039) ─────────────────────────────────────────────────

/// One app run over `dir`, without an app: nothing can reach an agent.
fn manager(dir: &std::path::Path) -> NetworkManager {
    let mut manager = NetworkManager::new();
    manager.load_persisted(dir.to_path_buf(), None);
    manager
}

#[test]
fn a_monitor_set_to_an_agent_stays_there_after_a_restart_and_is_not_checked_here() {
    let dir = tempfile::tempdir().unwrap();
    {
        let first = manager(dir.path());
        let mut config = on_edge("m");
        config.host = ServiceHost::default();
        // Started from the panel with the agent chosen; no agent to reach here.
        let started = first.start_http_monitor(config, RunLocation::Agent("edge".into()));
        assert!(started.is_err(), "not started anywhere else");
    }
    let second = manager(dir.path());
    assert!(second.agent_monitors.has("m"), "listed on its agent");
    assert!(
        second.agent_monitors.hosted.any(),
        "its agent is asked about it"
    );
    let listed = second.list_http_monitors();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        agent_of(&listed[0].config),
        Some("edge"),
        "where it runs is stored"
    );
    assert!(!listed[0].running);
    let error = second
        .resume_http_monitor("m")
        .expect_err("its agent is not connected");
    assert!(error.to_string().contains("not connected"), "{error}");
    let after = second.list_http_monitors();
    assert_eq!(
        after[0].status,
        HttpMonitorStatus::Error,
        "the row says why"
    );
    assert!(
        second.http_monitors.lock().unwrap().is_empty(),
        "nothing checks from this computer"
    );
}

#[test]
fn a_host_this_build_cannot_read_is_kept_and_never_checked_here() {
    let dir = tempfile::tempdir().unwrap();
    let doc = json!({"version": "1", "monitors": [{
        "id": "m", "url": "https://m.example/", "intervalMs": 30000, "method": "GET",
        "expectedStatus": 200, "timeoutMs": 5000, "host": {"kind": "cloud", "region": "eu"},
    }]});
    std::fs::write(dir.path().join("http-monitors.json"), doc.to_string()).unwrap();
    let manager = manager(dir.path());
    manager
        .resume_http_monitor("m")
        .expect_err("cannot read where it runs");
    let row = &manager.list_http_monitors()[0];
    assert_eq!((row.running, row.status), (false, HttpMonitorStatus::Error));
    assert!(row
        .reason
        .as_deref()
        .unwrap()
        .contains("cannot read where it runs"));
    assert!(manager.http_monitors.lock().unwrap().is_empty());
    let stored = std::fs::read_to_string(dir.path().join("http-monitors.json")).unwrap();
    assert!(
        stored.contains("\"region\":\"eu\""),
        "kept verbatim: {stored}"
    );
}

#[test]
fn a_stop_owed_before_a_restart_shows_as_stopping() {
    let dir = tempfile::tempdir().unwrap();
    let doc = json!({"version": "1", "monitors": [serde_json::to_value(on_edge("m")).unwrap()]});
    std::fs::write(dir.path().join("http-monitors.json"), doc.to_string()).unwrap();
    let owed = json!([{"agentId": "edge", "id": "m"}]);
    std::fs::write(
        dir.path().join("http_monitors_owed_stops.json"),
        owed.to_string(),
    )
    .unwrap();
    let manager = manager(dir.path());
    assert_eq!(
        manager.list_http_monitors()[0].status,
        HttpMonitorStatus::Stopping
    );
}
