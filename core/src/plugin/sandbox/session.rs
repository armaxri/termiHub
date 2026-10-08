//! [`SandboxedSession`]: one plugin session served by a runner — the
//! out-of-process counterpart of `termihub_plugin_api::LoadedBackend`, with the
//! same operations (`write_input`, `resize`, `close`, `is_alive`).
//!
//! **Semantics delta (host side only, concept "IPC surface"):** `write_input`
//! and `resize` are queued to the runner without a round trip, so a plugin's
//! error for them arrives later as a session error (logged under the plugin
//! target, and a `NotAlive` / `ChannelClosed` one flips liveness). `is_alive` is
//! the value the runner last pushed. The plugin itself still sees the
//! synchronous ABI and returns its status exactly as specified.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use termihub_plugin_api::PluginError;
use termihub_plugin_runner::ipc::{
    encode_data_frame, Cancel, CreateSession, FrameKind, Message, Resize, SessionRef,
    MAX_PAYLOAD_LEN, SESSION_ID_LEN,
};

use crate::connection::OutputSender;

use super::bridge::BridgeGrant;
use super::client::{SandboxedPlugin, CREATE_TIMEOUT, REQUEST_TIMEOUT};
use super::exit::RunnerExitCause;
use super::peer::Reply;

/// Largest input chunk carried in one `Input` frame.
const MAX_INPUT_CHUNK: usize = MAX_PAYLOAD_LEN - SESSION_ID_LEN;

/// A live session in a plugin runner. Dropping it closes the session.
pub struct SandboxedSession {
    plugin: Arc<SandboxedPlugin>,
    id: u32,
    alive: Arc<AtomicBool>,
    closed: bool,
}

impl std::fmt::Debug for SandboxedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxedSession")
            .field("id", &self.id)
            .field("alive", &self.is_alive())
            .finish_non_exhaustive()
    }
}

impl SandboxedSession {
    /// Create a session in `plugin`'s runner, waiting (bounded) for the
    /// plugin's `create_backend` result. Output is delivered to whatever
    /// sender `output` holds at the time; the session's capability-bridge
    /// calls are answered under `grant`.
    pub(crate) fn create(
        plugin: Arc<SandboxedPlugin>,
        config_json: &str,
        settings_json: &str,
        data_dir: &str,
        output: Arc<Mutex<Option<OutputSender>>>,
        grant: BridgeGrant,
    ) -> Result<Self, PluginError> {
        let alive = Arc::new(AtomicBool::new(true));
        let (id, reply) = plugin.register_session(output, Arc::clone(&alive));
        let connect_deadline_ms =
            u64::try_from(grant.connect_deadline().as_millis()).unwrap_or(u64::MAX);
        plugin.grant_bridge(id, grant);
        let request = Message::CreateSession(CreateSession {
            session_id: id,
            config_json: config_json.to_owned(),
            settings_json: settings_json.to_owned(),
            data_dir: data_dir.to_owned(),
            connect_deadline_ms,
        });
        // The create has its own (long) deadline; the hang verdict waits.
        let in_flight = plugin.call_in_flight();
        let outcome =
            plugin
                .send(&request)
                .and_then(|()| match reply.recv_timeout(CREATE_TIMEOUT) {
                    Ok(Reply::Created) => Ok(()),
                    Ok(Reply::Failed(error)) => Err(error),
                    Ok(Reply::Closed) => Err(PluginError::NotAlive),
                    Err(_) => {
                        // A missed call deadline is a hang (#4184): the
                        // runner's request thread is stuck in the plugin.
                        plugin.kill_for(RunnerExitCause::NotResponding);
                        Err(PluginError::Other(
                            "the plugin runner did not answer CreateSession in time".to_owned(),
                        ))
                    }
                });
        drop(in_flight);
        match outcome {
            Ok(()) => Ok(Self {
                plugin,
                id,
                alive,
                closed: false,
            }),
            Err(error) => {
                // A late success would leave an orphan session in the runner:
                // ask it to close whatever it may still create (best effort).
                let _ = plugin.send(&Message::Close(SessionRef { session_id: id }));
                plugin.retire_session(id);
                Err(error)
            }
        }
    }

    /// The host-assigned session id (diagnostics and tests).
    #[must_use]
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Queue terminal input for the plugin's `write_input`.
    pub fn write_input(&self, data: &[u8]) -> Result<(), PluginError> {
        self.ensure_alive()?;
        for chunk in data.chunks(MAX_INPUT_CHUNK.max(1)) {
            let frame = encode_data_frame(FrameKind::Input, self.id, chunk)
                .map_err(|e| PluginError::Other(e.to_string()))?;
            self.plugin.send_encoded(&frame)?;
        }
        Ok(())
    }

    /// Queue a terminal resize for the plugin's `resize`.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PluginError> {
        self.ensure_alive()?;
        self.plugin.send(&Message::Resize(Resize {
            session_id: self.id,
            cols,
            rows,
        }))
    }

    /// Why the session ended on its own: the cause of its runner's exit
    /// (#4184). `None` while it runs and after a [`close`](Self::close).
    #[must_use]
    pub fn exit_cause(&self) -> Option<RunnerExitCause> {
        if self.closed {
            None
        } else {
            self.plugin.exit_cause()
        }
    }

    /// Whether the session is alive (as last pushed by the runner, and the
    /// runner itself is running).
    #[must_use]
    pub fn is_alive(&self) -> bool {
        !self.closed && self.plugin.is_alive() && self.alive.load(Ordering::SeqCst)
    }

    /// Cancel and close the session: the plugin's `close` + `destroy` run in
    /// the runner. Waits at most 2 s; idempotent.
    pub fn close(&mut self) -> Result<(), PluginError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let result = self.request_close();
        self.plugin.retire_session(self.id);
        result
    }

    fn request_close(&self) -> Result<(), PluginError> {
        if !self.plugin.is_alive() {
            return Ok(());
        }
        let reply = self.plugin.expect_reply(self.id);
        self.plugin.send(&Message::Cancel(Cancel {
            session_id: Some(self.id),
        }))?;
        self.plugin.send(&Message::Close(SessionRef {
            session_id: self.id,
        }))?;
        match reply.map(|rx| rx.recv_timeout(REQUEST_TIMEOUT)) {
            Some(Ok(_)) | None => Ok(()),
            Some(Err(_)) => {
                // The close deadline is a call deadline: missing it is a hang.
                self.plugin.kill_for(RunnerExitCause::NotResponding);
                Err(PluginError::Other(
                    "the plugin runner did not close the session in time".to_owned(),
                ))
            }
        }
    }

    fn ensure_alive(&self) -> Result<(), PluginError> {
        if self.closed || !self.plugin.is_alive() {
            Err(PluginError::NotAlive)
        } else {
            Ok(())
        }
    }
}

impl Drop for SandboxedSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
