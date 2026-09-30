//! Tests for the FTP executor's resume and relaunch-after-restart (#3206).
//!
//! They drive [`run_ftp_transfer`] with a real `suppaftp` client against the
//! in-process mock server ([`MockFtpServer`]), so each server shape the resume
//! logic must handle — `REST STREAM` and `MDTM` advertised, no `REST`, no
//! `MDTM`, no `FEAT` at all — is exercised without the Docker fixture. A
//! relaunch is reproduced the way the desktop does it: the handle is
//! registered with the persisted total and seeded with the persisted source
//! mtime, and the executor is started from the persisted resume offset.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use super::*;
use crate::backends::ftp::mock_server::{MockFtpOptions, MockFtpServer, MockTransfer};
use crate::backends::ftp::FtpServerCaps;
use crate::files::transfer::{TransferDirection, TransferProgress, TransferStateTag, CHUNK_SIZE};

const REMOTE: &str = "/pub/data.bin";
/// `MDTM` timestamp of the source, and the same instant in Unix seconds.
const MTIME: &str = "20240101120000";
const MTIME_SECS: u64 = 1_704_110_400;
/// A later `MDTM`: the source was rewritten while the app was closed.
const LATER_MTIME: &str = "20240101120500";

/// Deterministic, non-repeating-per-chunk test content.
fn content(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A sink recording every emitted progress event.
fn recording_sink() -> (ProgressSink, Arc<Mutex<Vec<TransferProgress>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let rec = events.clone();
    let sink: ProgressSink = Arc::new(move |p: &TransferProgress| {
        rec.lock().expect("lock").push(p.clone());
    });
    (sink, events)
}

fn messages(events: &Arc<Mutex<Vec<TransferProgress>>>) -> Vec<String> {
    events
        .lock()
        .expect("lock")
        .iter()
        .filter_map(|p| p.message.clone())
        .collect()
}

/// Register a transfer the way a relaunch does: with the persisted total, and
/// seeded with the persisted source mtime.
fn relaunch_handle(
    reg: &TransferRegistry,
    id: &str,
    direction: TransferDirection,
    total: u64,
    persisted_mtime: Option<u64>,
) -> Arc<TransferHandle> {
    let handle = reg.enqueue(id, "ftp-session", direction, "data.bin", REMOTE, total);
    handle.set_source_mtime(persisted_mtime);
    handle
}

fn retr(offset: u64) -> MockTransfer {
    MockTransfer {
        command: "RETR",
        path: REMOTE.to_string(),
        offset,
    }
}

fn stor(offset: u64) -> MockTransfer {
    MockTransfer {
        command: "STOR",
        path: REMOTE.to_string(),
        offset,
    }
}

/// The local file's mtime as the executor's local fingerprint reports it.
fn local_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_nanos()).ok())
}

/// A download relaunched from its checkpoint: a mock server with `options`
/// serving `served` (at `mtime`), a local partial holding `partial`, and a
/// handle carrying the persisted `total` / `persisted_mtime`. Returns the
/// server, the final local bytes, the handle and the recorded events.
async fn relaunch_download(
    options: MockFtpOptions,
    served: &[u8],
    mtime: &str,
    partial: &[u8],
    total: u64,
    persisted_mtime: Option<u64>,
) -> (
    MockFtpServer,
    Vec<u8>,
    Arc<TransferHandle>,
    Arc<Mutex<Vec<TransferProgress>>>,
) {
    let server = MockFtpServer::start(options).await;
    server.put(REMOTE, served, mtime);
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");
    std::fs::write(&local, partial).expect("seed partial");
    let reg = TransferRegistry::new();
    let handle = relaunch_handle(
        &reg,
        "ftp-dl",
        TransferDirection::Download,
        total,
        persisted_mtime,
    );
    let (sink, events) = recording_sink();

    run_ftp_transfer(
        server.config(),
        FtpDirection::Download,
        REMOTE.to_string(),
        s(&local),
        handle.clone(),
        reg,
        sink,
        partial.len() as u64,
    )
    .await;

    let landed = std::fs::read(&local).expect("read download");
    (server, landed, handle, events)
}

