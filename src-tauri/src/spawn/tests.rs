//! Unit tests for the spawn core (#1364).
//!
//! Covers serde round-tripping of the wire types, CLI argument parsing,
//! pre-init subcommand classification, and the IPC transport. The transport is
//! exercised two ways: over an in-memory `tokio::io::duplex` pair (runs on every
//! platform) and over the real platform socket / named pipe.

use std::sync::{Arc, Mutex};

use super::{ipc_client, ipc_server};
use super::{
    classify_command, parse_spawn_args, set_pending, take_pending, Command, SpawnEndpoint,
    SpawnHandler, SpawnRequest, SpawnResponse, SpawnStatus,
};

fn full_request() -> SpawnRequest {
    SpawnRequest {
        location: Some("/home/user/projects/myapp".to_string()),
        entry_id: Some("entry-1".to_string()),
        connection: Some("conn-42".to_string()),
        new_window: true,
        pick: true,
        container_image: Some("ubuntu:22.04".to_string()),
        container_mount: Some("/workspace".to_string()),
    }
}

// ── serde round-trips ────────────────────────────────────────────────────

#[test]
fn spawn_request_serde_round_trip() {
    let req = full_request();
    let json = serde_json::to_string(&req).expect("serialize");
    // Newline-delimited framing requires each message to be a single line.
    assert!(!json.contains('\n'), "framing requires single-line JSON");
    let back: SpawnRequest = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(req, back);
}

#[test]
fn spawn_request_minimal_defaults() {
    let back: SpawnRequest = serde_json::from_str("{}").expect("deserialize empty object");
    assert_eq!(back, SpawnRequest::default());
}

#[test]
fn spawn_status_serializes_snake_case() {
    assert_eq!(
        serde_json::to_string(&SpawnStatus::Accepted).expect("serialize"),
        "\"accepted\""
    );
    assert_eq!(
        serde_json::to_string(&SpawnStatus::Error).expect("serialize"),
        "\"error\""
    );
}

#[test]
fn spawn_response_round_trip() {
    let resp = SpawnResponse::error("boom");
    let json = serde_json::to_string(&resp).expect("serialize");
    let back: SpawnResponse = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(resp, back);
    assert_eq!(back.status, SpawnStatus::Error);
    assert_eq!(back.message.as_deref(), Some("boom"));
}

// ── CLI parsing ──────────────────────────────────────────────────────────

fn to_args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

#[test]
fn parse_spawn_args_full() {
    let args = to_args(&[
        "--location",
        "/p",
        "--entry-id",
        "e",
        "--connection",
        "c",
        "--new-window",
        "--pick",
        "--container-image",
        "img",
        "--container-mount",
        "/mnt",
    ]);
    let req = parse_spawn_args(&args);
    assert_eq!(req.location.as_deref(), Some("/p"));
    assert_eq!(req.entry_id.as_deref(), Some("e"));
    assert_eq!(req.connection.as_deref(), Some("c"));
    assert!(req.new_window);
    assert!(req.pick);
    assert_eq!(req.container_image.as_deref(), Some("img"));
    assert_eq!(req.container_mount.as_deref(), Some("/mnt"));
}

#[test]
fn parse_spawn_args_equals_form_and_unknown_ignored() {
    let args = to_args(&["--location=/a b", "--unknown", "x", "--pick"]);
    let req = parse_spawn_args(&args);
    assert_eq!(req.location.as_deref(), Some("/a b"));
    assert!(req.pick);
    assert!(!req.new_window);
}

#[test]
fn parse_spawn_args_flag_without_value_is_none() {
    let args = to_args(&["--location"]);
    let req = parse_spawn_args(&args);
    assert_eq!(req.location, None);
}

// ── pre-init classification ──────────────────────────────────────────────

#[test]
fn classify_spawn_command() {
    let args = to_args(&["spawn", "--location", "/p"]);
    match classify_command(&args) {
        Command::Spawn(req) => assert_eq!(req.location.as_deref(), Some("/p")),
        other => panic!("expected spawn, got {other:?}"),
    }
}

#[test]
fn classify_shell_integration_and_none() {
    assert_eq!(
        classify_command(&to_args(&["install-shell-integration"])),
        Command::InstallShellIntegration
    );
    assert_eq!(
        classify_command(&to_args(&["uninstall-shell-integration"])),
        Command::UninstallShellIntegration
    );
    assert_eq!(
        classify_command(&to_args(&["--workspace", "w"])),
        Command::None
    );
    assert_eq!(classify_command(&[]), Command::None);
}

// ── pending request store ────────────────────────────────────────────────

#[test]
fn pending_spawn_set_and_take() {
    let req = SpawnRequest {
        location: Some("/z".to_string()),
        ..Default::default()
    };
    set_pending(req.clone());
    assert_eq!(take_pending(), Some(req));
    assert_eq!(take_pending(), None);
}

// ── transport over an in-memory duplex (all platforms) ───────────────────

#[tokio::test]
async fn transport_round_trips_over_duplex() {
    let (server_io, client_io) = tokio::io::duplex(4096);
    let req = full_request();
    let expected = req.clone();
    let handler: SpawnHandler = Arc::new(move |got| {
        assert_eq!(got, expected);
        SpawnResponse::accepted()
    });
    let server =
        tokio::spawn(async move { ipc_server::serve_connection(server_io, &handler).await });
    let resp = ipc_client::exchange(client_io, &req)
        .await
        .expect("exchange");
    assert_eq!(resp.status, SpawnStatus::Accepted);
    server.await.expect("join").expect("serve connection");
}

#[tokio::test]
async fn transport_rejects_invalid_request() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (server_io, client_io) = tokio::io::duplex(4096);
    let handler: SpawnHandler = Arc::new(|_| SpawnResponse::accepted());
    tokio::spawn(async move {
        let _ = ipc_server::serve_connection(server_io, &handler).await;
    });

    let (reader, mut writer) = tokio::io::split(client_io);
    writer
        .write_all(b"this is not json\n")
        .await
        .expect("write garbage");
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    reader.read_line(&mut line).await.expect("read response");
    let resp: SpawnResponse = serde_json::from_str(line.trim()).expect("parse response");
    assert_eq!(resp.status, SpawnStatus::Error);
}

// ── transport over the real platform socket / named pipe ─────────────────

async fn send_with_retry(endpoint: &SpawnEndpoint, req: &SpawnRequest) -> SpawnResponse {
    for _ in 0..100 {
        match ipc_client::send(endpoint, req).await {
            Ok(resp) => return resp,
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
        }
    }
    panic!("could not reach spawn server");
}

#[tokio::test]
async fn ipc_server_client_round_trip() {
    let endpoint = SpawnEndpoint::for_test("roundtrip");
    let received: Arc<Mutex<Option<SpawnRequest>>> = Arc::new(Mutex::new(None));
    let recv = received.clone();
    let handler: SpawnHandler = Arc::new(move |req| {
        *recv.lock().expect("lock") = Some(req);
        SpawnResponse::accepted()
    });

    let server_ep = endpoint.clone();
    let server = tokio::spawn(async move {
        let _ = ipc_server::serve(&server_ep, handler).await;
    });

    let req = SpawnRequest {
        location: Some("/home/u/proj".to_string()),
        new_window: true,
        ..Default::default()
    };
    let resp = send_with_retry(&endpoint, &req).await;
    assert_eq!(resp.status, SpawnStatus::Accepted);
    assert_eq!(received.lock().expect("lock").clone(), Some(req));

    server.abort();
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(endpoint.address());
    }
}
