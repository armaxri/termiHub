//! `connection.files.*` for agent-hosted sessions (#3242): SSH, Docker, FTP
//! and WSL sessions browse through their own backend's file browser, a session
//! this client does not hold is refused, and every failure keeps its JSON-RPC
//! code.

use super::*;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use base64::Engine;
use termihub_core::errors::FileError;
use termihub_core::files::{FileBrowser, FileEntry, RangedFileAccess, MAX_RANGE_BYTES};
use termihub_core::protocol::methods::FilesReadRangeResult;

use crate::session::manager::SessionProcessError;

/// An in-memory file tree standing in for a session backend's own browser
/// (SFTP, `docker exec`, the FTP control connection, the WSL share).
struct FakeBrowser {
    host: String,
    files: StdMutex<HashMap<String, Vec<u8>>>,
    /// Whether it offers ranged access (#3587).
    ranges: bool,
    /// Every ranged read and write reaching the backend, as `(op, offset)`;
    /// a probe is recorded as `("probe", 0)`.
    range_calls: StdMutex<Vec<(&'static str, u64)>>,
    /// Offers ranged access up front but learns on connect that it cannot
    /// serve slices, like FTP without `REST STREAM` (#4146).
    learns_unsupported: bool,
}

impl FakeBrowser {
    fn new(host: &str) -> Arc<Self> {
        Arc::new(Self::with_ranges(host, true))
    }

    fn without_ranges(host: &str) -> Arc<Self> {
        Arc::new(Self::with_ranges(host, false))
    }

    fn with_ranges(host: &str, ranges: bool) -> Self {
        Self {
            host: host.to_string(),
            files: StdMutex::new(HashMap::new()),
            ranges,
            range_calls: StdMutex::new(Vec::new()),
            learns_unsupported: false,
        }
    }

    fn learning_unsupported(host: &str) -> Arc<Self> {
        Arc::new(Self {
            learns_unsupported: true,
            ..Self::with_ranges(host, true)
        })
    }

    fn entry(&self, path: &str, size: u64) -> FileEntry {
        FileEntry {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            size,
            ..FileEntry::default()
        }
    }
}

#[async_trait::async_trait]
impl FileBrowser for FakeBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        let mut entries = vec![self.entry(&format!("{path}/{}-only", self.host), 0)];
        for (p, data) in self.files.lock().unwrap().iter() {
            entries.push(self.entry(p, data.len() as u64));
        }
        Ok(entries)
    }
    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| FileError::NotFound(path.to_string()))
    }
    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        self.files
            .lock()
            .unwrap()
            .insert(path.to_string(), data.to_vec());
        Ok(())
    }
    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.files
            .lock()
            .unwrap()
            .remove(path)
            .map(|_| ())
            .ok_or_else(|| FileError::NotFound(path.to_string()))
    }
    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        let mut files = self.files.lock().unwrap();
        let data = files
            .remove(from)
            .ok_or_else(|| FileError::NotFound(from.to_string()))?;
        files.insert(to.to_string(), data);
        Ok(())
    }
    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        let size = self
            .files
            .lock()
            .unwrap()
            .get(path)
            .map(|d| d.len() as u64)
            .ok_or_else(|| FileError::NotFound(path.to_string()))?;
        Ok(self.entry(path, size))
    }
    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.files
            .lock()
            .unwrap()
            .insert(format!("{path}/"), Vec::new());
        Ok(())
    }
    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn set_owner(
        &self,
        _path: &str,
        _uid: Option<u32>,
        _gid: Option<u32>,
    ) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn create_symlink(&self, _target: &str, _link_path: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    async fn copy(&self, _src: &str, _dest: &str) -> Result<(), FileError> {
        Err(FileError::NotSupported)
    }
    fn ranged(&self) -> Option<&dyn RangedFileAccess> {
        self.ranges.then_some(self as &dyn RangedFileAccess)
    }
}

