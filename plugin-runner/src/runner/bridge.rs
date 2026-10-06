//! The runner half of the capability bridge over IPC (#4183, plugin
//! OS-sandbox phase 2).
//!
//! The plugin gets the unchanged 1.x [`PluginHostBridge`]; every callback is
//! forwarded to the host as a `BridgeRequest` frame and blocks (with a per-call
//! deadline) on the matching `BridgeReply`. The host runs the very same
//! `PermissionSet` / `FilesystemScope` / `ConnectionPolicy` guards as the
//! in-process bridge, so the runner enforces nothing itself and holds no
//! permission state — it could not be trusted to.
//!
//! * **Network.** An approved `open_connection` comes back either as the
//!   connected socket itself (`SCM_RIGHTS` on Unix, popped from the channel's
//!   [`FdQueue`]) — the plugin then reads and writes it locally with no hop
//!   through the host — or, where a handle cannot be passed, as a **proxied**
//!   connection whose bytes travel as `StreamData` / `StreamWrite` frames with
//!   a per-direction credit window ([`STREAM_WINDOW`]). Dropping the stream
//!   sends `BridgeRelease`, which frees the host's connection slot.
//! * **Filesystem.** `read_file` / `write_file` / `stat_path` / `list_dir` are
//!   answered by the host; files larger than one frame are moved in
//!   [`MAX_BRIDGE_CHUNK`] pieces.
//!
//! The reader thread ([`super::run`]) routes `BridgeReply` and `Stream*`
//! frames here; plugin threads block in [`BridgeClient::call`]. Every callback
//! is `extern "C"`, tolerates a null context and contains panics.

use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;

use termihub_plugin_api::{
    FfiByteSlice, FfiOwnedBytes, FfiStr, PluginFileMetadata, PluginHostBridge,
    PluginHostBridgeVTable, PluginStatus, PluginTcpStream, PluginTcpStreamVTable, PluginWriteMode,
};
#[cfg(unix)]
use termihub_plugin_runner::ipc::fd::FdQueue;
use termihub_plugin_runner::ipc::{
    BridgeOp, BridgeReply, BridgeRequest, BridgeResult, ConnRef, Message, StreamAck, StreamChunk,
    StreamTransport, MAX_BRIDGE_CHUNK, STREAM_WINDOW,
};

use super::channel::Channel;

/// Deadline for one filesystem bridge call (the host does local file I/O).
const FS_DEADLINE: Duration = Duration::from_secs(30);

/// Deadline for one `open_connection` when the host did not send one.
pub(crate) const DEFAULT_CONNECT_DEADLINE: Duration = Duration::from_secs(60);

/// Largest `StreamData` chunk handed back to the plugin per proxied read.
const PROXY_READ_CHUNK: usize = 64 * 1024;

/// What a [`BridgeClient::call`] gets back.
struct Completion {
    result: BridgeResult,
    conn: Option<ConnHandle>,
}

/// A connection delivered with a `Connection` reply. Dropping it without
/// handing it to the plugin releases the host's slot.
enum ConnHandle {
    /// The connected socket itself, plus its release guard.
    #[cfg(unix)]
    Passed(std::os::fd::OwnedFd, ReleaseGuard),
    /// A proxied connection.
    Proxy(ProxyStream),
}

/// The bridge client shared by every session of the runner.
pub(crate) struct BridgeClient {
    channel: Arc<Channel>,
    next_request: AtomicU64,
    pending: Mutex<HashMap<u64, SyncSender<Completion>>>,
    proxies: Mutex<HashMap<u64, Arc<ProxyConn>>>,
    /// Set once the channel is gone: every later call fails at once.
    closed: AtomicBool,
    /// Descriptors received on the channel (Unix handle passing).
    #[cfg(unix)]
    fds: Option<FdQueue>,
}

impl BridgeClient {
    pub(crate) fn new(channel: Arc<Channel>, #[cfg(unix)] fds: Option<FdQueue>) -> Arc<Self> {
        Arc::new(Self {
            channel,
            next_request: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            proxies: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            #[cfg(unix)]
            fds,
        })
    }

