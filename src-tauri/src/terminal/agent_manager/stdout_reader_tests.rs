//! Tests for the desktop's agent-stdout reader (#4303, AGT2-001 / AGT2-003 /
//! DUP2-002).
//!
//! The end-to-end tests run against the in-process [`FakeAgentSshd`], which
//! writes its replies one byte per SSH data message, so every chunk boundary
//! falls inside a line and inside each multi-byte character.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::test::MockRuntime;
use termihub_core::backends::ssh::handler::SshSession;
use termihub_core::ipc::ndjson::{LineError, LineSplitter, MAX_LINE_LEN};
use tokio_util::sync::CancellationToken;

use super::super::fake_agent_sshd::{FakeAgentSshd, InitBehavior, SPLIT_AGENT_VERSION};
use super::super::{serialize_request, AgentConnectionManager};
use super::{frame, read_handshake_line, AgentReadError, Frame};
use crate::utils::ssh_auth::connect_and_authenticate_cancellable;

/// Ceiling for any one step against the loopback fake agent.
const STEP: Duration = Duration::from_secs(20);

/// Text mixing 2-, 3- and 4-byte UTF-8 characters.
const MULTIBYTE: &str = "Übersicht — €uro 😀 ok";

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

async fn open_session(server: &FakeAgentSshd) -> SshSession {
    let ssh_config = server.agent_config().to_ssh_config();
    tokio::task::spawn_blocking(move || {
        connect_and_authenticate_cancellable(&ssh_config, CancellationToken::new())
    })
    .await
    .expect("connect join")
    .expect("password auth to the fake agent")
}

/// An exec channel on `server` with `request` already written to it.
async fn channel_with_request(
    session: &SshSession,
    request: &str,
) -> russh::Channel<russh::client::Msg> {
    let channel = session.channel_open_session().await.expect("open channel");
    channel.exec(false, "termihub-agent").await.expect("exec");
    channel
        .data(request.as_bytes())
        .await
        .expect("write request");
    channel
}

// ── frame() ────────────────────────────────────────────────────────────────

#[test]
fn frame_trims_and_skips_blank_lines() {
    assert_eq!(
        frame("a", Ok("  {\"x\":1}\r".into())),
        Frame::Line("{\"x\":1}".into())
    );
    assert_eq!(frame("a", Ok("   ".into())), Frame::Skip);
}

#[test]
fn frame_drops_non_utf8_lines() {
    let bad = String::from_utf8(vec![0xff])
        .expect_err("invalid utf-8")
        .utf8_error();
    assert_eq!(frame("a", Err(LineError::InvalidUtf8(bad))), Frame::Skip);
}

#[test]
fn frame_treats_an_over_cap_line_as_fatal() {
    let err = LineError::TooLong { max_len: 8 };
    assert_eq!(
        frame("a", Err(err)),
        Frame::Fatal(AgentReadError::Frame(err))
    );
}

// ── read_handshake_line over a real russh channel ──────────────────────────

/// AGT2-001: a reply whose multi-byte characters are split across SSH data
/// messages decodes to exactly the text the agent sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_read_reassembles_multibyte_text_split_across_chunks() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let session = open_session(&server).await;
    let request = serialize_request(5, "fake.echo", json!({ "text": MULTIBYTE })).expect("req");
    let mut channel = channel_with_request(&session, &request).await;
    let mut lines = LineSplitter::new();

    let note = tokio::time::timeout(STEP, read_handshake_line(&mut channel, "a", &mut lines))
        .await
        .expect("note arrives")
        .expect("note line");
    let reply = tokio::time::timeout(STEP, read_handshake_line(&mut channel, "a", &mut lines))
        .await
        .expect("reply arrives")
        .expect("reply line");

    let note: serde_json::Value = serde_json::from_str(&note).expect("note json");
    let reply: serde_json::Value = serde_json::from_str(&reply).expect("reply json");
    assert_eq!(note["params"]["text"], MULTIBYTE);
    assert_eq!(reply["result"]["text"], MULTIBYTE);
    assert_eq!(reply["id"], 5);
}

