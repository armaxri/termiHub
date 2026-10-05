//! Ranged slices and queued transfers of agent-hosted sessions (#3587).
//!
//! An agent advertising `fileRanges` lets the session's file browser proxy
//! offer ranged access: `connection.files.read_range` / `write_range` under the
//! remote session id. The shared ranged executor then moves whole files through
//! it — checked here end to end against an agent double that applies the
//! protocol's rules to an in-memory file tree.

use std::collections::HashMap;

use base64::Engine;
use termihub_core::files::transfer::ranged::run_ranged_transfer;
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferRegistry, TransferStateTag, CHUNK_SIZE,
};
use termihub_core::files::RangedFileAccess;

use super::*;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn types_reply(type_id: &str) -> serde_json::Value {
    json!({
        "types": [{
            "typeId": type_id,
            "displayName": type_id,
            "icon": "terminal",
            "schema": {"groups": []},
            "capabilities": {
                "monitoring": false,
                "fileBrowser": true,
                "resize": true,
                "persistent": true
            }
        }]
    })
}

/// Mock agent with the given `sessionFiles` / `fileRanges` flags.
fn mock_agent(session_files: bool, file_ranges: bool) -> MockAgentRpcClient {
    let mut mock = MockAgentRpcClient::with_capabilities(types_reply("docker"));
    mock.session_files = Some(session_files);
    mock.file_ranges = Some(file_ranges);
    mock
}

async fn connected_proxy(mock: Arc<MockAgentRpcClient>) -> RemoteProxy {
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock);
    proxy
        .connect(json!({ "type": "docker", "config": {"image": "alpine"} }))
        .await
        .expect("connect should succeed");
    proxy
}

/// The proxy behind a connected session's file browser, owned.
fn owned_proxy(proxy: &RemoteProxy) -> Arc<RemoteFileBrowserProxy> {
    let browser = proxy.file_browser().expect("file browser");
    Arc::new(
        browser
            .as_any()
            .and_then(|any| any.downcast_ref::<RemoteFileBrowserProxy>())
            .expect("the agent proxy")
            .clone(),
    )
}

