//! File browsing for daemon-hosted sessions (#3242).
//!
//! Agent-hosted SSH, Docker, FTP and WSL sessions are usually persistent, so
//! their [`ConnectionType`](termihub_core::connection::ConnectionType) — and
//! with it the backend's own [`FileBrowser`] (SFTP, `docker exec`, the FTP
//! control connection, the WSL UNC share) — lives in the session daemon, not in
//! the worker. The worker reaches it over the frame protocol, the same way
//! process list / kill (#3210) and monitoring (#3871) do:
//!
//! - In the connect handshake the daemon's [`MSG_CAPABILITIES`] frame carries
//!   [`CAP_FILES`] when its backend has a file browser. A daemon started by an
//!   older agent does not set it, so the worker never sends it a request it
//!   would silently drop.
//! - The worker sends [`MSG_FILE_REQUEST`] (JSON [`FileRequest`]) and awaits
//!   the matching [`MSG_FILE_RESPONSE`] (JSON [`FileResponse`]) by request id.
//! - File contents never ride in the JSON. A write is announced with its size
//!   and followed by [`MSG_FILE_WRITE_DATA`] frames; a read's bytes come back in
//!   [`MSG_FILE_READ_DATA`] frames before its reply. Each data frame carries at
//!   most [`CHUNK_SIZE`] bytes, so a large transfer never holds the daemon link
//!   for longer than one chunk: terminal output and input frames interleave
//!   between chunks. The daemon side streams read chunks through a bounded
//!   channel (the worker task waits while the link is busy — backpressure, not
//!   buffering), and the worker side takes the writer lock once per chunk.
//!
//! The daemon runs one file worker task that serves requests in order (a
//! `mkdir` is never overtaken by the `list` that follows it), each bounded by a
//! timeout, with a bounded queue in front of it. Requests arrive only from the
//! connection that currently holds the session (single-attach), and replies go
//! only to it.
//!
//! On the worker, [`DaemonFileBrowser`] turns this back into an ordinary
//! [`FileBrowser`], so `connection.files.*` serve it exactly like any other
//! backend.
//!
//! [`MSG_CAPABILITIES`]: super::protocol::MSG_CAPABILITIES
//! [`CAP_FILES`]: super::protocol::CAP_FILES
//! [`MSG_FILE_RESPONSE`]: super::protocol::MSG_FILE_RESPONSE
//! [`MSG_FILE_READ_DATA`]: super::protocol::MSG_FILE_READ_DATA

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tracing::debug;

use termihub_core::errors::FileError;
use termihub_core::files::{
    FileBrowser, FileEntry, RangedFileAccess, MAX_RANGE_BYTES, MAX_REMOTE_READ_BYTES,
};

use super::client::{write_frame_timed, DaemonWriterHandle};
use super::protocol::{
    MSG_FILE_READ_DATA, MSG_FILE_REQUEST, MSG_FILE_RESPONSE, MSG_FILE_WRITE_DATA,
};

/// Largest file-content slice in one data frame (the same 64 KiB the desktop's
/// agent I/O lanes split large writes into, #3018). Bounds how long one chunk
/// holds the daemon link ahead of terminal output.
pub const CHUNK_SIZE: usize = 64 * 1024;

/// Largest file a read or write through the daemon may carry — the same bound
/// the backends apply to an in-memory read (CORE-013).
pub const MAX_TRANSFER_BYTES: u64 = MAX_REMOTE_READ_BYTES;

/// Upper bound on one metadata operation (list, stat, mkdir, …) inside the
/// daemon. Generous: the first operation of an SSH session opens its SFTP
/// channel.
pub const DAEMON_OP_TIMEOUT: Duration = Duration::from_secs(45);

/// Upper bound on one content operation (read, write, copy) inside the daemon.
pub const DAEMON_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

/// How long the worker waits for a metadata reply; longer than
/// [`DAEMON_OP_TIMEOUT`] so the daemon's own timeout (a typed failure) wins.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(60);