    /// Send one request and wait (bounded) for its reply. `Err` is the status
    /// the plugin sees for a transport failure or a missed deadline.
    fn call(
        &self,
        session_id: u32,
        op: BridgeOp,
        deadline: Duration,
    ) -> Result<Completion, PluginStatus> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(PluginStatus::Io);
        }
        let request_id = self.next_request.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(1);
        self.lock_pending().insert(request_id, tx);
        // Re-check after registering: `fail_all` may have drained the map
        // between the first check and the insert.
        if self.closed.load(Ordering::SeqCst) {
            self.lock_pending().remove(&request_id);
            return Err(PluginStatus::Io);
        }
        let request = Message::BridgeRequest(BridgeRequest {
            request_id,
            session_id,
            op,
        });
        if self.channel.send(&request).is_err() {
            self.lock_pending().remove(&request_id);
            return Err(PluginStatus::Io);
        }
        match rx.recv_timeout(deadline) {
            Ok(completion) => Ok(completion),
            Err(RecvTimeoutError::Timeout) => {
                // A late reply finds no waiter; a connection it carries is
                // released by the reader thread.
                self.lock_pending().remove(&request_id);
                Err(PluginStatus::Io)
            }
            Err(RecvTimeoutError::Disconnected) => Err(PluginStatus::Io),
        }
    }

    /// Reader thread: route one `BridgeReply` to its waiter.
    pub(crate) fn on_reply(self: &Arc<Self>, reply: BridgeReply) {
        let BridgeReply { request_id, result } = reply;
        let (result, conn) = match result {
            BridgeResult::Connection { conn_id, transport } => {
                match self.take_connection(conn_id, transport) {
                    Some(conn) => (BridgeResult::Connection { conn_id, transport }, Some(conn)),
                    None => (
                        BridgeResult::Status {
                            status: PluginStatus::Io as i32,
                        },
                        None,
                    ),
                }
            }
            other => (other, None),
        };
        let waiter = self.lock_pending().remove(&request_id);
        if let Some(tx) = waiter {
            // A waiter that just timed out drops the completion, and with it
            // the connection's release guard.
            let _ = tx.try_send(Completion { result, conn });
        }
    }

    /// Materialise the connection a reply announces. `None` (after releasing
    /// the host slot) if a passed handle is missing.
    fn take_connection(
        self: &Arc<Self>,
        conn_id: u64,
        transport: StreamTransport,
    ) -> Option<ConnHandle> {
        let guard = ReleaseGuard {
            conn_id,
            client: Arc::downgrade(self),
        };
        match transport {
            StreamTransport::Proxy => {
                let conn = Arc::new(ProxyConn::new(conn_id));
                self.lock_proxies().insert(conn_id, Arc::clone(&conn));
                Some(ConnHandle::Proxy(ProxyStream {
                    conn,
                    client: Arc::downgrade(self),
                    _release: guard,
                }))
            }
            #[cfg(unix)]
            StreamTransport::HandlePassed => {
                let fd = self.fds.as_ref().and_then(FdQueue::pop)?;
                Some(ConnHandle::Passed(fd, guard))
            }
            #[cfg(not(unix))]
            StreamTransport::HandlePassed => {
                // TODO(#4219): Windows handle passing (DuplicateHandle +
                // overlapped ReadFile/WriteFile) lands with the Windows
                // transport; until then the host only offers `Proxy` here.
                drop(guard);
                None
            }
        }
    }

    /// Reader thread: bytes for a proxied connection.
    pub(crate) fn on_stream_data(&self, chunk: StreamChunk) {
        if let Some(conn) = self.proxy(chunk.conn_id) {
            conn.push(&chunk.data);
        }
    }

    /// Reader thread: a proxied socket reached end of stream.
    pub(crate) fn on_stream_closed(&self, conn: ConnRef) {
        if let Some(conn) = self.proxy(conn.conn_id) {
            conn.close_read();
        }
    }

    /// Reader thread: proxied write credit came back.
    pub(crate) fn on_write_ack(&self, ack: StreamAck) {
        if let Some(conn) = self.proxy(ack.conn_id) {
            conn.write_acked(ack.bytes as usize, ack.failed);
        }
    }

    /// The channel is gone: fail every waiter and end every proxied stream.
    pub(crate) fn fail_all(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.lock_pending().clear();
        let proxies: Vec<_> = self.lock_proxies().drain().map(|(_, c)| c).collect();
        for conn in proxies {
            conn.shut();
        }
    }

    fn proxy(&self, conn_id: u64) -> Option<Arc<ProxyConn>> {
        self.lock_proxies().get(&conn_id).cloned()
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, SyncSender<Completion>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_proxies(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Arc<ProxyConn>>> {
        self.proxies.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Tells the host a bridge connection is gone (`BridgeRelease`) when dropped.
struct ReleaseGuard {
    conn_id: u64,
    client: Weak<BridgeClient>,
}

impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        if let Some(client) = self.client.upgrade() {
            if let Some(conn) = client.lock_proxies().remove(&self.conn_id) {
                conn.shut();
            }
            let _ = client.channel.send(&Message::BridgeRelease(ConnRef {
                conn_id: self.conn_id,
            }));
        }
    }
}

// ---------------------------------------------------------------------------
// The bridge handed to the plugin
// ---------------------------------------------------------------------------

/// Context behind one session's [`PluginHostBridge`].
struct SessionBridge {
    session_id: u32,
    client: Arc<BridgeClient>,
    connect_deadline: Duration,
}

/// Build the IPC-backed bridge for one session.
pub(crate) fn session_bridge(
    session_id: u32,
    client: &Arc<BridgeClient>,
    connect_deadline: Duration,
) -> PluginHostBridge {
    let ctx = Box::into_raw(Box::new(SessionBridge {
        session_id,
        client: Arc::clone(client),
        connect_deadline,
    }))
    .cast::<c_void>();
    // SAFETY: `ctx` is a leaked `Box<SessionBridge>` that every callback in
    // `IPC_BRIDGE` only reads and `bridge_destroy` reclaims exactly once.
    unsafe { PluginHostBridge::from_raw(ctx, &IPC_BRIDGE, Some(bridge_destroy)) }
}

static IPC_BRIDGE: PluginHostBridgeVTable = PluginHostBridgeVTable {
    open_connection: ipc_open_connection,
    read_file: ipc_read_file,
    write_file: ipc_write_file,
    stat_path: ipc_stat_path,
    list_dir: ipc_list_dir,
};

/// Run one callback body against the session context behind `ctx`, containing
/// panics. A null context is refused with `Other`.
///
/// # Safety
///
/// A non-null `ctx` must be a live `SessionBridge` from [`session_bridge`].
unsafe fn with_session(
    ctx: *mut c_void,
    body: impl FnOnce(&SessionBridge) -> PluginStatus,
) -> PluginStatus {
    // SAFETY: caller contract; `as_ref` handles null.
    let Some(bridge) = (unsafe { ctx.cast::<SessionBridge>().cast_const().as_ref() }) else {
        return PluginStatus::Other;
    };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(bridge)))
        .unwrap_or(PluginStatus::Panic)
}

