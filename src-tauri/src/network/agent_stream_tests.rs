//! Tests for streaming agent tool runs (#3353).

use super::*;
use std::sync::Mutex;

use serde_json::json;
use termihub_core::protocol::methods::{ToolDoneNotification, TOOL_CANCEL, TOOL_START};

use crate::connection::config::AgentSettings;
use crate::terminal::agent_manager::{
    AgentCapabilities, AgentConnectResult, AgentConnectionsData, AgentDefinitionInfo,
    AgentFolderInfo, AgentSessionInfo, ToolRunSender,
};
use crate::terminal::backend::{OutputSender, RemoteAgentConfig};
use crate::utils::errors::TerminalError;
use termihub_core::monitoring::MonitoringSender;

/// An agent that records requests and hands the test the run's notification
/// route, so the test plays the agent's `tool.event` / `tool.done` stream.
#[derive(Default)]
struct FakeAgent {
    streaming: bool,
    refuse_start: bool,
    route: Mutex<Option<ToolRunSender>>,
    unregistered: Mutex<Vec<String>>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl FakeAgent {
    fn streaming() -> Arc<Self> {
        Arc::new(Self {
            streaming: true,
            ..Self::default()
        })
    }

    fn requests(&self) -> Vec<(String, Value)> {
        self.requests.lock().unwrap().clone()
    }

    fn take_route(&self) -> Option<ToolRunSender> {
        self.route.lock().unwrap().take()
    }

    /// Wait (virtual time) until `tool.start` was sent; return the route.
    async fn started(&self) -> (ToolRunSender, String) {
        for _ in 0..1000 {
            let start = self
                .requests()
                .into_iter()
                .find(|(m, _)| m == TOOL_START)
                .map(|(_, p)| p);
            if let Some(p) = start {
                let route = self
                    .route
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("route registered");
                return (route, p["runId"].as_str().unwrap().to_string());
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("tool.start never sent");
    }

    async fn wait_for_request(&self, method: &str) -> Value {
        for _ in 0..1000 {
            if let Some((_, p)) = self.requests().into_iter().find(|(m, _)| m == method) {
                return p;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("{method} never sent");
    }
}

#[allow(unused_variables)]
impl AgentRpcClient for FakeAgent {
    fn connect_agent(
        &self,
        agent_id: &str,
        config: &RemoteAgentConfig,
        agent_settings: Option<&AgentSettings>,
    ) -> Result<AgentConnectResult, TerminalError> {
        unimplemented!()
    }
    fn cancel_connect(&self, agent_id: &str) -> bool {
        unimplemented!()
    }
    fn disconnect_agent(&self, agent_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn is_connected(&self, agent_id: &str) -> bool {
        true
    }
    fn get_capabilities(&self, agent_id: &str) -> Option<AgentCapabilities> {
        Some(AgentCapabilities {
            connection_types: vec![],
            max_sessions: 1,
            available_shells: vec![],
            available_serial_ports: vec![],
            docker_available: false,
            available_docker_images: vec![],
            monitoring_supported: false,
            tool_streaming: self.streaming,
            agent_version: "test".to_string(),
        })
    }
    fn shutdown_agent(&self, agent_id: &str, reason: Option<&str>) -> Result<u32, TerminalError> {
        unimplemented!()
    }
    fn send_request(
        &self,
        agent_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, TerminalError> {
        self.requests
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        if method == TOOL_START && self.refuse_start {
            return Err(TerminalError::RemoteError("too many runs".to_string()));
        }
        Ok(json!({ "runId": params["runId"] }))
    }
    fn register_tool_run(
        &self,
        agent_id: &str,
        run_id: &str,
        tx: ToolRunSender,
    ) -> Result<(), TerminalError> {
        *self.route.lock().unwrap() = Some(tx);
        Ok(())
    }
    fn unregister_tool_run(&self, agent_id: &str, run_id: &str) {
        self.unregistered.lock().unwrap().push(run_id.to_string());
    }
    fn create_session(
        &self,
        agent_id: &str,
        session_type: &str,
        config: Value,
        title: Option<&str>,
        definition_id: Option<&str>,
    ) -> Result<AgentSessionInfo, TerminalError> {
        unimplemented!()
    }
    fn attach_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn close_session(&self, agent_id: &str, remote_session_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn list_sessions(&self, agent_id: &str) -> Result<Vec<AgentSessionInfo>, TerminalError> {
        unimplemented!()
    }
    fn list_connections_and_folders(
        &self,
        agent_id: &str,
    ) -> Result<AgentConnectionsData, TerminalError> {
        unimplemented!()
    }
    fn list_definitions(&self, agent_id: &str) -> Result<Vec<AgentDefinitionInfo>, TerminalError> {
        unimplemented!()
    }
    fn save_definition(
        &self,
        agent_id: &str,
        definition: termihub_core::protocol::methods::ConnectionCreateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn update_definition(
        &self,
        agent_id: &str,
        params: termihub_core::protocol::methods::ConnectionUpdateParams,
    ) -> Result<AgentDefinitionInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_definition(&self, agent_id: &str, def_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn create_folder(
        &self,
        agent_id: &str,
        name: &str,
        parent_id: Option<&str>,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn update_folder(
        &self,
        agent_id: &str,
        params: termihub_core::protocol::methods::FolderUpdateParams,
    ) -> Result<AgentFolderInfo, TerminalError> {
        unimplemented!()
    }
    fn delete_folder(&self, agent_id: &str, folder_id: &str) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        output_tx: OutputSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_session_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn register_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        monitoring_tx: MonitoringSender,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn unregister_monitoring_output(
        &self,
        agent_id: &str,
        remote_session_id: &str,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn send_session_input(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        data: &[u8],
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn resize_session(
        &self,
        agent_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
    fn apply_agent_settings(
        &self,
        agent_id: &str,
        settings: &AgentSettings,
    ) -> Result<(), TerminalError> {
        unimplemented!()
    }
}

type Emitted = Arc<Mutex<Vec<(&'static str, Value)>>>;

/// Spawn `run_streaming` for `tool`, collecting every emitted Tauri event.
fn spawn_run(
    tool: StreamTool,
    agent: &Arc<FakeAgent>,
    cancel: CancellationToken,
) -> (Emitted, tokio::task::JoinHandle<()>) {
    let emitted: Emitted = Arc::default();
    let sink = emitted.clone();
    let client: Arc<dyn AgentRpcClient> = agent.clone();
    let handle = tokio::spawn(async move {
        run_streaming(
            tool,
            client,
            "agent-1",
            "task-1",
            json!({}),
            &cancel,
            |n, p| {
                sink.lock().unwrap().push((n, p));
            },
        )
        .await;
    });
    (emitted, handle)
}

fn event(kind: &str, payload: Value) -> ToolEvent {
    ToolEvent {
        kind: kind.to_string(),
        payload,
    }
}

fn done(run_id: &str, result: Value, cancelled: bool) -> ToolRunMessage {
    ToolRunMessage::Done(ToolDoneNotification {
        run_id: run_id.to_string(),
        result: Some(result),
        cancelled,
        ..Default::default()
    })
}

fn names(emitted: &Emitted) -> Vec<&'static str> {
    emitted.lock().unwrap().iter().map(|(n, _)| *n).collect()
}

#[test]
fn streaming_is_used_only_when_the_agent_advertises_it() {
    let new: Arc<dyn AgentRpcClient> = FakeAgent::streaming();
    let old: Arc<dyn AgentRpcClient> = Arc::new(FakeAgent::default());
    assert!(supports_streaming(&new, "agent-1"));
    // An older agent (no `toolStreaming`) keeps the one-shot `tool.run` path.
    assert!(!supports_streaming(&old, "agent-1"));
}

#[tokio::test(start_paused = true)]
async fn port_scan_results_are_re_emitted_live() {
    let agent = FakeAgent::streaming();
    let (emitted, handle) = spawn_run(StreamTool::PortScan, &agent, CancellationToken::new());
    let (route, run_id) = agent.started().await;

    let start = agent.wait_for_request(TOOL_START).await;
    assert_eq!(start["toolId"], "port_scan");

    route
        .send(ToolRunMessage::Events(vec![
            event(
                "result",
                json!({ "host": "10.0.0.1", "port": 22, "state": "open", "latencyMs": 3 }),
            ),
            event(
                "result",
                json!({ "host": "10.0.0.1", "port": 23, "state": "closed", "latencyMs": null }),
            ),
        ]))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    // Live: both results are out while the run is still going.
    assert_eq!(names(&emitted), vec![name::SCAN_RESULT, name::SCAN_RESULT]);
    assert!(!handle.is_finished());
    assert_eq!(emitted.lock().unwrap()[0].1["port"], 22);
    assert_eq!(emitted.lock().unwrap()[0].1["taskId"], "task-1");

    route
        .send(done(
            &run_id,
            json!({ "total": 2, "open": 1, "closed": 1, "filtered": 0, "elapsedMs": 9 }),
            false,
        ))
        .unwrap();
    handle.await.unwrap();
    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.len(), 3);
    assert_eq!(all[2].0, name::SCAN_COMPLETE);
    assert_eq!(all[2].1["summary"]["open"], 1);
    assert_eq!(*agent.unregistered.lock().unwrap(), vec![run_id]);
}

/// A sweep far longer than the old 60 s request bound streams to completion —
/// the streaming path has no request timeout. Paused time: no real waiting.
#[tokio::test(start_paused = true)]
async fn sweep_longer_than_sixty_seconds_completes() {
    let agent = FakeAgent::streaming();
    let (emitted, handle) = spawn_run(StreamTool::PingSweep, &agent, CancellationToken::new());
    let (route, run_id) = agent.started().await;
    let begun = tokio::time::Instant::now();

    for i in 0..120u32 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        route
            .send(ToolRunMessage::Events(vec![event(
                "result",
                json!({ "host": format!("10.0.{}.{}", i / 250, i % 250), "latencyMs": 1, "hostname": null }),
            )]))
            .unwrap();
    }
    assert!(begun.elapsed() >= Duration::from_secs(120));
    route
        .send(done(
            &run_id,
            json!({ "total": 65534, "up": 120, "down": 65414, "elapsedMs": 120000 }),
            false,
        ))
        .unwrap();
    handle.await.unwrap();

    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.len(), 121);
    assert!(all[..120].iter().all(|(n, _)| *n == name::SWEEP_RESULT));
    assert_eq!(all[120].0, name::SWEEP_COMPLETE);
    assert_eq!(all[120].1["canceled"], false);
    assert_eq!(all[120].1["summary"]["up"], 120);
}

#[tokio::test(start_paused = true)]
async fn stop_sends_tool_cancel_and_reports_partial_result_canceled() {
    let agent = FakeAgent::streaming();
    let cancel = CancellationToken::new();
    let (emitted, handle) = spawn_run(StreamTool::PingSweep, &agent, cancel.clone());
    let (route, run_id) = agent.started().await;

    cancel.cancel();
    let params = agent.wait_for_request(TOOL_CANCEL).await;
    assert_eq!(params["runId"], run_id.as_str());

    // The agent's confirmation carries the partial summary.
    route
        .send(done(
            &run_id,
            json!({ "total": 254, "up": 3, "down": 10, "elapsedMs": 400 }),
            true,
        ))
        .unwrap();
    handle.await.unwrap();
    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.last().unwrap().0, name::SWEEP_COMPLETE);
    assert_eq!(all.last().unwrap().1["canceled"], true);
}

#[tokio::test(start_paused = true)]
async fn unconfirmed_cancel_fails_after_grace() {
    let agent = FakeAgent::streaming();
    let cancel = CancellationToken::new();
    let (emitted, handle) = spawn_run(StreamTool::Ping, &agent, cancel.clone());
    let (_route, _) = agent.started().await;
    cancel.cancel();
    handle.await.unwrap();
    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0, name::PING_ERROR);
    assert!(all[0].1["error"]
        .as_str()
        .unwrap()
        .contains("did not confirm"));
}

#[tokio::test(start_paused = true)]
async fn transport_loss_fails_the_run() {
    let agent = FakeAgent::streaming();
    let (emitted, handle) = spawn_run(StreamTool::Traceroute, &agent, CancellationToken::new());
    let (route, _) = agent.started().await;
    route
        .send(ToolRunMessage::Events(vec![event(
            "hop",
            json!({ "hop": 1, "host": "gw", "ip": "10.0.0.1", "rttMs": [1.0, null, 2.0] }),
        )]))
        .unwrap();
    // The I/O task drops every route when the transport breaks.
    drop(route);
    drop(agent.take_route());
    handle.await.unwrap();
    assert_eq!(
        names(&emitted),
        vec![name::TRACEROUTE_HOP, name::TRACEROUTE_ERROR]
    );
    let err = emitted.lock().unwrap()[1].1["error"].clone();
    assert!(err.as_str().unwrap().contains("connection lost"), "{err}");
}

#[tokio::test(start_paused = true)]
async fn refused_start_is_an_error_event() {
    let agent = Arc::new(FakeAgent {
        streaming: true,
        refuse_start: true,
        ..FakeAgent::default()
    });
    let (emitted, handle) = spawn_run(StreamTool::PortScan, &agent, CancellationToken::new());
    handle.await.unwrap();
    assert_eq!(names(&emitted), vec![name::SCAN_ERROR]);
    assert_eq!(agent.unregistered.lock().unwrap().len(), 1, "route removed");
}

#[test]
fn completion_maps_every_outcome() {
    let ok = |result: Value, cancelled| StreamOutcome::Done {
        result: Some(result),
        error: None,
        cancelled,
    };
    let stats = json!({
        "sent": 3, "received": 3, "lossPercent": 0.0,
        "minMs": 1.0, "avgMs": 1.0, "maxMs": 1.0, "jitterMs": 0.0
    });
    let (n, p) = StreamTool::Ping.completion_payload("t", ok(stats, true));
    assert_eq!(n, name::PING_COMPLETE);
    assert_eq!(p["canceled"], true);
    assert_eq!(p["stats"]["sent"], 3);

    let (n, p) = StreamTool::Traceroute.completion_payload("t", ok(json!({}), false));
    assert_eq!(
        (n, p),
        (name::TRACEROUTE_COMPLETE, json!({ "taskId": "t" }))
    );

    // The agent's own failure message surfaces as the tool's error event.
    let failed = StreamOutcome::Done {
        result: None,
        error: Some("boom".to_string()),
        cancelled: false,
    };
    let (n, p) = StreamTool::PingSweep.completion_payload("t", failed);
    assert_eq!(n, name::SWEEP_ERROR);
    assert_eq!(p["error"], "boom");

    // A malformed aggregate is an error, not a bogus completion.
    let (n, _) = StreamTool::PortScan.completion_payload("t", ok(json!({ "x": 1 }), false));
    assert_eq!(n, name::SCAN_ERROR);
}

#[test]
fn unknown_or_malformed_events_are_skipped() {
    assert!(StreamTool::PingSweep
        .event_payload("t", event("progress", json!({})))
        .is_none());
    assert!(StreamTool::PortScan
        .event_payload("t", event("result", json!({ "nope": true })))
        .is_none());
    let (n, p) = StreamTool::Ping
        .event_payload(
            "t",
            event(
                "result",
                json!({ "seq": 0, "latencyMs": 12, "ttl": 56, "timedOut": false, "tcpFallback": false }),
            ),
        )
        .unwrap();
    assert_eq!(n, name::PING_RESULT);
    assert_eq!(p["result"]["seq"], 0);
}