/// AGT2-003: an agent that streams past the cap with no newline fails the read
/// with a typed frame error, and the reader never holds more than the cap.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_read_rejects_an_over_cap_line_with_bounded_memory() {
    const CAP: usize = 64 * 1024;
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let session = open_session(&server).await;
    let request = serialize_request(1, "fake.flood", json!({ "bytes": CAP * 8 })).expect("req");
    let mut channel = channel_with_request(&session, &request).await;
    let mut lines = LineSplitter::with_max_len(CAP);

    let outcome = tokio::time::timeout(STEP, read_handshake_line(&mut channel, "a", &mut lines))
        .await
        .expect("the read must fail rather than keep buffering");
    assert_eq!(
        outcome,
        Err(AgentReadError::Frame(LineError::TooLong { max_len: CAP }))
    );
    assert!(lines.buffered_len() <= CAP, "{}", lines.buffered_len());
}

// ── the real connect + steady-state I/O path ───────────────────────────────

fn new_manager(app: &tauri::App<MockRuntime>) -> Arc<AgentConnectionManager<MockRuntime>> {
    Arc::new(AgentConnectionManager::new(app.handle().clone()))
}

async fn connect(
    manager: &Arc<AgentConnectionManager<MockRuntime>>,
    server: &FakeAgentSshd,
) -> super::super::AgentConnectResult {
    let (m, cfg) = (manager.clone(), server.agent_config());
    tokio::time::timeout(
        STEP,
        tokio::task::spawn_blocking(move || m.connect_agent("agent-a", &cfg, None)),
    )
    .await
    .expect("connect settles")
    .expect("connect join")
    .expect("the fake agent connects")
}

async fn request(
    manager: &Arc<AgentConnectionManager<MockRuntime>>,
    method: &'static str,
    params: serde_json::Value,
) -> Result<serde_json::Value, crate::utils::errors::TerminalError> {
    let m = manager.clone();
    tokio::time::timeout(
        STEP,
        tokio::task::spawn_blocking(move || m.send_request("agent-a", method, params)),
    )
    .await
    .expect("request settles")
    .expect("request join")
}

/// AGT2-001 on the connect handshake: the `initialize` answer arrives one byte
/// per data message and its non-ASCII agent version survives intact.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_decodes_a_byte_split_initialize_answer() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::AnswerInOneByteChunks).await;
    let app = tauri::test::mock_app();
    let manager = new_manager(&app);

    let result = connect(&manager, &server).await;
    assert_eq!(result.agent_version, SPLIT_AGENT_VERSION);
    manager.disconnect_agent("agent-a").expect("disconnect");
}

/// AGT2-001 + DUP2-002 on the steady-state I/O loop: NDJSON keeps streaming
/// end to end — a notification and a response, both split one byte per data
/// message, several requests in a row — with multi-byte text intact.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn steady_state_streams_byte_split_ndjson_end_to_end() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let app = tauri::test::mock_app();
    let manager = new_manager(&app);
    connect(&manager, &server).await;

    for round in 0..3 {
        let params = json!({ "text": MULTIBYTE, "round": round });
        let result = request(&manager, "fake.echo", params.clone())
            .await
            .expect("echo answered");
        assert_eq!(result, params, "round {round}");
    }
    assert!(manager.is_connected("agent-a"));
    manager.disconnect_agent("agent-a").expect("disconnect");
}

/// AGT2-003 on the steady-state I/O loop: an agent that streams past the line
/// cap with no newline breaks the connection — the in-flight request fails —
/// instead of growing the desktop's buffer without bound.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn steady_state_tears_down_on_an_over_cap_line() {
    trust_all_host_keys();
    let server = FakeAgentSshd::serve(InitBehavior::Answer).await;
    let app = tauri::test::mock_app();
    let manager = new_manager(&app);
    connect(&manager, &server).await;

    let flood = json!({ "bytes": MAX_LINE_LEN + 64 * 1024 });
    let err = request(&manager, "fake.flood", flood)
        .await
        .expect_err("the flood never answers; the transport break fails the request");
    assert!(
        err.to_string().contains("connection lost"),
        "transport-loss error, got: {err}"
    );
    let _ = manager.disconnect_agent("agent-a");
}
