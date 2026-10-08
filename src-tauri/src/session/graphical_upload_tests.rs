//! Uploads to a graphical session's side channel (#4192): keep-both naming,
//! the local walk (recursive, no link following), placement on the file host,
//! and the agent carrier driving real queued uploads against an in-memory fake
//! agent host. The SSH carrier's live run is the Docker-gated
//! `core/tests/vnc_file_channel.rs` (VNC-FT-04).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use termihub_core::files::transfer::state::TransferStateTag;

use super::*;

// ── Keep-both naming ────────────────────────────────────────────────

#[test]
fn numbered_name_puts_the_number_before_the_extension() {
    assert_eq!(numbered_name("notes.md", 0), "notes.md");
    assert_eq!(numbered_name("notes.md", 1), "notes (1).md");
    assert_eq!(numbered_name("archive.tar.gz", 2), "archive.tar (2).gz");
    assert_eq!(numbered_name("README", 1), "README (1)");
    assert_eq!(numbered_name(".bashrc", 1), ".bashrc (1)");
}

#[test]
fn join_remote_uses_forward_slashes() {
    assert_eq!(
        join_remote("/home/arne/Desktop", "a.txt"),
        "/home/arne/Desktop/a.txt"
    );
    assert_eq!(join_remote("/home/arne/", "a.txt"), "/home/arne/a.txt");
    assert_eq!(join_remote("/", "a.txt"), "/a.txt");
}

// ── Fake file host ──────────────────────────────────────────────────

/// An in-memory file host: folders, files with bytes, refused mkdirs, and a
/// log of the raw agent requests.
#[derive(Default)]
struct FakeHost {
    dirs: Mutex<HashMap<String, ()>>,
    files: Mutex<HashMap<String, Vec<u8>>>,
    refuse_mkdir: Vec<String>,
    requests: Mutex<Vec<(String, Value)>>,
}

impl FakeHost {
    fn with_dirs(dirs: &[&str]) -> Self {
        let host = Self::default();
        for d in dirs {
            host.dirs.lock().unwrap().insert((*d).to_string(), ());
        }
        host
    }

    fn add_file(&self, path: &str, data: &[u8]) {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_string(), data.to_vec());
    }

    fn file(&self, path: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(path).cloned()
    }

    fn has_dir(&self, path: &str) -> bool {
        self.dirs.lock().unwrap().contains_key(path)
    }

    fn entry(&self, path: &str) -> Option<FileEntry> {
        let path = path.replacen('~', "/home/pi", 1);
        let (is_directory, size) = if self.has_dir(&path) {
            (true, 0)
        } else {
            (false, self.file(&path)?.len() as u64)
        };
        Some(FileEntry {
            name: path.rsplit('/').next().unwrap_or_default().to_string(),
            path,
            is_directory,
            size,
            modified: "2026-10-06T00:00:00Z".to_string(),
            ..FileEntry::default()
        })
    }
}

#[async_trait::async_trait]
impl UploadDestination for FakeHost {
    async fn home(&self) -> Result<String, String> {
        Ok("/home/pi".to_string())
    }

    async fn probe(&self, path: &str) -> Result<Option<bool>, String> {
        Ok(self.entry(path).map(|e| e.is_directory))
    }

    async fn mkdir(&self, path: &str) -> Result<(), String> {
        if self.refuse_mkdir.iter().any(|r| r == path) {
            return Err("permission denied".to_string());
        }
        self.dirs.lock().unwrap().insert(path.to_string(), ());
        Ok(())
    }
}

/// The fake agent: answers host-level `connection.files.*` requests from the
/// same in-memory host, refusing any request scoped to a connection.
impl AgentRequests for FakeHost {
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
            CONNECTION_FILES_STAT => self
                .entry(&path)
                .map(|e| serde_json::to_value(e).unwrap())
                .ok_or_else(|| format!("{path}: not found")),
            CONNECTION_FILES_MKDIR => {
                self.dirs.lock().unwrap().insert(path, ());
                Ok(json!({}))
            }
            CONNECTION_FILES_DELETE => {
                self.files.lock().unwrap().remove(&path);
                Ok(json!({}))
            }
            CONNECTION_FILES_WRITE_RANGE => {
                let offset = params["offset"].as_u64().unwrap_or_default();
                let data = b64
                    .decode(params["data"].as_str().unwrap_or_default())
                    .map_err(|e| e.to_string())?;
                let mut files = self.files.lock().unwrap();
                let file = files.entry(path.clone()).or_default();
                if offset == 0 {
                    file.clear();
                } else if file.len() as u64 != offset {
                    return Err(format!("{path}: holds {}, expected {offset}", file.len()));
                }
                file.extend_from_slice(&data);
                Ok(json!({}))
            }
            CONNECTION_FILES_READ_RANGE => {
                let offset = params["offset"].as_u64().unwrap_or_default() as usize;
                let len = params["length"].as_u64().unwrap_or_default() as usize;
                let file = self.file(&path).unwrap_or_default();
                let end = file.len().min(offset + len);
                let slice = file.get(offset.min(end)..end).unwrap_or_default();
                Ok(json!({ "data": b64.encode(slice), "eof": end == file.len() }))
            }
            other => Err(format!("unexpected method {other}")),
        }
    }
}