/// How long the worker waits for a content reply; longer than
/// [`DAEMON_TRANSFER_TIMEOUT`] for the same reason.
pub const TRANSFER_REPLY_TIMEOUT: Duration = Duration::from_secs(330);

/// File requests queued for the daemon's file worker. A request beyond it is
/// refused at once ("busy") instead of stalling the daemon loop.
pub const MAX_QUEUED_REQUESTS: usize = 16;

/// Writes whose data the daemon is still collecting at the same time.
pub const MAX_PENDING_UPLOADS: usize = 4;

/// Capacity of the daemon's file event channel (replies and read chunks). A
/// small bound: a read streams at the pace the daemon loop writes it out.
pub const EVENT_CAPACITY: usize = 8;

/// A file request from the worker to the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileRequest {
    /// Correlates the reply (and a write's data frames).
    pub id: u64,
    #[serde(flatten)]
    pub op: FileOp,
}

/// The operation a [`FileRequest`] asks for — one per [`FileBrowser`] method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FileOp {
    List {
        path: String,
    },
    Stat {
        path: String,
    },
    /// Read a whole file; its bytes follow in [`MSG_FILE_READ_DATA`] frames.
    Read {
        path: String,
    },
    /// Write `size` bytes, sent next in [`MSG_FILE_WRITE_DATA`] frames.
    Write {
        path: String,
        size: u64,
    },
    Delete {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Mkdir {
        path: String,
    },
    SetPermissions {
        path: String,
        mode: u32,
    },
    SetOwner {
        path: String,
        uid: Option<u32>,
        gid: Option<u32>,
    },
    CreateSymlink {
        target: String,
        link_path: String,
    },
    Copy {
        src: String,
        dest: String,
    },
    /// Read at most `length` bytes from `offset` (#3587); the bytes follow in
    /// [`MSG_FILE_READ_DATA`] frames. Sent only to a daemon that advertised
    /// [`CAP_FILE_RANGES`](super::protocol::CAP_FILE_RANGES).
    ReadRange {
        path: String,
        offset: u64,
        length: u32,
    },
    /// Write `size` bytes at `offset` (#3587), sent next in
    /// [`MSG_FILE_WRITE_DATA`] frames. Sent only to a daemon that advertised
    /// [`CAP_FILE_RANGES`](super::protocol::CAP_FILE_RANGES).
    WriteRange {
        path: String,
        offset: u64,
        size: u64,
    },
}

impl FileOp {
    /// Whether this operation moves file contents (and so gets the longer
    /// transfer timeouts).
    pub fn is_transfer(&self) -> bool {
        matches!(
            self,
            Self::Read { .. }
                | Self::Write { .. }
                | Self::Copy { .. }
                | Self::ReadRange { .. }
                | Self::WriteRange { .. }
        )
    }

    /// The announced size of a write's data frames, for the operations that
    /// carry any.
    pub fn upload_size(&self) -> Option<u64> {
        match self {
            Self::Write { size, .. } | Self::WriteRange { size, .. } => Some(*size),
            _ => None,
        }
    }
}

/// The daemon's reply to a [`FileRequest`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileResponse {
    /// The request's id.
    pub id: u64,
    pub outcome: FileOutcome,
}

/// What a [`FileOp`] produced.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FileOutcome {
    /// A directory listing.
    Listed {
        entries: Vec<FileEntry>,
    },
    /// One entry's metadata.
    Stat {
        entry: FileEntry,
    },
    /// A read finished; its `size` bytes were sent before this reply.
    Read {
        size: u64,
    },
    /// A write / delete / rename / mkdir / chmod / chown / symlink / copy
    /// finished.
    Done,
    Failed {
        error: WireFileError,
    },
}

