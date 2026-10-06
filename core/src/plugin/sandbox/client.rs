//! [`SandboxedPlugin`]: the host's handle on one running
//! `termihub-plugin-runner` (#4182).
//!
//! Spawn → handshake (bounded by deadlines) → a reader thread that demultiplexes
//! runner frames onto sessions. The runner is an **untrusted peer**: every
//! frame is validated (length cap and known kind in the codec; direction, known
//! session id, log bounds here), and any violation kills the runner. Its
//! sessions then report not-alive; the host and every other plugin keep running.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::{PluginError, MAX_LOG_MESSAGE_BYTES};
use termihub_plugin_runner::ipc::{Configure, FrameReader, Message, Sender};
#[cfg(unix)]
use termihub_plugin_runner::ipc::{ProtocolError, PROTOCOL_VERSION};
#[cfg(unix)]
use termihub_plugin_runner::loader::check_library_abi;
use termihub_plugin_runner::loader::LoadedPluginInfo;

use crate::connection::OutputSender;
use crate::plugin::host_context::emit_runner_log;
use crate::plugin::log_rate_limit::PluginLogLimiter;
use crate::plugin::HostError;

use super::spawn::{spawn_runner, Spawned};

/// How long the runner may take to say `Hello` after spawn.
#[cfg(unix)]
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the runner may take to load the plugin (digest, `dlopen`, init).
#[cfg(unix)]
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-request deadline for `CreateSession` and `Close` replies.
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a write to a stalled runner may block before it is killed.
#[cfg(unix)]
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the runner gets to exit after `Shutdown` before it is killed.
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
/// Upper bound on a `Log` line as the runner may send it: the 8 KiB message
/// bound, after lossy UTF-8 decoding (each invalid byte → 3-byte U+FFFD).
const MAX_WIRE_LOG_BYTES: usize = MAX_LOG_MESSAGE_BYTES * 3;

/// Read buffer of the host's frame reader.
const READ_BUFFER: usize = 64 * 1024;

/// What a host-side request (`CreateSession`, `Close`) waits for.
#[derive(Debug)]
pub(super) enum Reply {
    Created,
    Failed(PluginError),
    Closed,
}

/// Host-side state of one runner session.
pub(super) struct SessionSlot {
    /// Where `Output` bytes go (the session's current terminal subscriber).
    pub(super) output: Arc<Mutex<Option<OutputSender>>>,
    /// Liveness as last pushed by the runner (`Alive`).
    pub(super) alive: Arc<AtomicBool>,
    /// The waiter for an outstanding request, if any.
    pub(super) reply: Option<SyncSender<Reply>>,
}

/// State shared between the plugin handle and its reader thread.
struct Shared {
    plugin_id: String,
    sessions: Mutex<HashMap<u32, SessionSlot>>,
    /// Session ids are allocated from here; an id below it that is no longer in
    /// `sessions` is retired (late frames for it are ignored), one at or above
    /// it was never allocated (a violation).
    next_session: AtomicU32,
    dead: AtomicBool,
    child: Mutex<Option<Child>>,
    log_limiter: Arc<PluginLogLimiter>,
    /// When the session count last dropped to zero (idle reaping).
    idle_since: Mutex<Option<Instant>>,
}

/// A running plugin runner, after a successful handshake.
pub struct SandboxedPlugin {
    info: LoadedPluginInfo,
    writer: Mutex<Box<dyn Write + Send>>,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for SandboxedPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxedPlugin")
            .field("info", &self.info)
            .field("alive", &self.is_alive())
            .finish_non_exhaustive()
    }
}

impl SandboxedPlugin {
    /// No runner transport on this platform yet (Windows: next slice of #4182).
    #[cfg(not(unix))]
    pub(super) fn spawn(
        runner: &Path,
        _configure: &Configure,
        _log_limiter: Arc<PluginLogLimiter>,
    ) -> Result<Arc<Self>, HostError> {
        let Spawned { mut child } = spawn_runner(runner)?;
        let _ = child.kill();
        let _ = child.wait();
        Err(HostError::RunnerUnavailable {
            path: runner.to_owned(),
            detail: "no runner transport on this platform".to_owned(),
        })
    }