// --- Capability detection (FEAT) ---

#[test]
fn caps_from_features_detect_rest_stream_and_mdtm() {
    let mut features: HashMap<String, Option<String>> = HashMap::new();
    features.insert("SIZE".to_string(), None);
    features.insert("MDTM".to_string(), None);
    features.insert("REST".to_string(), Some("STREAM".to_string()));
    let caps = FtpServerCaps::from_features(&features);
    assert!(caps.rest_stream && caps.mdtm);
    assert!(caps.may_resume() && caps.may_query_mtime());

    // Feature names and values are case-insensitive.
    let mut lower: HashMap<String, Option<String>> = HashMap::new();
    lower.insert("rest".to_string(), Some("stream".to_string()));
    lower.insert("mdtm".to_string(), None);
    let caps = FtpServerCaps::from_features(&lower);
    assert!(caps.rest_stream && caps.mdtm);
}

#[test]
fn caps_without_rest_stream_or_mdtm_refuse_resume_and_mtime() {
    let mut features: HashMap<String, Option<String>> = HashMap::new();
    features.insert("SIZE".to_string(), None);
    // A bare `REST` without the STREAM mode is not the restart we need.
    features.insert("REST".to_string(), None);
    let caps = FtpServerCaps::from_features(&features);
    assert!(!caps.rest_stream && !caps.mdtm);
    assert!(!caps.may_resume(), "FEAT answered without REST STREAM");
    assert!(!caps.may_query_mtime(), "FEAT answered without MDTM");
}

/// A server that does not answer FEAT (a legacy server) advertises nothing,
/// so both are tried and any rejection falls back safely.
#[test]
fn unknown_caps_try_resume_and_mtime() {
    let caps = FtpServerCaps::unknown();
    assert!(caps.may_resume() && caps.may_query_mtime());
}

// --- Download relaunch ---

/// REST and MDTM advertised, source unchanged (same size and mtime): the
/// relaunch resumes from the checkpoint with `REST` and only the tail moves.
#[tokio::test]
async fn download_relaunch_resumes_via_rest_when_rest_and_mdtm_are_supported() {
    let data = content(CHUNK_SIZE * 3 + 17);
    let offset = CHUNK_SIZE + 100;
    let (server, landed, handle, _events) = relaunch_download(
        MockFtpOptions::default(),
        &data,
        MTIME,
        &data[..offset],
        data.len() as u64,
        Some(MTIME_SECS),
    )
    .await;

    assert_eq!(landed, data, "byte-exact after the resume");
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(
        server.transfers(),
        vec![retr(offset as u64)],
        "resumed from the checkpoint via REST, never from zero"
    );
    assert_eq!(
        handle.source_mtime(),
        Some(MTIME_SECS),
        "MDTM → Unix seconds"
    );
}

/// Same size but a new MDTM: the source was rewritten while the app was
/// closed, so the relaunch restarts from zero instead of splicing versions.
#[tokio::test]
async fn download_relaunch_restarts_when_source_mtime_changed() {
    let data = content(CHUNK_SIZE * 2 + 5);
    let offset = CHUNK_SIZE;
    // The partial holds bytes of the old version.
    let stale = vec![0xAA_u8; offset];
    let (server, landed, handle, _events) = relaunch_download(
        MockFtpOptions::default(),
        &data,
        LATER_MTIME,
        &stale,
        data.len() as u64,
        Some(MTIME_SECS),
    )
    .await;

    assert_eq!(landed, data, "the new version, not a splice");
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(server.transfers(), vec![retr(0)]);
    assert_eq!(server.rest_commands(), 0);
    assert_eq!(handle.source_mtime(), Some(MTIME_SECS + 300));
}