/// A [`FileError`] as it crosses the daemon socket, carrying the variant and
/// its fields in both directions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WireFileError {
    NotFound { message: String },
    PermissionDenied { message: String },
    AlreadyExists { message: String },
    OperationFailed { message: String },
    TooLarge { size: u64, limit: u64 },
    NotSupported,
    Io { message: String },
}

impl From<FileError> for WireFileError {
    fn from(e: FileError) -> Self {
        match e {
            FileError::NotFound(message) => Self::NotFound { message },
            FileError::PermissionDenied(message) => Self::PermissionDenied { message },
            FileError::AlreadyExists(message) => Self::AlreadyExists { message },
            FileError::OperationFailed(message) => Self::OperationFailed { message },
            FileError::TooLarge { size, limit } => Self::TooLarge { size, limit },
            FileError::NotSupported => Self::NotSupported,
            FileError::Io(e) => Self::Io {
                message: e.to_string(),
            },
        }
    }
}

impl From<WireFileError> for FileError {
    fn from(e: WireFileError) -> Self {
        match e {
            WireFileError::NotFound { message } => Self::NotFound(message),
            WireFileError::PermissionDenied { message } => Self::PermissionDenied(message),
            WireFileError::AlreadyExists { message } => Self::AlreadyExists(message),
            WireFileError::OperationFailed { message } => Self::OperationFailed(message),
            WireFileError::TooLarge { size, limit } => Self::TooLarge { size, limit },
            WireFileError::NotSupported => Self::NotSupported,
            WireFileError::Io { message } => Self::Io(std::io::Error::other(message)),
        }
    }
}

/// Encode a data frame payload: the request id (u64 BE) then the bytes.
pub fn encode_chunk(id: u64, data: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + data.len());
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(data);
    payload
}

/// Split a data frame payload into its request id and bytes; `None` when it is
/// too short to carry an id.
pub fn decode_chunk(payload: &[u8]) -> Option<(u64, &[u8])> {
    let id: [u8; 8] = payload.get(..8)?.try_into().ok()?;
    Some((u64::from_be_bytes(id), &payload[8..]))
}

fn failed(e: FileError) -> FileOutcome {
    FileOutcome::Failed { error: e.into() }
}

// ── Daemon side ─────────────────────────────────────────────────────

/// A daemon → worker file frame, before it is written to the socket.
#[derive(Debug)]
pub enum FileFrame {
    /// A slice of a read's bytes.
    Chunk { id: u64, data: Vec<u8> },
    /// The reply to a request.
    Reply(FileResponse),
}

impl FileFrame {
    /// The frame type and payload to write to the worker.
    pub fn encode(&self) -> Result<(u8, Vec<u8>), serde_json::Error> {
        match self {
            Self::Chunk { id, data } => Ok((MSG_FILE_READ_DATA, encode_chunk(*id, data))),
            Self::Reply(response) => Ok((MSG_FILE_RESPONSE, serde_json::to_vec(response)?)),
        }
    }
}

/// Where the file worker sends its frames, tagged with the connection
/// generation that asked. The daemon loop drops a frame whose generation is no
/// longer the attached one.
pub type FileEventSender = mpsc::Sender<(u64, FileFrame)>;

/// One request for the daemon's file worker.
#[derive(Debug)]
pub struct FileJob {
    /// The connection generation that asked.
    pub gen: u64,
    pub request: FileRequest,
    /// A write's complete contents (empty for every other operation).
    pub data: Vec<u8>,
}

/// Spawn the daemon's file worker for `browser`.
///
/// One task handles every request in order, each bounded by a timeout. It
/// runs on its own task, so a slow SFTP round-trip never stalls output
/// forwarding.
pub fn spawn_file_worker(
    browser: Arc<dyn FileBrowser + Send + Sync>,
    events: FileEventSender,
) -> mpsc::Sender<FileJob> {
    let (tx, rx) = mpsc::channel(MAX_QUEUED_REQUESTS);
    tokio::spawn(file_worker(browser, rx, events));
    tx
}

