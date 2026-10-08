//! The host's view of a runner as an **untrusted peer** (#4182): the reader
//! thread that demultiplexes runner frames onto sessions, the per-frame
//! validation (direction, known session id, log bounds), and the kill / reap
//! paths every violation or exit ends in.
//!
//! **Exit causes (#4184).** Whoever kills the runner records why first
//! ([`Shared::kill_for`]: not responding, out of memory, invalid data, or a
//! host stop); an exit nobody asked for is classified from the process status
//! when it is reaped. The final [`RunnerExitCause`] is recorded once and handed
//! to the exit hook the plugin handle installs (crash budget, respawn).

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::{PluginError, MAX_LOG_MESSAGE_BYTES};
use termihub_plugin_runner::ipc::{FrameReader, Message, ProtocolError, Sender};

use crate::connection::OutputSender;
use crate::plugin::host_context::emit_runner_log;
use crate::plugin::log_rate_limit::PluginLogLimiter;

use super::bridge::BridgeHost;
use super::client::EXIT_TIMEOUT;
use super::exit::RunnerExitCause;

/// Upper bound on a `Log` line as the runner may send it: the 8 KiB message
/// bound, after lossy UTF-8 decoding (each invalid byte → 3-byte U+FFFD).
const MAX_WIRE_LOG_BYTES: usize = MAX_LOG_MESSAGE_BYTES * 3;

/// Read buffer of the host's frame reader.
const READ_BUFFER: usize = 64 * 1024;

/// Longest runner stderr line forwarded in one piece.
const MAX_STDERR_LINE: u64 = 16 * 1024;

/// How long classifying an exit waits for the stderr forwarder to drain.
const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

/// Called once with the final cause when the runner is gone.
pub(super) type ExitHook = Box<dyn FnOnce(&RunnerExitCause) + Send>;

/// The final exit cause and the hook waiting for it.
#[derive(Default)]
struct ExitState {
    cause: Option<RunnerExitCause>,
    hook: Option<ExitHook>,
}

/// Ping bookkeeping for hang detection (#4184).
#[derive(Debug, Default)]
pub(super) struct HeartbeatState {
    /// Nonce of the last `Ping` sent (0: none yet).
    pub(super) last_sent: u64,
    /// When the unanswered `Ping` was sent (or a call deadline last covered
    /// it), if one is outstanding.
    pub(super) outstanding_since: Option<Instant>,
}

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
pub(super) struct Shared {
    pub(super) plugin_id: String,
    pub(super) sessions: Mutex<HashMap<u32, SessionSlot>>,
    /// Session ids are allocated from here; an id below it that is no longer in
    /// `sessions` is retired (late frames for it are ignored), one at or above
    /// it was never allocated (a violation).
    pub(super) next_session: AtomicU32,
    pub(super) dead: AtomicBool,
    pub(super) child: Mutex<Option<Child>>,
    pub(super) log_limiter: Arc<PluginLogLimiter>,
    /// When the session count last dropped to zero (idle reaping).
    pub(super) idle_since: Mutex<Option<Instant>>,
    /// Why the host is killing the runner, recorded before the kill (first
    /// wins).
    pending_cause: Mutex<Option<RunnerExitCause>>,
    /// The final exit cause, once the runner is reaped, and its hook.
    exit: Mutex<ExitState>,
    /// Hang detection state.
    pub(super) heartbeat: Mutex<HeartbeatState>,
    /// Requests with their own deadline in flight (`CreateSession`); while
    /// any is, a missing pong is not yet a hang.
    pub(super) calls_in_flight: AtomicUsize,
    /// The runner reported a failed allocation on stderr.
    out_of_memory: AtomicBool,
    /// The stderr forwarder is done (or there is none).
    stderr_done: AtomicBool,
    /// The capability-bridge service answering this runner's requests (#4183).
    pub(super) bridge: Arc<BridgeHost>,
}

impl Shared {
    /// State for a runner whose process is `child` (`None` in unit tests).
    pub(super) fn new(
        plugin_id: String,
        child: Option<Child>,
        log_limiter: Arc<PluginLogLimiter>,
    ) -> Arc<Self> {
        Arc::new(Self {
            bridge: BridgeHost::new(plugin_id.clone()),
            plugin_id,
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU32::new(1),
            dead: AtomicBool::new(false),
            child: Mutex::new(child),
            log_limiter,
            idle_since: Mutex::new(Some(Instant::now())),
            pending_cause: Mutex::new(None),
            exit: Mutex::new(ExitState::default()),
            heartbeat: Mutex::new(HeartbeatState::default()),
            calls_in_flight: AtomicUsize::new(0),
            out_of_memory: AtomicBool::new(false),
            stderr_done: AtomicBool::new(true),
        })
    }