#[async_trait::async_trait]
impl RangedFileAccess for FakeBrowser {
    async fn probe(&self) -> Result<(), FileError> {
        self.range_calls.lock().unwrap().push(("probe", 0));
        if self.learns_unsupported {
            Err(FileError::NotSupported)
        } else {
            Ok(())
        }
    }
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        self.range_calls.lock().unwrap().push(("read", offset));
        let files = self.files.lock().unwrap();
        let data = files
            .get(path)
            .ok_or_else(|| FileError::NotFound(path.to_string()))?;
        let start = (offset as usize).min(data.len());
        let end = (start + len as usize).min(data.len());
        Ok(data[start..end].to_vec())
    }
    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        self.range_calls.lock().unwrap().push(("write", offset));
        let mut files = self.files.lock().unwrap();
        let file = files.entry(path.to_string()).or_default();
        if offset == 0 {
            file.clear();
        } else if file.len() as u64 != offset {
            return Err(termihub_core::files::ranged::offset_mismatch(
                path,
                file.len() as u64,
                offset,
            ));
        }
        file.extend_from_slice(data);
        Ok(())
    }
}

type Resolution = Result<Arc<dyn FileBrowser + Send + Sync>, SessionProcessError>;

/// Session manager double whose file browser resolution is scripted per session.
struct FilesSessionManager {
    registry: termihub_core::connection::ConnectionTypeRegistry,
    resolutions: StdMutex<HashMap<String, Resolution>>,
}

impl FilesSessionManager {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            registry: crate::registry::build_registry(),
            resolutions: StdMutex::new(HashMap::new()),
        })
    }

    fn script(&self, session_id: &str, resolution: Resolution) {
        self.resolutions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), resolution);
    }
}

#[async_trait::async_trait]
impl SessionManagerApi for FilesSessionManager {
    fn registry(&self) -> &termihub_core::connection::ConnectionTypeRegistry {
        &self.registry
    }
    async fn create(
        &self,
        _type_id: &str,
        _title: String,
        _settings: Value,
        _definition_id: Option<String>,
    ) -> Result<crate::session::types::SessionSnapshot, SessionCreateError> {
        Err(SessionCreateError::InvalidConfig("unused".into()))
    }
    async fn list(&self) -> Vec<crate::session::types::SessionSnapshot> {
        Vec::new()
    }
    async fn get_session_type_id(&self, _session_id: &str) -> Option<String> {
        None
    }
    async fn session_process_manager(
        &self,
        _session_id: &str,
    ) -> Result<Arc<dyn termihub_core::monitoring::ProcessManager + Send + Sync>, SessionProcessError>
    {
        Err(SessionProcessError::Unknown)
    }
    async fn session_file_browser(&self, session_id: &str) -> Resolution {
        self.resolutions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or(Err(SessionProcessError::Unknown))
    }
    async fn close(&self, _session_id: &str) -> bool {
        false
    }
    async fn active_count(&self) -> u32 {
        0
    }
    async fn request_deferred_update(
        &self,
        _binary_path: Option<String>,
        _version: Option<String>,
        _expected_sha256: Option<String>,
        _signature: Option<String>,
        _pinned_version: Option<String>,
    ) -> Result<DeferredUpdateOutcome, DeferredUpdateError> {
        Ok(DeferredUpdateOutcome::Applying)
    }
    async fn attach(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn detach(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn write_input(&self, _session_id: &str, _data: &[u8]) -> Result<(), String> {
        Ok(())
    }
    async fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
        Ok(())
    }
    async fn get_buffer(&self, _session_id: &str) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    async fn set_persistent_buffer_size_bytes(&self, _bytes: usize) {}
    async fn agent_forward_write(&self, _stream_id: &str, _data: Vec<u8>) {}
    async fn agent_forward_close(&self, _stream_id: &str) {}
    async fn agent_forward_connect(
        &self,
        _stream_id: &str,
        _host: &str,
        _port: u16,
    ) -> Result<(), String> {
        Ok(())
    }
}

async fn handler_with(sessions: Arc<FilesSessionManager>) -> AgentHandler {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let tmp = std::env::temp_dir().join(format!("termihub-files-{}.json", uuid::Uuid::new_v4()));
    let conn_store = Arc::new(ConnectionStore::new_temp(tmp));
    let monitoring = Arc::new(crate::monitoring::MonitoringManager::new(
        tx,
        conn_store.clone(),
    ));
    let handler = AgentHandler::new(
        sessions as Arc<dyn SessionManagerApi>,
        conn_store as Arc<dyn ConnectionStoreApi>,
        monitoring as Arc<dyn MonitoringManagerApi>,
    )
    .unwrap();
    init_handler(&handler).await;
    handler
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[tokio::test]
async fn initialize_advertises_session_files() {
    let handler = make_handler();
    let r = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(r["result"]["capabilities"]["sessionFiles"], true, "{r}");
}

/// Each agent-hosted session type lists through its own backend — the
/// browser shows that session's files, never the agent host's.
#[tokio::test]
async fn ssh_docker_ftp_and_wsl_sessions_list_their_own_files() {
    let sessions = FilesSessionManager::new();
    for host in ["ssh", "docker", "ftp", "wsl"] {
        sessions.script(&format!("{host}-session"), Ok(FakeBrowser::new(host)));
    }
    let handler = handler_with(sessions).await;

    for host in ["ssh", "docker", "ftp", "wsl"] {
        let r = dispatch(
            &handler,
            pm::CONNECTION_FILES_LIST,
            json!({"connection_id": format!("{host}-session"), "path": "/srv"}),
            2,
        )
        .await;
        let listed: FilesListResult =
            serde_json::from_value(r["result"].clone()).unwrap_or_else(|e| panic!("{e}: {r}"));
        assert_eq!(listed.entries[0].path, format!("/srv/{host}-only"));
    }
}

/// Write, stat, read, rename, mkdir and delete all reach the session's own
/// backend, and never another session's.
#[tokio::test]
async fn file_operations_reach_the_sessions_backend() {
    let sessions = FilesSessionManager::new();
    let docker = FakeBrowser::new("docker");
    let ssh = FakeBrowser::new("ssh");
    sessions.script("docker-session", Ok(docker.clone()));
    sessions.script("ssh-session", Ok(ssh.clone()));
    let handler = handler_with(sessions).await;
    let id = "docker-session";

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_WRITE,
        json!({"connection_id": id, "path": "/app/a.txt", "data": b64(b"container data")}),
        2,
    )
    .await;
    assert!(r.get("error").is_none(), "{r}");

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_STAT,
        json!({"connection_id": id, "path": "/app/a.txt"}),
        3,
    )
    .await;
    assert_eq!(r["result"]["size"], 14, "{r}");

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ,
        json!({"connection_id": id, "path": "/app/a.txt"}),
        4,
    )
    .await;
    let read: FilesReadResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!(read.data, b64(b"container data"));

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_RENAME,
        json!({"connection_id": id, "old_path": "/app/a.txt", "new_path": "/app/b.txt"}),
        5,
    )
    .await;
    assert!(r.get("error").is_none(), "{r}");

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_MKDIR,
        json!({"connection_id": id, "path": "/app/dir"}),
        6,
    )
    .await;
    assert!(r.get("error").is_none(), "{r}");

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_DELETE,
        json!({"connectionId": id, "path": "/app/b.txt", "isDirectory": false}),
        7,
    )
    .await;
    assert!(r.get("error").is_none(), "{r}");

    let files = docker.files.lock().unwrap();
    assert!(files.contains_key("/app/dir/"));
    assert!(!files.contains_key("/app/b.txt"));
    assert!(
        ssh.files.lock().unwrap().is_empty(),
        "an operation never leaks into another session"
    );
}