async fn file_worker(
    browser: Arc<dyn FileBrowser + Send + Sync>,
    mut jobs: mpsc::Receiver<FileJob>,
    events: FileEventSender,
) {
    while let Some(FileJob { gen, request, data }) = jobs.recv().await {
        let (outcome, contents) = serve(browser.as_ref(), request.op, data).await;
        // Stream a read's bytes first, one chunk at a time: the bounded
        // channel makes this task wait while the daemon link is busy, so a
        // large read never queues up in memory twice nor starves output.
        if let Some(contents) = contents {
            for chunk in contents.chunks(CHUNK_SIZE) {
                let frame = FileFrame::Chunk {
                    id: request.id,
                    data: chunk.to_vec(),
                };
                if events.send((gen, frame)).await.is_err() {
                    return;
                }
            }
        }
        let reply = FileFrame::Reply(FileResponse {
            id: request.id,
            outcome,
        });
        if events.send((gen, reply)).await.is_err() {
            return;
        }
    }
}

/// Run `op` through the session backend's `browser`, bounded by
/// [`DAEMON_OP_TIMEOUT`] / [`DAEMON_TRANSFER_TIMEOUT`]. A read also returns
/// the bytes to stream back.
pub async fn serve(
    browser: &(dyn FileBrowser + Send + Sync),
    op: FileOp,
    data: Vec<u8>,
) -> (FileOutcome, Option<Vec<u8>>) {
    let limit = if op.is_transfer() {
        DAEMON_TRANSFER_TIMEOUT
    } else {
        DAEMON_OP_TIMEOUT
    };
    let timed_out = || {
        failed(FileError::OperationFailed(format!(
            "timed out after {limit:?}"
        )))
    };
    macro_rules! run {
        ($fut:expr, $ok:expr) => {
            match tokio::time::timeout(limit, $fut).await {
                Ok(Ok(value)) => ($ok(value), None),
                Ok(Err(e)) => (failed(e), None),
                Err(_) => (timed_out(), None),
            }
        };
    }
    let done = |()| FileOutcome::Done;
    match op {
        FileOp::List { path } => run!(browser.list_dir(&path), |entries| FileOutcome::Listed {
            entries
        }),
        FileOp::Stat { path } => run!(browser.stat(&path), |entry| FileOutcome::Stat { entry }),
        FileOp::Read { path } => {
            match tokio::time::timeout(limit, browser.read_file(&path)).await {
                Ok(Ok(bytes)) if bytes.len() as u64 > MAX_TRANSFER_BYTES => (
                    failed(FileError::TooLarge {
                        size: bytes.len() as u64,
                        limit: MAX_TRANSFER_BYTES,
                    }),
                    None,
                ),
                Ok(Ok(bytes)) => (
                    FileOutcome::Read {
                        size: bytes.len() as u64,
                    },
                    Some(bytes),
                ),
                Ok(Err(e)) => (failed(e), None),
                Err(_) => (timed_out(), None),
            }
        }
        FileOp::Write { path, .. } => run!(browser.write_file(&path, &data), done),
        FileOp::Delete { path } => run!(browser.delete(&path), done),
        FileOp::Rename { from, to } => run!(browser.rename(&from, &to), done),
        FileOp::Mkdir { path } => run!(browser.mkdir(&path), done),
        FileOp::SetPermissions { path, mode } => {
            run!(browser.set_permissions(&path, mode), done)
        }
        FileOp::SetOwner { path, uid, gid } => run!(browser.set_owner(&path, uid, gid), done),
        FileOp::CreateSymlink { target, link_path } => {
            run!(browser.create_symlink(&target, &link_path), done)
        }
        FileOp::Copy { src, dest } => run!(browser.copy(&src, &dest), done),
        FileOp::ReadRange {
            path,
            offset,
            length,
        } => {
            let Some(ranged) = browser.ranged() else {
                return (failed(FileError::NotSupported), None);
            };
            if length == 0 {
                // The per-session capability probe (#4146): ask the live
                // browser, which may only learn on connect that it cannot
                // serve slices (FTP without `REST STREAM`).
                return run!(ranged.probe(), |()| FileOutcome::Read { size: 0 });
            }
            let length = length.min(MAX_RANGE_BYTES);
            match tokio::time::timeout(limit, ranged.read_range(&path, offset, length)).await {
                Ok(Ok(bytes)) => (
                    FileOutcome::Read {
                        size: bytes.len() as u64,
                    },
                    Some(bytes),
                ),
                Ok(Err(e)) => (failed(e), None),
                Err(_) => (timed_out(), None),
            }
        }
        FileOp::WriteRange { path, offset, .. } => match browser.ranged() {
            Some(ranged) => run!(ranged.write_range(&path, offset, &data), done),
            None => (failed(FileError::NotSupported), None),
        },
    }
}

