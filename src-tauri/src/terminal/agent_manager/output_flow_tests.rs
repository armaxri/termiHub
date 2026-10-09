//! Output flow control and lossless output delivery for agent-hosted sessions
//! (#4416), against the in-process [`FakeAgentSshd`] over the real connect and
//! steady-state I/O path.
//!
//! * The desktop forwards a terminal's pause/resume to an agent advertising
//!   `outputFlow` as `connection.output_flow`, in order.
//! * An older agent without the capability is never sent the method, and the
//!   call is a silent success.
//! * A flood of `connection.output` notifications reaches the session's output
//!   route complete and in order, even while nothing drains it.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::test::MockRuntime;

use super::fake_agent_sshd::{FakeAgentSshd, InitBehavior};
use super::{AgentConnectionManager, AgentRpcClient};
use termihub_core::protocol::methods::CONNECTION_OUTPUT_FLOW;

/// Ceiling for any one step against the loopback fake agent.
const STEP: Duration = Duration::from_secs(20);

const AGENT: &str = "agent-flow";

fn trust_all_host_keys() {
    use termihub_core::backends::ssh::host_key::{
        set_host_key_verifier, HostKeyInfo, HostKeyVerifier,
    };
    struct TrustAll;
    #[async_trait::async_trait]
    impl HostKeyVerifier for TrustAll {
        async fn verify(&self, _info: &HostKeyInfo) -> bool {
            true
        }
    }
    let _ = set_host_key_verifier(Arc::new(TrustAll));
}

async fn connected(
    behavior: InitBehavior,
) -> (
    FakeAgentSshd,
    tauri::App<MockRuntime>,
    Arc<AgentConnectionManager<MockRuntime>>,
) {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(behavior).await;
    let app = tauri::test::mock_app();
    let manager = Arc::new(AgentConnectionManager::new(app.handle().clone()));
    let (m, cfg) = (manager.clone(), server.agent_config());
    tokio::time::timeout(
        STEP,
        tokio::task::spawn_blocking(move || m.connect_agent(AGENT, &cfg, None)),
    )
    .await
    .expect("connect settles")
    .expect("connect join")
    .expect("the fake agent connects");
    (server, app, manager)
}

async fn request(
    manager: &Arc<AgentConnectionManager<MockRuntime>>,
    method: &'static str,
    params: serde_json::Value,
) -> serde_json::Value {
    let m = manager.clone();
    tokio::time::timeout(
        STEP,
        tokio::task::spawn_blocking(move || m.send_request(AGENT, method, params)),
    )
    .await
    .expect("request settles")
    .expect("request join")
    .expect("request answered")
}

/// Poll `cond` until it holds or [`STEP`] passes.
async fn eventually(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + STEP;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cond()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_and_resume_are_forwarded_to_a_flow_capable_agent() {
    let (server, _app, manager) = connected(InitBehavior::AnswerWithOutputFlow).await;
    assert!(manager.supports_output_flow(AGENT));

    manager
        .set_session_output_paused(AGENT, "remote-1", true)
        .expect("pause forwarded");
    manager
        .set_session_output_paused(AGENT, "remote-1", false)
        .expect("resume forwarded");

    assert!(
        eventually(|| server.requests_for(CONNECTION_OUTPUT_FLOW).len() == 2).await,
        "the agent must receive both flow requests, got {:?}",
        server.requests()
    );
    assert_eq!(
        server.requests_for(CONNECTION_OUTPUT_FLOW),
        vec![
            json!({ "session_id": "remote-1", "paused": true }),
            json!({ "session_id": "remote-1", "paused": false }),
        ],
        "pause and resume must arrive in order"
    );
    manager.disconnect_agent(AGENT).expect("disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_older_agent_is_never_sent_output_flow() {
    // A pre-0.27.0 agent does not advertise `outputFlow`: the desktop must not
    // send it a method it does not know, and the caller sees no error.
    let (server, _app, manager) = connected(InitBehavior::Answer).await;
    assert!(!manager.supports_output_flow(AGENT));

    manager
        .set_session_output_paused(AGENT, "remote-1", true)
        .expect("a silent no-op on an older agent");
    // A request after the (skipped) pause: once it is answered, anything the
    // pause had queued would have reached the agent first.
    request(&manager, "fake.echo", json!({ "sync": true })).await;

    assert!(
        server.requests_for(CONNECTION_OUTPUT_FLOW).is_empty(),
        "an older agent was sent connection.output_flow: {:?}",
        server.requests()
    );
    assert!(manager.is_connected(AGENT), "the connection stays healthy");
    manager.disconnect_agent(AGENT).expect("disconnect");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_output_flood_is_delivered_complete_and_in_order() {
    // Far more chunks than any bounded route would hold. Nothing drains the
    // route until the flood is over: a lossy (`try_send`) route dropped
    // everything past its capacity here.
    const CHUNKS: u64 = 600;
    const SIZE: u64 = 1024;
    let (_server, _app, manager) = connected(InitBehavior::Answer).await;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    manager
        .register_session_output(AGENT, "remote-flood", tx)
        .expect("route registered");

    // The answer is written after the last notification, so once it arrives
    // the I/O task has routed every chunk.
    request(
        &manager,
        "fake.output_flood",
        json!({ "session_id": "remote-flood", "chunks": CHUNKS, "size": SIZE }),
    )
    .await;

    let chunks: Vec<Vec<u8>> = rx.try_iter().collect();
    assert_eq!(chunks.len() as u64, CHUNKS, "output chunks were lost");
    for (i, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.len() as u64, SIZE, "chunk {i} truncated");
        assert!(
            chunk.iter().all(|b| *b == (i % 251) as u8),
            "chunk {i} out of order"
        );
    }
    manager.disconnect_agent(AGENT).expect("disconnect");
}
