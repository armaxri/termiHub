//! The host's capability-bridge **service** for one plugin runner (#4183,
//! plugin OS-sandbox phase 2).
//!
//! A native plugin reaches the network and its declared paths only through
//! this service: the runner forwards each `PluginHostBridge` call as a
//! `BridgeRequest` frame, and the host answers it with the guarded operations
//! ([`guarded_connect`](crate::plugin::capabilities) and friends) against the
//! session's `PermissionSet`, `FilesystemScope` and `ConnectionPolicy`. One
//! enforcement point, identical on every OS; the runner holds no permission
//! state.
//!
//! * **Network.** An approved `open_connection` is connected by the host, which
//!   then passes the connected socket to the runner with the reply
//!   (`SCM_RIGHTS` on Unix; on Windows it duplicates the socket into the
//!   runner with `DuplicateHandle` and names the handle in the reply, #4219 —
//!   the runner drives it as a file handle, never through Winsock). Where a
//!   handle cannot be passed (a socket that is not a kernel handle, a failed
//!   duplication) the host keeps the socket and proxies it ([`super::proxy`]).
//!   Either way the session's connection slot stays reserved until the runner
//!   sends `BridgeRelease` (or the session / runner ends). On Windows the host
//!   keeps its own handle on a passed socket until then and shuts it down at
//!   release, which also ends the runner's copy.
//! * **Filesystem.** Reads and writes move in `MAX_BRIDGE_CHUNK` pieces; the
//!   path is re-resolved against the scope for every piece. A `list_dir` whose
//!   names do not fit one frame is paged (#4220): the host reads the directory
//!   once (bounded by `MAX_LIST_DIR_ENTRIES` / `MAX_LIST_DIR_BYTES`), answers
//!   the first page, and keeps the rest as a **snapshot** behind a one-use
//!   continuation cursor, so a directory changing between pages never yields
//!   duplicates or gaps. At most [`MAX_OPEN_LISTINGS`] snapshots are kept per
//!   runner (the least recently paged one is dropped first; continuing it is
//!   an I/O error).
//! * **Denials** are recorded as structured [`BridgeDenial`] events per plugin
//!   (and logged), ready for the UI phase to turn into toasts. The system calls
//!   the runner's OS sandbox refused (Linux seccomp, reported by the runner as
//!   `Denied{syscall}` log frames, #4236) land in the same list with
//!   [`DenialReason::Syscall`].
//!
//! The runner is an **untrusted peer**: a request for a never-allocated
//! session, a duplicate request id, an invalid write mode, an oversized
//! argument, a stream frame for a connection that was never handed out, or a
//! window overrun is a protocol violation that kills the runner. Requests run
//! on worker threads (a connect may take the whole connect timeout), at most
//! [`MAX_IN_FLIGHT`] at a time per runner; beyond that a request is refused
//! with `ResourceLimit`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime};

use termihub_plugin_api::{AbiVersion, PluginStatus, PluginWriteMode};
use termihub_plugin_runner::ipc::{
    BridgeOp, BridgeReply, BridgeRequest, BridgeResult, ConnRef, Message, StreamAck, StreamChunk,
    StreamTransport, LIST_DIR_ENTRY_OVERHEAD, MAX_BRIDGE_CHUNK,
};

use crate::plugin::capabilities::{
    guarded_connect, guarded_list_dir, guarded_read_chunk, guarded_stat, guarded_write,
    ConnectionGuard, ConnectionPolicy, ConnectionSlots,
};
use crate::plugin::security::PermissionSet;

use super::peer::Shared;
use super::proxy::{FrameSink, ProxyHost};
use super::writer::ChannelWriter;

/// Most bridge requests one runner may have in progress at once.
pub(super) const MAX_IN_FLIGHT: usize = 32;

/// Most paged `list_dir` snapshots one runner may hold at once (#4220). Each
/// is bounded by `MAX_LIST_DIR_BYTES`, so a runner that starts listings and
/// never finishes them pins at most this many.
pub(super) const MAX_OPEN_LISTINGS: usize = 4;

/// Most denial events kept per plugin (oldest dropped first).
const MAX_DENIALS: usize = 64;