/// An agent double serving ranged slices, `stat` and `delete` from `files`
/// with the protocol's rules (a write must land at the current size).
fn serve_files(files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> Box<Responder> {
    Box::new(move |method, params| {
        let path = params["path"].as_str().unwrap_or_default().to_string();
        let mut files = files.lock().unwrap();
        let fail = |message: String| Some(Err(TerminalError::RemoteError(message)));
        match method {
            "connection.files.read_range" => {
                let Some(data) = files.get(&path) else {
                    return fail(format!("not found: {path}"));
                };
                let offset = params["offset"].as_u64().unwrap() as usize;
                let length = params["length"].as_u64().unwrap() as usize;
                let start = offset.min(data.len());
                let end = (start + length).min(data.len());
                Some(Ok(json!({
                    "data": B64.encode(&data[start..end]),
                    "eof": end - start < length,
                })))
            }
            "connection.files.write_range" => {
                let offset = params["offset"].as_u64().unwrap();
                let data = B64.decode(params["data"].as_str().unwrap()).unwrap();
                let file = files.entry(path.clone()).or_default();
                if offset == 0 {
                    file.clear();
                } else if file.len() as u64 != offset {
                    return fail(format!("{path}: holds {}, expected {offset}", file.len()));
                }
                file.extend_from_slice(&data);
                Some(Ok(json!({})))
            }
            "connection.files.stat" => match files.get(&path) {
                Some(data) => Some(Ok(json!({
                    "name": "f",
                    "path": path,
                    "isDirectory": false,
                    "size": data.len(),
                    "modified": "2026-10-05T12:00:00Z",
                    "permissions": null,
                    "writable": null
                }))),
                None => fail(format!("not found: {path}")),
            },
            "connection.files.delete" => {
                files.remove(&path);
                Some(Ok(json!({})))
            }
            _ => None,
        }
    })
}

fn contents(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn range_requests(mock: &MockAgentRpcClient) -> Vec<(String, serde_json::Value)> {
    mock.sent_requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m.ends_with("_range"))
        .cloned()
        .collect()
}

/// Ranged slices go to the agent under the remote session id, with the
/// protocol's snake_case params; the probe is a zero-length read.
#[tokio::test]
async fn ranged_slices_route_under_the_remote_session_id() {
    let mock = Arc::new(mock_agent(true, true));
    let mut proxy = connected_proxy(mock.clone()).await;
    let owned = owned_proxy(&proxy);
    assert!(owned.ranged().is_some(), "fileRanges agent offers ranges");

    let _ = owned.probe_ranges().await;
    let _ = owned.read_range("/srv/a", 7, 3).await;
    let _ = owned.write_range("/srv/b", 0, b"hi").await;

    let sent = range_requests(&mock);
    assert_eq!(
        sent,
        vec![
            (
                "connection.files.read_range".to_string(),
                json!({"connection_id": "mock-session-1", "path": "", "offset": 0, "length": 0})
            ),
            (
                "connection.files.read_range".to_string(),
                json!({"connection_id": "mock-session-1", "path": "/srv/a", "offset": 7, "length": 3})
            ),
            (
                "connection.files.write_range".to_string(),
                json!({"connection_id": "mock-session-1", "path": "/srv/b", "offset": 0,
                       "data": B64.encode(b"hi")})
            ),
        ]
    );
    proxy.disconnect().await.ok();
}

/// An agent without `fileRanges` (or one too old to browse the session at
/// all) offers no ranged access, so the session keeps the byte-based path.
#[tokio::test]
async fn ranges_need_the_agent_capability() {
    for (session_files, file_ranges) in [(true, false), (false, true), (false, false)] {
        let mock = Arc::new(mock_agent(session_files, file_ranges));
        let mut proxy = connected_proxy(mock.clone()).await;
        let browser = proxy.file_browser().expect("file browser");
        assert!(
            browser.ranged().is_none(),
            "sessionFiles={session_files} fileRanges={file_ranges}"
        );
        proxy.disconnect().await.ok();
    }
}

fn sink() -> ProgressSink {
    Arc::new(|_| {})
}

/// A whole download and upload run through the queue over the agent, chunk
/// by chunk, and arrive byte-exact.
#[tokio::test]
async fn queued_transfers_cross_the_agent_byte_exact() {
    let files = Arc::new(Mutex::new(HashMap::new()));
    let remote = contents(CHUNK_SIZE * 2 + 333);
    files
        .lock()
        .unwrap()
        .insert("/srv/down.bin".to_string(), remote.clone());
    let mut mock = mock_agent(true, true);
    mock.responder = Some(serve_files(files.clone()));
    let mock = Arc::new(mock);
    let mut proxy = connected_proxy(mock.clone()).await;
    let owned = owned_proxy(&proxy);
    let dir = tempfile::tempdir().unwrap();
    let registry = TransferRegistry::new();

    let local = dir.path().join("down.bin");
    let handle = registry.enqueue(
        "dl",
        "agent-session",
        TransferDirection::Download,
        "down.bin",
        "/srv/down.bin",
        0,
    );
    run_ranged_transfer(
        owned.clone(),
        TransferDirection::Download,
        "/srv/down.bin".into(),
        local.to_string_lossy().into_owned(),
        handle.clone(),
        registry.clone(),
        sink(),
        0,
    )
    .await;
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(std::fs::read(&local).unwrap(), remote);

    let upload = contents(CHUNK_SIZE * 3 + 1);
    let source = dir.path().join("up.bin");
    std::fs::write(&source, &upload).unwrap();
    let handle = registry.enqueue(
        "ul",
        "agent-session",
        TransferDirection::Upload,
        "up.bin",
        "/srv/up.bin",
        0,
    );
    run_ranged_transfer(
        owned,
        TransferDirection::Upload,
        "/srv/up.bin".into(),
        source.to_string_lossy().into_owned(),
        handle.clone(),
        registry,
        sink(),
        0,
    )
    .await;
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(files.lock().unwrap()["/srv/up.bin"], upload);
    // One write per chunk: the upload really was chunked.
    let writes = range_requests(&mock)
        .into_iter()
        .filter(|(m, _)| m == "connection.files.write_range")
        .count();
    assert_eq!(writes, 4);
    proxy.disconnect().await.ok();
}