/// What the daemon loop should do after handing [`Uploads`] a write request or
/// a data frame.
#[derive(Debug)]
pub enum UploadStep {
    /// More data is expected (or the frame was for no known upload).
    Pending,
    /// The write's data is complete: run it.
    Complete(FileJob),
    /// The write is refused; send this reply.
    Refused(FileResponse),
}

/// A write whose data the daemon is still collecting.
#[derive(Debug)]
struct Upload {
    gen: u64,
    request: FileRequest,
    expected: usize,
    data: Vec<u8>,
}

/// The writes whose data frames the daemon loop is collecting (#3242).
///
/// Lives in the daemon loop itself, so collecting never waits on the file
/// worker: a write reaches the worker's queue only once its data is complete.
/// Bounded in count ([`MAX_PENDING_UPLOADS`]) and size
/// ([`MAX_TRANSFER_BYTES`]).
#[derive(Debug, Default)]
pub struct Uploads {
    pending: HashMap<u64, Upload>,
}

impl Uploads {
    /// Start collecting the write `request` (a [`FileOp::Write`] or
    /// [`FileOp::WriteRange`]) from the
    /// connection of generation `gen`.
    pub fn begin(&mut self, gen: u64, request: FileRequest) -> UploadStep {
        let Some(size) = request.op.upload_size() else {
            return UploadStep::Complete(FileJob {
                gen,
                request,
                data: Vec::new(),
            });
        };
        let refuse = |error: FileError| {
            UploadStep::Refused(FileResponse {
                id: request.id,
                outcome: failed(error),
            })
        };
        if size > MAX_TRANSFER_BYTES {
            return refuse(FileError::TooLarge {
                size,
                limit: MAX_TRANSFER_BYTES,
            });
        }
        if self.pending.len() >= MAX_PENDING_UPLOADS {
            return refuse(FileError::OperationFailed(
                "too many file writes in flight".into(),
            ));
        }
        let expected = size as usize;
        if expected == 0 {
            return UploadStep::Complete(FileJob {
                gen,
                request,
                data: Vec::new(),
            });
        }
        self.pending.insert(
            request.id,
            Upload {
                gen,
                request,
                expected,
                data: Vec::with_capacity(expected.min(CHUNK_SIZE)),
            },
        );
        UploadStep::Pending
    }

    /// Add a [`MSG_FILE_WRITE_DATA`] payload to its write.
    pub fn append(&mut self, payload: &[u8]) -> UploadStep {
        let Some((id, bytes)) = decode_chunk(payload) else {
            debug!("Malformed file data frame from agent");
            return UploadStep::Pending;
        };
        // Take the write out while it is extended; it goes back only while
        // more data is still expected.
        let Some(mut upload) = self.pending.remove(&id) else {
            // A refused or abandoned write's trailing data.
            return UploadStep::Pending;
        };
        if upload.data.len() + bytes.len() > upload.expected {
            return UploadStep::Refused(FileResponse {
                id,
                outcome: failed(FileError::OperationFailed(format!(
                    "more data than the announced {} bytes",
                    upload.expected
                ))),
            });
        }
        upload.data.extend_from_slice(bytes);
        if upload.data.len() < upload.expected {
            self.pending.insert(id, upload);
            return UploadStep::Pending;
        }
        UploadStep::Complete(FileJob {
            gen: upload.gen,
            request: upload.request,
            data: upload.data,
        })
    }