/// Longest host name a runner may ask to connect to (DNS caps names at 253).
const MAX_HOST_LEN: usize = 1024;

/// Longest path a runner may send (generous; real limits are far lower).
const MAX_PATH_LEN: usize = 32 * 1024;

/// Characters of a requested target kept in a denial event.
const MAX_DENIAL_TARGET_CHARS: usize = 256;

/// What a session is allowed through the bridge: its permissions and its
/// connection policy. Captured when the session is created.
#[derive(Debug, Clone)]
pub struct BridgeGrant {
    permissions: PermissionSet,
    policy: ConnectionPolicy,
}

impl BridgeGrant {
    /// A grant of `permissions`, bounded by `policy`.
    #[must_use]
    pub fn new(permissions: PermissionSet, policy: ConnectionPolicy) -> Self {
        Self {
            permissions,
            policy,
        }
    }

    /// How long the runner should wait for one `open_connection` answer: the
    /// policy's connect timeout per resolved address (bounded) plus slack for
    /// name resolution.
    #[must_use]
    pub(crate) fn connect_deadline(&self) -> Duration {
        self.policy
            .connect_timeout()
            .saturating_mul(4)
            .saturating_add(Duration::from_secs(10))
    }
}

/// Why the host refused a bridge request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenialReason {
    /// The plugin lacks the permission, or the path is outside its scope.
    Permission,
    /// A resource ceiling (concurrent connections, in-flight requests).
    ResourceLimit,
    /// The runner's OS sandbox refused a system call (Linux seccomp, #4236):
    /// `operation` names the system call, `count` how many calls the report
    /// covered, and there is no `target`.
    Syscall,
}

/// One refused bridge request, per plugin — what the UI phase turns into a
/// rate-limited toast and a Log Viewer entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeDenial {
    /// The plugin (manifest id).
    pub plugin_id: String,
    /// The plugin session whose bridge was called; `0` for a
    /// [`DenialReason::Syscall`] denial, which no session owns.
    pub session_id: u32,
    /// The ABI callback (`open_connection`, `read_file`, …), or the system
    /// call for a [`DenialReason::Syscall`] denial (`socket`, `connect`, …).
    pub operation: &'static str,
    /// What was asked for (`host:port` or a path), sanitised and truncated;
    /// empty for a [`DenialReason::Syscall`] denial.
    pub target: String,
    /// Why it was refused.
    pub reason: DenialReason,
    /// How many refused calls this event stands for: `1` for a bridge call;
    /// a syscall report coalesces the calls of one interval of the runner.
    pub count: u32,
    /// When.
    pub at: SystemTime,
}

/// Set once the runner's handshake succeeded.
struct Attached {
    writer: Arc<ChannelWriter>,
    plugin_abi: AbiVersion,
    shared: Weak<Shared>,
}

/// A bridge connection the host handed out.
struct HostConn {
    session_id: u32,
    /// Holds the session's connection slot until released.
    _slot: ConnectionGuard,
    /// The relay, for a proxied connection.
    proxy: Option<Arc<ProxyHost>>,
    /// The host's own handle on a socket duplicated into the runner
    /// (Windows): shut down on release, which ends the runner's copy too.
    #[cfg(windows)]
    passed: Option<std::net::TcpStream>,
}

/// How a fresh connection reaches the runner.
enum Delivery {
    /// The socket rides along with the reply (`SCM_RIGHTS`).
    #[cfg(unix)]
    Fd,
    /// The socket was duplicated into the runner as this handle value.
    #[cfg(windows)]
    Duplicated(u64),
    /// The host keeps the socket and relays its bytes.
    Proxy(Arc<ProxyHost>),
}

impl Delivery {
    fn transport(&self) -> StreamTransport {
        match self {
            #[cfg(unix)]
            Delivery::Fd => StreamTransport::HandlePassed,
            #[cfg(windows)]
            Delivery::Duplicated(handle) => StreamTransport::HandleDuplicated { handle: *handle },
            Delivery::Proxy(_) => StreamTransport::Proxy,
        }
    }
}

/// The unsent rest of a paged `list_dir` (#4220), behind one cursor.
struct Listing {
    session_id: u32,
    /// The path as the runner first asked for it; a continuation must repeat it.
    path: String,
    names: VecDeque<String>,
}