// ── Local walk ──────────────────────────────────────────────────────

fn write(path: &Path, data: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, data).unwrap();
}

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn plan_local_walks_folders_recursively() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("report.pdf");
    write(&file, b"pdf");
    let photos = tmp.path().join("photos");
    write(&photos.join("a.jpg"), b"a");
    write(&photos.join("trip/b.jpg"), b"b");
    std::fs::create_dir_all(photos.join("empty")).unwrap();

    let plan = plan_local(&[s(&file), s(&photos)]);

    assert!(plan.skipped.is_empty(), "{:?}", plan.skipped);
    assert_eq!(
        plan.items[0],
        LocalItem::File {
            local: file,
            name: "report.pdf".to_string()
        }
    );
    let LocalItem::Folder { name, dirs, files } = &plan.items[1] else {
        panic!("expected a folder: {:?}", plan.items[1]);
    };
    assert_eq!(name, "photos");
    assert_eq!(
        dirs,
        &vec![vec!["empty".to_string()], vec!["trip".to_string()]]
    );
    let rel: Vec<_> = files.iter().map(|(r, _)| r.join("/")).collect();
    assert_eq!(rel, vec!["a.jpg", "trip/b.jpg"]);
}

#[test]
fn plan_local_skips_missing_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let plan = plan_local(&[s(&tmp.path().join("gone.txt"))]);
    assert!(plan.items.is_empty());
    assert_eq!(plan.skipped.len(), 1);
}

#[cfg(unix)]
#[test]
fn plan_local_never_follows_symbolic_links() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("secret.txt");
    write(&target, b"secret");
    let link = tmp.path().join("link.txt");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let folder = tmp.path().join("folder");
    write(&folder.join("kept.txt"), b"kept");
    std::os::unix::fs::symlink(tmp.path(), folder.join("loop")).unwrap();

    let plan = plan_local(&[s(&link), s(&folder)]);

    let reasons: Vec<_> = plan.skipped.iter().map(|k| k.reason.as_str()).collect();
    assert_eq!(reasons, vec![SKIP_SYMLINK, SKIP_SYMLINK]);
    assert_eq!(plan.items.len(), 1, "only the folder is uploaded");
    let LocalItem::Folder { dirs, files, .. } = &plan.items[0] else {
        panic!("expected a folder");
    };
    assert!(dirs.is_empty(), "the looping link is not walked");
    assert_eq!(files.len(), 1);
}

// ── Placement ───────────────────────────────────────────────────────

fn file_item(name: &str) -> LocalItem {
    LocalItem::File {
        local: PathBuf::from(format!("/local/{name}")),
        name: name.to_string(),
    }
}

fn remotes(placement: &Placement) -> Vec<&str> {
    placement.files.iter().map(|f| f.remote.as_str()).collect()
}

#[tokio::test]
async fn place_keeps_both_on_a_name_clash() {
    let host = FakeHost::with_dirs(&["/home/pi/Desktop"]);
    host.add_file("/home/pi/Desktop/notes.md", b"old");
    host.add_file("/home/pi/Desktop/notes (1).md", b"older");
    let plan = LocalPlan {
        items: vec![file_item("notes.md"), file_item("new.txt")],
        skipped: vec![],
    };

    let placement = place(&host, "/home/pi/Desktop", plan).await;

    assert_eq!(
        remotes(&placement),
        vec!["/home/pi/Desktop/notes (2).md", "/home/pi/Desktop/new.txt"]
    );
    assert_eq!(host.file("/home/pi/Desktop/notes.md").unwrap(), b"old");
}

#[tokio::test]
async fn place_keeps_both_for_two_dropped_files_with_one_name() {
    let host = FakeHost::with_dirs(&["/d"]);
    let plan = LocalPlan {
        items: vec![file_item("a.txt"), file_item("a.txt")],
        skipped: vec![],
    };
    let placement = place(&host, "/d", plan).await;
    assert_eq!(remotes(&placement), vec!["/d/a.txt", "/d/a (1).txt"]);
}