    /// Spawn `runner`, hand it `configure`, and wait (bounded) until the plugin
    /// is loaded. The runner's report is re-checked against this host's ABI and
    /// the manifest mirror (untrusted peer). Any failure kills the runner.
    #[cfg(unix)]
    pub(super) fn spawn(
        runner: &Path,
        configure: &Configure,
        log_limiter: Arc<PluginLogLimiter>,
    ) -> Result<Arc<Self>, HostError> {
        let Spawned { child, stream } = spawn_runner(runner)?;
        let shared = Arc::new(Shared {
            plugin_id: configure.plugin_id.clone(),
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU32::new(1),
            dead: AtomicBool::new(false),
            child: Mutex::new(Some(child)),
            log_limiter,
            idle_since: Mutex::new(Some(Instant::now())),
        });
        match handshake(&stream, configure) {
            Ok(info) => {
                let _ = stream.set_read_timeout(None);
                let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                let reader = stream
                    .try_clone()
                    .map_err(|e| HostError::RunnerProtocol(format!("clone channel: {e}")))
                    .inspect_err(|_| shared.kill())?;
                let reader_shared = Arc::clone(&shared);
                std::thread::Builder::new()
                    .name(format!("plugin-runner-{}", configure.plugin_id))
                    .spawn(move || reader_shared.read_loop(reader))
                    .map_err(|e| HostError::RunnerProtocol(format!("reader thread: {e}")))
                    .inspect_err(|_| shared.kill())?;
                Ok(Arc::new(Self {
                    info,
                    writer: Mutex::new(Box::new(stream)),
                    shared,
                }))
            }
            Err(err) => {
                shared.kill();
                Err(err)
            }
        }
    }

    /// Metadata the plugin reported at load (re-validated by the host).
    #[must_use]
    pub fn info(&self) -> &LoadedPluginInfo {
        &self.info
    }

    /// Whether the runner is still running and talking.
    #[must_use]
    pub fn is_alive(&self) -> bool {
        !self.shared.dead.load(Ordering::SeqCst)
    }