    /// Drop every write in collection — its connection was replaced or ended,
    /// so its remaining data will never arrive.
    pub fn clear(&mut self) {
        self.pending.clear();
    }

    /// Number of writes being collected.
    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

// ── Worker side ─────────────────────────────────────────────────────

/// A request awaiting its reply, with the read bytes received so far.
struct Pending {
    reply: oneshot::Sender<(FileOutcome, Vec<u8>)>,
    data: Vec<u8>,
    overflow: bool,
}

/// Per-client file state shared between a [`DaemonClient`], its reader task
/// and the [`DaemonFileBrowser`]s handed out for it.
///
/// [`DaemonClient`]: super::client::DaemonClient
#[derive(Default)]
pub struct FileChannel {
    /// Whether the connected daemon advertised file support.
    supported: AtomicBool,
    /// Whether the connected daemon also serves ranged reads and writes
    /// (#3587).
    ranges: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
}

impl std::fmt::Debug for FileChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileChannel")
            .field("supported", &self.supported())
            .field("pending", &self.lock().len())
            .finish()
    }
}

impl FileChannel {
    /// Whether the connected daemon serves file requests.
    pub fn supported(&self) -> bool {
        self.supported.load(Ordering::SeqCst)
    }

    /// Record the connected daemon's advertised support.
    pub fn set_supported(&self, supported: bool) {
        self.supported.store(supported, Ordering::SeqCst);
    }

    /// Whether the connected daemon serves ranged reads and writes (#3587).
    pub fn ranges_supported(&self) -> bool {
        self.ranges.load(Ordering::SeqCst)
    }

    /// Record the connected daemon's advertised ranged-access support.
    pub fn set_ranges_supported(&self, supported: bool) {
        self.ranges.store(supported, Ordering::SeqCst);
    }

    /// Reserve a request id and the receiver its reply is delivered to.
    pub fn register(&self) -> (u64, oneshot::Receiver<(FileOutcome, Vec<u8>)>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (reply, rx) = oneshot::channel();
        self.lock().insert(
            id,
            Pending {
                reply,
                data: Vec::new(),
                overflow: false,
            },
        );
        (id, rx)
    }

    /// Drop a request that will not be answered (failed write, timeout).
    fn forget(&self, id: u64) {
        self.lock().remove(&id);
    }

    /// Add a [`MSG_FILE_READ_DATA`] payload to its read. Bytes beyond
    /// [`MAX_TRANSFER_BYTES`] are dropped and the read then fails.
    pub fn deliver_chunk(&self, payload: &[u8]) {
        let Some((id, bytes)) = decode_chunk(payload) else {
            debug!("Malformed file data frame from daemon");
            return;
        };
        let mut pending = self.lock();
        let Some(entry) = pending.get_mut(&id) else {
            return;
        };
        if entry.overflow || (entry.data.len() + bytes.len()) as u64 > MAX_TRANSFER_BYTES {
            entry.overflow = true;
            entry.data = Vec::new();
            return;
        }
        entry.data.extend_from_slice(bytes);
    }