/// A backend failure keeps its code: a missing file is `FILE_NOT_FOUND`, an
/// operation the backend cannot do is `FILE_BROWSING_NOT_SUPPORTED`.
#[tokio::test]
async fn backend_failures_keep_their_codes() {
    let sessions = FilesSessionManager::new();
    sessions.script("ftp-session", Ok(FakeBrowser::new("ftp")));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ,
        json!({"connection_id": "ftp-session", "path": "/missing"}),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::FILE_NOT_FOUND, "{r}");

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_SET_PERMISSIONS,
        json!({"connection_id": "ftp-session", "path": "/x", "mode": 420}),
        3,
    )
    .await;
    assert_eq!(
        r["error"]["code"],
        errors::FILE_BROWSING_NOT_SUPPORTED,
        "{r}"
    );
}

/// Ownership: a session this client does not hold (another desktop's, or one
/// it detached from) is refused for reads and writes alike, and nothing is
/// written.
#[tokio::test]
async fn a_session_held_by_another_client_is_refused() {
    let sessions = FilesSessionManager::new();
    sessions.script("theirs", Err(SessionProcessError::HeldElsewhere));
    let handler = handler_with(sessions).await;

    for (method, params) in [
        (
            pm::CONNECTION_FILES_LIST,
            json!({"connection_id": "theirs", "path": "/"}),
        ),
        (
            pm::CONNECTION_FILES_READ,
            json!({"connection_id": "theirs", "path": "/etc/passwd"}),
        ),
        (
            pm::CONNECTION_FILES_WRITE,
            json!({"connection_id": "theirs", "path": "/x", "data": b64(b"x")}),
        ),
    ] {
        let r = dispatch(&handler, method, params, 2).await;
        assert_eq!(
            r["error"]["code"],
            errors::SESSION_HELD_BY_OTHER,
            "{method}: {r}"
        );
    }
}