#[tokio::test]
async fn place_creates_a_dropped_folder_tree_under_a_free_name() {
    let host = FakeHost::with_dirs(&["/d", "/d/photos"]);
    let plan = LocalPlan {
        items: vec![LocalItem::Folder {
            name: "photos".to_string(),
            dirs: vec![vec!["trip".to_string()]],
            files: vec![
                (vec!["a.jpg".to_string()], PathBuf::from("/l/a.jpg")),
                (
                    vec!["trip".to_string(), "b.jpg".to_string()],
                    PathBuf::from("/l/trip/b.jpg"),
                ),
            ],
        }],
        skipped: vec![],
    };

    let placement = place(&host, "/d", plan).await;

    assert_eq!(placement.folders, 2);
    assert!(host.has_dir("/d/photos (1)") && host.has_dir("/d/photos (1)/trip"));
    assert_eq!(
        remotes(&placement),
        vec!["/d/photos (1)/a.jpg", "/d/photos (1)/trip/b.jpg"]
    );
}

#[tokio::test]
async fn place_skips_the_subtree_of_a_folder_it_cannot_create() {
    let host = FakeHost {
        refuse_mkdir: vec!["/d/f/locked".to_string()],
        ..FakeHost::with_dirs(&["/d"])
    };
    let plan = LocalPlan {
        items: vec![LocalItem::Folder {
            name: "f".to_string(),
            dirs: vec![
                vec!["locked".to_string()],
                vec!["locked".to_string(), "deep".to_string()],
            ],
            files: vec![
                (vec!["ok.txt".to_string()], PathBuf::from("/l/ok.txt")),
                (
                    vec!["locked".to_string(), "x.txt".to_string()],
                    PathBuf::from("/l/locked/x.txt"),
                ),
            ],
        }],
        skipped: vec![],
    };

    let placement = place(&host, "/d", plan).await;

    assert_eq!(remotes(&placement), vec!["/d/f/ok.txt"]);
    assert_eq!(placement.skipped.len(), 1);
    assert!(placement.skipped[0].reason.contains("permission denied"));
}

#[tokio::test]
async fn resolve_dest_dir_defaults_expands_home_and_checks_the_folder() {
    let host = FakeHost::with_dirs(&["/home/pi", "/home/pi/Desktop", "/home/pi/in"]);
    host.add_file("/home/pi/file.txt", b"x");

    assert_eq!(
        resolve_dest_dir(&host, None, "/home/pi/Desktop").await,
        Ok("/home/pi/Desktop".to_string())
    );
    assert_eq!(
        resolve_dest_dir(&host, Some(" ~/in "), "/home/pi/Desktop").await,
        Ok("/home/pi/in".to_string())
    );
    assert_eq!(
        resolve_dest_dir(&host, Some("~"), "/x").await,
        Ok("/home/pi".to_string())
    );
    let missing = resolve_dest_dir(&host, Some("/nope"), "/x")
        .await
        .unwrap_err();
    assert!(missing.contains("does not exist"), "{missing}");
    let not_dir = resolve_dest_dir(&host, Some("/home/pi/file.txt"), "/x")
        .await
        .unwrap_err();
    assert!(not_dir.contains("not a folder"), "{not_dir}");
}

// ── Queue over the agent carrier ────────────────────────────────────

fn quiet_sink() -> ProgressSink {
    Arc::new(|_: &termihub_core::files::transfer::TransferProgress| {})
}