/// A live session's grant plus its connection accounting.
struct SessionBridge {
    grant: BridgeGrant,
    slots: ConnectionSlots,
}

/// The bridge service of one runner.
pub(super) struct BridgeHost {
    plugin_id: String,
    attached: OnceLock<Attached>,
    sessions: Mutex<HashMap<u32, Arc<SessionBridge>>>,
    conns: Mutex<HashMap<u64, HostConn>>,
    next_conn: AtomicU64,
    in_flight: Mutex<HashSet<u64>>,
    listings: Mutex<HashMap<u64, Listing>>,
    next_listing: AtomicU64,
    denials: Mutex<VecDeque<BridgeDenial>>,
    force_proxy: AtomicBool,
    /// Connections whose socket was handed to the runner (not proxied).
    passed: AtomicU64,
}

impl BridgeHost {
    pub(super) fn new(plugin_id: String) -> Arc<Self> {
        Arc::new(Self {
            plugin_id,
            attached: OnceLock::new(),
            sessions: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            in_flight: Mutex::new(HashSet::new()),
            listings: Mutex::new(HashMap::new()),
            next_listing: AtomicU64::new(1),
            denials: Mutex::new(VecDeque::new()),
            force_proxy: AtomicBool::new(false),
            passed: AtomicU64::new(0),
        })
    }

    /// Wire the service to its runner once the handshake succeeded (before
    /// the reader thread starts, so every request finds it attached).
    pub(super) fn attach(
        &self,
        writer: Arc<ChannelWriter>,
        plugin_abi: AbiVersion,
        shared: Weak<Shared>,
    ) {
        let _ = self.attached.set(Attached {
            writer,
            plugin_abi,
            shared,
        });
    }

    /// Proxy every new connection even where handles can be passed (tests of
    /// the fallback path).
    pub(super) fn set_force_proxy(&self, on: bool) {
        self.force_proxy.store(on, Ordering::SeqCst);
    }

    /// Start serving a session's bridge with `grant`.
    pub(super) fn open_session(&self, session_id: u32, grant: BridgeGrant) {
        let slots = ConnectionSlots::new(&grant.policy);
        lock(&self.sessions).insert(session_id, Arc::new(SessionBridge { grant, slots }));
    }