/// The server does not advertise `REST STREAM`: the relaunch restarts from
/// zero (never even sending `REST`) and says why.
#[tokio::test]
async fn download_relaunch_restarts_from_zero_when_rest_is_unsupported() {
    let data = content(CHUNK_SIZE * 2 + 5);
    let offset = CHUNK_SIZE;
    let (server, landed, handle, events) = relaunch_download(
        MockFtpOptions {
            rest: false,
            ..MockFtpOptions::default()
        },
        &data,
        MTIME,
        &data[..offset],
        data.len() as u64,
        Some(MTIME_SECS),
    )
    .await;

    assert_eq!(landed, data);
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(server.transfers(), vec![retr(0)]);
    assert_eq!(server.rest_commands(), 0, "REST is not attempted");
    assert!(
        messages(&events)
            .iter()
            .any(|m| m.contains("resume not supported")),
        "the restart is surfaced: {:?}",
        messages(&events)
    );
}

/// No MDTM: only the size can be compared. An unchanged size resumes (an
/// unverified, size-only resume) and no mtime is recorded.
#[tokio::test]
async fn download_relaunch_without_mdtm_falls_back_to_size_only() {
    let data = content(CHUNK_SIZE * 2 + 5);
    let offset = CHUNK_SIZE + 3;
    let no_mdtm = MockFtpOptions {
        mdtm: false,
        ..MockFtpOptions::default()
    };
    let (server, landed, handle, _events) = relaunch_download(
        no_mdtm,
        &data,
        MTIME,
        &data[..offset],
        data.len() as u64,
        Some(MTIME_SECS),
    )
    .await;

    assert_eq!(landed, data);
    assert_eq!(server.transfers(), vec![retr(offset as u64)]);
    assert_eq!(handle.source_mtime(), None, "no mtime to persist");

    // A size change is still caught without an mtime.
    let grown = content(CHUNK_SIZE * 2 + 50);
    let (server, landed, _handle, _events) = relaunch_download(
        no_mdtm,
        &grown,
        MTIME,
        &grown[..offset],
        data.len() as u64,
        None,
    )
    .await;
    assert_eq!(landed, grown);
    assert_eq!(server.transfers(), vec![retr(0)]);
}

/// A legacy server that does not answer FEAT but does honour REST: the resume
/// is attempted and succeeds.
#[tokio::test]
async fn download_relaunch_without_feat_still_tries_rest() {
    let data = content(CHUNK_SIZE * 2 + 5);
    let offset = CHUNK_SIZE;
    let (server, landed, _handle, _events) = relaunch_download(
        MockFtpOptions {
            feat: false,
            ..MockFtpOptions::default()
        },
        &data,
        MTIME,
        &data[..offset],
        data.len() as u64,
        Some(MTIME_SECS),
    )
    .await;

    assert_eq!(landed, data);
    assert_eq!(server.transfers(), vec![retr(offset as u64)]);
}

/// A legacy server that answers neither FEAT nor REST: the rejected REST
/// falls back to a restart from zero rather than failing the transfer.
#[tokio::test]
async fn download_relaunch_restarts_when_rest_is_rejected() {
    let data = content(CHUNK_SIZE * 2 + 5);
    let offset = CHUNK_SIZE;
    let (server, landed, handle, _events) = relaunch_download(
        MockFtpOptions {
            feat: false,
            rest: false,
            mdtm: false,
        },
        &data,
        MTIME,
        &data[..offset],
        data.len() as u64,
        None,
    )
    .await;

    assert_eq!(landed, data);
    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(server.rest_commands(), 1, "REST was tried once");
    assert_eq!(server.transfers(), vec![retr(0)]);
}

/// A fresh transfer records the source mtime on the handle so the first
/// checkpoint persists it.
#[tokio::test]
async fn fresh_download_records_the_source_mtime() {
    let data = content(CHUNK_SIZE + 9);
    let (server, landed, handle, _events) =
        relaunch_download(MockFtpOptions::default(), &data, MTIME, &[], 0, None).await;

    assert_eq!(landed, data);
    assert_eq!(server.transfers(), vec![retr(0)]);
    assert_eq!(handle.source_mtime(), Some(MTIME_SECS));
}

