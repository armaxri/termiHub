//! A crashed agent-hosted upload resumes from its checkpoint (#5736): an
//! agent advertising `fileTruncate` cuts the remote partial back through
//! `connection.files.truncate`, so the relaunched upload appends at the
//! checkpoint instead of sending the whole file again. Checked end to end
//! through the agent double, which applies the protocol's rules to an
//! in-memory file tree.

use std::collections::HashMap;

use termihub_core::files::transfer::ranged::{run_ranged_transfer, RangedTransferTarget};
use termihub_core::files::transfer::{
    ProgressSink, TransferDirection, TransferProgress, TransferRegistry, TransferStateTag,
    CHUNK_SIZE,
};
use termihub_core::files::FileBrowser;

use super::ranged_tests::{contents, mock_agent, owned_proxy, serve_files};
use super::*;

const REMOTE: &str = "/srv/up.bin";

/// An agent double serving `files` that also shortens them by the
/// protocol's rules: a missing file is "not found", a length past the end is
/// refused, and the reply carries the size afterwards — unless `report` says
/// otherwise, standing in for a backend whose trim did not take.
fn serve_truncate(
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    report: Option<u64>,
) -> Box<Responder> {
    let serve = serve_files(files.clone());
    Box::new(move |method, params| {
        if method != "connection.files.truncate" {
            return serve(method, params);
        }
        let path = params["path"].as_str().unwrap().to_string();
        let length = params["length"].as_u64().unwrap();
        let mut files = files.lock().unwrap();
        let Some(file) = files.get_mut(&path) else {
            return Some(Err(TerminalError::RemoteError(format!(
                "not found: {path}"
            ))));
        };
        if length > file.len() as u64 {
            return Some(Err(TerminalError::RemoteError(format!(
                "{path}: refusing to extend"
            ))));
        }
        file.truncate(length as usize);
        Some(Ok(json!({ "size": report.unwrap_or(file.len() as u64) })))
    })
}

/// A connected agent-hosted Docker session whose agent has `fileTruncate`
/// set as given, serving `files`.
async fn session(
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    file_truncate: bool,
    report: Option<u64>,
) -> (Arc<FakeAgent>, RemoteProxy) {
    let mut mock = mock_agent(true, true);
    mock.capabilities_mut().file_truncate = file_truncate;
    mock.responder = Some(serve_truncate(files, report));
    let mock = Arc::new(mock);
    let mut proxy = RemoteProxy::new("agent-1".to_string(), mock.clone());
    proxy
        .connect(json!({ "type": "docker", "config": {"image": "alpine"} }))
        .await
        .expect("connect should succeed");
    (mock, proxy)
}

/// What a relaunched upload did: its final state, the row messages, every
/// `write_range` offset and every `truncate` length the agent received.
struct Relaunched {
    state: TransferStateTag,
    messages: Vec<String>,
    write_offsets: Vec<u64>,
    truncates: Vec<u64>,
}

/// Relaunch an upload of `data` from `checkpoint` while the agent's remote
/// file holds `partial` — longer than the checkpoint, as after a crash.
async fn relaunch_upload(
    file_truncate: bool,
    report: Option<u64>,
    data: &[u8],
    partial: &[u8],
    checkpoint: u64,
) -> (Relaunched, Vec<u8>) {
    let files = Arc::new(Mutex::new(HashMap::new()));
    files
        .lock()
        .unwrap()
        .insert(REMOTE.to_string(), partial.to_vec());
    let (mock, mut proxy) = session(files.clone(), file_truncate, report).await;
    let target = owned_proxy(&proxy);

    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("up.bin");
    std::fs::write(&local, data).unwrap();
    let mtime = std::fs::metadata(&local)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "ul-relaunch",
        "agent-session",
        TransferDirection::Upload,
        "up.bin",
        REMOTE,
        data.len() as u64,
    );
    handle.set_source_mtime(Some(mtime));
    let messages = Arc::new(Mutex::new(Vec::new()));
    let rec = messages.clone();
    let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
        if let Some(m) = &p.message {
            rec.lock().unwrap().push(m.clone());
        }
    });
    mock.requests.lock().unwrap().clear();
    run_ranged_transfer(
        target,
        TransferDirection::Upload,
        REMOTE.into(),
        local.to_string_lossy().into_owned(),
        handle.clone(),
        registry,
        sink,
        checkpoint,
    )
    .await;

    let requests = mock.requests.lock().unwrap().clone();
    let of = |method: &str, field: &str| -> Vec<u64> {
        requests
            .iter()
            .filter(|(m, _)| m == method)
            .map(|(_, p)| p[field].as_u64().unwrap())
            .collect()
    };
    let relaunched = Relaunched {
        state: handle.state().tag(),
        messages: messages.lock().unwrap().clone(),
        write_offsets: of("connection.files.write_range", "offset"),
        truncates: of("connection.files.truncate", "length"),
    };
    let remote = files.lock().unwrap()[REMOTE].clone();
    proxy.disconnect().await.ok();
    (relaunched, remote)
}