/// Read a plugin-supplied string, refusing invalid UTF-8 (the ABI promises
/// UTF-8, but the runner does not forward a broken promise to the host).
///
/// # Safety
///
/// `s` must describe readable memory for the call.
unsafe fn plugin_str(s: FfiStr) -> Result<String, PluginStatus> {
    let bytes: &[u8] = if s.len == 0 || s.ptr.is_null() {
        &[]
    } else {
        // SAFETY: caller contract.
        unsafe { std::slice::from_raw_parts(s.ptr, s.len) }
    };
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| PluginStatus::InvalidConfig)
}

/// A `Status` result as the plugin's status; anything else unexpected is `Io`.
fn status_of(result: &BridgeResult) -> PluginStatus {
    match result {
        BridgeResult::Status { status } => status_from_wire(*status),
        _ => PluginStatus::Io,
    }
}

/// Decode a wire status without ever transmuting an unknown discriminant.
fn status_from_wire(status: i32) -> PluginStatus {
    const VARIANTS: [PluginStatus; 10] = [
        PluginStatus::Ok,
        PluginStatus::ChannelClosed,
        PluginStatus::NotAlive,
        PluginStatus::InvalidConfig,
        PluginStatus::Io,
        PluginStatus::VersionMismatch,
        PluginStatus::Panic,
        PluginStatus::PermissionDenied,
        PluginStatus::Other,
        PluginStatus::ResourceLimit,
    ];
    VARIANTS
        .into_iter()
        .find(|v| *v as i32 == status)
        .unwrap_or(PluginStatus::Other)
}