    /// Route a [`MSG_FILE_RESPONSE`] payload to its waiter, with the bytes its
    /// read delivered. Malformed or unknown replies are dropped.
    pub fn deliver(&self, payload: &[u8]) {
        let response: FileResponse = match serde_json::from_slice(payload) {
            Ok(r) => r,
            Err(e) => {
                debug!("Malformed file reply from daemon: {e}");
                return;
            }
        };
        let Some(entry) = self.lock().remove(&response.id) else {
            debug!("File reply for unknown request {}", response.id);
            return;
        };
        let outcome = if entry.overflow {
            failed(FileError::TooLarge {
                size: MAX_TRANSFER_BYTES + 1,
                limit: MAX_TRANSFER_BYTES,
            })
        } else {
            response.outcome
        };
        let _ = entry.reply.send((outcome, entry.data));
    }

    /// Fail every pending request (the daemon connection ended or changed).
    pub fn fail_all(&self) {
        self.lock().clear();
    }

    /// Number of requests awaiting a reply.
    #[cfg(test)]
    pub fn pending_len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Pending>> {
        self.pending.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// [`FileBrowser`] for a daemon-hosted session: forwards each operation to the
/// session daemon, which runs it through the session backend's own browser.
pub struct DaemonFileBrowser {
    writer: DaemonWriterHandle,
    channel: Arc<FileChannel>,
}

impl DaemonFileBrowser {
    pub fn new(writer: DaemonWriterHandle, channel: Arc<FileChannel>) -> Self {
        Self { writer, channel }
    }

    /// Write one frame, taking the writer lock for that frame only.
    async fn send_frame(&self, msg_type: u8, payload: &[u8]) -> Result<(), String> {
        let mut guard = self.writer.lock().await;
        match guard.as_mut() {
            Some(writer) => write_frame_timed(writer, msg_type, payload)
                .await
                .map_err(|e| e.to_string()),
            None => Err("the session is not attached".to_string()),
        }
    }

    /// Send `op` (and a write's `data`, chunked) and await the outcome with the
    /// bytes a read returned. `Err` is a transport failure message.
    async fn call(&self, op: FileOp, data: &[u8]) -> Result<(FileOutcome, Vec<u8>), String> {
        let reply_timeout = if op.is_transfer() {
            TRANSFER_REPLY_TIMEOUT
        } else {
            REPLY_TIMEOUT
        };
        let (id, rx) = self.channel.register();
        let sent = async {
            let payload = serde_json::to_vec(&FileRequest { id, op })
                .map_err(|e| format!("encode file request: {e}"))?;
            self.send_frame(MSG_FILE_REQUEST, &payload).await?;
            // One lock per chunk: input and resize frames queued behind the
            // writer lock go out between chunks, so a large upload never
            // starves the terminal.
            for chunk in data.chunks(CHUNK_SIZE) {
                self.send_frame(MSG_FILE_WRITE_DATA, &encode_chunk(id, chunk))
                    .await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(e) = sent {
            self.channel.forget(id);
            return Err(e);
        }
        match tokio::time::timeout(reply_timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err("the session daemon connection closed".to_string()),
            Err(_) => {
                self.channel.forget(id);
                Err(format!(
                    "no reply from the session daemon in {reply_timeout:?}"
                ))
            }
        }
    }

    /// Run a unit-result operation.
    async fn call_done(&self, op: FileOp) -> Result<(), FileError> {
        match self.call(op, &[]).await {
            Ok((FileOutcome::Done, _)) => Ok(()),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }
}

/// A reply that does not fit its request.
fn unexpected(outcome: FileOutcome) -> FileError {
    match outcome {
        FileOutcome::Failed { error } => error.into(),
        _ => FileError::OperationFailed("unexpected reply from the session daemon".into()),
    }
}

#[async_trait::async_trait]
impl FileBrowser for DaemonFileBrowser {
    async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, FileError> {
        match self.call(FileOp::List { path: path.into() }, &[]).await {
            Ok((FileOutcome::Listed { entries }, _)) => Ok(entries),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>, FileError> {
        match self.call(FileOp::Read { path: path.into() }, &[]).await {
            Ok((FileOutcome::Read { size }, data)) if data.len() as u64 == size => Ok(data),
            Ok((FileOutcome::Read { size }, data)) => Err(FileError::OperationFailed(format!(
                "incomplete read from the session daemon: {} of {size} bytes",
                data.len()
            ))),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), FileError> {
        let size = data.len() as u64;
        if size > MAX_TRANSFER_BYTES {
            return Err(FileError::TooLarge {
                size,
                limit: MAX_TRANSFER_BYTES,
            });
        }
        let op = FileOp::Write {
            path: path.into(),
            size,
        };
        match self.call(op, data).await {
            Ok((FileOutcome::Done, _)) => Ok(()),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }

    async fn delete(&self, path: &str) -> Result<(), FileError> {
        self.call_done(FileOp::Delete { path: path.into() }).await
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FileError> {
        self.call_done(FileOp::Rename {
            from: from.into(),
            to: to.into(),
        })
        .await
    }

    async fn stat(&self, path: &str) -> Result<FileEntry, FileError> {
        match self.call(FileOp::Stat { path: path.into() }, &[]).await {
            Ok((FileOutcome::Stat { entry }, _)) => Ok(entry),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }

    async fn mkdir(&self, path: &str) -> Result<(), FileError> {
        self.call_done(FileOp::Mkdir { path: path.into() }).await
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<(), FileError> {
        self.call_done(FileOp::SetPermissions {
            path: path.into(),
            mode,
        })
        .await
    }

    async fn set_owner(
        &self,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
    ) -> Result<(), FileError> {
        self.call_done(FileOp::SetOwner {
            path: path.into(),
            uid,
            gid,
        })
        .await
    }

    async fn create_symlink(&self, target: &str, link_path: &str) -> Result<(), FileError> {
        self.call_done(FileOp::CreateSymlink {
            target: target.into(),
            link_path: link_path.into(),
        })
        .await
    }

    async fn copy(&self, src: &str, dest: &str) -> Result<(), FileError> {
        self.call_done(FileOp::Copy {
            src: src.into(),
            dest: dest.into(),
        })
        .await
    }

    fn ranged(&self) -> Option<&dyn RangedFileAccess> {
        // A daemon from before #3587 would drop the unknown request and leave
        // the call waiting for its timeout, so ask only one that advertised it.
        self.channel
            .ranges_supported()
            .then_some(self as &dyn RangedFileAccess)
    }
}

/// Ranged reads and writes through the session daemon (#3587): each slice is
/// one request, its bytes in data frames like any read or write.
#[async_trait::async_trait]
impl RangedFileAccess for DaemonFileBrowser {
    async fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, FileError> {
        let op = FileOp::ReadRange {
            path: path.into(),
            offset,
            length: len,
        };
        match self.call(op, &[]).await {
            Ok((FileOutcome::Read { size }, data)) if data.len() as u64 == size => Ok(data),
            Ok((FileOutcome::Read { size }, data)) => Err(FileError::OperationFailed(format!(
                "incomplete read from the session daemon: {} of {size} bytes",
                data.len()
            ))),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }

    /// Forward the probe as a zero-length `read_range` (#4146), which the
    /// daemon answers from its live browser. A daemon from before #4146 reads
    /// nothing and answers an empty read — supported, as it always did.
    async fn probe(&self) -> Result<(), FileError> {
        let op = FileOp::ReadRange {
            path: String::new(),
            offset: 0,
            length: 0,
        };
        match self.call(op, &[]).await {
            Ok((FileOutcome::Read { .. }, _)) => Ok(()),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }

    async fn write_range(&self, path: &str, offset: u64, data: &[u8]) -> Result<(), FileError> {
        let op = FileOp::WriteRange {
            path: path.into(),
            offset,
            size: data.len() as u64,
        };
        match self.call(op, data).await {
            Ok((FileOutcome::Done, _)) => Ok(()),
            Ok((other, _)) => Err(unexpected(other)),
            Err(message) => Err(FileError::OperationFailed(message)),
        }
    }
}

#[cfg(test)]
mod tests;