#[tokio::test]
async fn an_exited_session_is_not_running() {
    let sessions = FilesSessionManager::new();
    sessions.script("gone", Err(SessionProcessError::Exited));
    let handler = handler_with(sessions).await;
    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_LIST,
        json!({"connection_id": "gone", "path": "/"}),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::SESSION_NOT_RUNNING, "{r}");
}

/// A backend without a file browser — or a session daemon started by an older
/// agent — is not supported, with the reason in the message.
#[tokio::test]
async fn a_backend_without_files_is_not_supported() {
    let sessions = FilesSessionManager::new();
    sessions.script(
        "old-daemon",
        Err(SessionProcessError::Unsupported(
            "started by an older agent — reopen it".into(),
        )),
    );
    let handler = handler_with(sessions).await;
    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_LIST,
        json!({"connection_id": "old-daemon", "path": "/"}),
        2,
    )
    .await;
    assert_eq!(
        r["error"]["code"],
        errors::FILE_BROWSING_NOT_SUPPORTED,
        "{r}"
    );
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("reopen it"),
        "{r}"
    );
}

/// An id that is neither a session of this client nor a saved connection is
/// not found — it never falls back to the agent host's filesystem.
#[tokio::test]
async fn an_unknown_id_is_not_found() {
    let handler = handler_with(FilesSessionManager::new()).await;
    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_LIST,
        json!({"connection_id": "someone-elses-session", "path": "/"}),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::CONNECTION_NOT_FOUND, "{r}");
}

// ── connection.files.read_range / write_range (#3587) ──────────────

#[tokio::test]
async fn initialize_advertises_file_ranges() {
    let handler = make_handler();
    let r = dispatch(&handler, "initialize", init_params(), 1).await;
    assert_eq!(r["result"]["capabilities"]["fileRanges"], true, "{r}");
}

/// Slices are written at the current size and read back at an offset, with
/// `eof` set on a short read, all through the session's own backend.
#[tokio::test]
async fn ranged_slices_reach_the_sessions_backend() {
    let sessions = FilesSessionManager::new();
    let docker = FakeBrowser::new("docker");
    let ssh = FakeBrowser::new("ssh");
    sessions.script("docker-session", Ok(docker.clone()));
    sessions.script("ssh-session", Ok(ssh.clone()));
    let handler = handler_with(sessions).await;
    let id = "docker-session";

    for (offset, data) in [(0, &b"hello "[..]), (6, &b"world"[..])] {
        let r = dispatch(
            &handler,
            pm::CONNECTION_FILES_WRITE_RANGE,
            json!({"connection_id": id, "path": "/app/f", "offset": offset, "data": b64(data)}),
            2,
        )
        .await;
        assert!(r.get("error").is_none(), "{r}");
    }
    assert_eq!(docker.files.lock().unwrap()["/app/f"], b"hello world");

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ_RANGE,
        json!({"connection_id": id, "path": "/app/f", "offset": 6, "length": 3}),
        3,
    )
    .await;
    let read: FilesReadRangeResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!((read.data, read.eof), (b64(b"wor"), false));

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ_RANGE,
        json!({"connection_id": id, "path": "/app/f", "offset": 9, "length": 8}),
        4,
    )
    .await;
    let read: FilesReadRangeResult = serde_json::from_value(r["result"].clone()).unwrap();
    assert_eq!((read.data, read.eof), (b64(b"ld"), true));
    assert!(
        ssh.files.lock().unwrap().is_empty(),
        "no cross-session leak"
    );
}

/// A write that would not land at the end of the file is refused by the
/// backend and nothing changes.
#[tokio::test]
async fn a_misplaced_ranged_write_is_refused() {
    let sessions = FilesSessionManager::new();
    let ssh = FakeBrowser::new("ssh");
    ssh.files
        .lock()
        .unwrap()
        .insert("/f".into(), b"abcdef".to_vec());
    sessions.script("ssh-session", Ok(ssh.clone()));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_WRITE_RANGE,
        json!({"connection_id": "ssh-session", "path": "/f", "offset": 2, "data": b64(b"X")}),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::FILE_OPERATION_FAILED, "{r}");
    assert_eq!(ssh.files.lock().unwrap()["/f"], b"abcdef");
}