    /// Stop serving a session: later requests for it get `NotAlive`, and every
    /// connection it holds is released (a proxied one is closed).
    pub(super) fn close_session(&self, session_id: u32) {
        lock(&self.sessions).remove(&session_id);
        lock(&self.listings).retain(|_, l| l.session_id != session_id);
        let gone: Vec<HostConn> = {
            let mut conns = lock(&self.conns);
            let ids: Vec<u64> = conns
                .iter()
                .filter(|(_, c)| c.session_id == session_id)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| conns.remove(&id)).collect()
        };
        close_conns(gone);
    }

    /// The runner is gone: drop every session and connection.
    pub(super) fn shutdown(&self) {
        lock(&self.sessions).clear();
        lock(&self.listings).clear();
        let gone: Vec<HostConn> = lock(&self.conns).drain().map(|(_, c)| c).collect();
        close_conns(gone);
    }

    /// The denial events recorded so far (oldest first).
    pub(super) fn denials(&self) -> Vec<BridgeDenial> {
        lock(&self.denials).iter().cloned().collect()
    }

    /// Connections currently handed out (diagnostics and tests).
    pub(super) fn open_connections(&self) -> usize {
        lock(&self.conns).len()
    }

    /// Connections whose socket was handed to the runner rather than proxied,
    /// since it started (diagnostics and tests).
    pub(super) fn handles_passed(&self) -> u64 {
        self.passed.load(Ordering::SeqCst)
    }

    // -- runner frames --------------------------------------------------

    /// A `BridgeRequest`. `check_session` rejects a never-allocated session id.
    /// `Err` is a protocol violation.
    pub(super) fn request(
        self: &Arc<Self>,
        request: BridgeRequest,
        check_session: impl FnOnce(u32) -> Result<(), String>,
    ) -> Result<(), String> {
        check_session(request.session_id)?;
        validate_op(&request.op)?;
        if let BridgeOp::ListDir { path, cursor } = &request.op {
            self.check_listing(request.session_id, path, *cursor)?;
        }
        let request_id = request.request_id;
        {
            let mut in_flight = lock(&self.in_flight);
            if in_flight.contains(&request_id) {
                return Err(format!("duplicate bridge request id {request_id}"));
            }
            if in_flight.len() >= MAX_IN_FLIGHT {
                drop(in_flight);
                self.record_denial(&request, DenialReason::ResourceLimit);
                self.reply_status(request_id, PluginStatus::ResourceLimit);
                return Ok(());
            }
            in_flight.insert(request_id);
        }
        let session = lock(&self.sessions).get(&request.session_id).cloned();
        let Some(session) = session else {
            // A retired session: its plugin objects may still be winding down.
            lock(&self.in_flight).remove(&request_id);
            self.reply_status(request_id, PluginStatus::NotAlive);
            return Ok(());
        };
        let service = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name(format!("plugin-bridge-{}", self.plugin_id))
            .spawn(move || service.serve(request, &session));
        if spawned.is_err() {
            lock(&self.in_flight).remove(&request_id);
            self.reply_status(request_id, PluginStatus::ResourceLimit);
        }
        Ok(())
    }

    /// Whether a bridge request is being served. The plugin call that made it
    /// is blocked on the runner's request thread until the reply, so the hang
    /// watchdog defers its verdict meanwhile (#4184): each request has its own
    /// deadline (the policy's connect timeout).
    pub(super) fn has_in_flight(&self) -> bool {
        !lock(&self.in_flight).is_empty()
    }

    /// A `BridgeRelease`: the plugin dropped a connection.
    pub(super) fn release(&self, conn: ConnRef) -> Result<(), String> {
        self.check_conn_id(conn.conn_id)?;
        if let Some(gone) = lock(&self.conns).remove(&conn.conn_id) {
            close_conns(vec![gone]);
        }
        Ok(())
    }

    /// A `StreamAck` for a proxied connection.
    pub(super) fn stream_ack(&self, ack: StreamAck) -> Result<(), String> {
        match self.proxy_for(ack.conn_id)? {
            Some(proxy) => proxy.ack(ack.bytes as usize),
            None => Ok(()),
        }
    }

    /// A `StreamWrite` for a proxied connection.
    pub(super) fn stream_write(&self, chunk: StreamChunk) -> Result<(), String> {
        if chunk.data.len() > MAX_BRIDGE_CHUNK {
            return Err(format!("StreamWrite of {} bytes", chunk.data.len()));
        }
        match self.proxy_for(chunk.conn_id)? {
            Some(proxy) => proxy.write(chunk.data),
            None => Ok(()),
        }
    }

    /// The proxy behind `conn_id`: `Ok(None)` for a released connection, `Err`
    /// for one never handed out or one that is not proxied.
    fn proxy_for(&self, conn_id: u64) -> Result<Option<Arc<ProxyHost>>, String> {
        self.check_conn_id(conn_id)?;
        match lock(&self.conns).get(&conn_id) {
            None => Ok(None),
            Some(HostConn { proxy: None, .. }) => Err(format!(
                "stream frame for connection {conn_id}, whose socket was passed"
            )),
            Some(HostConn {
                proxy: Some(proxy), ..
            }) => Ok(Some(Arc::clone(proxy))),
        }
    }

    /// Untrusted-peer checks on a `list_dir` continuation: the cursor must have
    /// been issued, and while its snapshot is live it belongs to this session
    /// and path. A consumed, evicted or retired cursor is not a violation (the
    /// request is answered with `Io`).
    fn check_listing(&self, session_id: u32, path: &str, cursor: u64) -> Result<(), String> {
        if cursor == 0 {
            return Ok(());
        }
        if cursor >= self.next_listing.load(Ordering::SeqCst) {
            return Err(format!(
                "list_dir continuation with unissued cursor {cursor}"
            ));
        }
        match lock(&self.listings).get(&cursor) {
            Some(l) if l.session_id != session_id || l.path != path => Err(format!(
                "list_dir cursor {cursor} replayed for another session or path"
            )),
            _ => Ok(()),
        }
    }

    fn check_conn_id(&self, conn_id: u64) -> Result<(), String> {
        if conn_id == 0 || conn_id >= self.next_conn.load(Ordering::SeqCst) {
            Err(format!("frame for unknown bridge connection {conn_id}"))
        } else {
            Ok(())
        }
    }

    // -- serving ----------------------------------------------------------

    /// Worker thread: run one request's guarded operation and answer it.
    fn serve(&self, request: BridgeRequest, session: &SessionBridge) {
        let request_id = request.request_id;
        let perms = &session.grant.permissions;
        let outcome = match &request.op {
            BridgeOp::OpenConnection { host, port } => {
                match guarded_connect(perms, &session.grant.policy, &session.slots, host, *port) {
                    Ok((stream, slot)) => {
                        lock(&self.in_flight).remove(&request_id);
                        self.hand_out(request_id, request.session_id, stream, slot);
                        return;
                    }
                    Err(status) => Err(status),
                }
            }
            BridgeOp::ReadFile { path, offset } => {
                guarded_read_chunk(perms, path, *offset, MAX_BRIDGE_CHUNK)
                    .map(|(data, eof)| BridgeResult::Data { data, eof })
            }
            BridgeOp::WriteFile { path, data, mode } => {
                // `validate_op` already refused an unknown mode.
                let mode = write_mode(*mode).unwrap_or(PluginWriteMode::Truncate);
                guarded_write(perms, path, data, mode).map(|()| BridgeResult::Written)
            }
            BridgeOp::Stat { path } => guarded_stat(perms, path).map(|m| BridgeResult::Metadata {
                exists: m.exists,
                is_dir: m.is_dir,
                len: m.len,
            }),
            BridgeOp::ListDir { path, cursor } => {
                self.list_page(request.session_id, perms, path, *cursor)
            }
        };
        lock(&self.in_flight).remove(&request_id);
        match outcome {
            Ok(result) => self.reply(request_id, result),
            Err(status) => {
                match status {
                    PluginStatus::PermissionDenied => {
                        self.record_denial(&request, DenialReason::Permission);
                    }
                    PluginStatus::ResourceLimit => {
                        self.record_denial(&request, DenialReason::ResourceLimit);
                    }
                    _ => {}
                }
                self.reply_status(request_id, status);
            }
        }
    }

    /// One `list_dir` page (#4220): a fresh listing for cursor `0`, else the
    /// snapshot behind `cursor`. The rest, if any, is kept under a new one-use
    /// cursor.
    fn list_page(
        &self,
        session_id: u32,
        perms: &PermissionSet,
        path: &str,
        cursor: u64,
    ) -> Result<BridgeResult, PluginStatus> {
        let mut names: VecDeque<String> = if cursor == 0 {
            guarded_list_dir(perms, path)?.into()
        } else {
            // Consumed, evicted, or its session ended.
            lock(&self.listings)
                .remove(&cursor)
                .ok_or(PluginStatus::Io)?
                .names
        };
        let page = take_page(&mut names)?;
        if names.is_empty() {
            return Ok(BridgeResult::Entries {
                names: page,
                next_cursor: 0,
            });
        }
        let next_cursor = self.next_listing.fetch_add(1, Ordering::SeqCst);
        let mut listings = lock(&self.listings);
        while listings.len() >= MAX_OPEN_LISTINGS {
            // Cursors grow with every page, so the smallest is the listing
            // paged least recently (most likely abandoned).
            let Some(oldest) = listings.keys().min().copied() else {
                break;
            };
            listings.remove(&oldest);
        }
        listings.insert(
            next_cursor,
            Listing {
                session_id,
                path: path.to_owned(),
                names,
            },
        );
        Ok(BridgeResult::Entries {
            names: page,
            next_cursor,
        })
    }

    /// Register a fresh connection and deliver it: pass the socket where the
    /// channel can, proxy it otherwise.
    fn hand_out(
        &self,
        request_id: u64,
        session_id: u32,
        stream: std::net::TcpStream,
        slot: ConnectionGuard,
    ) {
        let Some(attached) = self.attached.get() else {
            return;
        };
        let conn_id = self.next_conn.fetch_add(1, Ordering::SeqCst);
        let pass = attached.writer.can_pass_handles() && !self.force_proxy.load(Ordering::SeqCst);
        let delivery = match pass.then(|| self.pass(attached, &stream)).flatten() {
            Some(delivery) => delivery,
            None => match stream.try_clone() {
                Ok(socket) => Delivery::Proxy(ProxyHost::new(conn_id, socket)),
                Err(_) => {
                    self.reply_status(request_id, PluginStatus::Io);
                    return;
                }
            },
        };
        let proxy = match &delivery {
            Delivery::Proxy(proxy) => Some(Arc::clone(proxy)),
            #[cfg(unix)]
            Delivery::Fd => None,
            #[cfg(windows)]
            Delivery::Duplicated(_) => None,
        };
        // Windows keeps its handle on a passed socket (shut down at release);
        // otherwise the host keeps no copy: the runner or the proxy owns it.
        #[cfg(windows)]
        let (passed, stream) = match delivery {
            Delivery::Duplicated(_) => (Some(stream), None),
            Delivery::Proxy(_) => (None, Some(stream)),
        };
        lock(&self.conns).insert(
            conn_id,
            HostConn {
                session_id,
                _slot: slot,
                proxy: proxy.clone(),
                #[cfg(windows)]
                passed,
            },
        );
        let reply = Message::BridgeReply(BridgeReply {
            request_id,
            result: BridgeResult::Connection {
                conn_id,
                transport: delivery.transport(),
            },
        });
        let sent = match delivery {
            #[cfg(unix)]
            Delivery::Fd => self.send_with_socket(attached, &reply, &stream),
            #[cfg(windows)]
            Delivery::Duplicated(handle) => {
                let sent = self.send(&reply);
                if !sent {
                    attached.writer.close_in_runner(handle);
                }
                sent
            }
            Delivery::Proxy(_) => self.send(&reply),
        };
        drop(stream);
        if !sent {
            if let Some(gone) = lock(&self.conns).remove(&conn_id) {
                close_conns(vec![gone]);
            }
            return;
        }
        match proxy {
            // Only after the reply, so no `StreamData` precedes it.
            Some(proxy) => proxy.start(self.frame_sink()),
            None => {
                self.passed.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// Unix: the socket can always ride along with the reply.
    #[cfg(unix)]
    fn pass(&self, _attached: &Attached, _stream: &std::net::TcpStream) -> Option<Delivery> {
        Some(Delivery::Fd)
    }

    /// Windows: duplicate the socket into the runner. `None` (proxy instead)
    /// for a socket that is not a kernel handle (a non-IFS layered provider)
    /// or a failed duplication.
    #[cfg(windows)]
    fn pass(&self, attached: &Attached, stream: &std::net::TcpStream) -> Option<Delivery> {
        if !winsock::is_kernel_handle(stream) {
            tracing::debug!(
                target: crate::plugin::PLUGIN_LOG_TARGET,
                plugin = %self.plugin_id,
                "bridge socket is not a kernel handle; proxying it"
            );
            return None;
        }
        match attached.writer.duplicate_into_runner(stream) {
            Ok(handle) => Some(Delivery::Duplicated(handle)),
            Err(e) => {
                tracing::debug!(
                    target: crate::plugin::PLUGIN_LOG_TARGET,
                    plugin = %self.plugin_id,
                    "duplicating a bridge socket into the runner failed ({e}); proxying it"
                );
                None
            }
        }
    }

    #[cfg(unix)]
    fn send_with_socket(
        &self,
        attached: &Attached,
        reply: &Message,
        stream: &std::net::TcpStream,
    ) -> bool {
        use std::os::fd::AsFd;
        let Ok(frame) = reply.encode() else {
            return false;
        };
        match attached.writer.write_frame_with_fd(&frame, stream.as_fd()) {
            Ok(()) => true,
            Err(e) => {
                self.kill(&format!("passing a bridge socket failed: {e}"));
                false
            }
        }
    }

    fn frame_sink(&self) -> FrameSink {
        let attached = self
            .attached
            .get()
            .map(|a| (Arc::clone(&a.writer), a.shared.clone()));
        Arc::new(move |message: &Message| {
            let Some((writer, shared)) = attached.as_ref() else {
                return false;
            };
            write_or_kill(writer, shared, message)
        })
    }

    fn reply(&self, request_id: u64, result: BridgeResult) {
        self.send(&Message::BridgeReply(BridgeReply { request_id, result }));
    }

    /// Answer with a status the plugin's ABI can decode (#3373).
    fn reply_status(&self, request_id: u64, status: PluginStatus) {
        let abi = self
            .attached
            .get()
            .map_or(termihub_plugin_api::CURRENT_PLUGIN_ABI_VERSION, |a| {
                a.plugin_abi
            });
        let status = status.for_peer(abi) as i32;
        self.reply(request_id, BridgeResult::Status { status });
    }

    fn send(&self, message: &Message) -> bool {
        match self.attached.get() {
            Some(a) => write_or_kill(&a.writer, &a.shared, message),
            None => false,
        }
    }

    /// Only the Unix socket hand-over kills from here (a Windows reply that
    /// fails to send kills through [`write_or_kill`]).
    #[cfg(unix)]
    fn kill(&self, reason: &str) {
        if let Some(shared) = self.attached.get().and_then(|a| a.shared.upgrade()) {
            shared.violation(reason);
        }
    }

    fn record_denial(&self, request: &BridgeRequest, reason: DenialReason) {
        let target = match &request.op {
            BridgeOp::OpenConnection { host, port } => format!("{host}:{port}"),
            BridgeOp::ReadFile { path, .. }
            | BridgeOp::WriteFile { path, .. }
            | BridgeOp::Stat { path }
            | BridgeOp::ListDir { path, .. } => path.clone(),
        };
        let denial = BridgeDenial {
            plugin_id: self.plugin_id.clone(),
            session_id: request.session_id,
            operation: request.op.name(),
            target: sanitize_target(&target),
            reason,
            count: 1,
            at: SystemTime::now(),
        };
        tracing::warn!(
            target: crate::plugin::PLUGIN_LOG_TARGET,
            plugin = %denial.plugin_id,
            session = denial.session_id,
            operation = denial.operation,
            requested = %denial.target,
            reason = ?denial.reason,
            "[{}] host bridge denied {} of `{}`",
            denial.plugin_id,
            denial.operation,
            denial.target
        );
        self.push_denial(denial);
    }

    /// Record a `Denied{syscall}` report of the runner (#4236): `count`
    /// calls of `syscall` (an already validated, known name) refused by the
    /// OS sandbox. The caller logs it (rate-limited with the plugin's log).
    pub(super) fn record_syscall_denial(&self, syscall: &'static str, count: u32) {
        self.push_denial(BridgeDenial {
            plugin_id: self.plugin_id.clone(),
            session_id: 0,
            operation: syscall,
            target: String::new(),
            reason: DenialReason::Syscall,
            count,
            at: SystemTime::now(),
        });
    }

    fn push_denial(&self, denial: BridgeDenial) {
        let mut denials = lock(&self.denials);
        if denials.len() >= MAX_DENIALS {
            denials.pop_front();
        }
        denials.push_back(denial);
    }
}

/// Write one frame; a failure (stalled or gone runner) kills the runner.
fn write_or_kill(writer: &ChannelWriter, shared: &Weak<Shared>, message: &Message) -> bool {
    let result = message
        .encode()
        .map_err(|e| e.to_string())
        .and_then(|frame| writer.write_frame(&frame).map_err(|e| e.to_string()));
    match result {
        Ok(()) => true,
        Err(e) => {
            if let Some(shared) = shared.upgrade() {
                shared.violation(&format!("writing a bridge frame failed: {e}"));
            }
            false
        }
    }
}

fn close_conns(conns: Vec<HostConn>) {
    for conn in conns {
        if let Some(proxy) = &conn.proxy {
            proxy.close();
        }
        // Ends the runner's duplicate too: it is the same connection.
        #[cfg(windows)]
        if let Some(socket) = &conn.passed {
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }
    }
}

/// Which sockets can be handed to the runner as a plain file handle.
#[cfg(windows)]
mod winsock {
    use std::os::windows::io::AsRawSocket;

    use windows_sys::Win32::Networking::WinSock::{
        getsockopt, SOCKET, SOL_SOCKET, SO_PROTOCOL_INFOW, WSAPROTOCOL_INFOW, XP1_IFS_HANDLES,
    };

    /// Whether `stream`'s provider hands out kernel (IFS) handles — the only
    /// kind `ReadFile` / `WriteFile` can drive in the runner. A non-IFS
    /// layered provider's socket is proxied instead.
    pub(super) fn is_kernel_handle(stream: &std::net::TcpStream) -> bool {
        // SAFETY: an all-zero `WSAPROTOCOL_INFOW` is a valid out-buffer.
        let mut info: WSAPROTOCOL_INFOW = unsafe { std::mem::zeroed() };
        let mut len = i32::try_from(std::mem::size_of::<WSAPROTOCOL_INFOW>()).unwrap_or(i32::MAX);
        // SAFETY: `info` is writable for `len` bytes; the socket is open.
        let rc = unsafe {
            getsockopt(
                stream.as_raw_socket() as SOCKET,
                SOL_SOCKET,
                SO_PROTOCOL_INFOW,
                std::ptr::addr_of_mut!(info).cast(),
                &mut len,
            )
        };
        rc == 0 && info.dwServiceFlags1 & XP1_IFS_HANDLES != 0
    }
}

/// Untrusted-peer checks on a request's arguments.
fn validate_op(op: &BridgeOp) -> Result<(), String> {
    match op {
        BridgeOp::OpenConnection { host, .. } if host.len() > MAX_HOST_LEN => {
            Err(format!("open_connection host of {} bytes", host.len()))
        }
        BridgeOp::OpenConnection { .. } => Ok(()),
        BridgeOp::WriteFile { path, data, mode } => {
            check_path(path)?;
            if write_mode(*mode).is_none() {
                return Err(format!("write_file with unknown mode {mode}"));
            }
            if data.len() > MAX_BRIDGE_CHUNK {
                return Err(format!("write_file chunk of {} bytes", data.len()));
            }
            Ok(())
        }
        BridgeOp::ReadFile { path, .. }
        | BridgeOp::Stat { path }
        | BridgeOp::ListDir { path, .. } => check_path(path),
    }
}

/// Move the next page of `names` off the front: as many as fit
/// [`MAX_BRIDGE_CHUNK`], each charged its length plus
/// [`LIST_DIR_ENTRY_OVERHEAD`]. `Io` if a single name cannot fit a page.
fn take_page(names: &mut VecDeque<String>) -> Result<Vec<String>, PluginStatus> {
    let mut page = Vec::new();
    let mut size = 0usize;
    while let Some(name) = names.front() {
        let cost = name.len() + LIST_DIR_ENTRY_OVERHEAD;
        if size + cost > MAX_BRIDGE_CHUNK {
            break;
        }
        size += cost;
        if let Some(name) = names.pop_front() {
            page.push(name);
        }
    }
    if page.is_empty() && !names.is_empty() {
        return Err(PluginStatus::Io);
    }
    Ok(page)
}

fn check_path(path: &str) -> Result<(), String> {
    if path.len() > MAX_PATH_LEN {
        Err(format!("bridge path of {} bytes", path.len()))
    } else if path.contains('\0') {
        Err("bridge path contains NUL".to_owned())
    } else {
        Ok(())
    }
}

/// Decode a wire write mode; `None` for an unknown discriminant (never
/// transmuted).
fn write_mode(mode: i32) -> Option<PluginWriteMode> {
    [
        PluginWriteMode::Truncate,
        PluginWriteMode::Append,
        PluginWriteMode::CreateNew,
    ]
    .into_iter()
    .find(|m| *m as i32 == mode)
}

/// A runner-supplied target as it may appear in logs and toasts: control
/// characters dropped, at most [`MAX_DENIAL_TARGET_CHARS`] characters.
fn sanitize_target(target: &str) -> String {
    let mut out: String = target
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DENIAL_TARGET_CHARS)
        .collect();
    if target.chars().count() > MAX_DENIAL_TARGET_CHARS {
        out.push('…');
    }
    out
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;