    /// Forward the runner's stderr (the plugin's own diagnostics) to the
    /// host's, line by line, noting a failed allocation on the way (a Rust
    /// plugin under `RLIMIT_AS` prints `memory allocation of N bytes failed`
    /// and aborts). Runs on its own thread until end of stream.
    pub(super) fn forward_stderr<R: std::io::Read>(self: Arc<Self>, stderr: R) {
        let mut reader = std::io::BufReader::new(stderr);
        let mut line = Vec::new();
        loop {
            line.clear();
            match std::io::Read::take(&mut reader, MAX_STDERR_LINE).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if is_allocation_failure(&line) {
                        self.out_of_memory.store(true, Ordering::SeqCst);
                    }
                    let _ = std::io::stderr().write_all(&line);
                }
            }
        }
        self.stderr_done.store(true, Ordering::SeqCst);
    }

    /// Mark a stderr forwarder as running (before its thread starts).
    pub(super) fn expect_stderr(&self) {
        self.stderr_done.store(false, Ordering::SeqCst);
    }

    pub(super) fn read_loop<R: std::io::Read>(self: Arc<Self>, reader: R) {
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
                // End of stream: the runner exited (or is exiting). `reap`
                // below classifies the exit before the sessions are ended, so
                // a session never reports dead without its cause.
                Ok(None) => break,
                // The runner died mid-stream (Linux resets a socket closed
                // with unread data): that is an exit, classified by `reap`,
                // not invalid data.
                Err(e) if runner_went_away(&e) => break,
                Err(e) => {
                    self.violation(&e.to_string());
                    break;
                }
            }
        }
        self.reap(EXIT_TIMEOUT);
    }

    /// Route one runner frame. `Err` is a protocol violation.
    pub(super) fn dispatch(&self, message: Message) -> Result<(), String> {
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
            Message::Pong(beat) => self.pong(beat.nonce),
            // The capability bridge over IPC (#4183).
            Message::BridgeRequest(request) => {
                self.bridge.request(request, |id| self.check_session_id(id))
            }
            Message::BridgeRelease(conn) => self.bridge.release(conn),
            Message::StreamAck(ack) => self.bridge.stream_ack(ack),
            Message::StreamWrite(chunk) => self.bridge.stream_write(chunk),
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

    /// A `Pong`: clears the outstanding ping. A nonce that was never sent is a
    /// violation; a stale duplicate is ignored.
    fn pong(&self, nonce: u64) -> Result<(), String> {
        let mut heartbeat = self.heartbeat.lock().unwrap_or_else(|e| e.into_inner());
        if nonce == 0 || nonce > heartbeat.last_sent {
            return Err(format!("pong {nonce} for a ping that was never sent"));
        }
        if nonce == heartbeat.last_sent {
            heartbeat.outstanding_since = None;
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

    pub(super) fn retire(&self, id: u32) {
        self.bridge.close_session(id);
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = sessions.remove(&id) {
            slot.alive.store(false, Ordering::SeqCst);
        }
        if sessions.is_empty() {
            *self.idle_since.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        }
    }

    /// A protocol violation: log it, kill the runner, end every session.
    pub(super) fn violation(&self, reason: &str) {
        self.kill_for(RunnerExitCause::InvalidData {
            detail: reason.to_owned(),
        });
    }

    /// Kill the runner for `cause` (recorded first, so the sessions it ends
    /// report it): a violation, a hang, the memory watchdog, or a host stop.
    pub(super) fn kill_for(&self, cause: RunnerExitCause) {
        if !self.dead.load(Ordering::SeqCst) && cause.is_failure() {
            tracing::warn!(
                target: crate::plugin::PLUGIN_LOG_TARGET,
                "[{}] killing the plugin runner: {}",
                self.plugin_id,
                cause.describe()
            );
        }
        self.set_pending_cause(cause);
        self.kill();
    }

    /// Record why the runner is about to end, unless a cause is already
    /// recorded (the first one wins).
    pub(super) fn set_pending_cause(&self, cause: RunnerExitCause) {
        let mut pending = self.pending_cause.lock().unwrap_or_else(|e| e.into_inner());
        if pending.is_none() {
            *pending = Some(cause);
        }
    }

    /// The cause the runner ended (or is being ended) with, if it did.
    ///
    /// Only the final cause is reported (#4239): a pending verdict can still
    /// give way to out-of-memory evidence when the runner is reaped.
    pub(super) fn exit_cause(&self) -> Option<RunnerExitCause> {
        self.exit
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cause
            .clone()
    }

    /// Install the exit hook; runs it at once if the runner already ended.
    pub(super) fn set_exit_hook(&self, hook: ExitHook) {
        let mut exit = self.exit.lock().unwrap_or_else(|e| e.into_inner());
        match exit.cause.clone() {
            Some(cause) => {
                drop(exit);
                // The cause is final, so the runner is gone: make sure every
                // session (and `is_alive`) says so before the hook acts on it.
                self.mark_dead("the plugin runner exited");
                hook(&cause);
            }
            None => exit.hook = Some(hook),
        }
    }

    /// Record the final cause from the reaped `status` (a pending cause wins),
    /// end every session, then run the exit hook. Idempotent.
    fn finish(&self, status: Option<std::process::ExitStatus>) {
        let pending = self
            .pending_cause
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        // A cause recorded by `kill_for` was already logged there.
        let natural = pending.is_none();
        // Let the stderr forwarder drain so a reported allocation failure is
        // not missed: it decides a natural exit, and it overrides a hang
        // verdict that raced it (#4239).
        if natural || pending == Some(RunnerExitCause::NotResponding) {
            let deadline = Instant::now() + STDERR_DRAIN_TIMEOUT;
            while !self.stderr_done.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let out_of_memory = self.out_of_memory.load(Ordering::SeqCst);
        let cause = match pending {
            None => RunnerExitCause::from_status(status, out_of_memory),
            Some(pending) => prefer_memory_evidence(pending, out_of_memory),
        };
        let mut exit = self.exit.lock().unwrap_or_else(|e| e.into_inner());
        if exit.cause.is_some() {
            return;
        }
        if natural && cause.is_failure() {
            tracing::warn!(
                target: crate::plugin::PLUGIN_LOG_TARGET,
                "[{}] {}",
                self.plugin_id,
                cause.describe()
            );
        }
        exit.cause = Some(cause.clone());
        let hook = exit.hook.take();
        drop(exit);
        // Dead before the hook runs: a respawn it triggers must not find this
        // runner still looking alive.
        self.mark_dead("the plugin runner exited");
        if let Some(hook) = hook {
            hook(&cause);
        }
    }

    pub(super) fn kill(&self) {
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
    pub(super) fn mark_dead(&self, _why: &str) {
        self.dead.store(true, Ordering::SeqCst);
        self.bridge.shutdown();
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
    pub(super) fn reap(&self, timeout: Duration) {
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let Some(child) = guard.as_mut() else {
            return;
        };
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => {
                    // Still running past the deadline (or unwaitable): the
                    // host ends it, so a stall here is a hang, not a crash.
                    self.set_pending_cause(RunnerExitCause::NotResponding);
                    let _ = child.kill();
                    break child.wait().ok();
                }
            }
        };
        *guard = None;
        drop(guard);
        self.finish(status);
        self.mark_dead("the plugin runner exited");
    }
}

/// Whether a read error means the runner's end of the channel is gone (it
/// exited or was killed) rather than that it sent something malformed.
fn runner_went_away(error: &ProtocolError) -> bool {
    match error {
        ProtocolError::Truncated => true,
        ProtocolError::Io(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

/// A hang verdict gives way to out-of-memory evidence (#4239): a plugin that
/// allocates without bound inside a call both stops answering pings and
/// exhausts its memory, and whichever timer noticed first must not decide the
/// overlay. Every other recorded cause stands.
fn prefer_memory_evidence(pending: RunnerExitCause, out_of_memory: bool) -> RunnerExitCause {
    match pending {
        RunnerExitCause::NotResponding if out_of_memory => RunnerExitCause::OutOfMemory,
        other => other,
    }
}

/// Whether a stderr line is Rust's report of a failed allocation
/// (`memory allocation of N bytes failed`).
fn is_allocation_failure(line: &[u8]) -> bool {
    const PREFIX: &[u8] = b"memory allocation of ";
    const SUFFIX: &[u8] = b" bytes failed";
    let trimmed = line.trim_ascii_end();
    trimmed.starts_with(PREFIX) && trimmed.ends_with(SUFFIX)
}

#[cfg(test)]
#[path = "peer_tests.rs"]
mod tests;
