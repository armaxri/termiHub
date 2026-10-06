//! Browsing a graphical session's side channel (#4193): the agent host as a
//! [`FileBrowser`] (every request host-level), the registry, the session
//! layer's file facade resolving a graphical session id through it, and a
//! queued download (with progress and cancel) over the agent carrier against
//! an in-memory fake agent host. The SSH carrier's live run is the
//! Docker-gated `core/tests/vnc_file_channel.rs` (VNC-FT-04).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use termihub_core::files::transfer::registry::TransferRegistry;
use termihub_core::files::transfer::state::TransferStateTag;
use termihub_core::files::transfer::{ProgressSink, TransferDirection};
use termihub_core::protocol::methods::{CONNECTION_FILES_READ_RANGE, CONNECTION_FILES_STAT};
use tokio::sync::Mutex as AsyncMutex;

use super::*;
use crate::session::file_ops::FileOps;
use crate::session::graphical_upload::AgentRequests;
use crate::session::manager::SessionEntry;
use crate::utils::errors::TerminalError;

/// An in-memory agent host answering host-level `connection.files.*`.
#[derive(Default)]
struct FakeAgentHost {
    dirs: Mutex<Vec<String>>,
    files: Mutex<HashMap<String, Vec<u8>>>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl FakeAgentHost {
    fn new(dirs: &[&str], files: &[(&str, &[u8])]) -> Arc<Self> {
        let host = Self::default();
        host.dirs
            .lock()
            .unwrap()
            .extend(dirs.iter().map(|d| (*d).to_string()));
        for (path, data) in files {
            host.files
                .lock()
                .unwrap()
                .insert((*path).to_string(), data.to_vec());
        }
        Arc::new(host)
    }

    fn entry(&self, path: &str) -> Option<FileEntry> {
        let path = path.replacen('~', "/home/pi", 1);
        let name = path.rsplit('/').next().unwrap_or_default().to_string();
        if self.dirs.lock().unwrap().contains(&path) {
            return Some(FileEntry {
                name,
                path,
                is_directory: true,
                ..FileEntry::default()
            });
        }
        let size = self.files.lock().unwrap().get(&path)?.len() as u64;
        Some(FileEntry {
            name,
            path,
            size,
            modified: "2026-10-06T00:00:00Z".to_string(),
            ..FileEntry::default()
        })
    }

    fn children(&self, dir: &str) -> Vec<FileEntry> {
        let prefix = format!("{}/", dir.trim_end_matches('/'));
        let mut paths: Vec<String> = self
            .dirs
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .chain(self.files.lock().unwrap().keys().cloned())
            .filter(|p| {
                p.strip_prefix(&prefix)
                    .is_some_and(|rest| !rest.contains('/'))
            })
            .collect();
        paths.sort();
        paths.iter().filter_map(|p| self.entry(p)).collect()
    }

    fn methods(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|(m, _)| m.clone())
            .collect()
    }
}

impl AgentRequests for FakeAgentHost {
    fn request(&self, _agent_id: &str, method: &str, params: Value) -> Result<Value, String> {
        use base64::Engine;
        self.requests
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        let scoped = params
            .get("connection_id")
            .or_else(|| params.get("connectionId"))
            .is_some_and(|c| !c.is_null());
        if scoped {
            return Err("host-level request expected".to_string());
        }
        let path = params["path"].as_str().unwrap_or_default().to_string();
        let b64 = base64::engine::general_purpose::STANDARD;
        match method {
            CONNECTION_FILES_LIST => Ok(json!({ "entries": self.children(&path) })),
            CONNECTION_FILES_STAT => self
                .entry(&path)
                .map(|e| serde_json::to_value(e).unwrap())
                .ok_or_else(|| format!("{path}: not found")),
            CONNECTION_FILES_READ => {
                let data = self
                    .files
                    .lock()
                    .unwrap()
                    .get(&path)
                    .cloned()
                    .ok_or_else(|| format!("{path}: not found"))?;
                Ok(json!({ "data": b64.encode(&data), "size": data.len() }))
            }
            CONNECTION_FILES_READ_RANGE => {
                let offset = params["offset"].as_u64().unwrap_or_default() as usize;
                let len = params["length"].as_u64().unwrap_or_default() as usize;
                let file = self
                    .files
                    .lock()
                    .unwrap()
                    .get(&path)
                    .cloned()
                    .unwrap_or_default();
                let end = file.len().min(offset + len);
                let slice = file.get(offset.min(end)..end).unwrap_or_default();
                Ok(json!({ "data": b64.encode(slice), "eof": end == file.len() }))
            }
            CONNECTION_FILES_MKDIR => {
                self.dirs.lock().unwrap().push(path);
                Ok(json!({}))
            }
            CONNECTION_FILES_RENAME => {
                let from = params["old_path"].as_str().unwrap_or_default();
                let to = params["new_path"].as_str().unwrap_or_default();
                let mut files = self.files.lock().unwrap();
                let data = files
                    .remove(from)
                    .ok_or_else(|| format!("{from}: not found"))?;
                files.insert(to.to_string(), data);
                Ok(json!({}))
            }
            CONNECTION_FILES_DELETE => {
                self.files.lock().unwrap().remove(&path);
                Ok(json!({}))
            }
            other => Err(format!("unexpected method {other}")),
        }
    }
}