    /// The runner's process id, while it runs (diagnostics and tests).
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.shared
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Child::id)
    }

    /// Number of open sessions.
    #[must_use]
    pub fn session_count(&self) -> usize {
        self.shared
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// When the plugin last became session-free, if it is session-free now.
    pub(super) fn idle_since(&self) -> Option<Instant> {
        *self
            .shared
            .idle_since
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Send one encoded message. A failed write (the runner is stalled past
    /// [`WRITE_TIMEOUT`] or gone) kills the runner.
    pub(super) fn send(&self, message: &Message) -> Result<(), PluginError> {
        let frame = message
            .encode()
            .map_err(|e| PluginError::Other(e.to_string()))?;
        self.send_encoded(&frame)
    }

    /// Send one already-encoded frame (the `Input` hot path).
    pub(super) fn send_encoded(&self, frame: &[u8]) -> Result<(), PluginError> {
        if !self.is_alive() {
            return Err(PluginError::NotAlive);
        }
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let result = writer.write_all(frame).and_then(|()| writer.flush());
        drop(writer);
        result.map_err(|e| {
            self.shared
                .violation(&format!("writing to the runner failed: {e}"));
            PluginError::NotAlive
        })
    }

    /// Register a new session slot and return its id plus the reply receiver.
    pub(super) fn register_session(
        &self,
        output: Arc<Mutex<Option<OutputSender>>>,
        alive: Arc<AtomicBool>,
    ) -> (u32, Receiver<Reply>) {
        let id = self.shared.next_session.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = sync_channel(1);
        let mut sessions = self
            .shared
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sessions.insert(
            id,
            SessionSlot {
                output,
                alive,
                reply: Some(tx),
            },
        );
        *self
            .shared
            .idle_since
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        (id, rx)
    }

    /// Arm a reply waiter on an existing session (for `Close`).
    pub(super) fn expect_reply(&self, id: u32) -> Option<Receiver<Reply>> {
        let mut sessions = self
            .shared
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let slot = sessions.get_mut(&id)?;
        let (tx, rx) = sync_channel(1);
        slot.reply = Some(tx);
        Some(rx)
    }

    /// Forget a session (closed, failed or timed out). Late frames for it are
    /// ignored from now on.
    pub(super) fn retire_session(&self, id: u32) {
        self.shared.retire(id);
    }

    /// Wind the runner down within bounded time: cancel everything, `Close`
    /// every session, `Shutdown`, then kill whatever is still running. The
    /// host never waits on a plugin without a deadline.
    pub fn shutdown(&self) {
        if self.is_alive() {
            let _ = self.send(&Message::Cancel(termihub_plugin_runner::ipc::Cancel {
                session_id: None,
            }));
            let ids: Vec<u32> = self
                .shared
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .keys()
                .copied()
                .collect();
            let deadline = Instant::now() + REQUEST_TIMEOUT;
            let waits: Vec<_> = ids
                .into_iter()
                .filter_map(|id| {
                    let rx = self.expect_reply(id)?;
                    self.send(&Message::Close(termihub_plugin_runner::ipc::SessionRef {
                        session_id: id,
                    }))
                    .ok()?;
                    Some(rx)
                })
                .collect();
            for rx in waits {
                let left = deadline.saturating_duration_since(Instant::now());
                let _ = rx.recv_timeout(left);
            }
            let _ = self.send(&Message::Shutdown);
        }
        self.shared.reap(EXIT_TIMEOUT);
    }
}

impl Drop for SandboxedPlugin {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Run the startup sequence on the calling thread, bounded by deadlines.
#[cfg(unix)]
fn handshake(
    stream: &std::os::unix::net::UnixStream,
    configure: &Configure,
) -> Result<LoadedPluginInfo, HostError> {
    let protocol = |what: &str| HostError::RunnerProtocol(what.to_owned());
    let mut frames = FrameReader::new(stream);
    let mut next = |timeout: Duration, waiting_for: &str| -> Result<Message, HostError> {
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| protocol(&e.to_string()))?;
        match frames.read_frame() {
            Ok(Some(frame)) => Message::decode_from_peer(frame, Sender::Host)
                .map_err(|e| protocol(&format!("waiting for {waiting_for}: {e}"))),
            Ok(None) => Err(protocol(&format!(
                "the runner exited while the host was waiting for {waiting_for}"
            ))),
            Err(ProtocolError::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Err(protocol(&format!("timed out waiting for {waiting_for}")))
            }
            Err(e) => Err(protocol(&format!("waiting for {waiting_for}: {e}"))),
        }
    };

    match next(HELLO_TIMEOUT, "Hello")? {
        Message::Hello(hello) if hello.protocol_version == PROTOCOL_VERSION => {}
        Message::Hello(hello) => {
            return Err(protocol(&format!(
                "runner speaks protocol {}, the host speaks {PROTOCOL_VERSION}",
                hello.protocol_version
            )))
        }
        other => return Err(protocol(&format!("expected Hello, got {:?}", other.kind()))),
    }
    let frame = Message::Configure(configure.clone())
        .encode()
        .map_err(|e| protocol(&e.to_string()))?;
    let mut writer = stream;
    writer
        .write_all(&frame)
        .map_err(|e| protocol(&format!("sending Configure: {e}")))?;
    match next(LOAD_TIMEOUT, "SandboxReport")? {
        Message::SandboxReport(_) => {}
        other => {
            return Err(protocol(&format!(
                "expected SandboxReport, got {:?}",
                other.kind()
            )))
        }
    }
    match next(LOAD_TIMEOUT, "Loaded")? {
        Message::Loaded(loaded) => {
            let info = loaded.into_info();
            // Re-apply the ABI gate + manifest mirror host-side: the runner ran
            // them, but the host does not take an untrusted peer's word for it.
            check_library_abi(
                info.abi_version,
                termihub_plugin_api::CURRENT_PLUGIN_ABI_VERSION,
                configure.manifest_api_version.as_deref(),
            )?;
            Ok(info)
        }
        Message::LoadFailed(failed) => Err(HostError::RunnerLoad {
            incompatible: failed.incompatible,
            message: failed.message,
        }),
        other => Err(protocol(&format!(
            "expected Loaded, got {:?}",
            other.kind()
        ))),
    }
}

impl Shared {
    fn read_loop<R: std::io::Read>(self: Arc<Self>, reader: R) {
        // Buffered: a frame is three reads (length, kind, payload); the buffer
        // turns a burst of small frames into one syscall.
        let mut frames = FrameReader::new(std::io::BufReader::with_capacity(READ_BUFFER, reader));
        loop {
            match frames.read_frame() {
                Ok(Some(frame)) => match Message::decode_from_peer(frame, Sender::Host) {
                    Ok(message) => {
                        if let Err(reason) = self.dispatch(message) {
                            self.violation(&reason);
                            break;
                        }
                    }
                    Err(e) => {
                        self.violation(&e.to_string());
                        break;
                    }
                },
                Ok(None) => {
                    self.mark_dead("the plugin runner exited");
                    break;
                }
                Err(e) => {
                    self.violation(&e.to_string());
                    break;
                }
            }
        }
        self.reap(EXIT_TIMEOUT);
    }

    /// Route one runner frame. `Err` is a protocol violation.
    fn dispatch(&self, message: Message) -> Result<(), String> {
        match message {
            Message::Output { session_id, data } => {
                let mut subscriber = None;
                self.with_session(session_id, |slot| {
                    subscriber = slot
                        .output
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                })?;
                // No subscriber yet (or a dropped receiver): drop the chunk, as
                // the in-process path does. Blocking here (outside every lock)
                // backpressures the runner through the socket.
                if let Some(sender) = subscriber {
                    let _ = sender.blocking_send(data);
                }
                Ok(())
            }
            Message::Alive(alive) => self.with_session(alive.session_id, |slot| {
                slot.alive.store(alive.alive, Ordering::SeqCst);
            }),
            Message::SessionCreated(r) => self.reply(r.session_id, Reply::Created),
            Message::SessionFailed(f) => {
                self.reply(f.session_id, Reply::Failed(f.error.into_error()))
            }
            Message::Closed(r) => self.reply(r.session_id, Reply::Closed),
            Message::SessionError(e) => self.with_session(e.session_id, |slot| {
                let error = e.error.into_error();
                if matches!(error, PluginError::NotAlive | PluginError::ChannelClosed) {
                    slot.alive.store(false, Ordering::SeqCst);
                }
                emit_runner_log(
                    &self.log_limiter,
                    &self.plugin_id,
                    termihub_plugin_api::PluginLogLevel::Warn.as_wire(),
                    format!("{} failed: {error}", e.operation).as_bytes(),
                    false,
                );
            }),
            Message::Log(log) => {
                if termihub_plugin_api::PluginLogLevel::from_wire(log.level).is_none() {
                    return Err(format!("invalid log level {}", log.level));
                }
                if log.message.len() > MAX_WIRE_LOG_BYTES {
                    return Err(format!("log line of {} bytes", log.message.len()));
                }
                if let Some(id) = log.session_id {
                    self.check_session_id(id)?;
                }
                let bytes = log.message.as_bytes();
                let bounded = &bytes[..bytes.len().min(MAX_LOG_MESSAGE_BYTES)];
                emit_runner_log(
                    &self.log_limiter,
                    &self.plugin_id,
                    log.level,
                    bounded,
                    log.truncated || bytes.len() > MAX_LOG_MESSAGE_BYTES,
                );
                Ok(())
            }
            // Hang detection (phase 3) consumes pongs; for now they are valid
            // and ignored.
            Message::Pong(_) => Ok(()),
            other => Err(format!(
                "unexpected {:?} frame after the handshake",
                other.kind()
            )),
        }
    }

    /// Run `f` on a live session; ignore a retired one; reject an id that was
    /// never allocated.
    fn with_session(&self, id: u32, f: impl FnOnce(&SessionSlot)) -> Result<(), String> {
        self.check_session_id(id)?;
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = sessions.get(&id) {
            f(slot);
        }
        Ok(())
    }

    fn check_session_id(&self, id: u32) -> Result<(), String> {
        if id == 0 || id >= self.next_session.load(Ordering::SeqCst) {
            Err(format!("frame for unknown session {id}"))
        } else {
            Ok(())
        }
    }

    fn reply(&self, id: u32, reply: Reply) -> Result<(), String> {
        self.check_session_id(id)?;
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = sessions.get_mut(&id).and_then(|slot| slot.reply.take()) {
            let _ = tx.try_send(reply);
        }
        Ok(())
    }

    fn retire(&self, id: u32) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = sessions.remove(&id) {
            slot.alive.store(false, Ordering::SeqCst);
        }
        if sessions.is_empty() {
            *self.idle_since.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        }
    }

    /// A protocol violation: log it, kill the runner, end every session.
    fn violation(&self, reason: &str) {
        if !self.dead.load(Ordering::SeqCst) {
            tracing::warn!(
                target: crate::plugin::PLUGIN_LOG_TARGET,
                "[{}] killing the plugin runner: {reason}",
                self.plugin_id
            );
        }
        self.kill();
    }

    fn kill(&self) {
        if let Some(child) = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            let _ = child.kill();
        }
        self.mark_dead("the plugin runner was stopped");
    }

    /// Mark the runner gone: every session reports not-alive, its output ends,
    /// and every waiter is released.
    fn mark_dead(&self, _why: &str) {
        self.dead.store(true, Ordering::SeqCst);
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for slot in sessions.values_mut() {
            slot.alive.store(false, Ordering::SeqCst);
            *slot.output.lock().unwrap_or_else(|e| e.into_inner()) = None;
            if let Some(tx) = slot.reply.take() {
                let _ = tx.try_send(Reply::Failed(PluginError::NotAlive));
            }
        }
    }

    /// Wait up to `timeout` for the runner to exit, then kill it; always reap.
    fn reap(&self, timeout: Duration) {
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let Some(child) = guard.as_mut() else {
            return;
        };
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
        *guard = None;
        drop(guard);
        self.mark_dead("the plugin runner exited");
    }
}