unsafe extern "C" fn ipc_open_connection(
    ctx: *mut c_void,
    host: FfiStr,
    port: u16,
    out_stream: *mut PluginTcpStream,
) -> PluginStatus {
    let body = |b: &SessionBridge| {
        if out_stream.is_null() {
            return PluginStatus::Other;
        }
        // SAFETY: the plugin passes a string valid for the call.
        let host = match unsafe { plugin_str(host) } {
            Ok(host) => host,
            Err(status) => return status,
        };
        let completion = match b.client.call(
            b.session_id,
            BridgeOp::OpenConnection { host, port },
            b.connect_deadline,
        ) {
            Ok(completion) => completion,
            Err(status) => return status,
        };
        let stream = match completion.conn {
            #[cfg(unix)]
            Some(ConnHandle::Passed(fd, guard)) => {
                PluginTcpStream::from_std_guarded(std::net::TcpStream::from(fd), Box::new(guard))
            }
            Some(ConnHandle::Proxy(proxy)) => proxy.into_plugin_stream(),
            None => return status_of(&completion.result),
        };
        // SAFETY: `out_stream` is the plugin's valid, writable out-parameter.
        unsafe { out_stream.write(stream) };
        PluginStatus::Ok
    };
    // SAFETY: `ctx` is the context this bridge was built with (or null).
    unsafe { with_session(ctx, body) }
}

unsafe extern "C" fn ipc_read_file(
    ctx: *mut c_void,
    path: FfiStr,
    out_bytes: *mut FfiOwnedBytes,
) -> PluginStatus {
    let body = |b: &SessionBridge| {
        if out_bytes.is_null() {
            return PluginStatus::Other;
        }
        // SAFETY: the plugin passes a string valid for the call.
        let path = match unsafe { plugin_str(path) } {
            Ok(path) => path,
            Err(status) => return status,
        };
        let mut contents = Vec::new();
        loop {
            let op = BridgeOp::ReadFile {
                path: path.clone(),
                offset: contents.len() as u64,
            };
            match b.client.call(b.session_id, op, FS_DEADLINE) {
                Ok(Completion {
                    result: BridgeResult::Data { data, eof },
                    ..
                }) => {
                    let progressed = !data.is_empty();
                    contents.extend_from_slice(&data);
                    if eof {
                        break;
                    }
                    if !progressed {
                        // A host that neither advances nor ends would loop
                        // forever.
                        return PluginStatus::Io;
                    }
                }
                Ok(other) => return status_of(&other.result),
                Err(status) => return status,
            }
        }
        // SAFETY: `out_bytes` is the plugin's valid, writable out-parameter.
        unsafe { out_bytes.write(FfiOwnedBytes::from_vec(contents)) };
        PluginStatus::Ok
    };
    // SAFETY: `ctx` is the context this bridge was built with (or null).
    unsafe { with_session(ctx, body) }
}

unsafe extern "C" fn ipc_write_file(
    ctx: *mut c_void,
    path: FfiStr,
    data: FfiByteSlice,
    mode: PluginWriteMode,
) -> PluginStatus {
    let body = |b: &SessionBridge| {
        // SAFETY: the plugin passes a string valid for the call.
        let path = match unsafe { plugin_str(path) } {
            Ok(path) => path,
            Err(status) => return status,
        };
        // SAFETY: the plugin passes a slice valid for the call.
        let bytes = unsafe { data.as_slice() };
        // The first chunk opens the file per `mode`; the rest append. An empty
        // write still sends one request (it creates / truncates the file).
        let mut chunks: Vec<&[u8]> = bytes.chunks(MAX_BRIDGE_CHUNK).collect();
        if chunks.is_empty() {
            chunks.push(&[]);
        }
        for (i, chunk) in chunks.into_iter().enumerate() {
            let mode = if i == 0 {
                mode as i32
            } else {
                PluginWriteMode::Append as i32
            };
            let op = BridgeOp::WriteFile {
                path: path.clone(),
                data: chunk.to_vec(),
                mode,
            };
            match b.client.call(b.session_id, op, FS_DEADLINE) {
                Ok(Completion {
                    result: BridgeResult::Written,
                    ..
                }) => {}
                Ok(other) => return status_of(&other.result),
                Err(status) => return status,
            }
        }
        PluginStatus::Ok
    };
    // SAFETY: `ctx` is the context this bridge was built with (or null).
    unsafe { with_session(ctx, body) }
}