/// A zero-length read is the capability probe: it succeeds on a ranged
/// backend without reading anything (the path need not even exist).
#[tokio::test]
async fn a_zero_length_read_probes_without_io() {
    let sessions = FilesSessionManager::new();
    let wsl = FakeBrowser::new("wsl");
    sessions.script("wsl-session", Ok(wsl.clone()));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ_RANGE,
        json!({"connection_id": "wsl-session", "path": "", "offset": 0, "length": 0}),
        2,
    )
    .await;
    assert_eq!(r["result"]["data"], "", "{r}");
    assert_eq!(
        *wsl.range_calls.lock().unwrap(),
        [("probe", 0)],
        "no slice read"
    );
}

/// The probe asks the live backend (#4146): one that offered slices up front
/// but learns on connect that it cannot serve them (FTP without
/// `REST STREAM`) answers `-32013`, so the desktop falls back to whole-file
/// transfers before the first slice.
#[tokio::test]
async fn a_backend_that_learns_it_cannot_serve_slices_fails_the_probe() {
    let sessions = FilesSessionManager::new();
    let ftp = FakeBrowser::learning_unsupported("ftp");
    sessions.script("ftp-session", Ok(ftp.clone()));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ_RANGE,
        json!({"connection_id": "ftp-session", "path": "", "offset": 0, "length": 0}),
        2,
    )
    .await;
    assert_eq!(
        r["error"]["code"],
        errors::FILE_BROWSING_NOT_SUPPORTED,
        "{r}"
    );
    assert_eq!(*ftp.range_calls.lock().unwrap(), [("probe", 0)]);
}

/// A backend without ranged access answers `-32013` for the probe and for
/// real slices alike, and is never written.
#[tokio::test]
async fn a_backend_without_ranges_is_not_supported() {
    let sessions = FilesSessionManager::new();
    let ftp = FakeBrowser::without_ranges("ftp");
    sessions.script("ftp-session", Ok(ftp.clone()));
    let handler = handler_with(sessions).await;

    for (method, params) in [
        (
            pm::CONNECTION_FILES_READ_RANGE,
            json!({"connection_id": "ftp-session", "path": "/f", "offset": 0, "length": 0}),
        ),
        (
            pm::CONNECTION_FILES_WRITE_RANGE,
            json!({"connection_id": "ftp-session", "path": "/f", "offset": 0, "data": b64(b"x")}),
        ),
    ] {
        let r = dispatch(&handler, method, params, 2).await;
        assert_eq!(
            r["error"]["code"],
            errors::FILE_BROWSING_NOT_SUPPORTED,
            "{method}: {r}"
        );
    }
    assert!(ftp.files.lock().unwrap().is_empty());
}

/// Oversized slices are refused as invalid params before reaching a backend.
#[tokio::test]
async fn oversized_slices_are_invalid() {
    let sessions = FilesSessionManager::new();
    let ssh = FakeBrowser::new("ssh");
    sessions.script("ssh-session", Ok(ssh.clone()));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ_RANGE,
        json!({"connection_id": "ssh-session", "path": "/f", "offset": 0,
               "length": MAX_RANGE_BYTES + 1}),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{r}");

    let big = vec![0u8; MAX_RANGE_BYTES as usize + 1];
    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_WRITE_RANGE,
        json!({"connection_id": "ssh-session", "path": "/f", "offset": 0, "data": b64(&big)}),
        3,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::INVALID_PARAMS, "{r}");
    assert!(ssh.range_calls.lock().unwrap().is_empty());
}

/// Ownership applies to ranged slices exactly as to every file operation.
#[tokio::test]
async fn ranged_slices_of_a_session_held_elsewhere_are_refused() {
    let sessions = FilesSessionManager::new();
    sessions.script("theirs", Err(SessionProcessError::HeldElsewhere));
    let handler = handler_with(sessions).await;

    let r = dispatch(
        &handler,
        pm::CONNECTION_FILES_READ_RANGE,
        json!({"connection_id": "theirs", "path": "/etc/shadow", "offset": 0, "length": 16}),
        2,
    )
    .await;
    assert_eq!(r["error"]["code"], errors::SESSION_HELD_BY_OTHER, "{r}");
}