/// Wait until every transfer of `session` has settled; returns their states.
async fn settled(registry: &TransferRegistry, session: &str) -> Vec<TransferStateTag> {
    for _ in 0..200 {
        let snaps = registry.list(Some(session));
        if !snaps.is_empty() && snaps.iter().all(|s| s.state.is_terminal()) {
            return snaps.into_iter().map(|s| s.state).collect();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "transfers did not settle: {:?}",
        registry.list(Some(session))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_carrier_uploads_through_the_queue_to_the_agent_host() {
    let tmp = tempfile::tempdir().unwrap();
    let big: Vec<u8> = (0..(600 * 1024)).map(|i| (i % 251) as u8).collect();
    write(&tmp.path().join("big.bin"), &big);
    write(&tmp.path().join("notes.md"), b"new notes");

    let host = Arc::new(FakeHost::with_dirs(&["/home/pi", "/home/pi/Desktop"]));
    host.add_file("/home/pi/Desktop/notes.md", b"keep me");
    let requests: Arc<dyn AgentRequests> = host.clone();
    let carrier = UploadCarrier::Agent(Arc::new(AgentHostFiles::new(
        "agent-1".to_string(),
        requests,
    )));

    let plan = plan_local(&[
        s(&tmp.path().join("big.bin")),
        s(&tmp.path().join("notes.md")),
    ]);
    let dest = carrier.destination();
    let dir = resolve_dest_dir(dest.as_ref(), None, "/home/pi/Desktop")
        .await
        .unwrap();
    let placement = place(dest.as_ref(), &dir, plan).await;
    let registry = TransferRegistry::new();
    let started = start_uploads(
        &carrier,
        "rd-1",
        placement.files,
        &registry,
        &quiet_sink(),
        None,
    );

    assert_eq!(started.len(), 2);
    assert_eq!(started[1].remote_path, "/home/pi/Desktop/notes (1).md");
    assert_eq!(
        settled(&registry, "rd-1").await,
        vec![TransferStateTag::Completed; 2]
    );
    assert_eq!(host.file("/home/pi/Desktop/big.bin").unwrap(), big);
    assert_eq!(
        host.file("/home/pi/Desktop/notes (1).md").unwrap(),
        b"new notes"
    );
    assert_eq!(host.file("/home/pi/Desktop/notes.md").unwrap(), b"keep me");
    // Large files stream in bounded slices, every one host-level.
    let requests = host.requests.lock().unwrap();
    let writes = requests
        .iter()
        .filter(|(m, _)| m == CONNECTION_FILES_WRITE_RANGE)
        .count();
    assert!(
        writes >= 3,
        "600 KiB must take several slices, got {writes}"
    );
    assert!(requests
        .iter()
        .all(|(_, p)| p["connection_id"].is_null()
            && p.get("connectionId").is_none_or(Value::is_null)));
}

#[tokio::test]
async fn cancel_session_transfers_cancels_only_that_session() {
    let registry = TransferRegistry::new();
    let a1 = registry.enqueue("a1", "rd-1", TransferDirection::Upload, "a", "/a", 0);
    let a2 = registry.enqueue("a2", "rd-1", TransferDirection::Upload, "b", "/b", 0);
    let other = registry.enqueue("b1", "ssh-9", TransferDirection::Upload, "c", "/c", 0);

    assert_eq!(cancel_session_transfers(&registry, "rd-1"), 2);
    assert!(a1.is_cancelled() && a2.is_cancelled());
    assert!(!other.is_cancelled());
    assert_eq!(cancel_session_transfers(&registry, "rd-unknown"), 0);
}

// ── Persistence and resume (#4205) ──────────────────────────────────

fn agent_carrier(host: &Arc<FakeHost>) -> UploadCarrier {
    let requests: Arc<dyn AgentRequests> = host.clone();
    UploadCarrier::Agent(Arc::new(AgentHostFiles::new(
        "agent-1".to_string(),
        requests,
    )))
}

fn graphical_target() -> PersistedGraphicalTarget {
    PersistedGraphicalTarget {
        connection_id: "Lab/pi-desktop".to_string(),
        route: termihub_core::connection::FileSideChannelKind::Agent,
        host: "lab-pi".to_string(),
        user: "pi".to_string(),
        agent_id: Some("agent-1".to_string()),
    }
}

/// With persistence, every queued upload is recorded — before its executor
/// runs — with the side channel's identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persisted_uploads_record_the_side_channel_identity() {
    let tmp = tempfile::tempdir().unwrap();
    write(&tmp.path().join("a.txt"), b"alpha");
    let host = Arc::new(FakeHost::with_dirs(&["/home/pi", "/home/pi/Desktop"]));
    let carrier = agent_carrier(&host);
    let persist = TransferPersistenceManager::new_test(tmp.path());
    let target = graphical_target();
    let registry = TransferRegistry::new();

    // The quiet sink does not fold progress into the durable queue, so the
    // record is still there to inspect after the upload finished.
    let files = vec![PlacedFile {
        local: tmp.path().join("a.txt"),
        remote: "/home/pi/Desktop/a.txt".to_string(),
    }];
    let started = start_uploads(
        &carrier,
        "rd-1",
        files,
        &registry,
        &quiet_sink(),
        Some((&persist, &target)),
    );
    let record = persist
        .get_record(&started[0].transfer_id)
        .expect("the upload is recorded before it runs");
    assert_eq!(record.graphical, Some(target));
    assert_eq!(record.session_id, "rd-1");
    assert_eq!(record.direction, TransferDirection::Upload);
    assert_eq!(record.remote_path, "/home/pi/Desktop/a.txt");
    assert_eq!(
        record.local_path.as_deref(),
        Some(s(&tmp.path().join("a.txt")).as_str())
    );

    assert_eq!(
        settled(&registry, "rd-1").await,
        vec![TransferStateTag::Completed]
    );
    assert_eq!(host.file("/home/pi/Desktop/a.txt").unwrap(), b"alpha");
}

/// Without a saved connection nothing is recorded (the default path).
#[tokio::test]
async fn unpersisted_uploads_leave_no_record() {
    let tmp = tempfile::tempdir().unwrap();
    write(&tmp.path().join("a.txt"), b"alpha");
    let host = Arc::new(FakeHost::with_dirs(&["/home/pi"]));
    let persist = TransferPersistenceManager::new_test(tmp.path());
    let registry = TransferRegistry::new();
    let started = start_uploads(
        &agent_carrier(&host),
        "rd-1",
        vec![PlacedFile {
            local: tmp.path().join("a.txt"),
            remote: "/home/pi/a.txt".to_string(),
        }],
        &registry,
        &quiet_sink(),
        None,
    );
    assert!(persist.get_record(&started[0].transfer_id).is_none());
}

/// Relaunch an upload over the agent carrier from `offset`, to completion.
async fn resume_upload(host: &Arc<FakeHost>, local: &Path, offset: u64) {
    let registry = TransferRegistry::new();
    let handle = registry.enqueue(
        "up-1",
        "rd-new",
        TransferDirection::Upload,
        "big.bin",
        "/home/pi/Desktop/big.bin",
        0,
    );
    crate::files::transfer::relaunch::run_side_channel_transfer(
        agent_carrier(host),
        TransferDirection::Upload,
        "/home/pi/Desktop/big.bin".to_string(),
        s(local),
        handle,
        registry.clone(),
        quiet_sink(),
        offset,
    )
    .await;
    assert_eq!(
        settled(&registry, "rd-new").await,
        vec![TransferStateTag::Completed]
    );
}

fn write_offsets(host: &FakeHost) -> Vec<u64> {
    host.requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, _)| m == CONNECTION_FILES_WRITE_RANGE)
        .map(|(_, p)| p["offset"].as_u64().unwrap_or_default())
        .collect()
}