unsafe extern "C" fn ipc_stat_path(
    ctx: *mut c_void,
    path: FfiStr,
    out_meta: *mut PluginFileMetadata,
) -> PluginStatus {
    let body = |b: &SessionBridge| {
        if out_meta.is_null() {
            return PluginStatus::Other;
        }
        // SAFETY: the plugin passes a string valid for the call.
        let path = match unsafe { plugin_str(path) } {
            Ok(path) => path,
            Err(status) => return status,
        };
        match b
            .client
            .call(b.session_id, BridgeOp::Stat { path }, FS_DEADLINE)
        {
            Ok(Completion {
                result:
                    BridgeResult::Metadata {
                        exists,
                        is_dir,
                        len,
                    },
                ..
            }) => {
                let meta = PluginFileMetadata {
                    exists,
                    is_dir,
                    len,
                };
                // SAFETY: `out_meta` is the plugin's valid, writable out-parameter.
                unsafe { out_meta.write(meta) };
                PluginStatus::Ok
            }
            Ok(other) => status_of(&other.result),
            Err(status) => status,
        }
    };
    // SAFETY: `ctx` is the context this bridge was built with (or null).
    unsafe { with_session(ctx, body) }
}

unsafe extern "C" fn ipc_list_dir(
    ctx: *mut c_void,
    path: FfiStr,
    out_entries: *mut FfiOwnedBytes,
) -> PluginStatus {
    let body = |b: &SessionBridge| {
        if out_entries.is_null() {
            return PluginStatus::Other;
        }
        // SAFETY: the plugin passes a string valid for the call.
        let path = match unsafe { plugin_str(path) } {
            Ok(path) => path,
            Err(status) => return status,
        };
        match b
            .client
            .call(b.session_id, BridgeOp::ListDir { path }, FS_DEADLINE)
        {
            Ok(Completion {
                result: BridgeResult::Entries { names },
                ..
            }) => {
                let encoded = encode_dir_entries(&names);
                // SAFETY: `out_entries` is the plugin's valid, writable out-parameter.
                unsafe { out_entries.write(FfiOwnedBytes::from_vec(encoded)) };
                PluginStatus::Ok
            }
            Ok(other) => status_of(&other.result),
            Err(status) => status,
        }
    };
    // SAFETY: `ctx` is the context this bridge was built with (or null).
    unsafe { with_session(ctx, body) }
}

/// The ABI's `list_dir` framing (CORE-035): a `u32_le` count, then each name
/// as a `u32_le` length and its bytes. Must stay in lockstep with
/// `PluginHostBridge::list_dir`'s decoder and core's in-process encoder.
fn encode_dir_entries(names: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&u32::try_from(names.len()).unwrap_or(u32::MAX).to_le_bytes());
    for name in names {
        buf.extend_from_slice(&u32::try_from(name.len()).unwrap_or(u32::MAX).to_le_bytes());
        buf.extend_from_slice(name.as_bytes());
    }
    buf
}

unsafe extern "C" fn bridge_destroy(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: reclaims the box leaked in `session_bridge`, exactly once.
        drop(unsafe { Box::from_raw(ctx.cast::<SessionBridge>()) });
    });
}

// ---------------------------------------------------------------------------
// Proxied connections (the fallback where a handle cannot be passed)
// ---------------------------------------------------------------------------

/// Shared state of one proxied connection: what the host sent that the plugin
/// has not read yet, and the write credit in flight.
struct ProxyConn {
    conn_id: u64,
    inbox: Mutex<Inbox>,
    readable: Condvar,
    outbox: Mutex<Outbox>,
    writable: Condvar,
}

#[derive(Default)]
struct Inbox {
    buf: VecDeque<u8>,
    eof: bool,
}

#[derive(Default)]
struct Outbox {
    in_flight: usize,
    failed: bool,
}

impl ProxyConn {
    fn new(conn_id: u64) -> Self {
        Self {
            conn_id,
            inbox: Mutex::new(Inbox::default()),
            readable: Condvar::new(),
            outbox: Mutex::new(Outbox::default()),
            writable: Condvar::new(),
        }
    }

    fn push(&self, data: &[u8]) {
        let mut inbox = self.inbox.lock().unwrap_or_else(|e| e.into_inner());
        inbox.buf.extend(data);
        self.readable.notify_all();
    }

