//! The host's capability-bridge **service** for one plugin runner (#4183,
//! plugin OS-sandbox phase 2).
//!
//! An out-of-process plugin reaches the network and its declared paths only
//! through this service: the runner forwards each `PluginHostBridge` call as a
//! `BridgeRequest` frame, and the host answers it with the very same guarded
//! operations the in-process bridge runs
//! ([`guarded_connect`](crate::plugin::capabilities) and friends) against the
//! session's `PermissionSet`, `FilesystemScope` and `ConnectionPolicy`. One
//! enforcement point, identical on every OS; the runner holds no permission
//! state.
//!
//! * **Network.** An approved `open_connection` is connected by the host, which
//!   then passes the connected socket to the runner with the reply
//!   (`SCM_RIGHTS` on Unix). Where a handle cannot be passed the host keeps the
//!   socket and proxies it ([`super::proxy`]). Either way the session's
//!   connection slot stays reserved until the runner sends `BridgeRelease` (or
//!   the session / runner ends).
//! * **Filesystem.** Reads and writes move in `MAX_BRIDGE_CHUNK` pieces; the
//!   path is re-resolved against the scope for every piece.
//! * **Denials** are recorded as structured [`BridgeDenial`] events per plugin
//!   (and logged), ready for the UI phase to turn into toasts.
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
    StreamTransport, MAX_BRIDGE_CHUNK,
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
}

/// One refused bridge request, per plugin — what the UI phase turns into a
/// rate-limited toast and a Log Viewer entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeDenial {
    /// The plugin (manifest id).
    pub plugin_id: String,
    /// The plugin session whose bridge was called.
    pub session_id: u32,
    /// The ABI callback (`open_connection`, `read_file`, …).
    pub operation: &'static str,
    /// What was asked for (`host:port` or a path), sanitised and truncated.
    pub target: String,
    /// Why it was refused.
    pub reason: DenialReason,
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
    denials: Mutex<VecDeque<BridgeDenial>>,
    force_proxy: AtomicBool,
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
            denials: Mutex::new(VecDeque::new()),
            force_proxy: AtomicBool::new(false),
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
            BridgeOp::ListDir { path } => guarded_list_dir(perms, path).and_then(|names| {
                // The listing must fit one reply frame.
                let size: usize = names.iter().map(|n| n.len() + 8).sum();
                if size > MAX_BRIDGE_CHUNK {
                    Err(PluginStatus::Io)
                } else {
                    Ok(BridgeResult::Entries { names })
                }
            }),
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
        let transport = if pass {
            StreamTransport::HandlePassed
        } else {
            StreamTransport::Proxy
        };
        let proxy = (!pass)
            .then(|| stream.try_clone().ok())
            .flatten()
            .map(|socket| ProxyHost::new(conn_id, socket));
        if !pass && proxy.is_none() {
            self.reply_status(request_id, PluginStatus::Io);
            return;
        }
        lock(&self.conns).insert(
            conn_id,
            HostConn {
                session_id,
                _slot: slot,
                proxy: proxy.clone(),
            },
        );
        let reply = Message::BridgeReply(BridgeReply {
            request_id,
            result: BridgeResult::Connection { conn_id, transport },
        });
        let sent = if pass {
            self.send_with_socket(attached, &reply, &stream)
        } else {
            self.send(&reply)
        };
        // The host keeps no copy of a passed socket: the runner owns it now.
        drop(stream);
        if !sent {
            if let Some(gone) = lock(&self.conns).remove(&conn_id) {
                close_conns(vec![gone]);
            }
            return;
        }
        if let Some(proxy) = proxy {
            // Only after the reply, so no `StreamData` precedes it.
            proxy.start(self.frame_sink());
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

    #[cfg(not(unix))]
    fn send_with_socket(
        &self,
        _attached: &Attached,
        _reply: &Message,
        _stream: &std::net::TcpStream,
    ) -> bool {
        // TODO(#4219): Windows passes the socket with `DuplicateHandle` into
        // the runner, which drives it with overlapped ReadFile/WriteFile (no
        // Winsock under LPAC). Until that transport exists `can_pass_handles`
        // is false here and every connection is proxied.
        false
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
            | BridgeOp::ListDir { path } => path.clone(),
        };
        let denial = BridgeDenial {
            plugin_id: self.plugin_id.clone(),
            session_id: request.session_id,
            operation: request.op.name(),
            target: sanitize_target(&target),
            reason,
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
        BridgeOp::ReadFile { path, .. } | BridgeOp::Stat { path } | BridgeOp::ListDir { path } => {
            check_path(path)
        }
    }
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
