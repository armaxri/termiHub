//! Tests for the single network-tool path (#3731).

use super::*;
use std::sync::Mutex;

use termihub_core::protocol::methods::TOOL_START;

use crate::network::events::name;
use crate::network::test_support::FakeAgent;
use crate::utils::errors::IpcErrorCode;

type Emitted = Arc<Mutex<Vec<(&'static str, Value)>>>;

fn collector() -> (
    Emitted,
    impl Fn(&'static str, Value) + Send + Sync + 'static,
) {
    let emitted: Emitted = Arc::default();
    let sink = Arc::clone(&emitted);
    (emitted, move |n, p| sink.lock().unwrap().push((n, p)))
}

/// The human `message` of the serialized IPC error envelope.
fn ipc_message(err: &TerminalError) -> String {
    serde_json::to_value(err).unwrap()["message"]
        .as_str()
        .unwrap()
        .to_string()
}

fn local() -> ToolTarget {
    ToolTarget::Local(Arc::new(ToolRegistry::with_builtin_network_tools()))
}

fn agent_target(agent: Arc<FakeAgent>) -> Result<ToolTarget, TerminalError> {
    let client: Arc<dyn AgentRpcClient> = agent;
    ToolTarget::for_location(
        ResolvedLocation::Agent("agent-1".to_string()),
        Arc::new(ToolRegistry::new()),
        Some(client),
    )
}

// ── Version floor ────────────────────────────────────────────────────────────

#[test]
fn an_agent_below_the_floor_gets_the_update_the_agent_message() {
    // An agent without `toolStreaming` (pre-0.9.0) predates the floor.
    let err = agent_target(Arc::new(FakeAgent::default()))
        .err()
        .expect("an old agent must be refused");
    assert_eq!(err.code(), IpcErrorCode::AgentOutdated);
    // What the frontend shows: the IPC envelope's human message.
    let message = ipc_message(&err);
    assert!(
        message.contains("Update the agent to use network tools"),
        "{message}"
    );
    assert!(
        message.contains("0.8.1"),
        "names the agent version: {message}"
    );
    assert!(
        message.contains(NETWORK_TOOLS_MIN_AGENT_PROTOCOL),
        "{message}"
    );
}

#[test]
fn an_old_agent_is_refused_before_anything_is_sent() {
    let agent = Arc::new(FakeAgent::default());
    let _ = agent_target(Arc::clone(&agent));
    assert!(
        agent.requests().is_empty(),
        "no request may reach the agent"
    );
}

#[test]
fn the_message_reads_well_without_a_version() {
    let message = agent_too_old_message("  ");
    assert!(message.starts_with("This agent is too old"), "{message}");
    assert!(message.contains("Update the agent to use network tools"));
}

#[test]
fn an_agent_at_the_floor_is_accepted() {
    assert!(matches!(
        agent_target(FakeAgent::streaming()),
        Ok(ToolTarget::Agent { .. })
    ));
}

#[test]
fn a_disconnected_agent_is_a_plain_network_error() {
    let agent = Arc::new(FakeAgent {
        disconnected: true,
        ..FakeAgent::default()
    });
    let err = agent_target(agent).err().expect("must be refused");
    assert!(matches!(err, TerminalError::NetworkError(_)), "{err:?}");
    assert!(ipc_message(&err).contains("not connected"));
}

#[test]
fn an_agent_location_without_an_agent_manager_is_an_error() {
    let err = ToolTarget::for_location(
        ResolvedLocation::Agent("agent-1".to_string()),
        Arc::new(ToolRegistry::new()),
        None,
    )
    .err()
    .expect("no client must be an error, not a panic");
    assert!(matches!(err, TerminalError::NetworkError(_)));
}

#[test]
fn a_local_location_needs_no_agent() {
    assert!(matches!(
        ToolTarget::for_location(ResolvedLocation::Local, Arc::new(ToolRegistry::new()), None),
        Ok(ToolTarget::Local(_))
    ));
}

// ── Routing: local runs the desktop registry, an agent runs `tool.*` ─────────

#[tokio::test]
async fn a_local_one_shot_runs_the_desktop_registry() {
    let result = run_one_shot(&local(), "open_ports", json!({}))
        .await
        .expect("open ports runs locally");
    assert!(result["ports"].is_array(), "{result}");
}

#[tokio::test]
async fn a_local_one_shot_surfaces_the_tool_error() {
    let err = run_one_shot(
        &local(),
        "wol",
        json!({ "mac": "not-a-mac", "broadcast": "255.255.255.255" }),
    )
    .await
    .expect_err("an invalid MAC must fail");
    assert!(matches!(err, TerminalError::NetworkError(_)), "{err:?}");
}

#[tokio::test]
async fn an_agent_one_shot_sends_tool_run_and_returns_the_aggregate() {
    let agent = Arc::new(FakeAgent {
        streaming: true,
        tool_run_reply: Some(json!({
            "events": [],
            "result": { "ports": [{ "protocol": "TCP", "localAddr": "0.0.0.0:22",
                                    "pid": null, "process": null }] }
        })),
        ..FakeAgent::default()
    });
    let target = agent_target(Arc::clone(&agent)).unwrap();
    let result = run_one_shot(&target, "open_ports", json!({}))
        .await
        .unwrap();
    assert_eq!(result["ports"][0]["localAddr"], "0.0.0.0:22");

    let requests = agent.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, TOOL_RUN);
    assert_eq!(
        requests[0].1,
        json!({ "toolId": "open_ports", "params": {} })
    );
    assert!(
        requests.iter().all(|(m, _)| !m.starts_with("network.")),
        "the retired network.* methods are never called"
    );
}

#[tokio::test]
async fn an_agent_one_shot_failure_is_an_error() {
    let agent = FakeAgent::streaming();
    let target = agent_target(agent).unwrap();
    assert!(run_one_shot(&target, "dns", json!({ "hostname": "x" }))
        .await
        .is_err());
}

#[tokio::test(start_paused = true)]
async fn an_agent_streaming_run_goes_through_tool_start() {
    let agent = FakeAgent::streaming();
    let target = agent_target(Arc::clone(&agent)).unwrap();
    let (emitted, emit) = collector();
    let handle = tokio::spawn(async move {
        run_streaming(
            target,
            StreamTool::Ping,
            "task-1",
            json!({ "host": "h" }),
            &CancellationToken::new(),
            emit,
        )
        .await;
    });
    let (route, run_id) = agent.started().await;
    let start = agent.wait_for_request(TOOL_START).await;
    assert_eq!(start["toolId"], "ping");
    assert_eq!(start["params"], json!({ "host": "h" }));
    route
        .send(crate::terminal::agent_manager::ToolRunMessage::Done(
            termihub_core::protocol::methods::ToolDoneNotification {
                run_id,
                result: Some(json!({
                    "sent": 1, "received": 1, "lossPercent": 0.0,
                    "minMs": 1.0, "avgMs": 1.0, "maxMs": 1.0, "jitterMs": 0.0
                })),
                ..Default::default()
            },
        ))
        .unwrap();
    handle.await.unwrap();
    let names: Vec<_> = emitted.lock().unwrap().iter().map(|(n, _)| *n).collect();
    assert_eq!(names.last(), Some(&name::PING_COMPLETE), "{names:?}");
}

// ── Local streaming emits the same event shapes ──────────────────────────────

#[tokio::test]
async fn a_local_port_scan_streams_results_then_the_summary() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let (emitted, emit) = collector();
    run_streaming(
        local(),
        StreamTool::PortScan,
        "task-1",
        json!({
            "targets": ["127.0.0.1"],
            "ports": port.to_string(),
            "timeoutMs": 1000,
            "concurrency": 1,
        }),
        &CancellationToken::new(),
        emit,
    )
    .await;

    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.len(), 2, "{all:?}");
    assert_eq!(all[0].0, name::SCAN_RESULT);
    assert_eq!(
        all[0].1,
        json!({
            "taskId": "task-1",
            "host": "127.0.0.1",
            "port": port,
            "state": "open",
            "latencyMs": all[0].1["latencyMs"],
        }),
        "the per-port payload shape is unchanged"
    );
    assert!(all[0].1["latencyMs"].is_u64());
    assert_eq!(all[1].0, name::SCAN_COMPLETE);
    assert_eq!(all[1].1["taskId"], "task-1");
    assert_eq!(all[1].1["summary"]["total"], 1);
    assert_eq!(all[1].1["summary"]["open"], 1);
}

#[tokio::test]
async fn a_local_empty_sweep_completes_uncanceled() {
    let (emitted, emit) = collector();
    run_streaming(
        local(),
        StreamTool::PingSweep,
        "task-1",
        json!({ "targets": [] }),
        &CancellationToken::new(),
        emit,
    )
    .await;
    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(all[0].0, name::SWEEP_COMPLETE);
    assert_eq!(all[0].1["canceled"], false);
    assert_eq!(all[0].1["summary"]["total"], 0);
}

#[tokio::test]
async fn a_local_run_failure_is_the_tools_error_event() {
    let (emitted, emit) = collector();
    run_streaming(
        local(),
        StreamTool::PortScan,
        "task-1",
        json!({ "targets": ["127.0.0.1"], "ports": "not-a-port" }),
        &CancellationToken::new(),
        emit,
    )
    .await;
    let all = emitted.lock().unwrap().clone();
    assert_eq!(all.len(), 1, "{all:?}");
    assert_eq!(all[0].0, name::SCAN_ERROR);
    assert_eq!(all[0].1["taskId"], "task-1");
    assert!(all[0].1["error"].is_string());
}