/// A relaunched upload continues from the persisted offset when the remote
/// partial file holds exactly those bytes: nothing before it is re-sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_relaunched_upload_resumes_from_the_verified_offset() {
    let tmp = tempfile::tempdir().unwrap();
    let big: Vec<u8> = (0..(600 * 1024)).map(|i| (i % 251) as u8).collect();
    let local = tmp.path().join("big.bin");
    write(&local, &big);
    let offset = 256 * 1024;
    let host = Arc::new(FakeHost::with_dirs(&["/home/pi", "/home/pi/Desktop"]));
    host.add_file("/home/pi/Desktop/big.bin", &big[..offset]);

    resume_upload(&host, &local, offset as u64).await;

    assert_eq!(host.file("/home/pi/Desktop/big.bin").unwrap(), big);
    let offsets = write_offsets(&host);
    assert!(!offsets.is_empty());
    assert!(
        offsets.iter().all(|o| *o >= offset as u64),
        "resumed past the checkpoint, got {offsets:?}"
    );
}

/// When the remote partial holds more than the checkpoint (bytes the
/// checkpoint cannot vouch for), the resume gate restarts from zero; when it
/// holds less (it was truncated meanwhile), the upload continues from the
/// bytes actually present — never after a gap.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_relaunched_upload_never_appends_after_unverified_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let big: Vec<u8> = (0..(600 * 1024)).map(|i| (i % 241) as u8).collect();
    let local = tmp.path().join("big.bin");
    write(&local, &big);

    let longer = Arc::new(FakeHost::with_dirs(&["/home/pi", "/home/pi/Desktop"]));
    longer.add_file("/home/pi/Desktop/big.bin", &big[..300 * 1024]);
    resume_upload(&longer, &local, 256 * 1024).await;
    assert_eq!(longer.file("/home/pi/Desktop/big.bin").unwrap(), big);
    assert_eq!(
        write_offsets(&longer).first(),
        Some(&0),
        "restarted from zero"
    );

    let shorter = Arc::new(FakeHost::with_dirs(&["/home/pi", "/home/pi/Desktop"]));
    shorter.add_file("/home/pi/Desktop/big.bin", &big[..1000]);
    resume_upload(&shorter, &local, 256 * 1024).await;
    assert_eq!(shorter.file("/home/pi/Desktop/big.bin").unwrap(), big);
    assert_eq!(
        write_offsets(&shorter).first(),
        Some(&1000),
        "continued from the bytes present"
    );
}
