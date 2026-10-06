//! The host's view of a runner as an **untrusted peer** (#4182): the reader
//! thread that demultiplexes runner frames onto sessions, the per-frame
//! validation (direction, known session id, log bounds), and the kill / reap
//! paths every violation or exit ends in.

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use termihub_plugin_api::{PluginError, MAX_LOG_MESSAGE_BYTES};
use termihub_plugin_runner::ipc::{FrameReader, Message, Sender};

use crate::connection::OutputSender;
use crate::plugin::host_context::emit_runner_log;
use crate::plugin::log_rate_limit::PluginLogLimiter;

use super::client::EXIT_TIMEOUT;

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
}

impl Shared {
    /// State for a runner whose process is `child` (`None` in unit tests).
    pub(super) fn new(
        plugin_id: String,
        child: Option<Child>,
        log_limiter: Arc<PluginLogLimiter>,
    ) -> Arc<Self> {
        Arc::new(Self {
            plugin_id,
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU32::new(1),
            dead: AtomicBool::new(false),
            child: Mutex::new(child),
            log_limiter,
            idle_since: Mutex::new(Some(Instant::now())),
        })
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

    pub(super) fn retire(&self, id: u32) {
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
        if !self.dead.load(Ordering::SeqCst) {
            tracing::warn!(
                target: crate::plugin::PLUGIN_LOG_TARGET,
                "[{}] killing the plugin runner: {reason}",
                self.plugin_id
            );
        }
        self.kill();
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

#[cfg(test)]
#[path = "peer_tests.rs"]
mod tests;