fn agent_carrier(host: &Arc<FakeAgentHost>) -> UploadCarrier {
    let requests: Arc<dyn AgentRequests> = host.clone();
    UploadCarrier::Agent(Arc::new(AgentHostFiles::new(
        "agent-1".to_string(),
        requests,
    )))
}

fn sample_host() -> Arc<FakeAgentHost> {
    FakeAgentHost::new(
        &["/home/pi", "/home/pi/Desktop", "/home/pi/Desktop/photos"],
        &[
            ("/home/pi/Desktop/report.pdf", b"%PDF-1.7 report"),
            ("/home/pi/Desktop/notes.md", b"notes"),
        ],
    )
}

// ── The agent host as a FileBrowser ─────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_host_browses_the_host_file_system_without_a_connection_id() {
    let host = sample_host();
    let browser = agent_carrier(&host).file_browser();

    let listing = browser.list_dir("/home/pi/Desktop").await.unwrap();
    let names: Vec<_> = listing.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["notes.md", "photos", "report.pdf"]);
    assert!(listing[1].is_directory);

    assert_eq!(
        browser
            .read_file("/home/pi/Desktop/notes.md")
            .await
            .unwrap(),
        b"notes"
    );
    assert_eq!(
        browser
            .stat("/home/pi/Desktop/report.pdf")
            .await
            .unwrap()
            .size,
        15
    );
    browser.mkdir("/home/pi/Desktop/new").await.unwrap();
    browser
        .rename("/home/pi/Desktop/notes.md", "/home/pi/Desktop/notes-old.md")
        .await
        .unwrap();
    browser.delete("/home/pi/Desktop/report.pdf").await.unwrap();
    assert!(browser.stat("/home/pi/Desktop/report.pdf").await.is_err());
    assert!(browser.ranged().is_some(), "queued downloads need slices");

    // Every request was host-level: the fake refuses a scoped one.
    assert_eq!(
        host.methods(),
        [
            CONNECTION_FILES_LIST,
            CONNECTION_FILES_READ,
            CONNECTION_FILES_STAT,
            CONNECTION_FILES_MKDIR,
            CONNECTION_FILES_RENAME,
            CONNECTION_FILES_DELETE,
            CONNECTION_FILES_STAT,
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_host_reports_the_agent_error() {
    let host = sample_host();
    let read = agent_carrier(&host)
        .file_browser()
        .read_file("/nope")
        .await
        .unwrap_err();
    assert!(read.to_string().contains("not found"), "{read}");
}

// ── Registry ────────────────────────────────────────────────────────

#[test]
fn side_channels_register_replace_and_remove() {
    let host = sample_host();
    let side = SideChannelBrowsers::default();
    assert!(side.get("rd-1").is_none());
    side.register("rd-1", agent_carrier(&host));
    assert!(side.get("rd-1").and_then(|c| c.agent()).is_some());
    assert!(!matches!(side.get("rd-1"), Some(UploadCarrier::Sftp(_))));
    // Opening again replaces (a reconnect's new route).
    side.register("rd-1", agent_carrier(&host));
    assert!(side.remove("rd-1"));
    assert!(!side.remove("rd-1"));
    assert!(side.get("rd-1").is_none());
}

// ── The session facade resolves a graphical session id ──────────────

type Map = Arc<AsyncMutex<HashMap<String, SessionEntry>>>;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_ops_resolve_a_graphical_session_through_its_side_channel() {
    let host = sample_host();
    let sessions: Map = Arc::new(AsyncMutex::new(HashMap::new()));
    let side = SideChannelBrowsers::default();
    side.register("rd-1", agent_carrier(&host));
    let ops = FileOps::new(&sessions).with_side_channels(&side);

    let listing = ops.list_dir("rd-1", "/home/pi/Desktop").await.unwrap();
    assert_eq!(listing.len(), 3);
    let entry = ops.stat("rd-1", "/home/pi/Desktop/notes.md").await.unwrap();
    assert_eq!(entry.size, 5);

    // A different id, or the same id once closed, is an unknown session.
    assert!(matches!(
        ops.list_dir("rd-2", "/").await,
        Err(TerminalError::SessionNotFound(_))
    ));
    side.remove("rd-1");
    assert!(matches!(
        ops.list_dir("rd-1", "/").await,
        Err(TerminalError::SessionNotFound(_))
    ));
    // Without the registry the facade never sees side channels.
    side.register("rd-1", agent_carrier(&host));
    assert!(matches!(
        FileOps::new(&sessions).list_dir("rd-1", "/").await,
        Err(TerminalError::SessionNotFound(_))
    ));
}

#[tokio::test]
async fn an_agent_side_channel_is_not_an_sftp_session() {
    let host = sample_host();
    let sessions: Map = Arc::new(AsyncMutex::new(HashMap::new()));
    let side = SideChannelBrowsers::default();
    side.register("rd-1", agent_carrier(&host));
    let ops = FileOps::new(&sessions).with_side_channels(&side);
    // SFTP-only extras (VS Code open, chmod via SFTP) are refused cleanly.
    assert!(matches!(
        ops.sftp_browser("rd-1").await,
        Err(TerminalError::RemoteError(_))
    ));
}

// ── Queued download over the agent carrier ──────────────────────────

fn quiet_sink() -> ProgressSink {
    Arc::new(|_: &termihub_core::files::transfer::TransferProgress| {})
}

async fn settled(registry: &TransferRegistry, id: &str) -> TransferStateTag {
    for _ in 0..250 {
        if let Some(snap) = registry
            .list(None)
            .into_iter()
            .find(|s| s.transfer_id == id)
        {
            if snap.state.is_terminal() {
                return snap.state;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("transfer {id} did not settle");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_side_channel_downloads_through_the_queue_in_slices() {
    let big: Vec<u8> = (0..(700 * 1024)).map(|i| (i % 253) as u8).collect();
    let host = FakeAgentHost::new(&["/home/pi"], &[("/home/pi/big.bin", &big)]);
    let files = agent_carrier(&host).agent().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("big.bin");

    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "dl-1",
        "rd-1",
        TransferDirection::Download,
        "big.bin",
        "/home/pi/big.bin",
        0,
    );
    let progress = Arc::new(Mutex::new(Vec::new()));
    let seen = progress.clone();
    let sink: ProgressSink = Arc::new(
        move |p: &termihub_core::files::transfer::TransferProgress| {
            seen.lock().unwrap().push(p.transferred);
        },
    );
    termihub_core::files::transfer::ranged::run_ranged_transfer(
        files,
        TransferDirection::Download,
        "/home/pi/big.bin".to_string(),
        local.to_string_lossy().into_owned(),
        handle,
        registry.clone(),
        sink,
        0,
    )
    .await;

    assert_eq!(
        settled(&registry, "dl-1").await,
        TransferStateTag::Completed
    );
    assert_eq!(std::fs::read(&local).unwrap(), big);
    let reads = host
        .methods()
        .iter()
        .filter(|m| *m == CONNECTION_FILES_READ_RANGE)
        .count();
    assert!(reads >= 3, "700 KiB must take several slices, got {reads}");
    assert!(
        progress.lock().unwrap().len() >= 2,
        "the queue row shows progress"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_side_channel_download_stops() {
    let host = FakeAgentHost::new(&["/home/pi"], &[("/home/pi/a.bin", &[7u8; 4096])]);
    let files = agent_carrier(&host).agent().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "dl-2",
        "rd-1",
        TransferDirection::Download,
        "a.bin",
        "/home/pi/a.bin",
        0,
    );
    // Cancelled before it starts (the session closed, or the user's cancel).
    assert_eq!(
        crate::session::graphical_upload::cancel_session_transfers(&registry, "rd-1"),
        1
    );
    termihub_core::files::transfer::ranged::run_ranged_transfer(
        files,
        TransferDirection::Download,
        "/home/pi/a.bin".to_string(),
        tmp.path().join("a.bin").to_string_lossy().into_owned(),
        handle,
        registry.clone(),
        quiet_sink(),
        0,
    )
    .await;
    assert_eq!(
        settled(&registry, "dl-2").await,
        TransferStateTag::Cancelled
    );
}