/// The crash left the remote partial past the checkpoint. The agent trims it
/// back, and the upload resumes from the checkpoint and arrives byte-exact.
#[tokio::test]
async fn a_crashed_upload_trims_the_remote_partial_and_resumes() {
    let data = contents(CHUNK_SIZE * 3 + 9);
    let checkpoint = CHUNK_SIZE as u64;
    let partial = &data[..CHUNK_SIZE * 2 - 7];

    let (run, remote) = relaunch_upload(true, None, &data, partial, checkpoint).await;

    assert_eq!(run.state, TransferStateTag::Completed, "{:?}", run.messages);
    assert_eq!(remote, data, "byte-exact");
    assert_eq!(run.truncates, vec![checkpoint]);
    assert_eq!(
        run.write_offsets.first(),
        Some(&checkpoint),
        "resumed from the checkpoint, never from zero: {:?}",
        run.write_offsets
    );
    assert!(run.messages.is_empty(), "{:?}", run.messages);
}

/// An agent from before #5736 does not advertise `fileTruncate`: it is never
/// sent the method, and the upload restarts from zero with the row note.
#[tokio::test]
async fn an_older_agent_is_never_asked_and_the_upload_restarts() {
    let data = contents(CHUNK_SIZE * 3 + 9);
    let partial = &data[..CHUNK_SIZE * 2 - 7];

    let (run, remote) = relaunch_upload(false, None, &data, partial, CHUNK_SIZE as u64).await;

    assert_eq!(run.state, TransferStateTag::Completed);
    assert_eq!(remote, data, "byte-exact");
    assert!(run.truncates.is_empty(), "never asked");
    assert_eq!(run.write_offsets.first(), Some(&0));
    assert!(
        run.messages
            .iter()
            .any(|m| m.contains("past the last checkpoint and cannot be trimmed")),
        "{:?}",
        run.messages
    );
}

/// An agent that reports any size but the checkpoint after the trim fails
/// it: the upload restarts from zero rather than appending to a partial it
/// could not verify.
#[tokio::test]
async fn a_trim_reporting_the_wrong_size_restarts_the_upload() {
    let data = contents(CHUNK_SIZE * 3 + 9);
    let checkpoint = CHUNK_SIZE as u64;
    let partial = &data[..CHUNK_SIZE * 2 - 7];

    let (run, remote) =
        relaunch_upload(true, Some(checkpoint + 1), &data, partial, checkpoint).await;

    assert_eq!(run.state, TransferStateTag::Completed);
    assert_eq!(remote, data, "byte-exact");
    assert_eq!(run.truncates, vec![checkpoint]);
    assert_eq!(run.write_offsets.first(), Some(&0));
    assert!(
        run.messages
            .iter()
            .any(|m| m.contains("could not trim the remote partial")),
        "{:?}",
        run.messages
    );
}

/// The request carries the remote session id, the path and the length, in
/// the agent's snake_case, and an agent that lacks the method or a backend
/// that cannot shorten reads as "not supported".
#[tokio::test]
async fn truncate_requests_the_session_file_and_maps_not_supported() {
    let files = Arc::new(Mutex::new(HashMap::new()));
    files
        .lock()
        .unwrap()
        .insert(REMOTE.to_string(), b"0123456789".to_vec());
    let (mock, mut proxy) = session(files.clone(), true, None).await;
    let target = owned_proxy(&proxy);
    assert!(target.ranged().is_some());

    RangedTransferTarget::truncate(target.as_ref(), REMOTE, 4)
        .await
        .unwrap();
    assert_eq!(files.lock().unwrap()[REMOTE], b"0123");
    let sent = mock
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _)| m == "connection.files.truncate")
        .map(|(_, p)| p.clone())
        .unwrap();
    assert_eq!(
        sent,
        json!({ "connection_id": "mock-session-1", "path": REMOTE, "length": 4 })
    );

    mock.push(
        "connection.files.truncate",
        Step::error(|| TerminalError::AgentUnsupported("-32013".into())),
    );
    assert!(matches!(
        RangedTransferTarget::truncate(target.as_ref(), REMOTE, 0).await,
        Err(FileError::NotSupported)
    ));
    proxy.disconnect().await.ok();
}