    fn close_read(&self) {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).eof = true;
        self.readable.notify_all();
    }

    fn write_acked(&self, bytes: usize, failed: bool) {
        let mut outbox = self.outbox.lock().unwrap_or_else(|e| e.into_inner());
        outbox.in_flight = outbox.in_flight.saturating_sub(bytes);
        outbox.failed |= failed;
        self.writable.notify_all();
    }

    /// End both directions (released, or the channel is gone).
    fn shut(&self) {
        self.close_read();
        self.write_acked(0, true);
    }

    /// Block until data or end of stream; return the bytes taken (`0` = EOF).
    fn read(&self, buf: &mut [u8]) -> usize {
        let mut inbox = self.inbox.lock().unwrap_or_else(|e| e.into_inner());
        while inbox.buf.is_empty() && !inbox.eof && !buf.is_empty() {
            inbox = self.readable.wait(inbox).unwrap_or_else(|e| e.into_inner());
        }
        let n = buf.len().min(inbox.buf.len()).min(PROXY_READ_CHUNK);
        for (dst, src) in buf.iter_mut().zip(inbox.buf.drain(..n)) {
            *dst = src;
        }
        n
    }

    /// Block until write credit is available; reserve and return how many
    /// bytes of `len` may go out now, or `None` once the connection failed.
    fn reserve_write(&self, len: usize) -> Option<usize> {
        let mut outbox = self.outbox.lock().unwrap_or_else(|e| e.into_inner());
        while outbox.in_flight >= STREAM_WINDOW && !outbox.failed {
            outbox = self
                .writable
                .wait(outbox)
                .unwrap_or_else(|e| e.into_inner());
        }
        if outbox.failed {
            return None;
        }
        let n = len
            .min(STREAM_WINDOW - outbox.in_flight)
            .min(MAX_BRIDGE_CHUNK);
        outbox.in_flight += n;
        Some(n)
    }
}

/// The plugin-facing state behind a proxied [`PluginTcpStream`].
struct ProxyStream {
    conn: Arc<ProxyConn>,
    client: Weak<BridgeClient>,
    /// Dropped with the stream: removes the proxy and sends `BridgeRelease`.
    _release: ReleaseGuard,
}

impl ProxyStream {
    fn into_plugin_stream(self) -> PluginTcpStream {
        PluginTcpStream {
            state: Box::into_raw(Box::new(self)).cast::<c_void>(),
            vtable: &PROXY_STREAM_VTABLE,
        }
    }

    fn read(&self, buf: &mut [u8]) -> Result<usize, PluginStatus> {
        let n = self.conn.read(buf);
        if n > 0 {
            let client = self.client.upgrade().ok_or(PluginStatus::Io)?;
            let ack = Message::StreamAck(StreamAck {
                conn_id: self.conn.conn_id,
                bytes: u32::try_from(n).unwrap_or(u32::MAX),
                failed: false,
            });
            // The bytes are already the plugin's; a lost ack only matters if
            // the channel is gone, and then the stream is ending anyway.
            let _ = client.channel.send(&ack);
        }
        Ok(n)
    }

    fn write(&self, data: &[u8]) -> Result<usize, PluginStatus> {
        if data.is_empty() {
            return Ok(0);
        }
        let n = self
            .conn
            .reserve_write(data.len())
            .ok_or(PluginStatus::Io)?;
        let client = self.client.upgrade().ok_or(PluginStatus::Io)?;
        let chunk = Message::StreamWrite(StreamChunk {
            conn_id: self.conn.conn_id,
            data: data[..n].to_vec(),
        });
        if client.channel.send(&chunk).is_err() {
            self.conn.shut();
            return Err(PluginStatus::Io);
        }
        Ok(n)
    }
}

static PROXY_STREAM_VTABLE: PluginTcpStreamVTable = PluginTcpStreamVTable {
    read: proxy_read,
    write: proxy_write,
    destroy: proxy_destroy,
};