// --- Upload relaunch ---

/// An upload relaunched from its checkpoint: `server` holds `remote_partial`,
/// the local source holds `data`. Returns the handle and events.
async fn relaunch_upload(
    server: &MockFtpServer,
    data: &[u8],
    remote_partial: &[u8],
) -> (Arc<TransferHandle>, Arc<Mutex<Vec<TransferProgress>>>) {
    server.put(REMOTE, remote_partial, MTIME);
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("data.bin");
    std::fs::write(&local, data).expect("seed source");
    let reg = TransferRegistry::new();
    let handle = relaunch_handle(
        &reg,
        "ftp-ul",
        TransferDirection::Upload,
        data.len() as u64,
        local_mtime(&local),
    );
    let (sink, events) = recording_sink();

    run_ftp_transfer(
        server.config(),
        FtpDirection::Upload,
        REMOTE.to_string(),
        s(&local),
        handle.clone(),
        reg,
        sink,
        remote_partial.len() as u64,
    )
    .await;
    (handle, events)
}

#[tokio::test]
async fn upload_relaunch_resumes_via_rest_when_supported() {
    let server = MockFtpServer::start(MockFtpOptions::default()).await;
    let data = content(CHUNK_SIZE * 3 + 1);
    let offset = CHUNK_SIZE * 2;
    let (handle, _events) = relaunch_upload(&server, &data, &data[..offset]).await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(server.get(REMOTE).expect("uploaded"), data);
    assert_eq!(server.transfers(), vec![stor(offset as u64)]);
}

#[tokio::test]
async fn upload_relaunch_restarts_from_zero_when_rest_is_unsupported() {
    let server = MockFtpServer::start(MockFtpOptions {
        rest: false,
        ..MockFtpOptions::default()
    })
    .await;
    let data = content(CHUNK_SIZE * 2 + 1);
    let offset = CHUNK_SIZE;
    let (handle, _events) = relaunch_upload(&server, &data, &data[..offset]).await;

    assert_eq!(handle.state().tag(), TransferStateTag::Completed);
    assert_eq!(server.get(REMOTE).expect("uploaded"), data);
    assert_eq!(server.transfers(), vec![stor(0)]);
    assert_eq!(server.rest_commands(), 0);
}

// --- A folder path handed to a download (#3944) ---

/// A download of a folder path fails: `RETR` on a directory is refused (a real
/// server answers `550`, like the mock for a path that is not a file), so the
/// transfer ends `Failed` after its retries and never lands any content. The
/// executor has already created the local file by then, so an empty file can be
/// left at the chosen path. That is why `session_download` refuses a folder up
/// front and the frontend copies folders file by file (#3944).
#[tokio::test]
async fn download_of_a_folder_path_fails_and_lands_no_content() {
    let server = MockFtpServer::start(MockFtpOptions::default()).await;
    server.put("/pub/inner.bin", &content(64), MTIME);
    let dir = tempfile::tempdir().expect("tempdir");
    let local = dir.path().join("pub");
    let reg = TransferRegistry::new();
    let handle = reg.enqueue(
        "ftp-dir",
        "ftp-session",
        TransferDirection::Download,
        "pub",
        "/pub",
        0,
    );
    let (sink, _events) = recording_sink();

    run_ftp_transfer(
        server.config(),
        FtpDirection::Download,
        "/pub".to_string(),
        s(&local),
        handle.clone(),
        reg,
        sink,
        0,
    )
    .await;

    assert_eq!(handle.state().tag(), TransferStateTag::Failed);
    assert!(server.transfers().is_empty(), "no RETR ever streamed data");
    let landed = std::fs::read(&local).unwrap_or_default();
    assert!(landed.is_empty(), "a folder download must not land content");
}