unsafe extern "C" fn proxy_read(
    state: *mut c_void,
    buf: *mut u8,
    len: usize,
    out_read: *mut usize,
) -> PluginStatus {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: `state` is the live `ProxyStream` behind this handle.
        let Some(stream) = (unsafe { state.cast::<ProxyStream>().cast_const().as_ref() }) else {
            return PluginStatus::Other;
        };
        if out_read.is_null() || (buf.is_null() && len > 0) {
            return PluginStatus::Other;
        }
        let slice: &mut [u8] = if len == 0 {
            &mut []
        } else {
            // SAFETY: the plugin owns `buf` for `len` bytes for the call.
            unsafe { std::slice::from_raw_parts_mut(buf, len) }
        };
        match stream.read(slice) {
            Ok(n) => {
                // SAFETY: `out_read` is the plugin's valid out-parameter.
                unsafe { out_read.write(n) };
                PluginStatus::Ok
            }
            Err(status) => status,
        }
    }))
    .unwrap_or(PluginStatus::Panic)
}

unsafe extern "C" fn proxy_write(
    state: *mut c_void,
    data: FfiByteSlice,
    out_written: *mut usize,
) -> PluginStatus {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: `state` is the live `ProxyStream` behind this handle.
        let Some(stream) = (unsafe { state.cast::<ProxyStream>().cast_const().as_ref() }) else {
            return PluginStatus::Other;
        };
        if out_written.is_null() {
            return PluginStatus::Other;
        }
        // SAFETY: the plugin passes a slice valid for the call.
        let bytes = unsafe { data.as_slice() };
        match stream.write(bytes) {
            Ok(n) => {
                // SAFETY: `out_written` is the plugin's valid out-parameter.
                unsafe { out_written.write(n) };
                PluginStatus::Ok
            }
            Err(status) => status,
        }
    }))
    .unwrap_or(PluginStatus::Panic)
}

unsafe extern "C" fn proxy_destroy(state: *mut c_void) {
    if state.is_null() {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        // SAFETY: reclaims the box leaked in `into_plugin_stream`, exactly once.
        drop(unsafe { Box::from_raw(state.cast::<ProxyStream>()) });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_statuses_decode_without_transmuting() {
        assert_eq!(status_from_wire(0), PluginStatus::Ok);
        assert_eq!(status_from_wire(7), PluginStatus::PermissionDenied);
        assert_eq!(status_from_wire(9), PluginStatus::ResourceLimit);
        assert_eq!(status_from_wire(-1), PluginStatus::Other);
        assert_eq!(status_from_wire(10_000), PluginStatus::Other);
    }

    #[test]
    fn dir_entries_use_the_abi_framing() {
        let encoded = encode_dir_entries(&["a".to_owned(), "b\nc".to_owned()]);
        let mut expected = 2u32.to_le_bytes().to_vec();
        expected.extend(1u32.to_le_bytes());
        expected.extend(b"a");
        expected.extend(3u32.to_le_bytes());
        expected.extend(b"b\nc");
        assert_eq!(encoded, expected);
    }

    #[test]
    fn proxy_reads_block_until_data_then_report_eof() {
        let conn = Arc::new(ProxyConn::new(1));
        let reader = {
            let conn = Arc::clone(&conn);
            std::thread::spawn(move || {
                let mut buf = [0u8; 8];
                let n = conn.read(&mut buf);
                (n, buf)
            })
        };
        std::thread::sleep(Duration::from_millis(20));
        conn.push(b"hey");
        let (n, buf) = reader.join().unwrap();
        assert_eq!(&buf[..n], b"hey");
        conn.close_read();
        assert_eq!(conn.read(&mut [0u8; 4]), 0);
    }

    #[test]
    fn proxy_writes_respect_the_credit_window() {
        let conn = ProxyConn::new(1);
        assert_eq!(conn.reserve_write(10), Some(10));
        // Fill the window, then a writer must wait for an ack.
        let mut used = 10;
        while used < STREAM_WINDOW {
            used += conn.reserve_write(STREAM_WINDOW).unwrap();
        }
        let conn = Arc::new(conn);
        let waiter = {
            let conn = Arc::clone(&conn);
            std::thread::spawn(move || conn.reserve_write(5))
        };
        std::thread::sleep(Duration::from_millis(20));
        assert!(!waiter.is_finished(), "the window is full");
        conn.write_acked(3, false);
        assert_eq!(waiter.join().unwrap(), Some(3));
        conn.write_acked(0, true);
        assert_eq!(
            conn.reserve_write(1),
            None,
            "a failed stream refuses writes"
        );
    }
}
